//! Meet through the real server: two fake clients on WebSockets, the recording upload, the page.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, WebSocket};

use super::*;

#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<(String, Value)>>>);

impl Host for Events {
    fn emit(&self, event: &str, payload: Value) {
        self.0.lock().unwrap().push((event.to_string(), payload));
    }
}

struct Fixture {
    hub: Arc<Hub>,
    port: u16,
    dir: PathBuf,
    events: Events,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture(name: &str) -> Fixture {
    let dir = std::env::temp_dir().join(format!("zazabor-meet-test-{name}-{}", store::new_id()));
    std::fs::create_dir_all(&dir).unwrap();
    let events = Events::default();
    let conn = store::open(&dir.join("meet.db")).unwrap();
    let hub = Hub::new(Box::new(events.clone()), conn, dir.clone(), dir.join("rec")).unwrap();
    let port = hub.ensure_server(0).unwrap();
    Fixture { hub, port, dir, events }
}

fn meeting(f: &Fixture, lobby: bool) -> Meeting {
    f.hub.create("Team: sync/up", "meeting", None, 30, true, lobby, vec![]).unwrap()
}

struct Client {
    ws: WebSocket<TcpStream>,
}

impl Client {
    fn connect(port: u16, code: &str, headers: &[(&str, &str)]) -> Client {
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut req = format!("ws://127.0.0.1:{port}/ws/{code}").into_client_request().unwrap();
        for (k, v) in headers {
            req.headers_mut().insert(tungstenite::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
        }
        let (ws, _) = tungstenite::client(req, stream).unwrap();
        Client { ws }
    }

    fn send(&mut self, v: Value) {
        self.ws.send(Message::text(v.to_string())).unwrap();
    }

    /// The next message of type `t` (others are skipped); None on close or timeout.
    fn expect(&mut self, t: &str) -> Value {
        let end = Instant::now() + Duration::from_secs(6);
        while Instant::now() < end {
            match self.ws.read() {
                Ok(Message::Text(s)) => {
                    let v: Value = serde_json::from_str(s.as_str()).unwrap();
                    if v["t"] == t {
                        return v;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => {}
            }
        }
        panic!("no {t} message");
    }

    /// The messages up to the socket closing.
    fn until_closed(&mut self) -> Vec<String> {
        let mut seen = Vec::new();
        for _ in 0..50 {
            match self.ws.read() {
                Ok(Message::Text(s)) => seen.push(serde_json::from_str::<Value>(s.as_str()).unwrap()["t"].as_str().unwrap().to_string()),
                Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) | Err(tungstenite::Error::AlreadyClosed) => return seen,
                Ok(_) => {}
                Err(_) => return seen,
            }
        }
        panic!("the socket stayed open");
    }
}

fn hello(name: &str, host: Option<&str>) -> Value {
    let mut v = json!({"t": "hello", "name": name, "audio": true, "video": true});
    if let Some(h) = host {
        v["host"] = json!(h);
    }
    v
}

fn http(port: u16, req: &str, body: &[u8]) -> (String, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(req.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut out = Vec::new();
    let _ = s.read_to_end(&mut out);
    let text = String::from_utf8_lossy(&out).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    (head.to_string(), body.to_string())
}

#[test]
fn the_lobby_admits_relays_and_ends() {
    let f = fixture("lobby");
    let m = meeting(&f, true);
    let token = f.hub.host_token().to_string();

    let mut host = Client::connect(f.port, &m.code, &[]);
    host.send(hello("Hosty", Some(&token)));
    let w = host.expect("welcome");
    assert_eq!(w["host"], true);
    assert_eq!(w["peers"], json!([]));
    assert_eq!(w["meeting"]["title"], "Team: sync/up");
    assert_eq!(w["meeting"]["recording"], false);
    assert!(w["ice"].as_array().unwrap().len() >= 2);
    let host_id = w["id"].as_str().unwrap().to_string();

    let mut guest = Client::connect(f.port, &m.code, &[]);
    guest.send(hello("Guesty", None));
    guest.expect("lobby");
    let knock = host.expect("knock");
    assert_eq!(knock["name"], "Guesty");
    let guest_id = knock["id"].as_str().unwrap().to_string();
    assert_eq!(f.hub.list().unwrap()[0].waiting, 1);

    // A guest can't admit itself, or anyone: it isn't in the room yet.
    guest.send(json!({"t": "admit", "id": guest_id}));
    host.send(json!({"t": "admit", "id": guest_id}));
    guest.expect("admitted");
    let gw = guest.expect("welcome");
    assert_eq!(gw["host"], false);
    assert_eq!(gw["peers"][0]["id"], host_id.as_str());
    assert_eq!(gw["peers"][0]["name"], "Hosty");
    assert_eq!(gw["peers"][0]["host"], true);
    host.expect("knock-gone");
    let joined = host.expect("peer-joined");
    assert_eq!(joined["peer"]["id"], guest_id.as_str());

    // Signals are relayed as they are, and only to the one asked.
    let offer = json!({"type": "offer", "sdp": "v=0..."});
    guest.send(json!({"t": "signal", "to": host_id, "data": offer}));
    let s = host.expect("signal");
    assert_eq!((s["from"].as_str(), &s["data"]), (Some(guest_id.as_str()), &offer));

    guest.send(json!({"t": "state", "audio": false, "video": true, "hand": true, "sharing": false}));
    let st = host.expect("peer-state");
    assert_eq!((st["audio"].clone(), st["hand"].clone()), (json!(false), json!(true)));

    guest.send(json!({"t": "chat", "text": "  hello there  "}));
    for c in [&mut host, &mut guest] {
        let chat = c.expect("chat");
        assert_eq!((chat["text"].as_str(), chat["name"].as_str(), chat["from"].as_str()), (Some("hello there"), Some("Guesty"), Some(guest_id.as_str())));
    }
    guest.send(json!({"t": "react", "emoji": "🎉"}));
    assert_eq!(host.expect("react")["emoji"], "🎉");

    host.send(json!({"t": "mute", "id": guest_id}));
    guest.expect("mute-request");
    // Host-only actions from a guest do nothing.
    guest.send(json!({"t": "end"}));
    guest.send(json!({"t": "rec", "on": true}));
    guest.send(json!({"t": "chat", "text": "still here"}));
    assert_eq!(host.expect("chat")["text"], "still here");
    assert!(!f.hub.list().unwrap()[0].recording);

    // A second guest is turned away.
    let mut late = Client::connect(f.port, &m.code, &[]);
    late.send(hello("Late", None));
    late.expect("lobby");
    let k = host.expect("knock");
    host.send(json!({"t": "deny", "id": k["id"]}));
    assert_eq!(late.until_closed(), ["denied"]);

    // Guest leaves, then the host ends the meeting for everyone.
    drop(guest);
    assert_eq!(host.expect("peer-left")["id"], guest_id.as_str());
    let mut guest2 = Client::connect(f.port, &m.code, &[]);
    guest2.send(hello("Two", None));
    guest2.expect("lobby");
    let k2 = host.expect("knock");
    host.send(json!({"t": "admit", "id": k2["id"]}));
    guest2.expect("welcome");
    host.send(json!({"t": "end"}));
    assert_eq!(guest2.until_closed(), ["ended"]);
    assert!(f.events.0.lock().unwrap().iter().any(|(e, _)| e == "meet-changed"));
    assert!(!f.hub.list().unwrap()[0].live);
}

#[test]
fn no_lobby_means_straight_in_and_bad_tokens_are_refused() {
    let f = fixture("nolobby");
    let m = meeting(&f, false);
    let mut a = Client::connect(f.port, &m.code, &[]);
    a.send(hello("  A\u{7}  ", None));
    let wa = a.expect("welcome");
    assert_eq!(wa["name"], "A");
    let mut b = Client::connect(f.port, &m.code, &[]);
    b.send(hello("", None));
    let wb = b.expect("welcome");
    assert_eq!(wb["name"], "Guest");
    assert_eq!(wb["peers"].as_array().unwrap().len(), 1);
    a.expect("peer-joined");

    let mut bad = Client::connect(f.port, &m.code, &[]);
    bad.send(hello("Eve", Some("00")));
    assert_eq!(bad.until_closed(), ["denied"]);

    // A real token that arrives through the tunnel isn't a host.
    let mut tunnelled = Client::connect(f.port, &m.code, &[("cf-connecting-ip", "1.2.3.4")]);
    tunnelled.send(hello("Eve", Some(f.hub.host_token())));
    assert_eq!(tunnelled.until_closed(), ["denied"]);

    let mut unknown = Client::connect(f.port, "zzzzzzzzzz", &[]);
    unknown.send(hello("X", None));
    assert_eq!(unknown.until_closed(), ["error"]);
}

#[test]
fn a_full_room_turns_people_away() {
    let f = fixture("full");
    let m = meeting(&f, false);
    let mut clients = Vec::new();
    for n in 0..room::MAX_PEOPLE {
        let mut c = Client::connect(f.port, &m.code, &[]);
        c.send(hello(&format!("P{n}"), None));
        c.expect("welcome");
        clients.push(c);
    }
    let mut extra = Client::connect(f.port, &m.code, &[]);
    extra.send(hello("One too many", None));
    assert_eq!(extra.until_closed(), ["full"]);
    assert_eq!(f.hub.list().unwrap()[0].people, room::MAX_PEOPLE);
}

#[test]
fn the_page_and_its_info_are_served_with_a_strict_policy() {
    let f = fixture("page");
    let m = meeting(&f, true);
    let (head, body) = http(f.port, &format!("GET /m/{} HTTP/1.1\r\nHost: x\r\n\r\n", m.code), b"");
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    assert!(head.contains("Content-Security-Policy: default-src 'none'; script-src 'self'"));
    assert!(head.contains("Referrer-Policy: no-referrer"));
    assert!(body.contains("room.js"));
    let (head, _) = http(f.port, "GET /m/zzzzzzzzzz HTTP/1.1\r\nHost: x\r\n\r\n", b"");
    assert!(head.starts_with("HTTP/1.1 404"));
    let (head, _) = http(f.port, "GET /assets/room.js HTTP/1.1\r\nHost: x\r\n\r\n", b"");
    assert!(head.contains("text/javascript"));

    let (_, body) = http(f.port, &format!("GET /api/info/{} HTTP/1.1\r\nHost: x\r\n\r\n", m.code), b"");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!((v["title"].as_str(), v["recorded"].clone(), v["lobby"].clone(), v["host"].clone()), (Some("Team: sync/up"), json!(true), json!(true), json!(false)));
    let (_, body) = http(f.port, &format!("GET /api/info/{}?host={} HTTP/1.1\r\nHost: x\r\n\r\n", m.code, f.hub.host_token()), b"");
    let v: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["host"], true);
    assert!(v["hostName"].as_str().is_some_and(|n| !n.is_empty()));
    let (_, body) = http(f.port, &format!("GET /api/info/{}?host={} HTTP/1.1\r\nHost: x\r\ncf-connecting-ip: 1.1.1.1\r\n\r\n", m.code, f.hub.host_token()), b"");
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["host"], false);
}

fn upload(f: &Fixture, code: &str, token: &str, rec: &str, seq: u64, body: &[u8], extra: &str) -> (String, Value) {
    let req = format!("POST /rec/{code}?host={token}&rec={rec}&seq={seq} HTTP/1.1\r\nHost: x\r\n{extra}Content-Length: {}\r\n\r\n", body.len());
    let (head, body) = http(f.port, &req, body);
    (head.lines().next().unwrap().to_string(), serde_json::from_str(&body).unwrap_or(Value::Null))
}

#[test]
fn recording_chunks_append_in_order_and_need_the_host_token() {
    let f = fixture("rec");
    let m = meeting(&f, false);
    let token = f.hub.host_token().to_string();
    let mut host = Client::connect(f.port, &m.code, &[]);
    host.send(hello("Hosty", Some(&token)));
    host.expect("welcome");
    let mut guest = Client::connect(f.port, &m.code, &[]);
    guest.send(hello("G", None));
    guest.expect("welcome");
    host.expect("peer-joined");

    host.send(json!({"t": "rec", "on": true}));
    assert_eq!(guest.expect("rec")["on"], true);
    assert!(f.hub.list().unwrap()[0].recording);
    guest.send(json!({"t": "chat", "text": "for the record"}));
    host.expect("chat");

    let rec = "abcdef0123456789";
    assert!(upload(&f, &m.code, "wrong", rec, 0, b"EVIL", "").0.contains("403"));
    assert!(upload(&f, &m.code, &token, rec, 0, b"EVIL", "cf-connecting-ip: 1.1.1.1\r\n").0.contains("403"));
    assert!(upload(&f, &m.code, &token, "x", 0, b"A", "").0.contains("400"));
    assert!(upload(&f, &m.code, &token, rec, 1, b"B", "").0.contains("404"), "no seq 0 yet");
    let (status, v) = upload(&f, &m.code, &token, rec, 0, &[0x1A, 0x45, 0xDF, 0xA3, 1], "");
    assert!(status.contains("200"), "{status}");
    assert_eq!(v["next"], 1);
    assert_eq!(upload(&f, &m.code, &token, rec, 1, b"-two-", "").1["next"], 2);
    assert!(upload(&f, &m.code, &token, rec, 4, b"gap", "").0.contains("409"));
    assert_eq!(upload(&f, &m.code, &token, rec, 1, b"-two-", "").1["next"], 2, "a repeat is ignored");
    assert_eq!(upload(&f, &m.code, &token, rec, 2, b"-three", "").1["next"], 3);
    // Too big a chunk is refused before it is read.
    let (status, _) = http(f.port, &format!("POST /rec/{}?host={token}&rec={rec}&seq=3 HTTP/1.1\r\nContent-Length: {}\r\n\r\n", m.code, server::MAX_CHUNK + 1), b"");
    assert!(status.contains("413"), "{status}");

    let recs = f.hub.recordings().unwrap();
    assert_eq!(recs.len(), 1);
    let path = PathBuf::from(&recs[0].path);
    assert!(path.starts_with(f.dir.join("rec")));
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("Team sync up 20") && name.ends_with(".webm"), "{name}");
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(bytes, [&[0x1A, 0x45, 0xDF, 0xA3, 1][..], b"-two-", b"-three"].concat());
    assert_eq!(recs[0].bytes, bytes.len() as i64);
    let chat = std::fs::read_to_string(room::chat_path(&path)).unwrap();
    assert!(chat.contains("] G: for the record\n"), "{chat}");

    // Pausing and resuming starts the next part.
    host.send(json!({"t": "rec", "on": false}));
    guest.expect("rec");
    host.send(json!({"t": "rec", "on": true}));
    guest.expect("rec");
    assert!(upload(&f, &m.code, &token, "fedcba9876543210", 0, b"part2", "").0.contains("200"));
    let recs = f.hub.recordings().unwrap();
    assert_eq!(recs.len(), 2);
    assert!(recs.iter().any(|r| r.path.ends_with("(2).webm")));

    // Leaving stops it.
    drop(host);
    assert_eq!(guest.expect("rec")["on"], false);
    let r = recs.iter().find(|r| r.path.ends_with("(2).webm")).unwrap();
    f.hub.delete_recording(&r.id).unwrap();
    assert!(!PathBuf::from(&r.path).exists());
    assert_eq!(f.hub.recordings().unwrap().len(), 1);
}

#[test]
fn meetings_list_in_the_right_order_and_live_ones_cannot_be_deleted() {
    let f = fixture("list");
    let now = now_ms();
    let past = f.hub.create("Past", "meeting", Some(now - 86_400_000), 30, true, true, vec![]).unwrap();
    let soon = f.hub.create("Soon", "meeting", Some(now + 3_600_000), 30, true, true, vec![InviteeIn { email: "a@b.co".into(), name: "A".into() }]).unwrap();
    let later = f.hub.create("Later", "call", Some(now + 7_200_000), 0, false, false, vec![]).unwrap();
    let titles: Vec<String> = f.hub.list().unwrap().into_iter().map(|m| m.title).collect();
    assert_eq!(titles, ["Soon", "Later", "Past"]);
    assert!(f.hub.create("x", "meeting", None, 30, true, true, vec![InviteeIn { email: "nope".into(), name: String::new() }]).is_err());
    let again = f.hub.update(&soon.id, "Soon!", "meeting", soon.starts_at, 30, true, true, vec![InviteeIn { email: "A@B.co".into(), name: "A".into() }, InviteeIn { email: "c@d.co".into(), name: String::new() }]).unwrap();
    assert_eq!((again.title.as_str(), again.invitees.len()), ("Soon!", 2));
    assert_eq!(later.kind, "call");

    let mut c = Client::connect(f.port, &past.code, &[]);
    c.send(hello("A", None));
    c.expect("lobby");
    assert!(f.hub.delete(&past.id).unwrap_err().contains("live"));
    f.hub.end(&past.id).unwrap();
    assert_eq!(c.until_closed(), ["ended"]);
    f.hub.delete(&past.id).unwrap();
    assert_eq!(f.hub.list().unwrap().len(), 2);
}

#[test]
fn settings_are_checked_and_reach_the_pages() {
    let f = fixture("settings");
    assert_eq!(f.hub.state().stun.len(), 2);
    assert!(f.hub.set_settings(vec!["http://nope".into()], None).is_err());
    assert!(f.hub.set_settings(vec![], Some(Turn { url: "http://x".into(), username: "u".into(), credential: "c".into() })).is_err());
    let s = f.hub.set_settings(vec![" stun:a.example:3478 ".into(), "".into()], Some(Turn { url: "turn:t.example:3478".into(), username: "u".into(), credential: "c".into() })).unwrap();
    assert_eq!(s.stun, ["stun:a.example:3478"]);
    assert_eq!(f.hub.ice(), json!([{"urls": ["stun:a.example:3478"]}, {"urls": ["turn:t.example:3478"], "username": "u", "credential": "c"}]));
}

#[test]
fn names_and_file_names_are_cleaned() {
    assert_eq!(file_safe("a/b: c*d?"), "a b c d");
    assert_eq!(file_safe("../.hidden"), "hidden");
    assert_eq!(file_safe("   "), "Meeting");
    assert_eq!(room::clean_name("  \u{0}Ann\n "), "Ann");
    assert_eq!(room::clean_name(&"x".repeat(100)).len(), room::MAX_NAME);
    assert!(stamp_for_file(now_ms()).len() == 16);
    assert!(when_text(0).contains("1970") || when_text(0).contains("1969"));
}

/// For the browser checks: serves a meeting until `MEET_LINGER` seconds pass (default 600) and
/// writes `{host, guest, dir}` to `MEET_OUT`. `cargo test --lib meet::tests::serve -- --ignored --nocapture`
#[test]
#[ignore]
fn serve() {
    let dir = std::env::temp_dir().join(format!("zazabor-meet-serve-{}", store::new_id()));
    let events = Events::default();
    let conn = store::open(&dir.join("meet.db")).unwrap();
    let hub = Hub::new(Box::new(events), conn, dir.clone(), dir.join("recordings")).unwrap();
    let port = hub.ensure_server(0).unwrap();
    let m = hub.create("E2E check", "meeting", None, 30, true, true, vec![]).unwrap();
    let info = json!({
        "host": hub.host_url(&m.id).unwrap(),
        "guest": format!("http://127.0.0.1:{port}/m/{}", m.code),
        "dir": dir.join("recordings"),
        "port": port,
    });
    println!("{info}");
    if let Some(out) = std::env::var_os("MEET_OUT") {
        std::fs::write(out, info.to_string()).unwrap();
    }
    let secs = std::env::var("MEET_LINGER").ok().and_then(|s| s.parse().ok()).unwrap_or(600);
    std::thread::sleep(Duration::from_secs(secs));
    let _ = std::fs::remove_dir_all(&dir);
}
