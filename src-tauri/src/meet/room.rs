//! A meeting room: who is in it, who waits in the lobby, and the signalling between them. The
//! room never touches media (that goes peer to peer); it relays offers, answers and candidates,
//! and tells everyone who joined, left, muted, raised a hand or chatted.

use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use serde::Serialize;
use serde_json::{json, Value};

use super::store::Stored;
use super::Hub;

/// At most this many people at once (a full mesh).
pub const MAX_PEOPLE: usize = 16;
pub const MAX_CHAT: usize = 2000;
pub const MAX_NAME: usize = 40;

/// What a connection's thread writes out.
pub enum Out {
    Text(String),
    Close,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub host: bool,
    pub audio: bool,
    pub video: bool,
    pub hand: bool,
    pub sharing: bool,
}

struct Conn {
    peer: Peer,
    tx: Sender<Out>,
}

impl Conn {
    fn send(&self, v: Value) {
        let _ = self.tx.send(Out::Text(v.to_string()));
    }
}

#[derive(Default)]
struct Inner {
    peers: Vec<Conn>,
    lobby: Vec<Conn>,
    meeting_id: String,
    title: String,
    recording: bool,
    /// Where the recording being made writes (decided when the host turns it on), and whether a
    /// upload has taken it yet.
    rec_path: Option<PathBuf>,
    rec_claimed: bool,
    rec_started: Option<Instant>,
    rec_base: Option<String>,
    rec_parts: u32,
}

pub struct Room {
    pub code: String,
    inner: Mutex<Inner>,
}

/// What happened to a `hello`.
#[derive(Debug, PartialEq)]
pub enum Hello {
    Joined,
    Lobby,
    Refused,
}

pub fn clean_name(raw: &str) -> String {
    let name: String = raw.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(MAX_NAME).collect();
    if name.is_empty() {
        "Guest".into()
    } else {
        name
    }
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl Room {
    pub fn new(code: &str) -> Room {
        Room { code: code.to_string(), inner: Mutex::new(Inner::default()) }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// (people, waiting, host in, recording)
    pub fn counts(&self) -> (usize, usize, bool, bool) {
        let i = self.lock();
        (i.peers.len(), i.lobby.len(), i.peers.iter().any(|c| c.peer.host), i.recording)
    }

    /// A connection said hello. `host` is whether it proved itself with the host token.
    pub fn hello(&self, hub: &Hub, m: &Stored, id: &str, tx: Sender<Out>, hello: &Value, is_host: bool) -> Hello {
        let peer = Peer {
            id: id.to_string(),
            name: clean_name(hello.get("name").and_then(Value::as_str).unwrap_or("")),
            host: is_host,
            audio: flag(hello, "audio"),
            video: flag(hello, "video"),
            hand: false,
            sharing: false,
        };
        let conn = Conn { peer, tx };
        let mut i = self.lock();
        i.meeting_id = m.id.clone();
        i.title = m.title.clone();
        if i.peers.len() >= MAX_PEOPLE && !is_host {
            conn.send(json!({"t": "full"}));
            return Hello::Refused;
        }
        if m.lobby && !is_host {
            let knock = json!({"t": "knock", "id": id, "name": conn.peer.name});
            let name = conn.peer.name.clone();
            conn.send(json!({"t": "lobby"}));
            i.lobby.push(conn);
            let host_in = i.peers.iter().any(|c| c.peer.host);
            for c in i.peers.iter().filter(|c| c.peer.host) {
                c.send(knock.clone());
            }
            let (mid, title) = (i.meeting_id.clone(), i.title.clone());
            drop(i);
            if !host_in {
                hub.emit("meet-knock", json!({"meetingId": mid, "title": title, "name": name}));
            }
            hub.emit("meet-changed", Value::Null);
            return Hello::Lobby;
        }
        self.admit_locked(hub, &mut i, conn, m);
        // The host sees who was already waiting.
        if is_host {
            let waiting: Vec<Value> = i.lobby.iter().map(|c| json!({"t": "knock", "id": c.peer.id, "name": c.peer.name})).collect();
            if let Some(host) = i.peers.iter().find(|c| c.peer.id == id) {
                for k in waiting {
                    host.send(k);
                }
            }
        }
        drop(i);
        hub.emit("meet-changed", Value::Null);
        Hello::Joined
    }

    fn admit_locked(&self, hub: &Hub, i: &mut Inner, conn: Conn, m: &Stored) {
        let others: Vec<Peer> = i.peers.iter().map(|c| c.peer.clone()).collect();
        let peer = conn.peer.clone();
        for c in &i.peers {
            c.send(json!({"t": "peer-joined", "peer": peer}));
        }
        conn.send(json!({
            "t": "welcome", "id": peer.id, "name": peer.name, "peers": others,
            "meeting": {"title": m.title, "kind": m.kind, "recording": i.recording, "autoRecord": m.auto_record, "lobby": m.lobby},
            "ice": hub.ice(), "host": peer.host,
        }));
        i.peers.push(conn);
    }

    /// A connection went away.
    pub fn leave(&self, hub: &Hub, id: &str) {
        let mut i = self.lock();
        let mut changed = false;
        if let Some(pos) = i.lobby.iter().position(|c| c.peer.id == id) {
            let c = i.lobby.remove(pos);
            for h in i.peers.iter().filter(|c| c.peer.host) {
                h.send(json!({"t": "knock-gone", "id": id, "name": c.peer.name}));
            }
            changed = true;
        }
        if let Some(pos) = i.peers.iter().position(|c| c.peer.id == id) {
            let c = i.peers.remove(pos);
            for o in &i.peers {
                o.send(json!({"t": "peer-left", "id": id}));
            }
            // The recording stops when the host leaves (the host's page makes it).
            if c.peer.host && !i.peers.iter().any(|c| c.peer.host) && i.recording {
                i.recording = false;
                i.rec_path = None;
                for o in &i.peers {
                    o.send(json!({"t": "rec", "on": false}));
                }
            }
            changed = true;
        }
        drop(i);
        if changed {
            hub.emit("meet-changed", Value::Null);
        }
    }

    /// Everyone is told, then every connection closes.
    pub fn end(&self, hub: &Hub) {
        let mut i = self.lock();
        let inner = &mut *i;
        for c in inner.peers.drain(..).chain(inner.lobby.drain(..)) {
            c.send(json!({"t": "ended"}));
            let _ = c.tx.send(Out::Close);
        }
        i.recording = false;
        i.rec_path = None;
        drop(i);
        hub.emit("meet-changed", Value::Null);
    }

    /// A message from a connection that is in (or waiting for) the room.
    pub fn handle(&self, hub: &Hub, m: &Stored, id: &str, v: &Value) {
        let t = v.get("t").and_then(Value::as_str).unwrap_or("");
        let mut i = self.lock();
        let Some(me) = i.peers.iter().position(|c| c.peer.id == id) else { return };
        let is_host = i.peers[me].peer.host;
        match t {
            "signal" => {
                let to = v.get("to").and_then(Value::as_str).unwrap_or("");
                if let Some(c) = i.peers.iter().find(|c| c.peer.id == to && c.peer.id != id) {
                    c.send(json!({"t": "signal", "from": id, "data": v.get("data").cloned().unwrap_or(Value::Null)}));
                }
            }
            "state" => {
                let p = &mut i.peers[me].peer;
                p.audio = flag(v, "audio");
                p.video = flag(v, "video");
                p.hand = flag(v, "hand");
                p.sharing = flag(v, "sharing");
                let msg = json!({"t": "peer-state", "id": id, "audio": p.audio, "video": p.video, "hand": p.hand, "sharing": p.sharing});
                for c in i.peers.iter().filter(|c| c.peer.id != id) {
                    c.send(msg.clone());
                }
            }
            "chat" => {
                let text: String = v.get("text").and_then(Value::as_str).unwrap_or("").chars().filter(|c| !c.is_control() || *c == '\n').take(MAX_CHAT).collect();
                let text = text.trim().to_string();
                if text.is_empty() {
                    return;
                }
                let name = i.peers[me].peer.name.clone();
                let msg = json!({"t": "chat", "from": id, "name": name, "text": text, "at": now_ms()});
                for c in &i.peers {
                    c.send(msg.clone());
                }
                if let (true, Some(path), Some(start)) = (i.recording, i.rec_path.as_ref(), i.rec_started) {
                    let secs = start.elapsed().as_secs();
                    let line = format!("[{:02}:{:02}:{:02}] {}: {}\n", secs / 3600, secs / 60 % 60, secs % 60, name, text.replace('\n', " / "));
                    let chat = chat_path(path);
                    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(chat) {
                        let _ = f.write_all(line.as_bytes());
                    }
                }
            }
            "react" => {
                let emoji: String = v.get("emoji").and_then(Value::as_str).unwrap_or("").chars().take(4).collect();
                if emoji.is_empty() {
                    return;
                }
                let msg = json!({"t": "react", "from": id, "emoji": emoji});
                for c in &i.peers {
                    c.send(msg.clone());
                }
            }
            "admit" | "deny" if is_host => {
                let target = v.get("id").and_then(Value::as_str).unwrap_or("");
                if let Some(pos) = i.lobby.iter().position(|c| c.peer.id == target) {
                    let c = i.lobby.remove(pos);
                    let gone = json!({"t": "knock-gone", "id": target, "name": c.peer.name});
                    for h in i.peers.iter().filter(|c| c.peer.host) {
                        h.send(gone.clone());
                    }
                    if t == "deny" {
                        c.send(json!({"t": "denied"}));
                        let _ = c.tx.send(Out::Close);
                    } else if i.peers.len() >= MAX_PEOPLE {
                        c.send(json!({"t": "full"}));
                        let _ = c.tx.send(Out::Close);
                    } else {
                        c.send(json!({"t": "admitted"}));
                        self.admit_locked(hub, &mut i, c, m);
                    }
                    drop(i);
                    hub.emit("meet-changed", Value::Null);
                }
            }
            "mute" if is_host => {
                let target = v.get("id").and_then(Value::as_str).unwrap_or("");
                if let Some(c) = i.peers.iter().find(|c| c.peer.id == target) {
                    c.send(json!({"t": "mute-request"}));
                }
            }
            "remove" if is_host => {
                let target = v.get("id").and_then(Value::as_str).unwrap_or("");
                if target != id {
                    if let Some(pos) = i.peers.iter().position(|c| c.peer.id == target) {
                        let c = i.peers.remove(pos);
                        c.send(json!({"t": "removed"}));
                        let _ = c.tx.send(Out::Close);
                        for o in &i.peers {
                            o.send(json!({"t": "peer-left", "id": target}));
                        }
                        drop(i);
                        hub.emit("meet-changed", Value::Null);
                    }
                }
            }
            "end" if is_host => {
                drop(i);
                self.end(hub);
                hub.drop_room(&self.code);
            }
            "rec" if is_host => {
                let on = flag(v, "on");
                if on == i.recording {
                    return;
                }
                i.recording = on;
                if on {
                    let path = next_path(hub, &mut i);
                    i.rec_path = Some(path);
                    i.rec_claimed = false;
                    i.rec_started = Some(Instant::now());
                } else {
                    i.rec_path = None;
                }
                for c in &i.peers {
                    c.send(json!({"t": "rec", "on": on}));
                }
                drop(i);
                hub.emit("meet-changed", Value::Null);
            }
            _ => {}
        }
    }

    /// The file the next upload with `seq=0` writes: the one decided when recording started, or
    /// (a second recorder in the same stretch) a new part.
    pub fn claim_path(&self, hub: &Hub) -> (PathBuf, String, String) {
        let mut i = self.lock();
        let path = match (i.rec_path.clone(), i.rec_claimed) {
            (Some(p), false) => p,
            _ => {
                let p = next_path(hub, &mut i);
                i.rec_path = Some(p.clone());
                i.rec_started = Some(Instant::now());
                p
            }
        };
        i.rec_claimed = true;
        (path, i.meeting_id.clone(), i.title.clone())
    }
}

pub fn chat_path(rec: &std::path::Path) -> PathBuf {
    rec.with_extension("chat.txt")
}

/// `Title 2026-11-21 14.30.webm`, then `… (2).webm` for the next part.
fn next_path(hub: &Hub, i: &mut Inner) -> PathBuf {
    let dir = hub.rec_dir();
    let _ = std::fs::create_dir_all(&dir);
    let base = i.rec_base.get_or_insert_with(|| format!("{} {}", super::file_safe(&i.title), super::stamp_for_file(now_ms()))).clone();
    loop {
        i.rec_parts += 1;
        let name = if i.rec_parts == 1 { format!("{base}.webm") } else { format!("{base} ({}).webm", i.rec_parts) };
        let path = dir.join(name);
        if !path.exists() {
            return path;
        }
    }
}
