//! Meet: voice calls, group video calls and scheduled meetings hosted by this PC
//! (docs/plans/meet.md). Guests join from a browser link; the audio and video go peer to peer, and
//! this PC serves the meeting page and relays the signalling (`server.rs`, `room.rs`). A Cloudflare
//! quick tunnel (`tunnel.rs`) makes the link reachable from outside the Wi-Fi. The host's own page
//! records the meeting and uploads it here (`/rec`), into ~/Videos/Zazabor Meetings.
//!
//! The `Hub` holds everything and reaches the app only through `Host`, so the tests run it with
//! no window.

pub mod browser;
pub mod invite;
pub mod room;
pub mod server;
pub mod store;
pub mod tunnel;

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use room::Room;
use store::{Fields, Invitee, Recording, Stored};

pub type Result<T> = std::result::Result<T, String>;

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

const DEFAULT_STUN: [&str; 2] = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Turn {
    pub url: String,
    pub username: String,
    pub credential: String,
}

/// A meeting for the page: what's stored plus what the room knows.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub code: String,
    pub title: String,
    pub kind: String,
    pub starts_at: Option<i64>,
    pub minutes: i64,
    pub auto_record: bool,
    pub lobby: bool,
    pub invitees: Vec<Invitee>,
    pub created_at: i64,
    pub live: bool,
    pub host_in: bool,
    pub people: usize,
    pub waiting: usize,
    pub recording: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MeetState {
    pub port: u16,
    pub tunnel: tunnel::Info,
    pub browser: Option<String>,
    pub recordings_dir: String,
    pub stun: Vec<String>,
    pub turn: Option<Turn>,
}

/// What the hub needs from the app.
pub trait Host: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: Value);
    /// A scheduled meeting is about to start (a desktop notification with Start).
    fn starting(&self, _hub: &Arc<Hub>, _m: &Stored) {}
}

/// A recording being written.
struct RecFile {
    code: String,
    id: String,
    path: PathBuf,
    next: u64,
    bytes: i64,
}

pub struct Hub {
    host: Box<dyn Host>,
    db: Mutex<Connection>,
    rooms: Mutex<HashMap<String, Arc<Room>>>,
    recs: Mutex<HashMap<String, Arc<Mutex<RecFile>>>>,
    pub data_dir: PathBuf,
    rec_dir: Mutex<PathBuf>,
    host_token: String,
    port: Mutex<Option<u16>>,
    pub tunnel: Arc<tunnel::Tunnel>,
    notified: Mutex<HashSet<String>>,
}

impl Hub {
    pub fn new(host: Box<dyn Host>, conn: Connection, data_dir: PathBuf, rec_dir: PathBuf) -> Result<Arc<Hub>> {
        store::migrate(&conn)?;
        Ok(Arc::new(Hub {
            host,
            db: Mutex::new(conn),
            rooms: Mutex::new(HashMap::new()),
            recs: Mutex::new(HashMap::new()),
            data_dir,
            rec_dir: Mutex::new(rec_dir),
            host_token: store::hex(&store::random_bytes::<32>()),
            port: Mutex::new(None),
            tunnel: tunnel::Tunnel::new(),
            notified: Mutex::new(HashSet::new()),
        }))
    }

    pub fn with_db<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        f(&mut lock(&self.db))
    }

    pub fn emit(&self, event: &str, payload: Value) {
        self.host.emit(event, payload);
    }

    pub fn changed(&self) {
        self.emit("meet-changed", Value::Null);
    }

    pub fn rec_dir(&self) -> PathBuf {
        lock(&self.rec_dir).clone()
    }

    pub fn is_host_token(&self, token: &str) -> bool {
        let (a, b) = (token.as_bytes(), self.host_token.as_bytes());
        // Compares every byte, so the time taken doesn't tell how much of a guess was right.
        a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    }

    pub fn host_token(&self) -> &str {
        &self.host_token
    }

    /// Starts the server on first use. Returns the port.
    pub fn ensure_server(self: &Arc<Self>, preferred: u16) -> Result<u16> {
        let mut port = lock(&self.port);
        if let Some(p) = *port {
            return Ok(p);
        }
        let p = server::start(self, preferred)?;
        *port = Some(p);
        Ok(p)
    }

    pub fn port(&self) -> Option<u16> {
        *lock(&self.port)
    }

    // ---- rooms

    pub fn room(&self, code: &str) -> Arc<Room> {
        lock(&self.rooms).entry(code.to_string()).or_insert_with(|| Arc::new(Room::new(code))).clone()
    }

    fn existing_room(&self, code: &str) -> Option<Arc<Room>> {
        lock(&self.rooms).get(code).cloned()
    }

    pub fn drop_room(&self, code: &str) {
        lock(&self.rooms).remove(code);
    }

    pub fn meeting_by_code(&self, code: &str) -> Option<Stored> {
        self.with_db(|c| store::by_code(c, code)).ok().flatten()
    }

    /// The STUN and TURN servers the pages are given.
    pub fn ice(&self) -> Value {
        let (stun, turn) = self.ice_settings();
        let mut out: Vec<Value> = stun.iter().map(|u| json!({"urls": [u]})).collect();
        if let Some(t) = turn {
            out.push(json!({"urls": [t.url], "username": t.username, "credential": t.credential}));
        }
        Value::Array(out)
    }

    fn ice_settings(&self) -> (Vec<String>, Option<Turn>) {
        self.with_db(|c| {
            let stun = store::meta(c, "stun").and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok()).unwrap_or_else(|| DEFAULT_STUN.iter().map(|s| s.to_string()).collect());
            let turn = store::meta(c, "turn").and_then(|s| serde_json::from_str::<Turn>(&s).ok());
            Ok((stun, turn))
        })
        .unwrap_or_default()
    }

    // ---- what the page sees

    fn view(&self, m: Stored) -> Meeting {
        let (people, waiting, host_in, recording) = self.existing_room(&m.code).map(|r| r.counts()).unwrap_or((0, 0, false, false));
        Meeting {
            id: m.id, code: m.code, title: m.title, kind: m.kind, starts_at: m.starts_at, minutes: m.minutes, auto_record: m.auto_record, lobby: m.lobby,
            invitees: m.invitees, created_at: m.created_at, live: people > 0, host_in, people, waiting, recording,
        }
    }

    pub fn state(&self) -> MeetState {
        let (stun, turn) = self.ice_settings();
        MeetState {
            port: self.port().unwrap_or(0),
            tunnel: self.tunnel.info(),
            browser: browser::label(),
            recordings_dir: self.rec_dir().to_string_lossy().into_owned(),
            stun,
            turn,
        }
    }

    pub fn list(&self) -> Result<Vec<Meeting>> {
        let now = now_ms();
        let mut all: Vec<Meeting> = self.with_db(|c| store::all(c))?.into_iter().map(|m| self.view(m)).collect();
        let upcoming = |m: &Meeting| m.live || m.starts_at.is_some_and(|t| t + m.minutes.max(30) * 60_000 > now);
        all.sort_by_key(|m| (!upcoming(m), if upcoming(m) { m.starts_at.unwrap_or(0) } else { -m.starts_at.unwrap_or(m.created_at) }));
        Ok(all)
    }

    fn fields(title: &str, kind: &str, starts_at: Option<i64>, minutes: i64, auto_record: bool, lobby: bool, invitees: Vec<InviteeIn>, keep: &[Invitee]) -> Result<Fields> {
        let kind = if kind == "call" { "call" } else { "meeting" };
        let title = title.trim();
        let title: String = if title.is_empty() { if kind == "call" { "Call".into() } else { "Meeting".into() } } else { title.chars().take(120).collect() };
        let mut seen = HashSet::new();
        let mut list = Vec::new();
        for i in invitees {
            let email = i.email.trim().to_string();
            if email.is_empty() {
                continue;
            }
            if !email.contains('@') || email.contains(char::is_whitespace) {
                return Err(format!("“{email}” isn't an email address."));
            }
            if !seen.insert(email.to_lowercase()) {
                continue;
            }
            let old = keep.iter().find(|k| k.email.eq_ignore_ascii_case(&email));
            list.push(Invitee { email, name: i.name.trim().chars().take(80).collect(), sent_at: old.and_then(|o| o.sent_at), error: old.and_then(|o| o.error.clone()) });
        }
        Ok(Fields { title, kind: kind.into(), starts_at, minutes: minutes.clamp(0, 24 * 60), auto_record, lobby, invitees: list })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create(&self, title: &str, kind: &str, starts_at: Option<i64>, minutes: i64, auto_record: bool, lobby: bool, invitees: Vec<InviteeIn>) -> Result<Meeting> {
        let f = Self::fields(title, kind, starts_at, minutes, auto_record, lobby, invitees, &[])?;
        let m = self.with_db(|c| store::create(c, &f, now_ms()))?;
        self.changed();
        Ok(self.view(m))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update(&self, id: &str, title: &str, kind: &str, starts_at: Option<i64>, minutes: i64, auto_record: bool, lobby: bool, invitees: Vec<InviteeIn>) -> Result<Meeting> {
        let old = self.with_db(|c| store::get(c, id))?;
        let f = Self::fields(title, kind, starts_at, minutes, auto_record, lobby, invitees, &old.invitees)?;
        let m = self.with_db(|c| store::update(c, id, &f))?;
        self.changed();
        Ok(self.view(m))
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let m = self.with_db(|c| store::get(c, id))?;
        if let Some(r) = self.existing_room(&m.code) {
            let (people, waiting, ..) = r.counts();
            if people + waiting > 0 {
                return Err("This meeting is live. End it first.".into());
            }
        }
        self.drop_room(&m.code);
        self.with_db(|c| store::delete(c, id))?;
        self.changed();
        Ok(())
    }

    pub fn end(&self, id: &str) -> Result<()> {
        let m = self.with_db(|c| store::get(c, id))?;
        if let Some(r) = self.existing_room(&m.code) {
            r.end(self);
            self.drop_room(&m.code);
        }
        Ok(())
    }

    /// The link guests use: the tunnel's address. Starts the tunnel if it's off and waits up to 20 s.
    pub fn join_url(self: &Arc<Self>, id: &str) -> Result<String> {
        let m = self.with_db(|c| store::get(c, id))?;
        let port = self.ensure_server(server::PREFERRED_PORT)?;
        if !self.tunnel.wanted() {
            self.start_tunnel(port);
        }
        let base = self.tunnel.wait_on(Duration::from_secs(20))?;
        Ok(format!("{base}/m/{}", m.code))
    }

    fn start_tunnel(self: &Arc<Self>, port: u16) {
        let hub = self.clone();
        self.tunnel.start(port, self.data_dir.clone(), Arc::new(move || hub.changed()));
    }

    pub fn set_tunnel(self: &Arc<Self>, on: bool) -> Result<MeetState> {
        let port = self.ensure_server(server::PREFERRED_PORT)?;
        if on {
            self.start_tunnel(port);
        } else {
            if self.list()?.iter().any(|m| m.live) {
                return Err("A meeting is live. End it before turning the tunnel off.".into());
            }
            self.tunnel.stop();
            self.changed();
        }
        Ok(self.state())
    }

    pub fn set_settings(&self, stun: Vec<String>, turn: Option<Turn>) -> Result<MeetState> {
        let stun: Vec<String> = stun.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        for s in &stun {
            if !(s.starts_with("stun:") || s.starts_with("stuns:")) {
                return Err(format!("“{s}” isn't a STUN address (it starts with stun:)."));
            }
        }
        let turn = turn.filter(|t| !t.url.trim().is_empty());
        if let Some(t) = &turn {
            if !(t.url.starts_with("turn:") || t.url.starts_with("turns:")) {
                return Err("The TURN address starts with turn: or turns:.".into());
            }
        }
        self.with_db(|c| {
            store::set_meta(c, "stun", &serde_json::to_string(&stun).map_err(|e| e.to_string())?)?;
            store::set_meta(c, "turn", &turn.as_ref().map(|t| serde_json::to_string(t).unwrap_or_default()).unwrap_or_default())
        })?;
        self.changed();
        Ok(self.state())
    }

    pub fn host_url(self: &Arc<Self>, id: &str) -> Result<String> {
        let m = self.with_db(|c| store::get(c, id))?;
        let port = self.ensure_server(server::PREFERRED_PORT)?;
        Ok(format!("http://127.0.0.1:{port}/m/{}?host={}", m.code, self.host_token))
    }

    pub fn open(self: &Arc<Self>, id: &str) -> Result<()> {
        let url = self.host_url(id)?;
        browser::open(&url, &self.data_dir.join("meet-browser"))
    }

    // ---- recordings

    pub fn recordings(&self) -> Result<Vec<Recording>> {
        self.with_db(|c| store::recordings(c))
    }

    pub fn delete_recording(&self, id: &str) -> Result<()> {
        let r = self.with_db(|c| store::recording(c, id))?;
        let path = PathBuf::from(&r.path);
        // Only files in the recordings folder are ours to delete.
        if path.parent() == Some(self.rec_dir().as_path()) {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(room::chat_path(&path));
        }
        lock(&self.recs).remove(id);
        self.with_db(|c| store::delete_recording(c, id))?;
        self.changed();
        Ok(())
    }

    /// Appends a chunk of the host page's recording. Returns the next sequence number expected.
    pub fn rec_append(&self, code: &str, rec: &str, seq: u64, body: &[u8]) -> std::result::Result<u64, (&'static str, String)> {
        if rec.len() < 8 || rec.len() > 40 || !rec.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(("400 Bad Request", "bad recording id".into()));
        }
        let file = {
            let mut recs = lock(&self.recs);
            if let Some(f) = recs.get(rec) {
                f.clone()
            } else if seq == 0 {
                let m = self.meeting_by_code(code).ok_or(("404 Not Found", "no such meeting".to_string()))?;
                let (path, meeting_id, title) = self.room(code).claim_path(self);
                std::fs::File::create(&path).map_err(|e| ("500 Internal Server Error", e.to_string()))?;
                let now = now_ms();
                let row = Recording { id: rec.to_string(), meeting_id: if meeting_id.is_empty() { m.id } else { meeting_id }, title, path: path.to_string_lossy().into_owned(), started_at: now, ended_at: None, bytes: 0 };
                self.with_db(|c| store::add_recording(c, &row)).map_err(|e| ("500 Internal Server Error", e))?;
                let f = Arc::new(Mutex::new(RecFile { code: code.to_string(), id: rec.to_string(), path, next: 0, bytes: 0 }));
                recs.insert(rec.to_string(), f.clone());
                f
            } else {
                return Err(("404 Not Found", "unknown recording".into()));
            }
        };
        let mut f = lock(&file);
        if f.code != code {
            return Err(("403 Forbidden", "wrong meeting".into()));
        }
        if seq < f.next {
            return Ok(f.next);
        }
        if seq > f.next {
            return Err(("409 Conflict", format!("expected {}", f.next)));
        }
        let mut out = std::fs::OpenOptions::new().append(true).open(&f.path).map_err(|e| ("500 Internal Server Error", e.to_string()))?;
        out.write_all(body).map_err(|e| ("500 Internal Server Error", e.to_string()))?;
        f.next += 1;
        f.bytes += body.len() as i64;
        let (id, bytes) = (f.id.clone(), f.bytes);
        drop(out);
        let _ = self.with_db(|c| store::grow_recording(c, &id, bytes, now_ms()));
        if seq == 0 || seq % 5 == 0 {
            self.changed();
        }
        Ok(f.next)
    }

    // ---- invitations

    /// Sends the invitations; each invitee's `sentAt` or `error` is set.
    pub fn invite(self: &Arc<Self>, id: &str, account_id: &str, message: &str) -> Result<Vec<Invitee>> {
        let m = self.with_db(|c| store::get(c, id))?;
        if m.invitees.is_empty() {
            return Err("Add someone to invite first.".into());
        }
        let url = self.join_url(id)?;
        let (account_name, account_email) = crate::mail::account_address(account_id)?;
        let host = full_name_or(&account_name);
        let invites = self.send_all(&m, &url, account_id, (&host, &account_email), message, false);
        self.with_db(|c| store::set_invitees(c, id, &invites, Some(&url), Some(account_id)))?;
        self.changed();
        Ok(invites)
    }

    fn send_all(&self, m: &Stored, url: &str, account_id: &str, organizer: (&str, &str), message: &str, starting: bool) -> Vec<Invitee> {
        let when = m.starts_at.map(when_text);
        let mail = invite::compose(m, url, organizer.0, when.as_deref(), message, starting);
        let files = if starting {
            Vec::new()
        } else {
            invite::ics(m, url, organizer, now_ms()).map(|ics| vec![("invite.ics".to_string(), "text/calendar; method=REQUEST; charset=UTF-8".to_string(), ics.into_bytes())]).unwrap_or_default()
        };
        m.invitees
            .iter()
            .map(|i| {
                let mut out = i.clone();
                match crate::mail::send_message(account_id, (&i.name, &i.email), &mail.subject, &mail.html, &mail.text, files.clone()) {
                    Ok(()) => {
                        out.sent_at = Some(now_ms());
                        out.error = None;
                    }
                    Err(e) => out.error = Some(e),
                }
                out
            })
            .collect()
    }

    // ---- scheduled meetings

    /// Every 30 s: five minutes before a meeting, the tunnel is made sure of, the invitees get
    /// the new link if it changed, and the host gets a notification.
    pub fn tick(self: &Arc<Self>) {
        let now = now_ms();
        let Ok(all) = self.with_db(|c| store::all(c)) else { return };
        for m in all {
            let Some(start) = m.starts_at else { continue };
            if now < start - 5 * 60_000 || now > start + m.minutes.max(30) * 60_000 {
                continue;
            }
            let port = match self.ensure_server(server::PREFERRED_PORT) {
                Ok(p) => p,
                Err(_) => continue,
            };
            if !self.tunnel.wanted() {
                self.start_tunnel(port);
            }
            if lock(&self.notified).insert(m.id.clone()) {
                self.host.starting(self, &m);
            }
            let Some(base) = self.tunnel.info().url else { continue };
            let url = format!("{base}/m/{}", m.code);
            if let (false, Some(old), Some(account)) = (m.started_mail, m.invite_url.as_deref(), m.invite_account.as_deref()) {
                if old != url && !m.invitees.is_empty() {
                    if let Ok((name, email)) = crate::mail::account_address(account) {
                        let host = full_name_or(&name);
                        let sent = self.send_all(&m, &url, account, (&host, &email), "", true);
                        let _ = self.with_db(|c| {
                            store::set_invitees(c, &m.id, &sent, None, None)?;
                            store::set_started_mail(c, &m.id, &url)
                        });
                        self.changed();
                    }
                }
            }
        }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct InviteeIn {
    pub email: String,
    #[serde(default)]
    pub name: String,
}

// ---- small helpers shared by the modules

fn local_tm(ms: i64) -> libc::tm {
    let secs = ms.div_euclid(1000) as libc::time_t;
    // SAFETY: `tm` is plain data; localtime_r only writes to it.
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&secs, &mut tm);
        tm
    }
}

/// `2026-11-21 14.30` for a file name.
pub fn stamp_for_file(ms: i64) -> String {
    let tm = local_tm(ms);
    format!("{:04}-{:02}-{:02} {:02}.{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min)
}

/// `Sat 21 Nov 2026, 14:30 (UTC+6)`
pub fn when_text(ms: i64) -> String {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let tm = local_tm(ms);
    let off = tm.tm_gmtoff / 60;
    let zone = if off == 0 { "UTC".to_string() } else { format!("UTC{}{}{}", if off < 0 { '-' } else { '+' }, off.abs() / 60, if off % 60 != 0 { format!(":{:02}", off.abs() % 60) } else { String::new() }) };
    format!("{} {} {} {}, {:02}:{:02} ({zone})", DAYS[tm.tm_wday as usize % 7], tm.tm_mday, MONTHS[tm.tm_mon as usize % 12], tm.tm_year + 1900, tm.tm_hour, tm.tm_min)
}

/// A title as a file name: no slashes or other characters file managers dislike.
pub fn file_safe(title: &str) -> String {
    let s: String = title.chars().map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { ' ' } else { c }).collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let s: String = s.chars().take(60).collect();
    let s = s.trim().trim_start_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if s.is_empty() {
        "Meeting".into()
    } else {
        s
    }
}

/// The system user's full name (the GECOS field), else the login name.
pub fn full_name() -> String {
    full_name_or("Host")
}

fn full_name_or(fallback: &str) -> String {
    let mut buf = vec![0 as libc::c_char; 4096];
    // SAFETY: an all-zero passwd is a valid out-parameter for getpwuid_r.
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: the buffer and out-pointers outlive the call; strings are copied before they drop.
    let rc = unsafe { libc::getpwuid_r(libc::getuid(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result) };
    if rc == 0 && !result.is_null() {
        // SAFETY: on success these point at NUL-terminated strings inside `buf`.
        let gecos = unsafe { std::ffi::CStr::from_ptr(pwd.pw_gecos) }.to_string_lossy().into_owned();
        let name = gecos.split(',').next().unwrap_or("").trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    if fallback.is_empty() { "Host".into() } else { fallback.to_string() }
}

// ---- the app

static HUB: OnceLock<Arc<Hub>> = OnceLock::new();

struct AppHost(AppHandle);

impl Host for AppHost {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.emit(event, payload);
    }

    fn starting(&self, hub: &Arc<Hub>, m: &Stored) {
        let (hub, id) = (hub.clone(), m.id.clone());
        let when = m.starts_at.map(when_text).unwrap_or_default();
        let click: Box<dyn Fn() + Send + 'static> = Box::new(move || {
            let (hub, id) = (hub.clone(), id.clone());
            std::thread::spawn(move || {
                if let Err(e) = hub.open(&id) {
                    eprintln!("Meet: {e}");
                }
            });
        });
        crate::desktop_notify::show(crate::desktop_notify::Note { title: &format!("{} is about to start", m.title), body: &format!("{when}. Click to start the meeting."), icon: "camera-web", category: "x-zazabor.meet", replaces: 0 }, Some(click));
    }
}

/// Opens `meet.db`; the server starts when the page first asks, and a clock watches the scheduled meetings.
pub fn init(app: AppHandle, data_dir: PathBuf) {
    let conn = match store::open(&data_dir.join("meet.db")) {
        Ok(c) => c,
        Err(err) => {
            eprintln!("Meet: {err}");
            return;
        }
    };
    let rec_dir = app.path().video_dir().ok().or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Videos"))).unwrap_or_else(std::env::temp_dir).join("Zazabor Meetings");
    match Hub::new(Box::new(AppHost(app)), conn, data_dir, rec_dir) {
        Ok(hub) => {
            let _ = HUB.set(hub.clone());
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(30));
                hub.tick();
            });
        }
        Err(err) => eprintln!("Meet: {err}"),
    }
}

fn the_hub() -> Result<Arc<Hub>> {
    HUB.get().cloned().ok_or_else(|| "Meet isn't available.".to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce(Arc<Hub>) -> Result<T> + Send + 'static) -> Result<T> {
    crate::ensure_unlocked()?;
    let hub = the_hub()?;
    tauri::async_runtime::spawn_blocking(move || f(hub)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn meet_state() -> Result<MeetState> {
    blocking(|hub| {
        hub.ensure_server(server::PREFERRED_PORT)?;
        Ok(hub.state())
    })
    .await
}

#[tauri::command]
pub async fn meet_list() -> Result<Vec<Meeting>> {
    blocking(|hub| hub.list()).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn meet_create(title: String, kind: String, starts_at: Option<i64>, minutes: i64, auto_record: bool, lobby: bool, invitees: Vec<InviteeIn>) -> Result<Meeting> {
    blocking(move |hub| hub.create(&title, &kind, starts_at, minutes, auto_record, lobby, invitees)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn meet_update(id: String, title: String, kind: String, starts_at: Option<i64>, minutes: i64, auto_record: bool, lobby: bool, invitees: Vec<InviteeIn>) -> Result<Meeting> {
    blocking(move |hub| hub.update(&id, &title, &kind, starts_at, minutes, auto_record, lobby, invitees)).await
}

#[tauri::command]
pub async fn meet_delete(id: String) -> Result<()> {
    blocking(move |hub| hub.delete(&id)).await
}

#[tauri::command]
pub async fn meet_join_url(id: String) -> Result<String> {
    blocking(move |hub| hub.join_url(&id)).await
}

#[tauri::command]
pub async fn meet_open(id: String) -> Result<()> {
    blocking(move |hub| hub.open(&id)).await
}

#[tauri::command]
pub async fn meet_invite(id: String, account_id: String, message: String) -> Result<Vec<Invitee>> {
    blocking(move |hub| hub.invite(&id, &account_id, &message)).await
}

#[tauri::command]
pub async fn meet_end(id: String) -> Result<()> {
    blocking(move |hub| hub.end(&id)).await
}

#[tauri::command]
pub async fn meet_recordings() -> Result<Vec<Recording>> {
    blocking(|hub| hub.recordings()).await
}

#[tauri::command]
pub async fn meet_recording_delete(id: String) -> Result<()> {
    blocking(move |hub| hub.delete_recording(&id)).await
}

#[tauri::command]
pub async fn meet_tunnel(on: bool) -> Result<MeetState> {
    blocking(move |hub| hub.set_tunnel(on)).await
}

#[tauri::command]
pub async fn meet_settings(stun: Vec<String>, turn: Option<Turn>) -> Result<MeetState> {
    blocking(move |hub| hub.set_settings(stun, turn)).await
}

#[cfg(test)]
mod tests;
