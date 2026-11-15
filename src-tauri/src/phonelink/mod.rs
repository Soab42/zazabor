//! Phone Link: a paired Android phone on the PC, like Windows' Phone Link
//! (docs/plans/phone-link.md). The Wi-Fi link lives in `link.rs`, the cache in `store.rs`, file
//! transfers in `xfer.rs`; Bluetooth calls in `hfp/`.
//!
//! This is the hub: one `Hub` holds the listener, the connected phones, the pairing on screen and
//! the transfers, and turns what phones send into events for the page (`phone-*`). It reaches the
//! app only through `Host`, so the tests run it with no window.
//!
//! The page's settings (`config.json` → `phone`: `downloadDir`, `notify`, `mirrorNotifs`, `clip`,
//! and an optional `pcName`) are read from the file when they're needed, the way Mail does it.
//! `phone_link_enable` writes `phone.enabled` there too, and the page should set it in its own
//! copy of the config so its next save keeps it.

pub mod hfp;
pub mod link;
pub mod store;
pub mod xfer;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use link::Link;
use xfer::Transfer;

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Where files sent to the phone go when no folder is given (relative to its main storage).
pub const PHONE_DOWNLOADS: &str = "Download/Zazabor";

/// What the page configures, as the hub needs it.
#[derive(Clone, Debug, Default)]
pub struct Settings {
    pub pc_name: String,
    pub download_dir: PathBuf,
    /// Desktop notifications for new texts.
    pub notify: bool,
    /// Desktop notifications for the phone's own notifications.
    pub mirror_notifs: bool,
    /// Clipboard sharing (also needs turning on per phone).
    pub clip: bool,
}

/// What the hub needs from the app.
pub trait Host: Send + Sync + 'static {
    /// Tells every window.
    fn emit(&self, event: &str, payload: Value);
    fn settings(&self) -> Settings;
    /// Shows a desktop notification; clicking it asks the page to open `open`
    /// (`phone-open` → `{phoneId, tab, threadId?, key?}`).
    fn desktop(&self, _title: &str, _body: &str, _icon: &str, _open: Value) {}
    /// The phone shared its clipboard.
    fn set_clipboard(&self, _text: &str) {}
}

/// The link's clocks (shorter in the tests).
#[derive(Clone, Debug)]
pub struct Timing {
    /// Ping after this long without sending anything.
    pub ping: Duration,
    /// Hang up after this long without hearing anything.
    pub dead: Duration,
    /// How long a request waits for its answer.
    pub request: Duration,
    /// …and one that lists files or photos.
    pub listing: Duration,
    /// How long a download may go without a byte before it fails.
    pub stall: Duration,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing { ping: Duration::from_secs(10), dead: Duration::from_secs(30), request: Duration::from_secs(15), listing: Duration::from_secs(60), stall: Duration::from_secs(60) }
    }
}

/// A phone, for the page.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Phone {
    pub phone_id: String,
    pub name: String,
    pub model: String,
    /// What the phone calls itself (its Bluetooth name).
    pub device_name: String,
    pub connected: bool,
    pub last_seen: i64,
    pub battery: Option<i64>,
    pub charging: bool,
    pub signal: Option<i64>,
    pub network: Option<String>,
    pub carrier: Option<String>,
    pub wifi: Option<String>,
    pub caps: Vec<String>,
    pub unread_sms: i64,
    pub notif_count: usize,
    /// Clipboard sharing with this phone.
    pub clip: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub phone_id: String,
    pub name: String,
    /// "482 913"; empty until the keys are agreed.
    pub code: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PhoneState {
    pub enabled: bool,
    pub port: Option<u16>,
    pub pc_name: String,
    /// The PC's addresses on the local network, for typing into the phone when it can't find the PC.
    pub addresses: Vec<String>,
    pub phones: Vec<Phone>,
    pub pairing: Option<PairingInfo>,
    pub clip: bool,
}

/// What a connected phone told the PC lately.
#[derive(Default)]
struct Live {
    status: Value,
    notifs: Vec<Value>,
}

struct Pairing {
    info: PairingInfo,
    answer: mpsc::Sender<bool>,
    /// Which attempt owns it: a stale connection from the same phone mustn't end a newer one.
    attempt: u64,
}

static PAIRING_ATTEMPT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub struct Hub {
    host: Box<dyn Host>,
    db: Mutex<Connection>,
    pub pc_id: String,
    pub timing: Timing,
    pub transfers: xfer::Transfers,
    listener: Mutex<Option<link::Listener>>,
    links: Mutex<HashMap<String, Arc<Link>>>,
    live: Mutex<HashMap<String, Live>>,
    pairing: Mutex<Option<Pairing>>,
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

/// A thumbnail or photo the phone sent as base64, as a `data:` URL.
fn data_url(mime: &str, b64: Option<&str>) -> Option<String> {
    b64.filter(|b| !b.is_empty()).map(|b| if b.starts_with("data:") { b.to_string() } else { format!("data:{mime};base64,{b}") })
}

/// Apps whose notifications are texts the link already shows (so they aren't shown twice).
const SMS_APPS: [&str; 4] = ["com.google.android.apps.messaging", "com.samsung.android.messaging", "com.android.mms", "com.android.messaging"];

impl Hub {
    pub fn new(host: Box<dyn Host>, conn: Connection, timing: Timing) -> Result<Arc<Hub>, String> {
        store::migrate(&conn)?;
        let pc_id = store::pc_id(&conn)?;
        Ok(Arc::new(Hub {
            host,
            db: Mutex::new(conn),
            pc_id,
            timing,
            transfers: xfer::Transfers::new(),
            listener: Mutex::new(None),
            links: Mutex::new(HashMap::new()),
            live: Mutex::new(HashMap::new()),
            pairing: Mutex::new(None),
        }))
    }

    pub fn with_db<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
        f(&mut lock(&self.db))
    }

    /// The name phones see: the one set with `set_pc_name` (kept in phone.db), or the page's
    /// default ("Zazabor on ‹hostname›").
    pub fn pc_name(&self) -> String {
        self.with_db(|c| store::pc_name(c)).ok().flatten().unwrap_or_else(|| self.host.settings().pc_name)
    }

    /// Renames the PC for phones (empty = the default); the mDNS advert follows when it's on.
    pub fn set_pc_name(&self, name: &str) -> Result<(), String> {
        let name: String = name.trim().chars().take(63).collect();
        self.with_db(|c| store::set_pc_name(c, &name))?;
        self.emit_changed();
        Ok(())
    }

    pub fn download_dir(&self) -> PathBuf {
        self.host.settings().download_dir
    }

    fn emit(&self, event: &str, payload: Value) {
        self.host.emit(event, payload);
    }

    pub fn emit_changed(&self) {
        let state = self.state();
        self.emit("phone-changed", serde_json::to_value(state).unwrap_or_default());
    }

    pub(crate) fn transfer_changed(&self, t: &Transfer) {
        self.emit("phone-transfer", serde_json::to_value(t).unwrap_or_default());
    }

    // ---- the listener

    /// Starts listening on `host` (port `link::PORT` or the next free one; 0 = any). Returns the port.
    pub fn start(self: &Arc<Self>, host: &str, port: u16) -> Result<u16, String> {
        if let Some(l) = lock(&self.listener).as_ref() {
            return Ok(l.port);
        }
        let listener = link::listen(self, host, port)?;
        let port = listener.port;
        *lock(&self.listener) = Some(listener);
        Ok(port)
    }

    /// Stops listening and hangs up on every phone.
    pub fn stop(&self) {
        if let Some(l) = lock(&self.listener).take() {
            l.stop();
        }
        let links: Vec<Arc<Link>> = lock(&self.links).values().cloned().collect();
        for l in links {
            l.close();
        }
        if let Some(p) = lock(&self.pairing).take() {
            let _ = p.answer.send(false);
        }
    }

    pub fn port(&self) -> Option<u16> {
        lock(&self.listener).as_ref().map(|l| l.port)
    }

    // ---- pairing (called by the handshake)

    /// A phone wants to pair: returns where the user's answer will arrive, or None while another
    /// phone is pairing.
    /// Starts showing a pairing; returns the attempt's number (for `end_pairing`) and the user's answers.
    pub(crate) fn begin_pairing(&self, phone_id: &str, name: &str) -> Option<(u64, mpsc::Receiver<bool>)> {
        let mut pairing = lock(&self.pairing);
        if pairing.as_ref().is_some_and(|p| p.info.phone_id != phone_id) {
            return None;
        }
        let (tx, rx) = mpsc::channel();
        let name = if name.trim().is_empty() { "Android phone".to_string() } else { name.trim().to_string() };
        let attempt = PAIRING_ATTEMPT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        *pairing = Some(Pairing { info: PairingInfo { phone_id: phone_id.into(), name, code: String::new() }, answer: tx, attempt });
        Some((attempt, rx))
    }

    /// The keys are agreed: show the code.
    pub(crate) fn show_pairing(&self, phone_id: &str, code: String) {
        let info = {
            let mut pairing = lock(&self.pairing);
            let Some(p) = pairing.as_mut().filter(|p| p.info.phone_id == phone_id) else { return };
            p.info.code = code;
            p.info.clone()
        };
        self.emit("phone-pair", serde_json::to_value(&info).unwrap_or_default());
        self.emit_changed();
    }

    pub(crate) fn pairing_name(&self, phone_id: &str) -> String {
        lock(&self.pairing).as_ref().filter(|p| p.info.phone_id == phone_id).map(|p| p.info.name.clone()).unwrap_or_else(|| "Android phone".into())
    }

    pub(crate) fn end_pairing(&self, phone_id: &str, attempt: u64) {
        let ended = {
            let mut pairing = lock(&self.pairing);
            if pairing.as_ref().is_some_and(|p| p.info.phone_id == phone_id && p.attempt == attempt) {
                *pairing = None;
                true
            } else {
                false
            }
        };
        if ended {
            self.emit_changed();
        }
    }

    /// The user answered "Does your phone show 482 913?".
    pub fn pair_answer(&self, phone_id: &str, accept: bool) -> Result<(), String> {
        let pairing = lock(&self.pairing);
        let p = pairing.as_ref().filter(|p| p.info.phone_id == phone_id).ok_or("That phone isn't pairing any more.")?;
        p.answer.send(accept).map_err(|_| "That phone isn't pairing any more.".to_string())
    }

    // ---- connections (called by the link)

    pub fn link(&self, phone_id: &str) -> Option<Arc<Link>> {
        lock(&self.links).get(phone_id).filter(|l| !l.is_closed()).cloned()
    }

    fn need(&self, phone_id: &str) -> Result<Arc<Link>, String> {
        self.link(phone_id).ok_or_else(|| "The phone isn't connected. Open Zazabor Link on it, on the same Wi-Fi.".to_string())
    }

    pub fn is_connected(&self, phone_id: &str) -> bool {
        self.link(phone_id).is_some()
    }

    fn caps_of(hello: &Value) -> Vec<String> {
        hello.get("caps").and_then(Value::as_array).map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect()).unwrap_or_default()
    }

    /// A phone proved itself with `hello`.
    pub(crate) fn connected(self: &Arc<Self>, link: &Arc<Link>, hello: &Value) {
        let id = link.phone_id.clone();
        let caps = Self::caps_of(hello);
        let _ = self.with_db(|c| store::seen(c, &id, &str_of(hello, "name").unwrap_or_default(), &str_of(hello, "model").unwrap_or_default(), &caps, crate::notes::now()));
        if let Some(old) = lock(&self.links).insert(id.clone(), link.clone()) {
            old.close();
        }
        lock(&self.live).entry(id.clone()).or_default();
        self.emit_changed();
        // Fill the cache from the phone, off the reader thread.
        let hub = self.clone();
        std::thread::spawn(move || hub.refresh(&id, &caps));
    }

    /// Fetches the lists the phone may share, for the cache.
    fn refresh(&self, phone_id: &str, caps: &[String]) {
        let has = |c: &str| caps.iter().any(|x| x == c);
        let mut fetched = Vec::new();
        if has("sms") && self.fetch_threads(phone_id).is_ok() {
            fetched.push("threads");
        }
        if has("calls") && self.fetch_calls(phone_id).is_ok() {
            fetched.push("calls");
        }
        if has("contacts") && self.fetch_contacts(phone_id).is_ok() {
            fetched.push("contacts");
        }
        if has("notifications") && self.fetch_notifs(phone_id).is_ok() {
            fetched.push("notifs");
        }
        for what in fetched {
            self.emit("phone-synced", json!({"phoneId": phone_id, "what": what}));
        }
        self.emit_changed();
    }

    pub(crate) fn disconnected(&self, link: &Arc<Link>) {
        let id = &link.phone_id;
        let gone = {
            let mut links = lock(&self.links);
            if links.get(id).is_some_and(|l| Arc::ptr_eq(l, link)) {
                links.remove(id);
                true
            } else {
                false
            }
        };
        if !gone {
            return;
        }
        lock(&self.live).remove(id);
        let _ = self.with_db(|c| store::touch(c, id, crate::notes::now()));
        self.transfers.phone_gone(self, id);
        self.emit_changed();
    }

    /// File data from the phone.
    pub(crate) fn data(&self, link: &Link, xfer: u32, bytes: &[u8]) {
        self.transfers.data(self, &link.phone_id, xfer, bytes);
    }

    /// A message the phone sent on its own.
    pub(crate) fn message(&self, link: &Link, msg: Value) {
        let id = link.phone_id.as_str();
        let t = msg.get("t").and_then(Value::as_str).unwrap_or("");
        match t {
            "ping" => {}
            "hello" => {
                let caps = Self::caps_of(&msg);
                let _ = self.with_db(|c| store::seen(c, id, &str_of(&msg, "name").unwrap_or_default(), &str_of(&msg, "model").unwrap_or_default(), &caps, crate::notes::now()));
                self.emit_changed();
            }
            "status" => {
                let mut status = msg.clone();
                if let Some(o) = status.as_object_mut() {
                    o.remove("t");
                }
                lock(&self.live).entry(id.into()).or_default().status = status;
                self.emit_changed();
            }
            "sms.new" => self.sms_arrived(id, msg.get("msg").cloned().unwrap_or_default()),
            "notif.posted" => self.notif_posted(id, msg.get("n").cloned().unwrap_or_default()),
            "notif.removed" => {
                let key = msg.get("key").cloned().unwrap_or_default();
                let removed = {
                    let mut live = lock(&self.live);
                    let notifs = &mut live.entry(id.into()).or_default().notifs;
                    let before = notifs.len();
                    notifs.retain(|n| n.get("key") != Some(&key));
                    notifs.len() != before
                };
                self.emit("phone-notif-removed", json!({"phoneId": id, "key": key}));
                if removed {
                    self.emit_changed();
                }
            }
            "call.state" => {
                let mut call = msg.clone();
                if let Some(o) = call.as_object_mut() {
                    o.remove("t");
                    o.insert("phoneId".into(), id.into());
                }
                if str_of(&call, "name").is_none() {
                    let number = str_of(&call, "number").unwrap_or_default();
                    if let Ok(Some(name)) = self.with_db(|c| store::contact_name(c, id, &number)) {
                        call["name"] = name.into();
                    }
                }
                self.emit("phone-call-state", call);
            }
            "file.offer" => self.transfers.offered(self, link, &msg),
            "file.end" => self.transfers.ended(self, id, &msg),
            "xfer.cancel" => self.transfers.cancelled(self, id, &msg),
            "clip" => {
                let on = self.host.settings().clip && self.with_db(|c| store::phone(c, id)).ok().flatten().is_some_and(|p| p.clip);
                if let (true, Some(text)) = (on, msg.get("text").and_then(Value::as_str)) {
                    self.host.set_clipboard(text);
                }
            }
            _ => {
                // A request this PC doesn't know: say so, so the phone doesn't wait.
                if let Some(rid) = msg.get("rid") {
                    let _ = link.send(json!({"t": "re", "rid": rid, "ok": false, "error": format!("This PC doesn't know “{t}”. Update Zazabor Home.")}));
                }
            }
        }
    }

    fn sms_arrived(&self, phone_id: &str, msg: Value) {
        if !msg.is_object() {
            return;
        }
        let _ = self.with_db(|c| store::add_msg(c, phone_id, &msg));
        self.emit("phone-sms", json!({"phoneId": phone_id, "msg": msg}));
        self.emit_changed();
        if msg.get("out").and_then(Value::as_bool) == Some(true) || !self.host.settings().notify {
            return;
        }
        let number = str_of(&msg, "address").unwrap_or_default();
        let from = self.with_db(|c| store::contact_name(c, phone_id, &number)).ok().flatten().unwrap_or(number);
        let body = str_of(&msg, "body").unwrap_or_default();
        let thread = msg.get("threadId").cloned().unwrap_or_default();
        self.host.desktop(&from, &body, "phone", json!({"phoneId": phone_id, "tab": "messages", "threadId": thread}));
    }

    fn notif_posted(&self, phone_id: &str, n: Value) {
        let Some(key) = n.get("key").cloned() else { return };
        let fresh = {
            let mut live = lock(&self.live);
            let notifs = &mut live.entry(phone_id.into()).or_default().notifs;
            match notifs.iter_mut().find(|x| x.get("key") == Some(&key)) {
                Some(old) => {
                    let changed = old.get("title") != n.get("title") || old.get("text") != n.get("text");
                    *old = n.clone();
                    changed
                }
                None => {
                    notifs.insert(0, n.clone());
                    true
                }
            }
        };
        self.emit("phone-notif", json!({"phoneId": phone_id, "n": n}));
        self.emit_changed();
        let settings = self.host.settings();
        let app = str_of(&n, "app").unwrap_or_default();
        if !fresh || !settings.mirror_notifs || (settings.notify && SMS_APPS.contains(&app.as_str())) {
            return;
        }
        let title = match (str_of(&n, "appName"), str_of(&n, "title")) {
            (Some(a), Some(t)) => format!("{t} · {a}"),
            (a, t) => t.or(a).unwrap_or_else(|| "Phone".into()),
        };
        self.host.desktop(&title, &str_of(&n, "text").unwrap_or_default(), "phone", json!({"phoneId": phone_id, "tab": "notifications", "key": key}));
    }

    // ---- what the page asks for

    pub fn state(&self) -> PhoneState {
        let settings = self.host.settings();
        let paired = self.with_db(|c| store::phones(c)).unwrap_or_default();
        let phones = paired
            .into_iter()
            .map(|p| {
                let connected = self.is_connected(&p.phone_id);
                let (status, notif_count) = lock(&self.live).get(&p.phone_id).map(|l| (l.status.clone(), l.notifs.len())).unwrap_or_default();
                let unread_sms = self.with_db(|c| store::unread(c, &p.phone_id)).unwrap_or(0);
                Phone {
                    connected,
                    last_seen: if connected { crate::notes::now() } else { p.last_seen },
                    battery: status.get("battery").and_then(Value::as_i64),
                    charging: status.get("charging").and_then(Value::as_bool).unwrap_or(false),
                    signal: status.get("signal").and_then(Value::as_i64),
                    network: str_of(&status, "network"),
                    carrier: str_of(&status, "carrier"),
                    wifi: str_of(&status, "wifi"),
                    caps: p.caps,
                    unread_sms,
                    notif_count,
                    clip: p.clip,
                    phone_id: p.phone_id,
                    name: p.name,
                    model: p.model,
                    device_name: p.device_name,
                }
            })
            .collect();
        PhoneState { enabled: self.port().is_some(), port: self.port(), pc_name: self.pc_name(), addresses: if self.port().is_some() { crate::wallet::sync_net::local_addresses() } else { Vec::new() }, phones, pairing: lock(&self.pairing).as_ref().map(|p| p.info.clone()), clip: settings.clip }
    }

    fn paired(&self, phone_id: &str) -> Result<store::Paired, String> {
        self.with_db(|c| store::phone(c, phone_id))?.ok_or_else(|| "That phone isn't paired.".to_string())
    }

    pub fn forget(&self, phone_id: &str) -> Result<(), String> {
        if let Some(link) = lock(&self.links).remove(phone_id) {
            link.close();
        }
        lock(&self.live).remove(phone_id);
        self.transfers.phone_gone(self, phone_id);
        self.with_db(|c| store::forget(c, phone_id))?;
        self.emit_changed();
        Ok(())
    }

    pub fn rename(&self, phone_id: &str, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Give the phone a name.".into());
        }
        self.with_db(|c| store::rename(c, phone_id, name))?;
        self.emit_changed();
        Ok(())
    }

    fn fetch_threads(&self, phone_id: &str) -> Result<Vec<Value>, String> {
        let answer = self.need(phone_id)?.request(json!({"t": "sms.threads", "limit": 300}), self.timing.request)?;
        let threads = answer.get("threads").and_then(Value::as_array).cloned().unwrap_or_default();
        self.with_db(|c| store::save_threads(c, phone_id, &threads, crate::notes::now()))?;
        self.with_db(|c| store::threads(c, phone_id))
    }

    /// Threads, newest first: fresh from the phone when it's connected, otherwise the cache.
    pub fn threads(&self, phone_id: &str) -> Result<Vec<Value>, String> {
        self.paired(phone_id)?;
        if self.is_connected(phone_id) {
            match self.fetch_threads(phone_id) {
                Ok(t) => return Ok(t),
                Err(e) => eprintln!("Phone Link: threads: {e}"),
            }
        }
        self.with_db(|c| store::threads(c, phone_id))
    }

    /// A thread's messages (oldest first), the 50 before `before` (or the newest 50). Opening the
    /// newest page marks the thread read.
    pub fn thread(self: &Arc<Self>, phone_id: &str, thread_id: Value, before: Option<i64>) -> Result<Vec<Value>, String> {
        self.paired(phone_id)?;
        let key = match &thread_id {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        if let Some(link) = self.link(phone_id) {
            match link.request(json!({"t": "sms.thread", "threadId": thread_id, "before": before, "limit": 50}), self.timing.request) {
                Ok(answer) => {
                    let msgs = answer.get("msgs").and_then(Value::as_array).cloned().unwrap_or_default();
                    self.with_db(|c| store::save_msgs(c, phone_id, &msgs))?;
                }
                Err(e) => eprintln!("Phone Link: thread: {e}"),
            }
            if before.is_none() {
                let _ = self.with_db(|c| store::thread_read(c, phone_id, &key));
                let hub = self.clone();
                std::thread::spawn(move || {
                    let _ = link.request(json!({"t": "sms.read", "threadId": thread_id}), hub.timing.request);
                    hub.emit_changed();
                });
            }
        }
        self.with_db(|c| store::msgs(c, phone_id, &key, before, 50))
    }

    pub fn sms_send(&self, phone_id: &str, to: Vec<String>, body: &str) -> Result<(), String> {
        let to: Vec<String> = to.into_iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
        if to.is_empty() {
            return Err("Who's it to?".into());
        }
        if body.trim().is_empty() {
            return Err("Write something first.".into());
        }
        self.need(phone_id)?.request(json!({"t": "sms.send", "to": to, "body": body}), self.timing.request)?;
        Ok(())
    }

    fn fetch_calls(&self, phone_id: &str) -> Result<Vec<Value>, String> {
        let answer = self.need(phone_id)?.request(json!({"t": "calls.list", "limit": 300}), self.timing.request)?;
        let calls = answer.get("calls").and_then(Value::as_array).cloned().unwrap_or_default();
        self.with_db(|c| store::save_calls(c, phone_id, &calls, crate::notes::now()))?;
        Ok(calls)
    }

    pub fn calls(&self, phone_id: &str) -> Result<Vec<Value>, String> {
        self.paired(phone_id)?;
        if self.is_connected(phone_id) {
            match self.fetch_calls(phone_id) {
                Ok(_) => {}
                Err(e) => eprintln!("Phone Link: calls: {e}"),
            }
        }
        self.with_db(|c| store::calls(c, phone_id))
    }

    fn fetch_contacts(&self, phone_id: &str) -> Result<Vec<Value>, String> {
        let answer = self.need(phone_id)?.request(json!({"t": "contacts.list"}), self.timing.listing)?;
        let contacts = answer.get("contacts").and_then(Value::as_array).cloned().unwrap_or_default();
        self.with_db(|c| store::save_contacts(c, phone_id, &contacts, crate::notes::now()))?;
        Ok(contacts)
    }

    pub fn contacts(&self, phone_id: &str) -> Result<Vec<Value>, String> {
        self.paired(phone_id)?;
        if self.is_connected(phone_id) {
            if let Err(e) = self.fetch_contacts(phone_id) {
                eprintln!("Phone Link: contacts: {e}");
            }
        }
        self.with_db(|c| store::contacts(c, phone_id))
    }

    pub fn contact_photo(&self, phone_id: &str, id: Value) -> Result<Option<String>, String> {
        let answer = self.need(phone_id)?.request(json!({"t": "contact.photo", "id": id}), self.timing.request)?;
        Ok(data_url("image/jpeg", answer.get("jpeg").and_then(Value::as_str)))
    }

    fn fetch_notifs(&self, phone_id: &str) -> Result<Vec<Value>, String> {
        let answer = self.need(phone_id)?.request(json!({"t": "notif.list"}), self.timing.request)?;
        let notifs = answer.get("notifs").and_then(Value::as_array).cloned().unwrap_or_default();
        lock(&self.live).entry(phone_id.into()).or_default().notifs = notifs.clone();
        Ok(notifs)
    }

    /// The phone's notifications (none while it's away).
    pub fn notifs(&self, phone_id: &str) -> Result<Vec<Value>, String> {
        self.paired(phone_id)?;
        if self.is_connected(phone_id) {
            if let Err(e) = self.fetch_notifs(phone_id) {
                eprintln!("Phone Link: notifications: {e}");
            }
        }
        Ok(lock(&self.live).get(phone_id).map(|l| l.notifs.clone()).unwrap_or_default())
    }

    pub fn notif_dismiss(&self, phone_id: &str, key: Value) -> Result<(), String> {
        self.need(phone_id)?.request(json!({"t": "notif.dismiss", "key": key}), self.timing.request)?;
        Ok(())
    }

    pub fn notif_action(&self, phone_id: &str, key: Value, action: u32, text: Option<String>) -> Result<(), String> {
        self.need(phone_id)?.request(json!({"t": "notif.action", "key": key, "action": action, "text": text}), self.timing.request)?;
        Ok(())
    }

    /// Recent photos, newest first, each thumbnail as a `data:` URL.
    pub fn photos(&self, phone_id: &str, offset: u32, limit: u32) -> Result<Vec<Value>, String> {
        let answer = self.need(phone_id)?.request(json!({"t": "photos.list", "offset": offset, "limit": limit}), self.timing.listing)?;
        let mut photos = answer.get("photos").and_then(Value::as_array).cloned().unwrap_or_default();
        for p in &mut photos {
            let thumb = data_url("image/jpeg", p.get("thumb").and_then(Value::as_str));
            p["thumb"] = thumb.map(Value::String).unwrap_or(Value::Null);
        }
        Ok(photos)
    }

    pub fn files(&self, phone_id: &str, path: &str) -> Result<Vec<Value>, String> {
        let answer = self.need(phone_id)?.request(json!({"t": "files.list", "path": path}), self.timing.listing)?;
        Ok(answer.get("entries").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    /// Fetches phone files (paths, or `content://` URIs from Photos, sent on unchanged). `names`
    /// are the local names to use, one per path; otherwise the name the phone's answer gives,
    /// otherwise the path's last segment.
    pub fn download(self: &Arc<Self>, phone_id: &str, paths: Vec<String>, names: Option<Vec<String>>, dest: Option<PathBuf>) -> Result<Vec<u32>, String> {
        let link = self.need(phone_id)?;
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let names = names.unwrap_or_default();
        let items = paths.into_iter().enumerate().map(|(i, p)| (p, names.get(i).filter(|n| !n.trim().is_empty()).cloned())).collect();
        Ok(xfer::download(self, link, items, dest.unwrap_or_else(|| self.download_dir())))
    }

    pub fn upload(self: &Arc<Self>, phone_id: &str, paths: Vec<PathBuf>, dir: Option<String>) -> Result<Vec<u32>, String> {
        let link = self.need(phone_id)?;
        let dir = dir.filter(|d| !d.trim().is_empty()).unwrap_or_else(|| PHONE_DOWNLOADS.to_string());
        xfer::upload(self, link, paths, dir)
    }

    pub fn file_delete(&self, phone_id: &str, path: &str) -> Result<(), String> {
        self.need(phone_id)?.request(json!({"t": "files.delete", "path": path}), self.timing.request)?;
        Ok(())
    }

    pub fn ring(&self, phone_id: &str) -> Result<(), String> {
        self.need(phone_id)?.request(json!({"t": "ring"}), self.timing.request)?;
        Ok(())
    }

    /// Asks the phone to start mirroring (it asks its user for screen capture, then streams ZMIR
    /// to the Cast receiver, which the page turns on). `port` is the receiver's ZMIR port when
    /// known (the phone assumes 47212 otherwise).
    pub fn mirror(&self, phone_id: &str, port: Option<u16>) -> Result<(), String> {
        let mut msg = json!({"t": "mirror.start"});
        if let Some(port) = port.filter(|p| *p != 0) {
            msg["port"] = port.into();
        }
        self.need(phone_id)?.request(msg, self.timing.listing)?;
        Ok(())
    }

    pub fn clip_share(&self, phone_id: &str, on: bool) -> Result<(), String> {
        self.paired(phone_id)?;
        self.with_db(|c| store::set_clip(c, phone_id, on))?;
        self.emit_changed();
        Ok(())
    }

    /// Sends the PC's copied text to every connected phone that shares the clipboard.
    pub fn share_clip(&self, text: &str) {
        if !self.host.settings().clip || text.is_empty() {
            return;
        }
        let phones = self.with_db(|c| store::phones(c)).unwrap_or_default();
        for p in phones.into_iter().filter(|p| p.clip) {
            if let Some(link) = self.link(&p.phone_id) {
                let _ = link.send(json!({"t": "clip", "text": text}));
            }
        }
    }

    /// `call.dial` / `call.answer` / `call.end` through the app (the audio stays on the phone).
    pub fn call(&self, phone_id: &str, action: &str, number: Option<&str>) -> Result<(), String> {
        let t = match action {
            "dial" | "call.dial" => "call.dial",
            "answer" | "call.answer" => "call.answer",
            "end" | "hangup" | "decline" | "call.end" => "call.end",
            _ => return Err(format!("Unknown call action “{action}”.")),
        };
        let mut msg = json!({"t": t});
        if t == "call.dial" {
            msg["number"] = number.filter(|n| !n.trim().is_empty()).ok_or("Which number?")?.into();
        }
        self.need(phone_id)?.request(msg, self.timing.request)?;
        Ok(())
    }

    /// The connected phone that can place calls through the app ("calls" in its caps).
    pub fn calling_phone(&self) -> Option<String> {
        let phones = self.with_db(|c| store::phones(c)).ok()?;
        phones.into_iter().find(|p| self.is_connected(&p.phone_id) && p.caps.iter().any(|c| c == "calls")).map(|p| p.phone_id)
    }

    /// Marks a thread read, here and (when connected) on the phone.
    pub fn sms_read(&self, phone_id: &str, thread_id: Value) -> Result<(), String> {
        self.paired(phone_id)?;
        let key = match &thread_id {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        self.with_db(|c| store::thread_read(c, phone_id, &key))?;
        let sent = match self.link(phone_id) {
            Some(link) => link.request(json!({"t": "sms.read", "threadId": thread_id}), self.timing.request).map(|_| ()),
            None => Ok(()),
        };
        self.emit_changed();
        sent
    }

    /// The paired phone whose own (Bluetooth) name or name here is `name`, connected ones first.
    pub fn phone_named(&self, name: &str) -> Option<store::Paired> {
        let name = name.trim().to_lowercase();
        let mut phones = self.with_db(|c| store::phones(c)).ok()?;
        phones.sort_by_key(|p| !self.is_connected(&p.phone_id));
        phones.into_iter().find(|p| p.device_name.to_lowercase() == name || p.name.to_lowercase() == name)
    }

    /// A caller's name from a phone's contacts (`phone_id`), or from any paired phone's.
    pub fn contact_name(&self, phone_id: Option<&str>, number: &str) -> Option<String> {
        let mut ids: Vec<String> = phone_id.map(|p| vec![p.to_string()]).unwrap_or_default();
        ids.extend(self.with_db(|c| store::phones(c)).unwrap_or_default().into_iter().map(|p| p.phone_id));
        ids.iter().find_map(|id| self.with_db(|c| store::contact_name(c, id, number)).ok().flatten())
    }
}

// ---- the app ------------------------------------------------------------------------------------

static HUB: OnceLock<Arc<Hub>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

/// The hub, once `init` ran (None in tests and before startup).
pub fn hub() -> Option<&'static Arc<Hub>> {
    HUB.get()
}

fn the_hub() -> Result<Arc<Hub>, String> {
    HUB.get().cloned().ok_or_else(|| "Phone Link didn't start.".to_string())
}

/// The page's settings in `config.json` (`phone.*`).
fn config() -> Value {
    APP.get()
        .and_then(|app| app.path().app_config_dir().ok())
        .and_then(|dir| std::fs::read_to_string(dir.join("config.json")).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v.get("phone").cloned())
        .unwrap_or_default()
}

/// Sets `phone.enabled` in `config.json`, keeping everything else.
fn save_enabled(on: bool) {
    let Some(path) = APP.get().and_then(|app| app.path().app_config_dir().ok()).map(|d| d.join("config.json")) else { return };
    let mut json = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or_else(|| json!({}));
    if !json.is_object() {
        return;
    }
    if !json.get("phone").is_some_and(Value::is_object) {
        json["phone"] = json!({});
    }
    json["phone"]["enabled"] = on.into();
    let tmp = path.with_extension("json.tmp");
    if let Ok(text) = serde_json::to_string_pretty(&json) {
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

struct AppHost;

impl Host for AppHost {
    fn emit(&self, event: &str, payload: Value) {
        if let Some(app) = APP.get() {
            let _ = app.emit(event, payload);
        }
    }

    fn settings(&self) -> Settings {
        let c = config();
        let flag = |key: &str, default: bool| c.get(key).and_then(Value::as_bool).unwrap_or(default);
        let pc_name = str_of(&c, "pcName").map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| format!("Zazabor on {}", crate::cast::cast_hostname()));
        let download_dir = str_of(&c, "downloadDir").map(PathBuf::from).unwrap_or_else(|| {
            APP.get()
                .and_then(|app| app.path().download_dir().ok())
                .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())).join("Downloads"))
                .join("Zazabor Link")
        });
        Settings { pc_name, download_dir, notify: flag("notify", true), mirror_notifs: flag("mirrorNotifs", true), clip: flag("clip", false) }
    }

    fn desktop(&self, title: &str, body: &str, icon: &str, open: Value) {
        let Some(app) = APP.get() else { return };
        // The window in front already shows it.
        if app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false) {
            return;
        }
        // What the phone says stays private while Zazabor is locked.
        let (title, body) = if crate::lock::is_locked() { ("Your phone".to_string(), "Something new on your phone".to_string()) } else { (title.to_string(), body.to_string()) };
        let icon = if icon == "phone" { "phone" } else { icon }.to_string();
        let app = app.clone();
        std::thread::spawn(move || {
            let click_app = app.clone();
            crate::desktop_notify::show(
                crate::desktop_notify::Note { title: &title, body: &body, icon: &icon, category: "im.received", replaces: 0 },
                Some(Box::new(move || {
                    if let Some(main) = click_app.get_webview_window("main") {
                        let _ = main.unminimize();
                        let _ = main.show();
                        let _ = main.set_focus();
                    }
                    let _ = click_app.emit("phone-open", open.clone());
                })),
            );
        });
    }

    fn set_clipboard(&self, text: &str) {
        let Some(app) = APP.get() else { return };
        *lock(&FROM_PHONE) = Some(text.to_string());
        let text = text.to_string();
        let _ = app.run_on_main_thread(move || {
            gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).set_text(&text);
        });
    }
}

/// Opens `phone.db` and, when the page left Phone Link on, starts listening.
pub fn init(app: AppHandle, data_dir: PathBuf) {
    let _ = APP.set(app);
    let conn = match store::open(&data_dir.join("phone.db")) {
        Ok(c) => c,
        Err(err) => {
            eprintln!("Phone Link: {err}");
            return;
        }
    };
    match Hub::new(Box::new(AppHost), conn, Timing::default()) {
        Ok(hub) => {
            let _ = HUB.set(hub);
        }
        Err(err) => {
            eprintln!("Phone Link: {err}");
            return;
        }
    }
    if config().get("enabled").and_then(Value::as_bool) == Some(true) {
        std::thread::spawn(|| {
            if let Err(err) = switch(true) {
                eprintln!("Phone Link: {err}");
            }
        });
    }
}

/// Starts or stops the listener and its mDNS advert.
fn switch(on: bool) -> Result<PhoneState, String> {
    let hub = the_hub()?;
    if on {
        let port = hub.start("0.0.0.0", link::PORT)?;
        if let Err(err) = mdns::start(&hub.pc_id, &hub.pc_name(), port) {
            eprintln!("Phone Link: phones won't find this PC by themselves: {err}");
        }
    } else {
        mdns::stop();
        hub.stop();
    }
    hub.emit_changed();
    Ok(hub.state())
}

/// The `_zazabor-link._tcp` advert.
mod mdns {
    use mdns_sd::{IfKind, ServiceDaemon, ServiceInfo};
    use std::collections::HashMap;
    use std::sync::Mutex;

    pub const SERVICE: &str = "_zazabor-link._tcp.local.";
    static DAEMON: Mutex<Option<ServiceDaemon>> = Mutex::new(None);

    pub fn start(pc_id: &str, name: &str, port: u16) -> Result<(), String> {
        stop();
        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        let virtual_ifs: Vec<IfKind> = if_addrs::get_if_addrs().unwrap_or_default().into_iter().filter(|i| crate::cast::is_virtual(&i.name)).map(|i| IfKind::Name(i.name)).collect();
        if !virtual_ifs.is_empty() {
            let _ = daemon.disable_interface(virtual_ifs);
        }
        let short = &pc_id[..pc_id.len().min(8)];
        let host = format!("zazabor-link-{short}.local.");
        let txt: HashMap<String, String> = [("name", name), ("id", pc_id), ("v", "1")].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let info = ServiceInfo::new(SERVICE, &instance_name(name, short), &host, "", port, Some(txt)).map_err(|e| e.to_string())?;
        daemon.register(info.enable_addr_auto()).map_err(|e| e.to_string())?;
        *super::lock(&DAEMON) = Some(daemon);
        Ok(())
    }

    /// An mDNS instance name: the PC's name without dots, at most 63 bytes.
    pub fn instance_name(name: &str, short: &str) -> String {
        let clean: String = name.chars().map(|c| if c == '.' { ' ' } else { c }).collect();
        let mut out = clean.trim().to_string();
        if out.is_empty() {
            out = format!("Zazabor {short}");
        }
        while out.len() > 63 {
            out.pop();
        }
        out
    }

    pub fn stop() {
        if let Some(daemon) = super::lock(&DAEMON).take() {
            let _ = daemon.shutdown();
        }
    }
}

// ---- for other modules (Bluetooth calls, the clipboard)

/// The paired phone whose `hello` name (= its Bluetooth name) or name here is `name`:
/// (phoneId, name shown here, connected over Wi-Fi).
pub fn phone_named(name: &str) -> Option<(String, String, bool)> {
    let hub = hub()?;
    let p = hub.phone_named(name)?;
    let connected = hub.is_connected(&p.phone_id);
    Some((p.phone_id, p.name, connected))
}

/// A caller's name from the cached contacts of `phone_id` (or any paired phone).
pub fn contact_name(phone_id: Option<&str>, number: &str) -> Option<String> {
    hub()?.contact_name(phone_id, number)
}

/// A phone's cached contacts (`Contact` JSON, by name).
pub fn contacts_of(phone_id: &str) -> Vec<Value> {
    hub().and_then(|h| h.with_db(|c| store::contacts(c, phone_id)).ok()).unwrap_or_default()
}

/// Places, answers or ends a call through the Zazabor Link app (no Bluetooth; the audio stays
/// on the phone). `action` is "dial", "answer" or "end". With no phone given, the connected
/// phone that shares calls (the first of them when there are several).
pub fn call_via_app(phone_id: Option<&str>, action: &str, number: Option<&str>) -> Result<(), String> {
    let hub = the_hub()?;
    let id = match phone_id {
        Some(id) => id.to_string(),
        None => hub.calling_phone().ok_or("No phone with Zazabor Link's calls permission is connected over Wi-Fi.")?,
    };
    hub.call(&id, action, number)
}

/// The last text a phone put on the PC's clipboard, so it isn't sent straight back.
static FROM_PHONE: Mutex<Option<String>> = Mutex::new(None);

/// The PC's clipboard changed (clipboard history saw a new text): phones sharing it get the text.
pub fn share_clip(text: &str) {
    if lock(&FROM_PHONE).take().is_some_and(|t| t == text) {
        return;
    }
    if let Some(hub) = hub() {
        hub.share_clip(text);
    }
}

// ---- commands -----------------------------------------------------------------------------------

async fn blocking<T: Send + 'static>(f: impl FnOnce(Arc<Hub>) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let hub = the_hub()?;
    tauri::async_runtime::spawn_blocking(move || f(hub)).await.map_err(|e| e.to_string())?
}

/// Library-like commands refuse while Zazabor is locked.
async fn private<T: Send + 'static>(f: impl FnOnce(Arc<Hub>) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    crate::ensure_unlocked()?;
    blocking(f).await
}

#[tauri::command]
pub fn phone_state() -> Result<PhoneState, String> {
    Ok(the_hub()?.state())
}

/// Turns the link on or off (the listener and its mDNS advert) and keeps it in `phone.enabled`.
#[tauri::command]
pub async fn phone_link_enable(on: bool) -> Result<PhoneState, String> {
    let state = tauri::async_runtime::spawn_blocking(move || switch(on)).await.map_err(|e| e.to_string())??;
    save_enabled(on);
    Ok(state)
}

#[tauri::command]
pub fn phone_pair_answer(phone_id: String, accept: bool) -> Result<(), String> {
    the_hub()?.pair_answer(&phone_id, accept)
}

#[tauri::command]
pub fn phone_forget(phone_id: String) -> Result<(), String> {
    the_hub()?.forget(&phone_id)
}

#[tauri::command]
pub fn phone_rename(phone_id: String, name: String) -> Result<(), String> {
    the_hub()?.rename(&phone_id, &name)
}

#[tauri::command]
pub async fn phone_threads(phone_id: String) -> Result<Vec<Value>, String> {
    private(move |h| h.threads(&phone_id)).await
}

#[tauri::command]
pub async fn phone_thread(phone_id: String, thread_id: Value, before: Option<i64>) -> Result<Vec<Value>, String> {
    private(move |h| h.thread(&phone_id, thread_id, before)).await
}

#[tauri::command]
pub async fn phone_sms_send(phone_id: String, to: Vec<String>, body: String) -> Result<(), String> {
    private(move |h| h.sms_send(&phone_id, to, &body)).await
}

#[tauri::command]
pub async fn phone_calls(phone_id: String) -> Result<Vec<Value>, String> {
    private(move |h| h.calls(&phone_id)).await
}

#[tauri::command]
pub async fn phone_contacts(phone_id: String) -> Result<Vec<Value>, String> {
    private(move |h| h.contacts(&phone_id)).await
}

#[tauri::command]
pub async fn phone_contact_photo(phone_id: String, id: Value) -> Result<Option<String>, String> {
    private(move |h| h.contact_photo(&phone_id, id)).await
}

#[tauri::command]
pub async fn phone_notifs(phone_id: String) -> Result<Vec<Value>, String> {
    private(move |h| h.notifs(&phone_id)).await
}

#[tauri::command]
pub async fn phone_notif_dismiss(phone_id: String, key: Value) -> Result<(), String> {
    private(move |h| h.notif_dismiss(&phone_id, key)).await
}

#[tauri::command]
pub async fn phone_notif_action(phone_id: String, key: Value, action: u32, text: Option<String>) -> Result<(), String> {
    private(move |h| h.notif_action(&phone_id, key, action, text)).await
}

#[tauri::command]
pub async fn phone_photos(phone_id: String, offset: u32, limit: u32) -> Result<Vec<Value>, String> {
    private(move |h| h.photos(&phone_id, offset, limit)).await
}

#[tauri::command]
pub async fn phone_files(phone_id: String, path: String) -> Result<Vec<Value>, String> {
    private(move |h| h.files(&phone_id, &path)).await
}

#[tauri::command]
pub async fn phone_download(phone_id: String, paths: Vec<String>, names: Option<Vec<String>>, dest: Option<String>) -> Result<Vec<u32>, String> {
    private(move |h| h.download(&phone_id, paths, names, dest.filter(|d| !d.is_empty()).map(PathBuf::from))).await
}

/// Marks a conversation read (the cached unread count, and the phone's).
#[tauri::command]
pub async fn phone_sms_read(phone_id: String, thread_id: Value) -> Result<(), String> {
    private(move |h| h.sms_read(&phone_id, thread_id)).await
}

/// The name phones see for this PC (empty = "Zazabor on ‹hostname›"). Kept in phone.db.
#[tauri::command]
pub async fn phone_set_pc_name(name: String) -> Result<PhoneState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let hub = the_hub()?;
        hub.set_pc_name(&name)?;
        if let Some(port) = hub.port() {
            if let Err(err) = mdns::start(&hub.pc_id, &hub.pc_name(), port) {
                eprintln!("Phone Link: phones won't find this PC by themselves: {err}");
            }
        }
        Ok(hub.state())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn phone_upload(phone_id: String, paths: Vec<String>, dir: Option<String>) -> Result<Vec<u32>, String> {
    private(move |h| h.upload(&phone_id, paths.into_iter().map(PathBuf::from).collect(), dir)).await
}

#[tauri::command]
pub async fn phone_file_delete(phone_id: String, path: String) -> Result<(), String> {
    private(move |h| h.file_delete(&phone_id, &path)).await
}

#[tauri::command]
pub fn phone_transfers() -> Result<Vec<Transfer>, String> {
    Ok(the_hub()?.transfers.list())
}

#[tauri::command]
pub fn phone_transfer_cancel(id: u32) -> Result<(), String> {
    let hub = the_hub()?;
    hub.transfers.cancel(&hub, id)
}

#[tauri::command]
pub async fn phone_ring(phone_id: String) -> Result<(), String> {
    blocking(move |h| h.ring(&phone_id)).await
}

#[tauri::command]
pub async fn phone_mirror(phone_id: String) -> Result<(), String> {
    // The Cast receiver's screen-mirroring port, when it's running.
    let port = crate::cast::cast_receiver_info().services.into_iter().find(|s| s.id == "mirror" && s.error.is_none()).map(|s| s.port);
    blocking(move |h| h.mirror(&phone_id, port)).await
}

#[tauri::command]
pub fn phone_clip_share(phone_id: String, on: bool) -> Result<(), String> {
    the_hub()?.clip_share(&phone_id, on)
}

/// Calls through the Zazabor Link app when Bluetooth calls aren't set up: `action` is "dial"
/// (with `number`), "answer" or "end".
#[tauri::command]
pub async fn phone_link_call(phone_id: String, action: String, number: Option<String>) -> Result<(), String> {
    blocking(move |h| h.call(&phone_id, &action, number.as_deref())).await
}

#[cfg(test)]
mod tests;
