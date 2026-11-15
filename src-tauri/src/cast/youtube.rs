//! YouTube: DIAL ("Cast" in the YouTube app finds Zazabor as a TV) and the lounge pairing that
//! carries the play queue and the remote's commands. Played with yt-dlp (`ytdlp`).
//!
//! Zazabor is a lounge *screen*, the role a smart TV plays. It gets a screen id from YouTube once
//! (kept in `cast::data_dir()`), a lounge token for it, and binds a BrowserChannel session to
//! `www.youtube.com/api/lounge/bc/bind`. A long poll on that session brings the phone's commands
//! (`setPlaylist`, `pause`, `seekTo`…), and short POSTs send the screen's state back
//! (`nowPlaying`, `onStateChange`, `onVolumeChanged`…). A phone joins the session in one of two ways:
//!
//! - DIAL: it finds `/dial/dd.xml` over SSDP, reads `/apps/YouTube` (whose `additionalData`
//!   carries the screen id), and POSTs `pairingCode=…`, which the screen registers with the lounge.
//! - "Link with TV code": the user types the 12-digit code from `tv_code()` in the YouTube app.
//!
//! The protocol is undocumented; this follows yt-cast-receiver, plaincast and pyytlounge. Only a
//! generic screen name ("Zazabor") and random ids go to YouTube, never the PC's name.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::http::{self, xml_escape, Request, Response};
use super::{ssdp, Media, PlayState, Settings, Source};

const API: &str = "https://www.youtube.com/api/lounge";
const DEVICE_TYPE: &str = "urn:dial-multiscreen-org:device:dial:1";
const DIAL_SERVICE: &str = "urn:dial-multiscreen-org:service:dial:1";
const APP: &str = "YouTube";
/// The screen app and name YouTube sees. Generic on purpose: the PC's own name stays local.
const SCREEN_APP: &str = "zazabor";
const SCREEN_NAME: &str = "Zazabor";
/// "cl" is the YouTube app ("m" would be YouTube Music).
const THEME: &str = "cl";
const MAX_LAUNCH_BODY: usize = 4096;
/// A "Link with TV code" lasts a while; TVs fetch a new one every five minutes while it shows.
const CODE_REFRESH: Duration = Duration::from_secs(300);
/// The page asks for the code every few seconds while its dialog is open.
const CODE_WANTED_FOR: Duration = Duration::from_secs(30);
/// A long poll ends after this and is opened again (the server also ends it on its own).
const POLL_BUDGET: Duration = Duration::from_secs(240);

// ---- state ---------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
struct Identity {
    screen_id: String,
    device_id: String,
}

/// The BrowserChannel session with the lounge.
#[derive(Clone, Debug)]
struct Channel {
    sid: String,
    gsession: String,
    /// Request counter for POSTs.
    rid: u64,
    /// Index of the next message we send.
    ofs: u64,
    /// The last message id received.
    aid: i64,
}

#[derive(Clone, Debug, PartialEq)]
struct Remote {
    id: String,
    name: String,
}

/// The phone's play queue.
#[derive(Clone, Debug, Default, PartialEq)]
struct Queue {
    list_id: String,
    ids: Vec<String>,
    index: usize,
    params: String,
    ctt: String,
}

impl Queue {
    fn has_next(&self) -> bool {
        self.index + 1 < self.ids.len()
    }

    fn has_previous(&self) -> bool {
        self.index > 0 && !self.ids.is_empty()
    }
}

/// The video the screen shows (or loads).
#[derive(Clone, Debug)]
struct Playing {
    video_id: String,
    /// "Client playback nonce": a random id per playback that the phone echoes.
    cpn: String,
    /// Which load this is, so a slow yt-dlp answer for an older one is dropped.
    request: u64,
    /// The hub's session, once yt-dlp answered.
    session: Option<u64>,
    resolving: bool,
    /// The last state reported to the phone (`STATE_*`).
    code: i32,
    /// Position reported (seconds) and when.
    time: f64,
    at: Instant,
    duration: f64,
    live: bool,
}

const STATE_ENDED: i32 = 0;
const STATE_PLAYING: i32 = 1;
const STATE_PAUSED: i32 = 2;
const STATE_LOADING: i32 = 3;
const STATE_STOPPED: i32 = 4;

struct State {
    generation: u64,
    name: String,
    dial_uuid: String,
    identity: Option<Identity>,
    token: Option<String>,
    channel: Option<Channel>,
    outbox: Option<mpsc::Sender<Out>>,
    /// DIAL pairing codes that arrived before the lounge was ready.
    pending_pairing: Vec<String>,
    code: Option<(String, Instant)>,
    code_wanted: Option<Instant>,
    remotes: Vec<Remote>,
    queue: Queue,
    playing: Option<Playing>,
    next_request: u64,
    volume: Option<(i64, bool)>,
    /// The DIAL app was stopped with DELETE (it is "running" again on the next launch).
    stopped: bool,
    last_error: Option<String>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn state() -> MutexGuard<'static, Option<State>> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs `work` on the state if it still belongs to `generation`.
fn with_state<R>(generation: u64, work: impl FnOnce(&mut State) -> R) -> Option<R> {
    let mut slot = state();
    match slot.as_mut() {
        Some(s) if s.generation == generation && super::alive(generation) => Some(work(s)),
        _ => None,
    }
}

// ---- the receiver's entry points -----------------------------------------------------------

/// A UUID for the DIAL device, derived from the receiver's id but different from the DLNA one.
fn dial_uuid(id: &str) -> String {
    let h: String = Sha256::digest(format!("zazabor-dial:{id}").as_bytes()).iter().take(16).map(|b| format!("{b:02x}")).collect();
    // A name-based (version 5) UUID with the RFC 4122 variant bits.
    let variant = ["8", "9", "a", "b"][usize::from_str_radix(&h[16..17], 16).unwrap_or(0) % 4];
    format!("{}-{}-5{}-{variant}{}-{}", &h[..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

/// SSDP entries for the DIAL server.
pub fn adverts(settings: &Settings) -> Vec<ssdp::Advert> {
    vec![ssdp::Advert { uuid: dial_uuid(&settings.id), device_type: DEVICE_TYPE.into(), services: vec![DIAL_SERVICE.into()], location: "/dial/dd.xml".into() }]
}

pub fn start(generation: u64, settings: &Settings) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    {
        let mut slot = state();
        let old = slot.take();
        if let Some(old) = &old {
            farewell(old);
        }
        let (identity, token) = old.map(|o| (o.identity, o.token)).unwrap_or((None, None));
        *slot = Some(State {
            generation,
            name: settings.name.clone(),
            dial_uuid: dial_uuid(&settings.id),
            identity,
            token,
            channel: None,
            outbox: Some(tx),
            pending_pairing: Vec::new(),
            code: None,
            code_wanted: None,
            remotes: Vec::new(),
            queue: Queue::default(),
            playing: None,
            next_request: 0,
            volume: None,
            stopped: false,
            last_error: None,
        });
    }
    let spawn = |name: &str, work: Box<dyn FnOnce() + Send>| std::thread::Builder::new().name(name.into()).spawn(work).map(|_| ()).map_err(|e| e.to_string());
    spawn("cast-yt-lounge", Box::new(move || lounge_loop(generation)))?;
    spawn("cast-yt-send", Box::new(move || sender_loop(generation, rx)))?;
    spawn("cast-yt-status", Box::new(move || status_loop(generation)))?;
    Ok(())
}

/// The current "Link with TV code", if any. Asking keeps it fresh for a while.
pub fn tv_code() -> Option<String> {
    let mut slot = state();
    let s = slot.as_mut()?;
    s.code_wanted = Some(Instant::now());
    s.code.as_ref().filter(|(_, at)| at.elapsed() < CODE_REFRESH * 2).map(|(code, _)| format_code(code))
}

pub fn new_tv_code() -> Result<String, String> {
    let started = Instant::now();
    loop {
        let ready = {
            let slot = state();
            let s = slot.as_ref().ok_or("Turn on Cast to This PC first.")?;
            match (&s.identity, &s.token) {
                (Some(id), Some(token)) => Some((s.generation, id.clone(), token.clone())),
                _ => None,
            }
        };
        if let Some((generation, identity, token)) = ready {
            let code = fetch_pairing_code(&identity, &token)?;
            with_state(generation, |s| {
                s.code = Some((code.clone(), Instant::now()));
                s.code_wanted = Some(Instant::now());
            });
            return Ok(format_code(&code));
        }
        if started.elapsed() > Duration::from_secs(20) {
            let error = state().as_ref().and_then(|s| s.last_error.clone());
            return Err(match error {
                Some(e) => format!("YouTube isn't reachable: {e}"),
                None => "YouTube isn't ready yet. Try again in a moment.".into(),
            });
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// "123456789012" → "123 456 789 012".
fn format_code(code: &str) -> String {
    let digits: Vec<char> = code.chars().filter(char::is_ascii_digit).collect();
    digits.chunks(3).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join(" ")
}

// ---- DIAL ----------------------------------------------------------------------------------

/// What the DIAL pages show, taken from the state.
#[derive(Clone, Debug, Default)]
struct DialInfo {
    name: String,
    uuid: String,
    identity: Option<Identity>,
    running: bool,
}

/// What a DIAL request asks the lounge to do.
#[derive(Debug, PartialEq)]
enum DialAction {
    Launch { pairing_code: Option<String>, theme: String },
    Stop,
}

/// DIAL's HTTP endpoints (`/dial/…`, `/apps/YouTube`).
pub fn route(request: &Request) -> Option<Response> {
    let path = request.path.as_str();
    if path != "/dial/dd.xml" && path != "/apps" && !path.starts_with("/apps/") {
        return None;
    }
    let info = {
        let slot = state();
        let s = slot.as_ref()?;
        if !super::alive(s.generation) {
            return None;
        }
        DialInfo { name: s.name.clone(), uuid: s.dial_uuid.clone(), identity: s.identity.clone(), running: s.identity.is_some() && !s.stopped }
    };
    let (response, action) = serve_dial(request, &info);
    match action {
        Some(DialAction::Launch { pairing_code, theme }) => launch(pairing_code, &theme),
        Some(DialAction::Stop) => stop_app(),
        None => {}
    }
    Some(response)
}

fn serve_dial(request: &Request, info: &DialInfo) -> (Response, Option<DialAction>) {
    let method = request.method.as_str();
    if request.path == "/dial/dd.xml" {
        return match method {
            "GET" | "HEAD" => (Response::xml(device_description(info)).header("Application-URL", format!("{}/apps/", request.base_url())), None),
            _ => (Response::new(405).header("Allow", "GET, HEAD"), None),
        };
    }
    // DIAL 2.x §6.6: a request with an Origin the app doesn't accept is refused.
    let origin = request.header("origin");
    let Some(cors) = check_origin(origin) else {
        return (Response::new(403), None);
    };
    let with_cors = |mut r: Response| {
        if let Some(origin) = &cors {
            r = r.header("Access-Control-Allow-Origin", origin.clone()).header("Access-Control-Expose-Headers", "Location").header("Vary", "Origin");
        }
        r
    };
    let rest = request.path.strip_prefix("/apps").unwrap_or("");
    let (app, sub) = match rest.trim_start_matches('/').split_once('/') {
        Some((a, s)) => (a, s),
        None => (rest.trim_start_matches('/'), ""),
    };
    if method == "OPTIONS" {
        let r = Response::new(204).header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS").header("Access-Control-Allow-Headers", "Content-Type").header("Access-Control-Max-Age", "600");
        return (with_cors(r), None);
    }
    if app != APP {
        return (with_cors(Response::not_found()), None);
    }
    match (method, sub) {
        ("GET" | "HEAD", "") => (with_cors(Response::ok("text/xml; charset=\"utf-8\"", app_description(info))), None),
        ("POST", "") => {
            if request.body.len() > MAX_LAUNCH_BODY {
                return (with_cors(Response::new(413)), None);
            }
            let params = http::parse_query(request.body_text().trim());
            let get = |k: &str| params.iter().find(|(key, _)| key == k).map(|(_, v)| v.trim().to_string()).filter(|v| !v.is_empty());
            let action = DialAction::Launch { pairing_code: get("pairingCode"), theme: get("theme").unwrap_or_else(|| THEME.into()) };
            let location = format!("{}/apps/{APP}/run", request.base_url());
            (with_cors(Response::new(201).header("LOCATION", location)), Some(action))
        }
        ("POST", "dial_data") => (with_cors(Response::new(200)), None),
        ("DELETE", "run") => (with_cors(Response::new(200)), Some(DialAction::Stop)),
        ("DELETE", _) => (with_cors(Response::not_found()), None),
        _ => (with_cors(Response::new(405).header("Allow", "GET, POST, DELETE, OPTIONS")), None),
    }
}

/// `Some(None)`: allowed without CORS headers (no Origin); `Some(Some(o))`: allowed, echo `o`;
/// `None`: refused. Native apps send `package:…`; web pages only from youtube.com may launch.
fn check_origin(origin: Option<&str>) -> Option<Option<String>> {
    let Some(origin) = origin.map(str::trim) else { return Some(None) };
    let lower = origin.to_ascii_lowercase();
    if lower == "null" || lower.is_empty() {
        return None;
    }
    let scheme = lower.split(':').next().unwrap_or("");
    if !matches!(scheme, "http" | "https" | "file") {
        return Some(Some(origin.to_string()));
    }
    let host = lower.strip_prefix("https://").unwrap_or("");
    let host = host.split([':', '/']).next().unwrap_or("");
    (host == "youtube.com" || host.ends_with(".youtube.com")).then(|| Some(origin.to_string()))
}

fn device_description(info: &DialInfo) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>{DEVICE_TYPE}</deviceType><friendlyName>{}</friendlyName><manufacturer>Zazabor Home</manufacturer><modelName>Zazabor Home</modelName><UDN>uuid:{}</UDN><iconList><icon><mimetype>image/png</mimetype><width>128</width><height>128</height><depth>32</depth><url>/dlna/icon.png</url></icon></iconList><serviceList><service><serviceType>{DIAL_SERVICE}</serviceType><serviceId>urn:dial-multiscreen-org:serviceId:dial</serviceId><controlURL>/dial/control</controlURL><eventSubURL></eventSubURL><SCPDURL>/dial/scpd.xml</SCPDURL></service></serviceList></device></root>"#,
        xml_escape(&info.name),
        xml_escape(&info.uuid),
    )
}

fn app_description(info: &DialInfo) -> String {
    let mut xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<service xmlns=\"urn:dial-multiscreen-org:schemas:dial\" dialVer=\"2.1\"><name>{APP}</name><options allowStop=\"true\"/><state>{}</state>",
        if info.running { "running" } else { "stopped" }
    );
    if info.running {
        xml.push_str("<link rel=\"run\" href=\"run\"/>");
    }
    if let Some(id) = &info.identity {
        xml.push_str(&format!(
            "<additionalData><screenId>{}</screenId><theme>{THEME}</theme><deviceId>{}</deviceId><loungeTokenRefreshIntervalMs>1500000</loungeTokenRefreshIntervalMs></additionalData>",
            xml_escape(&id.screen_id),
            xml_escape(&id.device_id)
        ));
    }
    xml.push_str("</service>");
    xml
}

/// The phone launched the app: register its pairing code so it joins the lounge.
fn launch(pairing_code: Option<String>, theme: &str) {
    if theme != THEME {
        eprintln!("[cast] YouTube: launch for theme {theme:?}; only the YouTube app (cl) is supported");
    }
    let Some(code) = pairing_code else { return };
    let ready = {
        let mut slot = state();
        let Some(s) = slot.as_mut() else { return };
        s.stopped = false;
        match (&s.identity, &s.channel) {
            (Some(identity), Some(_)) => Some((s.generation, identity.clone())),
            _ => {
                s.pending_pairing.push(code.clone());
                s.pending_pairing.truncate(8);
                None
            }
        }
    };
    if let Some((generation, identity)) = ready {
        std::thread::spawn(move || register_pairing_code(generation, &identity, &code));
    }
}

fn stop_app() {
    let session = {
        let mut slot = state();
        let Some(s) = slot.as_mut() else { return };
        s.stopped = true;
        s.queue = Queue::default();
        s.playing.take().and_then(|p| p.session)
    };
    if let Some(session) = session {
        super::stop(session);
    }
}

// ---- talking to YouTube --------------------------------------------------------------------

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .build()
        .into()
}

fn form(pairs: &[(&str, String)]) -> String {
    let mut out = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        out.append_pair(k, v);
    }
    out.finish()
}

fn post(url: &str, body: &str) -> Result<(u16, String), String> {
    let response = agent()
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send(body)
        .map_err(|e| format!("couldn't reach YouTube: {e}"))?;
    let status = response.status().as_u16();
    let text = response.into_body().with_config().limit(4 << 20).lossy_utf8(true).read_to_string().map_err(|e| e.to_string())?;
    Ok((status, text))
}

fn random_text(len: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bytes = vec![0u8; len];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes);
    bytes.iter().map(|b| ALPHABET[(*b as usize) % 64] as char).collect()
}

fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

fn identity_file() -> std::path::PathBuf {
    super::data_dir().join("youtube-screen.json")
}

fn load_identity() -> Option<Identity> {
    let v: Value = serde_json::from_slice(&std::fs::read(identity_file()).ok()?).ok()?;
    let text = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() < 200).map(String::from);
    Some(Identity { screen_id: text("screenId")?, device_id: text("deviceId")? })
}

fn save_identity(identity: &Identity) {
    let path = identity_file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, json!({"screenId": identity.screen_id, "deviceId": identity.device_id}).to_string());
}

fn generate_screen_id() -> Result<String, String> {
    let response = agent().get(&format!("{API}/pairing/generate_screen_id")).call().map_err(|e| format!("couldn't reach YouTube: {e}"))?;
    let status = response.status().as_u16();
    let text = response.into_body().with_config().limit(4096).read_to_string().map_err(|e| e.to_string())?;
    let id = text.trim();
    if status != 200 || id.is_empty() || id.len() > 100 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(format!("YouTube didn't give a screen id ({status})"));
    }
    Ok(id.to_string())
}

/// A lounge token for the screen, or None when YouTube doesn't know the screen.
fn lounge_token(screen_id: &str) -> Result<Option<String>, String> {
    let (status, text) = post(&format!("{API}/pairing/get_lounge_token_batch"), &form(&[("screen_ids", screen_id.into())]))?;
    if status != 200 {
        return Err(format!("YouTube answered {status} for a lounge token"));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("screens").and_then(|s| s.get(0)).and_then(|s| s.get("loungeToken")).and_then(Value::as_str).filter(|t| !t.is_empty()).map(String::from))
}

fn fetch_pairing_code(identity: &Identity, token: &str) -> Result<String, String> {
    let body = form(&[
        ("access_type", "permanent".into()),
        ("app", SCREEN_APP.into()),
        ("lounge_token", token.into()),
        ("screen_id", identity.screen_id.clone()),
        ("screen_name", SCREEN_NAME.into()),
        ("device_id", identity.device_id.clone()),
    ]);
    let (status, text) = post(&format!("{API}/pairing/get_pairing_code?ctx=pair"), &body)?;
    let code: String = text.trim().chars().filter(|c| !c.is_whitespace()).collect();
    if status != 200 || code.len() != 12 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("YouTube didn't give a TV code ({status})"));
    }
    Ok(code)
}

fn register_pairing_code(generation: u64, identity: &Identity, code: &str) {
    let body = form(&[
        ("access_type", "permanent".into()),
        ("app", SCREEN_APP.into()),
        ("pairing_code", code.into()),
        ("screen_id", identity.screen_id.clone()),
        ("screen_name", SCREEN_NAME.into()),
        ("device_id", identity.device_id.clone()),
    ]);
    match post(&format!("{API}/pairing/register_pairing_code"), &body) {
        Ok((200, _)) => {}
        Ok((status, _)) => note_error(generation, format!("pairing answered {status}")),
        Err(e) => note_error(generation, e),
    }
}

/// Protocol tracing, on when ZAZABOR_YT_DEBUG is set.
fn debug(text: impl FnOnce() -> String) {
    if std::env::var_os("ZAZABOR_YT_DEBUG").is_some() {
        eprintln!("[cast] YouTube debug: {}", text());
    }
}

fn note_error(generation: u64, error: String) {
    eprintln!("[cast] YouTube: {error}");
    with_state(generation, |s| s.last_error = Some(error));
}

const DEVICE_INFO: &str = r#"{"brand":"Zazabor","model":"PC","year":0,"os":"Linux","osVersion":"","chipset":"","clientName":"TVHTML5","dialAdditionalDataSupportLevel":"unsupported","mdxDialServerType":"MDX_DIAL_SERVER_TYPE_UNKNOWN"}"#;

/// The query every bind request carries.
fn bind_query(identity: &Identity, token: &str, extra: &[(&str, String)]) -> String {
    let mut pairs: Vec<(&str, String)> = vec![
        ("device", "LOUNGE_SCREEN".into()),
        ("id", identity.device_id.clone()),
        ("obfuscatedGaiaId", String::new()),
        ("name", SCREEN_NAME.into()),
        ("app", SCREEN_APP.into()),
        ("theme", THEME.into()),
        ("capabilities", "dsp,mic,dpa,ntb".into()),
        ("cst", "m".into()),
        ("mdxVersion", "2".into()),
        ("loungeIdToken", token.into()),
        ("VER", "8".into()),
        ("v", "2".into()),
        ("zx", random_text(12)),
        ("t", "1".into()),
    ];
    pairs.extend(extra.iter().cloned());
    form(&pairs)
}

// ---- the lounge's message stream -----------------------------------------------------------

/// One message from the lounge: `[aid, [name, args…]]`.
#[derive(Clone, Debug, PartialEq)]
struct Incoming {
    aid: i64,
    name: String,
    args: Vec<Value>,
}

/// Splits the bind response into messages. It is a run of `<length>\n<JSON array>` chunks; the
/// length is in characters of some encoding, so the parser finds each array's end itself.
#[derive(Default)]
struct ChunkParser {
    buf: Vec<u8>,
}

impl ChunkParser {
    fn push(&mut self, bytes: &[u8]) -> Vec<Incoming> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            let start = self.buf.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(self.buf.len());
            self.buf.drain(..start);
            if self.buf.is_empty() {
                break;
            }
            if self.buf[0] != b'[' {
                // The length line (or something unexpected): skip to the next line.
                match self.buf.iter().position(|&b| b == b'\n') {
                    Some(nl) => {
                        self.buf.drain(..=nl);
                        continue;
                    }
                    None => break,
                }
            }
            let Some(end) = json_end(&self.buf) else {
                if self.buf.len() > 8 << 20 {
                    self.buf.clear();
                }
                break;
            };
            if let Ok(Value::Array(items)) = serde_json::from_slice::<Value>(&self.buf[..end]) {
                out.extend(items.iter().filter_map(incoming));
            }
            self.buf.drain(..end);
        }
        out
    }
}

/// The length of the JSON array at the start of `buf`, once it is complete.
fn json_end(buf: &[u8]) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (i, &b) in buf.iter().enumerate() {
        if in_string {
            match (escaped, b) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'[' | b'{' => depth += 1,
            b']' | b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

fn incoming(item: &Value) -> Option<Incoming> {
    let aid = item.get(0)?.as_i64()?;
    let body = item.get(1)?.as_array()?;
    let name = body.first()?.as_str()?.to_string();
    Some(Incoming { aid, name, args: body[1..].to_vec() })
}

/// A command from the lounge, parsed.
#[derive(Clone, Debug, PartialEq)]
enum Command {
    SetPlaylist { video_id: Option<String>, ids: Vec<String>, index: Option<usize>, time: f64, list_id: String, params: String, ctt: String },
    UpdatePlaylist { ids: Vec<String>, list_id: String },
    SetVideo { video_id: String, time: f64 },
    Play,
    Pause,
    SeekTo(f64),
    SetVolume { volume: Option<i64>, delta: Option<i64>, muted: Option<bool> },
    Next,
    Previous,
    StopVideo,
    GetNowPlaying,
    GetVolume,
    RemoteConnected(Remote),
    RemoteDisconnected(Remote),
    /// Who is in the lounge, and which device just joined or left (`ui`: the user chose to).
    LoungeStatus { remotes: Vec<Remote>, event: Option<(String, bool)> },
    Sid(String),
    Gsession(String),
    Noop,
    Other(String),
}

/// A string argument (numbers and booleans as text).
fn arg(args: &[Value], key: &str) -> Option<String> {
    match args.first()?.get(key)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}

fn ids_of(text: &str) -> Vec<String> {
    text.split(',').map(str::trim).filter(|id| super::ytdlp::valid_id(id)).map(String::from).collect()
}

fn remote_of(v: &Value) -> Option<Remote> {
    let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    Some(Remote { id: text("id")?, name: text("name").or_else(|| text("clientName")).unwrap_or_else(|| "A phone".into()) })
}

fn parse_command(message: &Incoming) -> Command {
    let a = message.args.as_slice();
    let seconds = |k: &str| arg(a, k).and_then(|t| t.parse::<f64>().ok()).filter(|t| t.is_finite() && *t >= 0.0).unwrap_or(0.0);
    match message.name.as_str() {
        "c" => Command::Sid(a.first().and_then(Value::as_str).unwrap_or("").to_string()),
        "S" => Command::Gsession(a.first().and_then(Value::as_str).unwrap_or("").to_string()),
        "noop" => Command::Noop,
        "setPlaylist" => Command::SetPlaylist {
            video_id: arg(a, "videoId").filter(|id| super::ytdlp::valid_id(id)),
            ids: arg(a, "videoIds").map(|t| ids_of(&t)).unwrap_or_default(),
            index: arg(a, "currentIndex").and_then(|t| t.parse().ok()),
            time: seconds("currentTime"),
            list_id: arg(a, "listId").unwrap_or_default(),
            params: arg(a, "params").unwrap_or_default(),
            ctt: arg(a, "ctt").unwrap_or_default(),
        },
        "updatePlaylist" => Command::UpdatePlaylist { ids: arg(a, "videoIds").map(|t| ids_of(&t)).unwrap_or_default(), list_id: arg(a, "listId").unwrap_or_default() },
        "setVideo" => match arg(a, "videoId").filter(|id| super::ytdlp::valid_id(id)) {
            Some(video_id) => Command::SetVideo { video_id, time: seconds("currentTime") },
            None => Command::Other("setVideo".into()),
        },
        "play" => Command::Play,
        "pause" => Command::Pause,
        "seekTo" => Command::SeekTo(seconds("newTime")),
        "setVolume" => Command::SetVolume {
            volume: arg(a, "volume").and_then(|t| t.parse::<f64>().ok()).map(|v| v.round().clamp(0.0, 100.0) as i64),
            delta: arg(a, "delta").and_then(|t| t.parse::<f64>().ok()).map(|v| v.round() as i64),
            muted: arg(a, "muted").map(|t| t.eq_ignore_ascii_case("true")),
        },
        "next" => Command::Next,
        "previous" => Command::Previous,
        "stopVideo" => Command::StopVideo,
        "getNowPlaying" => Command::GetNowPlaying,
        "getVolume" => Command::GetVolume,
        "remoteConnected" | "remoteDisconnected" => match a.first().and_then(remote_of) {
            Some(r) if message.name == "remoteConnected" => Command::RemoteConnected(r),
            Some(r) => Command::RemoteDisconnected(r),
            None => Command::Other(message.name.clone()),
        },
        "loungeStatus" => {
            let devices: Vec<Value> = arg(a, "devices").and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
            let remotes = devices.iter().filter(|d| d.get("type").and_then(Value::as_str) == Some("REMOTE_CONTROL")).filter_map(remote_of).collect();
            let event = arg(a, "connectionEventDetails").and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|d| {
                let id = d.get("deviceId").and_then(Value::as_str)?.to_string();
                let ui = matches!(d.get("ui"), Some(Value::String(s)) if s == "true") || d.get("ui") == Some(&Value::Bool(true));
                Some((id, ui))
            });
            Command::LoungeStatus { remotes, event }
        }
        other => Command::Other(other.to_string()),
    }
}

// ---- what the screen tells the phone -------------------------------------------------------

/// A message to send: its name and arguments.
#[derive(Clone, Debug, PartialEq)]
struct Out {
    name: &'static str,
    args: Vec<(String, String)>,
}

fn out(name: &'static str, args: &[(&str, String)]) -> Out {
    Out { name, args: args.iter().map(|(k, v)| (k.to_string(), v.clone())).collect() }
}

fn secs(t: f64) -> String {
    format!("{:.3}", t.max(0.0))
}

/// The position now, counting time played since the last report.
fn position(p: &Playing) -> f64 {
    let t = if p.code == STATE_PLAYING { p.time + p.at.elapsed().as_secs_f64() } else { p.time };
    if p.duration > 0.0 { t.min(p.duration) } else { t }
}

fn state_args(p: &Playing) -> Vec<(&'static str, String)> {
    let loaded = if matches!(p.code, STATE_PLAYING | STATE_PAUSED | STATE_LOADING) { p.duration } else { 0.0 };
    vec![
        ("state", p.code.to_string()),
        ("currentTime", secs(position(p))),
        ("duration", secs(p.duration)),
        ("loadedTime", secs(loaded)),
        ("seekableStartTime", "0".into()),
        ("seekableEndTime", secs(p.duration)),
        ("cpn", p.cpn.clone()),
    ]
}

fn now_playing(queue: &Queue, playing: Option<&Playing>) -> Out {
    let Some(p) = playing else { return out("nowPlaying", &[]) };
    let mut args = state_args(p);
    args.push(("videoId", p.video_id.clone()));
    if !queue.list_id.is_empty() {
        args.push(("listId", queue.list_id.clone()));
    }
    if !queue.ids.is_empty() {
        args.push(("currentIndex", queue.index.to_string()));
    }
    if !queue.ctt.is_empty() {
        args.push(("ctt", queue.ctt.clone()));
    }
    if !queue.params.is_empty() {
        args.push(("params", queue.params.clone()));
    }
    out("nowPlaying", &args)
}

fn state_change(p: &Playing) -> Out {
    out("onStateChange", &state_args(p))
}

fn previous_next(queue: &Queue) -> Out {
    out("onHasPreviousNextChanged", &[("hasPrevious", queue.has_previous().to_string()), ("hasNext", queue.has_next().to_string())])
}

fn volume_message(volume: i64, muted: bool) -> Out {
    out("onVolumeChanged", &[("volume", volume.to_string()), ("muted", muted.to_string())])
}

fn autoplay_mode() -> Out {
    out("onAutoplayModeChanged", &[("autoplayMode", "UNSUPPORTED".into())])
}

/// The POST body for a batch of messages: `count`, `ofs`, `req0__sc`, `req0_<arg>`…
fn send_body(messages: &[Out], ofs: u64) -> String {
    let mut pairs: Vec<(String, String)> = vec![("count".into(), messages.len().to_string()), ("ofs".into(), ofs.to_string())];
    for (i, m) in messages.iter().enumerate() {
        pairs.push((format!("req{i}__sc"), m.name.to_string()));
        for (k, v) in &m.args {
            pairs.push((format!("req{i}_{k}"), v.clone()));
        }
    }
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in &pairs {
        s.append_pair(k, v);
    }
    s.finish()
}

fn send_locked(s: &State, messages: Vec<Out>) {
    if let Some(tx) = &s.outbox {
        for m in messages {
            let _ = tx.send(m);
        }
    }
}

// ---- threads -------------------------------------------------------------------------------

/// Sleeps up to `total`, waking early when the receiver stops.
fn nap(generation: u64, total: Duration) {
    let until = Instant::now() + total;
    while super::alive(generation) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(200).min(until.saturating_duration_since(Instant::now())));
    }
}

/// Connects to the lounge and keeps the long poll open, reconnecting as needed.
fn lounge_loop(generation: u64) {
    let mut failures: u32 = 0;
    while super::alive(generation) {
        match connect(generation) {
            Ok(()) => {
                failures = 0;
                poll(generation);
            }
            Err(e) => {
                note_error(generation, e);
                failures = (failures + 1).min(6);
                nap(generation, Duration::from_secs(2u64.pow(failures).min(60)));
            }
        }
    }
}

/// Screen id, lounge token and a fresh bind session.
fn connect(generation: u64) -> Result<(), String> {
    let (identity, token) = with_state(generation, |s| (s.identity.clone(), s.token.clone())).ok_or("stopped")?;
    let mut identity = match identity.or_else(load_identity) {
        Some(i) => i,
        None => {
            let i = Identity { screen_id: generate_screen_id()?, device_id: random_uuid() };
            save_identity(&i);
            i
        }
    };
    let token = match token {
        Some(t) => t,
        None => match lounge_token(&identity.screen_id)? {
            Some(t) => t,
            None => {
                // YouTube forgot the screen: make a new one.
                identity = Identity { screen_id: generate_screen_id()?, device_id: identity.device_id };
                save_identity(&identity);
                lounge_token(&identity.screen_id)?.ok_or("YouTube gave no lounge token")?
            }
        },
    };
    with_state(generation, |s| {
        s.identity = Some(identity.clone());
        s.token = Some(token.clone());
    })
    .ok_or("stopped")?;

    let rid = 41_000 + u64::from(random_text(2).bytes().map(u32::from).sum::<u32>() % 8_000);
    let query = bind_query(&identity, &token, &[("deviceInfo", DEVICE_INFO.into()), ("RID", rid.to_string()), ("CVER", "1".into())]);
    let (status, text) = post(&format!("{API}/bc/bind?{query}"), "count=0")?;
    if status == 401 || status == 410 {
        with_state(generation, |s| s.token = None);
        return Err(format!("the lounge token expired ({status})"));
    }
    if status != 200 {
        return Err(format!("the lounge answered {status}"));
    }
    let messages = ChunkParser::default().push(text.as_bytes());
    // The first message POST must carry the next RID after the bind (`post_messages` adds 1 first);
    // a gap makes the lounge hold it and refuse the next one with RID_OUTSIDE_WINDOW.
    let mut channel = Channel { sid: String::new(), gsession: String::new(), rid, ofs: 0, aid: -1 };
    for m in &messages {
        channel.aid = channel.aid.max(m.aid);
        match parse_command(m) {
            Command::Sid(sid) => channel.sid = sid,
            Command::Gsession(g) => channel.gsession = g,
            _ => {}
        }
    }
    if channel.sid.is_empty() || channel.gsession.is_empty() {
        return Err("the lounge gave no session".into());
    }
    let pending = with_state(generation, |s| {
        s.channel = Some(channel);
        s.last_error = None;
        std::mem::take(&mut s.pending_pairing)
    })
    .ok_or("stopped")?;
    for code in pending {
        let identity = identity.clone();
        std::thread::spawn(move || register_pairing_code(generation, &identity, &code));
    }
    for m in messages {
        handle(generation, &m);
    }
    Ok(())
}

/// The long poll: reads the lounge's messages until the session must be made again.
fn poll(generation: u64) {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .timeout_recv_body(Some(POLL_BUDGET))
        .http_status_as_error(false)
        .build()
        .into();
    let mut failures = 0u32;
    while super::alive(generation) {
        let Some(url) = with_state(generation, |s| {
            let (identity, token, channel) = (s.identity.as_ref()?, s.token.as_ref()?, s.channel.as_ref()?);
            let extra = [("RID", "rpc".to_string()), ("SID", channel.sid.clone()), ("CI", "0".into()), ("AID", channel.aid.to_string()), ("gsessionid", channel.gsession.clone()), ("TYPE", "xmlhttp".into())];
            Some(format!("{API}/bc/bind?{}", bind_query(identity, token, &extra)))
        })
        .flatten() else {
            return;
        };
        let response = match agent.get(&url).call() {
            Ok(r) => r,
            Err(e) => {
                failures += 1;
                if failures > 3 {
                    note_error(generation, format!("the lounge stopped answering: {e}"));
                    return;
                }
                nap(generation, Duration::from_secs(2 * u64::from(failures)));
                continue;
            }
        };
        debug(|| format!("long poll opened: {}", response.status().as_u16()));
        match response.status().as_u16() {
            200 => failures = 0,
            400 => return, // "Unknown SID": bind again
            401 | 410 => {
                with_state(generation, |s| s.token = None);
                return;
            }
            status => {
                failures += 1;
                if failures > 3 {
                    note_error(generation, format!("the lounge answered {status}"));
                    return;
                }
                nap(generation, Duration::from_secs(2 * u64::from(failures)));
                continue;
            }
        }
        let mut reader = response.into_body().into_reader();
        let mut parser = ChunkParser::default();
        let mut buf = [0u8; 8192];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            for m in parser.push(&buf[..n]) {
                if with_state(generation, |s| {
                    if let Some(c) = s.channel.as_mut() {
                        c.aid = c.aid.max(m.aid);
                    }
                })
                .is_none()
                {
                    return;
                }
                handle(generation, &m);
            }
        }
    }
}

/// Sends queued messages in small batches.
fn sender_loop(generation: u64, rx: mpsc::Receiver<Out>) {
    let mut queue: Vec<Out> = Vec::new();
    let mut failures = 0u32;
    while super::alive(generation) {
        match rx.recv_timeout(Duration::from_millis(400)) {
            Ok(m) => queue.push(m),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        if queue.is_empty() {
            continue;
        }
        std::thread::sleep(Duration::from_millis(20));
        queue.extend(rx.try_iter());
        if queue.len() > 64 {
            queue.drain(..queue.len() - 64);
        }
        match post_messages(generation, &queue) {
            Ok(true) => {
                queue.clear();
                failures = 0;
            }
            // No session yet: keep them for when there is one.
            Ok(false) => nap(generation, Duration::from_millis(500)),
            Err(e) => {
                failures += 1;
                if failures >= 3 {
                    eprintln!("[cast] YouTube: dropped {} messages: {e}", queue.len());
                    queue.clear();
                    failures = 0;
                }
                nap(generation, Duration::from_secs(1));
            }
        }
    }
}

/// POSTs `messages` on the bind session. Ok(false) when there is no session.
fn post_messages(generation: u64, messages: &[Out]) -> Result<bool, String> {
    let Some(Some((url, body))) = with_state(generation, |s| {
        let (identity, token, channel) = (s.identity.as_ref()?, s.token.as_ref()?, s.channel.as_mut()?);
        channel.rid += 1;
        let extra = [("deviceInfo", DEVICE_INFO.to_string()), ("SID", channel.sid.clone()), ("RID", channel.rid.to_string()), ("AID", channel.aid.to_string()), ("gsessionid", channel.gsession.clone())];
        Some((format!("{API}/bc/bind?{}", bind_query(identity, token, &extra)), send_body(messages, channel.ofs)))
    }) else {
        return Ok(false);
    };
    let (status, text) = post(&url, &body)?;
    debug(|| format!("sent {:?} → {status} {}", messages.iter().map(|m| m.name).collect::<Vec<_>>(), text.chars().take(200).collect::<String>()));
    match status {
        200 => {
            with_state(generation, |s| {
                if let Some(c) = s.channel.as_mut() {
                    c.ofs += messages.len() as u64;
                }
            });
            Ok(true)
        }
        400 | 401 | 410 => {
            // The session is gone; the long poll notices too and binds again.
            with_state(generation, |s| s.channel = None);
            Ok(false)
        }
        status => Err(format!("the lounge answered {status}")),
    }
}

/// Tells the phones the screen left (the receiver stopped).
fn farewell(old: &State) {
    let (Some(identity), Some(token), Some(channel)) = (old.identity.clone(), old.token.clone(), old.channel.clone()) else { return };
    std::thread::spawn(move || {
        let extra = [("deviceInfo", DEVICE_INFO.to_string()), ("SID", channel.sid.clone()), ("RID", (channel.rid + 1).to_string()), ("AID", channel.aid.to_string()), ("gsessionid", channel.gsession.clone())];
        let url = format!("{API}/bc/bind?{}", bind_query(&identity, &token, &extra));
        let _ = post(&url, &send_body(&[out("loungeScreenDisconnected", &[])], channel.ofs));
    });
}

/// Once a second: follow the player, report changes, move on through the queue, and keep the TV
/// code fresh while the page shows it.
fn status_loop(generation: u64) {
    let mut last_code_try: Option<Instant> = None;
    while super::alive(generation) {
        std::thread::sleep(Duration::from_secs(1));
        if !super::alive(generation) {
            break;
        }
        tick(generation);

        let want_code = with_state(generation, |s| {
            let wanted = s.code_wanted.is_some_and(|t| t.elapsed() < CODE_WANTED_FOR);
            let stale = s.code.as_ref().is_none_or(|(_, at)| at.elapsed() >= CODE_REFRESH);
            match (&s.identity, &s.token, &s.channel) {
                (Some(id), Some(token), Some(_)) if wanted && stale => Some((id.clone(), token.clone())),
                _ => None,
            }
        })
        .flatten();
        if let Some((identity, token)) = want_code {
            if last_code_try.is_none_or(|t| t.elapsed() > Duration::from_secs(20)) {
                last_code_try = Some(Instant::now());
                match fetch_pairing_code(&identity, &token) {
                    Ok(code) => {
                        with_state(generation, |s| s.code = Some((code, Instant::now())));
                    }
                    Err(e) => note_error(generation, e),
                }
            }
        }
    }
    // The receiver went off (and no new one took over): say goodbye.
    let mut slot = state();
    if let Some(s) = slot.as_mut().filter(|s| s.generation == generation) {
        farewell(s);
        s.channel = None;
    }
}

fn code_of(state: PlayState) -> i32 {
    match state {
        PlayState::Loading | PlayState::Buffering => STATE_LOADING,
        PlayState::Playing => STATE_PLAYING,
        PlayState::Paused => STATE_PAUSED,
        PlayState::Ended => STATE_ENDED,
        PlayState::Idle | PlayState::Error => STATE_STOPPED,
    }
}

/// Follows the hub's session for the video that plays.
fn tick(generation: u64) {
    let Some(Some((session, volume_session))) = with_state(generation, |s| {
        let p = s.playing.as_ref();
        Some((p.and_then(|p| p.session), p.and_then(|p| p.session).unwrap_or(0)))
    }) else {
        return;
    };
    let status = super::status(volume_session);
    let mut advance = false;
    with_state(generation, |s| {
        let mut messages = Vec::new();
        let volume = ((status.volume * 100.0).round() as i64, status.muted);
        if s.volume.is_some_and(|v| v != volume) || (s.volume.is_none() && session.is_some()) {
            messages.push(volume_message(volume.0, volume.1));
        }
        s.volume = Some(volume);
        let queue = s.queue.clone();
        if let (Some(_), Some(p)) = (session, s.playing.as_mut().filter(|p| p.session == session)) {
            let code = code_of(status.state);
            let time = status.time_ms as f64 / 1000.0;
            let length = status.length_ms as f64 / 1000.0;
            let new_length = length > 0.0 && (length - p.duration).abs() > 1.0;
            if length > 0.0 {
                p.duration = length;
            }
            // A position the phone wouldn't expect (a seek, a stall) is reported too.
            let jumped = matches!(code, STATE_PLAYING | STATE_PAUSED) && status.time_ms > 0 && (position(p) - time).abs() > 2.5;
            if code != p.code || jumped || new_length {
                let was_loading = p.code == STATE_LOADING;
                p.code = code;
                if status.time_ms > 0 || code != STATE_PLAYING {
                    p.time = if code == STATE_ENDED { p.duration } else { time };
                }
                p.at = Instant::now();
                messages.push(state_change(p));
                if new_length || (was_loading && code == STATE_PLAYING) {
                    messages.push(now_playing(&queue, Some(p)));
                }
            }
            match status.state {
                PlayState::Ended | PlayState::Error if queue.has_next() => advance = true,
                PlayState::Idle | PlayState::Error => p.session = None,
                _ => {}
            }
        }
        send_locked(s, messages);
    });
    if advance {
        step(generation, 1);
    }
}

// ---- commands ------------------------------------------------------------------------------

fn handle(generation: u64, message: &Incoming) {
    debug(|| format!("got {} {} {}", message.aid, message.name, Value::Array(message.args.clone()).to_string().chars().take(300).collect::<String>()));
    let command = parse_command(message);
    match &command {
        Command::Noop | Command::Sid(_) | Command::Gsession(_) => {}
        Command::Other(name) => eprintln!("[cast] YouTube: ignored {name}"),
        _ => eprintln!("[cast] YouTube: {}", message.name),
    }
    apply(generation, command);
}

fn apply(generation: u64, command: Command) {
    match command {
        Command::SetPlaylist { video_id, ids, index, time, list_id, params, ctt } => {
            let ids = if ids.is_empty() { video_id.iter().cloned().collect() } else { ids };
            let index = index.filter(|&i| i < ids.len()).or_else(|| video_id.as_ref().and_then(|v| ids.iter().position(|id| id == v))).unwrap_or(0);
            let Some(video) = ids.get(index).cloned() else {
                return apply(generation, Command::StopVideo);
            };
            let same = with_state(generation, |s| {
                let same = s.playing.as_ref().is_some_and(|p| p.video_id == video && (p.resolving || p.session.is_some_and(super::is_current))) && s.queue.index == index;
                s.queue = Queue { list_id, ids, index, params, ctt };
                if same {
                    let messages = vec![now_playing(&s.queue, s.playing.as_ref()), previous_next(&s.queue)];
                    send_locked(s, messages);
                }
                same
            });
            if same == Some(false) {
                load(generation, video, time);
            }
        }
        Command::UpdatePlaylist { ids, list_id } => {
            with_state(generation, |s| {
                let current = s.playing.as_ref().map(|p| p.video_id.clone());
                s.queue.index = current.and_then(|v| ids.iter().position(|id| *id == v)).unwrap_or(s.queue.index.min(ids.len().saturating_sub(1)));
                s.queue.ids = ids;
                s.queue.list_id = list_id;
                let messages = vec![now_playing(&s.queue, s.playing.as_ref()), previous_next(&s.queue)];
                send_locked(s, messages);
            });
        }
        Command::SetVideo { video_id, time } => {
            with_state(generation, |s| s.queue = Queue { ids: vec![video_id.clone()], ..Queue::default() });
            load(generation, video_id, time);
        }
        Command::Play | Command::Pause => {
            let pause = command == Command::Pause;
            // While yt-dlp works there's nothing to play or pause yet.
            let target = with_state(generation, |s| s.playing.as_ref().filter(|p| !p.resolving).map(|p| (p.session, p.video_id.clone(), position(p)))).flatten();
            match target {
                Some((Some(session), _, _)) if super::is_current(session) => {
                    super::set_paused(session, pause);
                }
                // Stopped or ended: play it again.
                Some((_, video, time)) if !pause => load(generation, video, if time > 1.0 { time } else { 0.0 }),
                _ => {}
            }
        }
        Command::SeekTo(t) => {
            let session = with_state(generation, |s| {
                let p = s.playing.as_mut()?;
                p.time = t;
                p.at = Instant::now();
                let message = state_change(p);
                let session = p.session;
                send_locked(s, vec![message]);
                session
            })
            .flatten();
            if let Some(session) = session {
                super::seek(session, (t * 1000.0) as i64);
            }
        }
        Command::SetVolume { volume, delta, muted } => {
            let session = with_state(generation, |s| s.playing.as_ref().and_then(|p| p.session)).flatten().unwrap_or(0);
            let now = super::status(session);
            let current = (now.volume * 100.0).round() as i64;
            let level = volume.or(delta.map(|d| current + d)).unwrap_or(current).clamp(0, 100);
            let muted = muted.unwrap_or(now.muted);
            // The hub acts on the session that plays; with none, there's nothing to turn.
            if super::is_current(session) {
                super::set_volume(session, level as f64 / 100.0);
                super::set_muted(session, muted);
            }
            with_state(generation, |s| {
                s.volume = Some((level, muted));
                send_locked(s, vec![volume_message(level, muted)]);
            });
        }
        Command::Next => step(generation, 1),
        Command::Previous => step(generation, -1),
        Command::StopVideo => {
            let session = with_state(generation, |s| {
                let p = s.playing.as_mut()?;
                let session = p.session.take();
                p.resolving = false;
                p.request = u64::MAX;
                p.code = STATE_STOPPED;
                p.time = 0.0;
                p.at = Instant::now();
                let messages = vec![state_change(p)];
                send_locked(s, messages);
                session
            })
            .flatten();
            if let Some(session) = session {
                super::stop(session);
            }
        }
        Command::GetNowPlaying => {
            with_state(generation, |s| send_locked(s, vec![now_playing(&s.queue, s.playing.as_ref())]));
        }
        Command::GetVolume => {
            let session = with_state(generation, |s| s.playing.as_ref().and_then(|p| p.session)).flatten().unwrap_or(0);
            let now = super::status(session);
            with_state(generation, |s| send_locked(s, vec![volume_message((now.volume * 100.0).round() as i64, now.muted)]));
        }
        Command::RemoteConnected(remote) => connected(generation, remote),
        Command::RemoteDisconnected(remote) => {
            with_state(generation, |s| s.remotes.retain(|r| r.id != remote.id));
        }
        Command::LoungeStatus { remotes, event } => {
            let known: Vec<String> = with_state(generation, |s| s.remotes.iter().map(|r| r.id.clone()).collect()).unwrap_or_default();
            // The first status names the screen itself; only phones' comings and goings count.
            let event = event.filter(|(id, _)| known.contains(id) || remotes.iter().any(|r| r.id == *id));
            match event {
                Some((id, _)) if !known.contains(&id) => {
                    with_state(generation, |s| s.remotes = remotes.iter().filter(|r| r.id != id).cloned().collect());
                    if let Some(remote) = remotes.iter().find(|r| r.id == id).cloned() {
                        connected(generation, remote);
                    }
                }
                Some((id, explicit)) => {
                    let left = !remotes.iter().any(|r| r.id == id);
                    let empty = remotes.is_empty();
                    with_state(generation, |s| s.remotes = remotes);
                    // The last phone chose to disconnect: the TV stops, as a TV does.
                    if left && explicit && empty {
                        apply(generation, Command::StopVideo);
                    }
                }
                None => {
                    with_state(generation, |s| {
                        s.remotes = remotes;
                        let messages = vec![previous_next(&s.queue), now_playing(&s.queue, s.playing.as_ref()), autoplay_mode()];
                        send_locked(s, messages);
                    });
                }
            }
        }
        Command::Other(name) if name == "getSubtitlesTrack" => {
            // No captions on the PC; phones accept an empty answer.
            with_state(generation, |s| {
                let video = s.playing.as_ref().map(|p| p.video_id.clone()).unwrap_or_default();
                send_locked(s, vec![out("onSubtitlesTrackChanged", &[("videoId", video)])]);
            });
        }
        Command::Sid(_) | Command::Gsession(_) | Command::Noop | Command::Other(_) => {}
    }
}

/// A phone joined: tell it what plays.
fn connected(generation: u64, remote: Remote) {
    let session = with_state(generation, |s| s.playing.as_ref().and_then(|p| p.session)).flatten().unwrap_or(0);
    let now = super::status(session);
    with_state(generation, |s| {
        // loungeStatus and remoteConnected both announce a phone; greet it once.
        if s.remotes.iter().any(|r| r.id == remote.id) {
            return;
        }
        s.remotes.push(remote);
        let mut messages = vec![previous_next(&s.queue), now_playing(&s.queue, s.playing.as_ref())];
        if let Some(p) = &s.playing {
            messages.push(state_change(p));
        }
        messages.push(volume_message((now.volume * 100.0).round() as i64, now.muted));
        messages.push(autoplay_mode());
        send_locked(s, messages);
    });
}

/// Next (+1) or previous (-1) in the phone's queue.
fn step(generation: u64, by: i64) {
    let target = with_state(generation, |s| {
        let i = s.queue.index as i64 + by;
        if i < 0 || i >= s.queue.ids.len() as i64 {
            return None;
        }
        s.queue.index = i as usize;
        Some(s.queue.ids[i as usize].clone())
    })
    .flatten();
    if let Some(video) = target {
        load(generation, video, 0.0);
    }
}

/// Starts loading `video_id`: reports "loading" now, and resolves it on a worker thread.
fn load(generation: u64, video_id: String, start: f64) {
    let Some((request, old)) = with_state(generation, |s| {
        s.next_request += 1;
        let request = s.next_request;
        let old = s.playing.as_ref().and_then(|p| p.session);
        let p = Playing { video_id: video_id.clone(), cpn: random_text(16), request, session: None, resolving: true, code: STATE_LOADING, time: start, at: Instant::now(), duration: 0.0, live: false };
        let messages = vec![now_playing(&s.queue, Some(&p)), state_change(&p), previous_next(&s.queue)];
        s.playing = Some(p);
        s.stopped = false;
        send_locked(s, messages);
        (request, old)
    }) else {
        return;
    };
    // The old video waits quietly while the new one resolves.
    if let Some(old) = old.filter(|&o| super::is_current(o)) {
        super::set_paused(old, true);
    }
    let _ = std::thread::Builder::new().name("cast-yt-resolve".into()).spawn(move || {
        let result = super::ytdlp::resolve(&video_id);
        let mut failed_with_next = false;
        with_state(generation, |s| {
            let (sender, sender_key) = match s.remotes.last() {
                Some(r) => (r.name.clone(), format!("youtube:{}", r.id)),
                None => ("YouTube".to_string(), "youtube:remote".to_string()),
            };
            let has_next = s.queue.has_next();
            let Some(p) = s.playing.as_mut().filter(|p| p.request == request) else { return };
            p.resolving = false;
            match result {
                Ok(r) => {
                    eprintln!("[cast] YouTube: playing {video_id} as {}", r.formats);
                    p.live = r.live;
                    p.duration = r.duration_ms as f64 / 1000.0;
                    let media = Media {
                        url: r.url,
                        title: r.title,
                        subtitle: r.channel,
                        artwork: r.thumbnail,
                        start_ms: if r.live { 0 } else { (start * 1000.0) as i64 },
                        live: r.live,
                        options: r.options,
                        sender,
                        sender_key,
                    };
                    p.session = Some(super::play(Source::Youtube, media));
                }
                Err(e) => {
                    eprintln!("[cast] YouTube: couldn't play {video_id}: {e}");
                    p.code = STATE_STOPPED;
                    p.at = Instant::now();
                    let message = state_change(p);
                    s.last_error = Some(e);
                    failed_with_next = has_next;
                    send_locked(s, vec![message]);
                }
            }
        });
        if failed_with_next {
            step(generation, 1);
        }
    });
}

// ---- tests ---------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    fn request(method: &str, path: &str, origin: Option<&str>, body: &str) -> Request {
        let mut headers = vec![("host".to_string(), "192.168.1.5:47213".to_string())];
        if let Some(o) = origin {
            headers.push(("origin".into(), o.into()));
        }
        Request {
            method: method.into(),
            path: path.into(),
            query: String::new(),
            headers,
            body: body.as_bytes().to_vec(),
            peer: "192.168.1.20:5000".parse::<SocketAddr>().unwrap(),
            local: "192.168.1.5:47213".parse::<SocketAddr>().unwrap(),
        }
    }

    fn info() -> DialInfo {
        DialInfo { name: "Zazabor on desk & co".into(), uuid: dial_uuid("abc"), identity: Some(Identity { screen_id: "scr123".into(), device_id: "dev-1".into() }), running: true }
    }

    fn header<'a>(r: &'a Response, name: &str) -> Option<&'a str> {
        r.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    #[test]
    fn dial_uuid_is_stable_and_not_the_dlna_one() {
        let id = "6f1c2d3e-0000-4000-8000-0123456789ab";
        let u = dial_uuid(id);
        assert_eq!(u, dial_uuid(id));
        assert_ne!(u, id);
        assert_eq!(u.len(), 36);
        assert_eq!(u.matches('-').count(), 4);
        let a = adverts(&Settings { name: "x".into(), id: id.into() });
        assert_eq!(a[0].device_type, DEVICE_TYPE);
        assert_eq!(a[0].services, vec![DIAL_SERVICE.to_string()]);
        assert_eq!(a[0].location, "/dial/dd.xml");
        assert_eq!(a[0].uuid, u);
    }

    #[test]
    fn serves_the_device_description() {
        let (r, action) = serve_dial(&request("GET", "/dial/dd.xml", None, ""), &info());
        assert_eq!(r.status, 200);
        assert_eq!(header(&r, "Application-URL"), Some("http://192.168.1.5:47213/apps/"));
        let xml = String::from_utf8(r.body).unwrap();
        assert!(xml.contains("<deviceType>urn:dial-multiscreen-org:device:dial:1</deviceType>"));
        assert!(xml.contains("<friendlyName>Zazabor on desk &amp; co</friendlyName>"));
        assert!(xml.contains(&format!("<UDN>uuid:{}</UDN>", dial_uuid("abc"))));
        assert!(xml.contains("urn:dial-multiscreen-org:service:dial:1"));
        assert!(action.is_none());
        assert_eq!(serve_dial(&request("POST", "/dial/dd.xml", None, ""), &info()).0.status, 405);
    }

    #[test]
    fn serves_the_app_state_with_the_screen_id() {
        let (r, _) = serve_dial(&request("GET", "/apps/YouTube", None, ""), &info());
        assert_eq!(r.status, 200);
        let xml = String::from_utf8(r.body).unwrap();
        assert!(xml.contains(r#"<service xmlns="urn:dial-multiscreen-org:schemas:dial" dialVer="2.1">"#));
        assert!(xml.contains("<name>YouTube</name>"));
        assert!(xml.contains("<state>running</state>"));
        assert!(xml.contains(r#"<link rel="run" href="run"/>"#));
        assert!(xml.contains("<additionalData><screenId>scr123</screenId><theme>cl</theme><deviceId>dev-1</deviceId>"));
        assert!(xml.contains(r#"<options allowStop="true"/>"#));

        let stopped = DialInfo { identity: None, running: false, ..info() };
        let xml = String::from_utf8(serve_dial(&request("GET", "/apps/YouTube", None, ""), &stopped).0.body).unwrap();
        assert!(xml.contains("<state>stopped</state>") && !xml.contains("<link") && !xml.contains("additionalData"));

        assert_eq!(serve_dial(&request("GET", "/apps/Netflix", None, ""), &info()).0.status, 404);
    }

    #[test]
    fn launches_with_a_pairing_code() {
        let (r, action) = serve_dial(&request("POST", "/apps/YouTube", None, "pairingCode=0f0e-uuid&theme=cl&v=jNQXAC9IVRw&t=0"), &info());
        assert_eq!(r.status, 201);
        assert_eq!(header(&r, "LOCATION"), Some("http://192.168.1.5:47213/apps/YouTube/run"));
        assert_eq!(action, Some(DialAction::Launch { pairing_code: Some("0f0e-uuid".into()), theme: "cl".into() }));

        let big = "x".repeat(MAX_LAUNCH_BODY + 1);
        assert_eq!(serve_dial(&request("POST", "/apps/YouTube", None, &big), &info()).0.status, 413);

        let (r, action) = serve_dial(&request("DELETE", "/apps/YouTube/run", None, ""), &info());
        assert_eq!((r.status, action), (200, Some(DialAction::Stop)));
        assert_eq!(serve_dial(&request("DELETE", "/apps/YouTube/other", None, ""), &info()).0.status, 404);
        assert_eq!(serve_dial(&request("PUT", "/apps/YouTube", None, ""), &info()).0.status, 405);
    }

    #[test]
    fn checks_the_origin() {
        // Web pages from elsewhere are refused.
        for bad in ["http://evil.example", "https://evil.example", "https://youtube.com.evil.example", "file://", "null", "http://www.youtube.com"] {
            let (r, action) = serve_dial(&request("POST", "/apps/YouTube", Some(bad), "pairingCode=x"), &info());
            assert_eq!(r.status, 403, "{bad}");
            assert!(action.is_none());
        }
        // The YouTube site and native apps are allowed, with CORS headers.
        for good in ["https://www.youtube.com", "https://youtube.com", "package:com.google.android.youtube"] {
            let (r, _) = serve_dial(&request("GET", "/apps/YouTube", Some(good), ""), &info());
            assert_eq!(r.status, 200, "{good}");
            assert_eq!(header(&r, "Access-Control-Allow-Origin"), Some(good));
        }
        let (r, _) = serve_dial(&request("OPTIONS", "/apps/YouTube", Some("https://www.youtube.com"), ""), &info());
        assert_eq!(r.status, 204);
        assert!(header(&r, "Access-Control-Allow-Methods").unwrap().contains("DELETE"));
        // No Origin: no CORS headers.
        let (r, _) = serve_dial(&request("GET", "/apps/YouTube", None, ""), &info());
        assert!(header(&r, "Access-Control-Allow-Origin").is_none());
    }

    #[test]
    fn parses_chunked_bind_responses() {
        let body = "60\n[[0,[\"c\",\"SID123\",\"\",8]\n]\n,[1,[\"S\",\"GS456\"]]\n]\n72\n[[2,[\"loungeStatus\",{\"devices\":\"[]\",\"queueId\":\"q\"}]],[3,[\"noop\"]]]\n";
        let mut p = ChunkParser::default();
        let messages = p.push(body.as_bytes());
        assert_eq!(messages.iter().map(|m| (m.aid, m.name.as_str())).collect::<Vec<_>>(), vec![(0, "c"), (1, "S"), (2, "loungeStatus"), (3, "noop")]);
        assert_eq!(parse_command(&messages[0]), Command::Sid("SID123".into()));
        assert_eq!(parse_command(&messages[1]), Command::Gsession("GS456".into()));

        // Split anywhere, with brackets and non-ASCII inside strings.
        let chunk = "47\n[[7,[\"remoteConnected\",{\"name\":\"Pixel ]\\\" 7 ünï\",\"id\":\"r1\"}]]]\n";
        let mut p = ChunkParser::default();
        let mut got = Vec::new();
        for piece in chunk.as_bytes().chunks(5) {
            got.extend(p.push(piece));
        }
        assert_eq!(got.len(), 1);
        assert_eq!(parse_command(&got[0]), Command::RemoteConnected(Remote { id: "r1".into(), name: "Pixel ]\" 7 ünï".into() }));
        // Junk before a chunk is skipped.
        assert_eq!(ChunkParser::default().push(b")]}'\n12\n[[9,[\"noop\"]]]").len(), 1);
    }

    fn msg(name: &str, args: Value) -> Incoming {
        Incoming { aid: 1, name: name.into(), args: vec![args] }
    }

    #[test]
    fn parses_commands() {
        assert_eq!(
            parse_command(&msg("setPlaylist", json!({"videoId": "bbbbbbbbbbb", "videoIds": "aaaaaaaaaaa,bbbbbbbbbbb,bad id", "currentIndex": "1", "currentTime": "12.5", "listId": "RQabc", "params": "p", "ctt": "c"}))),
            Command::SetPlaylist { video_id: Some("bbbbbbbbbbb".into()), ids: vec!["aaaaaaaaaaa".into(), "bbbbbbbbbbb".into()], index: Some(1), time: 12.5, list_id: "RQabc".into(), params: "p".into(), ctt: "c".into() }
        );
        // pyytlounge's play_video sends just the id.
        assert_eq!(
            parse_command(&msg("setPlaylist", json!({"videoId": "jNQXAC9IVRw"}))),
            Command::SetPlaylist { video_id: Some("jNQXAC9IVRw".into()), ids: vec![], index: None, time: 0.0, list_id: String::new(), params: String::new(), ctt: String::new() }
        );
        assert_eq!(parse_command(&msg("seekTo", json!({"newTime": 42}))), Command::SeekTo(42.0));
        assert_eq!(parse_command(&msg("seekTo", json!({"newTime": "7.25"}))), Command::SeekTo(7.25));
        assert_eq!(parse_command(&msg("setVolume", json!({"volume": "35", "muted": "true"}))), Command::SetVolume { volume: Some(35), delta: None, muted: Some(true) });
        assert_eq!(parse_command(&msg("setVolume", json!({"delta": "-5"}))), Command::SetVolume { volume: None, delta: Some(-5), muted: None });
        assert_eq!(parse_command(&msg("setVideo", json!({"videoId": "jNQXAC9IVRw", "currentTime": "3"}))), Command::SetVideo { video_id: "jNQXAC9IVRw".into(), time: 3.0 });
        assert_eq!(parse_command(&Incoming { aid: 2, name: "pause".into(), args: vec![] }), Command::Pause);
        assert_eq!(parse_command(&Incoming { aid: 2, name: "dpadCommand".into(), args: vec![] }), Command::Other("dpadCommand".into()));

        let devices = json!([
            {"type": "LOUNGE_SCREEN", "name": "Zazabor", "id": "s"},
            {"type": "REMOTE_CONTROL", "name": "Pixel 7", "id": "r1", "user": "Someone"}
        ])
        .to_string();
        let status = msg("loungeStatus", json!({"devices": devices, "connectionEventDetails": "{\"deviceId\":\"r1\",\"ui\":\"true\"}"}));
        assert_eq!(parse_command(&status), Command::LoungeStatus { remotes: vec![Remote { id: "r1".into(), name: "Pixel 7".into() }], event: Some(("r1".into(), true)) });
        assert_eq!(parse_command(&msg("loungeStatus", json!({"devices": "[]"}))), Command::LoungeStatus { remotes: vec![], event: None });
    }

    #[test]
    fn builds_outgoing_messages() {
        let queue = Queue { list_id: "RQx".into(), ids: vec!["aaaaaaaaaaa".into(), "bbbbbbbbbbb".into()], index: 0, ..Queue::default() };
        let p = Playing { video_id: "aaaaaaaaaaa".into(), cpn: "cpn1".into(), request: 1, session: Some(3), resolving: false, code: STATE_PAUSED, time: 4.0, at: Instant::now(), duration: 9.5, live: false };
        let np = now_playing(&queue, Some(&p));
        let get = |o: &Out, k: &str| o.args.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
        assert_eq!(get(&np, "videoId").as_deref(), Some("aaaaaaaaaaa"));
        assert_eq!(get(&np, "state").as_deref(), Some("2"));
        assert_eq!(get(&np, "currentTime").as_deref(), Some("4.000"));
        assert_eq!(get(&np, "duration").as_deref(), Some("9.500"));
        assert_eq!(get(&np, "listId").as_deref(), Some("RQx"));
        assert_eq!(get(&np, "currentIndex").as_deref(), Some("0"));
        assert!(now_playing(&queue, None).args.is_empty());
        let pn = previous_next(&queue);
        assert_eq!(pn.args, vec![("hasPrevious".to_string(), "false".to_string()), ("hasNext".to_string(), "true".to_string())]);

        let body = send_body(&[volume_message(40, false), state_change(&p)], 7);
        assert!(body.starts_with("count=2&ofs=7&req0__sc=onVolumeChanged&req0_volume=40&req0_muted=false&req1__sc=onStateChange&req1_state=2"));
    }

    #[test]
    fn position_runs_while_playing() {
        let mut p = Playing { video_id: "a".into(), cpn: String::new(), request: 0, session: None, resolving: false, code: STATE_PLAYING, time: 2.0, at: Instant::now() - Duration::from_secs(3), duration: 4.0, live: false };
        assert_eq!(position(&p), 4.0);
        p.code = STATE_PAUSED;
        assert_eq!(position(&p), 2.0);
    }

    #[test]
    fn formats_tv_codes() {
        assert_eq!(format_code("123456789012"), "123 456 789 012");
    }

    /// Installs the state for `generation` without the lounge threads (DIAL only).
    fn install(generation: u64, settings: &Settings, identity: Option<Identity>) {
        *state() = Some(State {
            generation,
            name: settings.name.clone(),
            dial_uuid: dial_uuid(&settings.id),
            identity,
            token: None,
            channel: None,
            outbox: None,
            pending_pairing: Vec::new(),
            code: None,
            code_wanted: None,
            remotes: Vec::new(),
            queue: Queue::default(),
            playing: None,
            next_request: 0,
            volume: None,
            stopped: false,
            last_error: None,
        });
    }

    fn local_agent() -> ureq::Agent {
        ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).http_status_as_error(false).build().into()
    }

    /// Finds the DIAL server the way a phone does: M-SEARCH, the description, then the app.
    /// Binds UDP 1900 (shared) and the receiver's web port, so it is opt-in.
    #[test]
    #[ignore = "uses the network: SSDP multicast on this machine"]
    fn dial_discovery_on_this_machine() {
        let generation = super::super::testing::begin();
        let settings = Settings { name: "Zazabor discovery test".into(), id: random_uuid() };
        install(generation, &settings, Some(Identity { screen_id: "test-screen".into(), device_id: "test-device".into() }));
        let server = http::start(generation).expect("web server");
        eprintln!("web server on port {}", server.port);
        ssdp::start(generation, server.port, adverts(&settings)).expect("ssdp");
        let uuid = dial_uuid(&settings.id);

        let socket = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
        socket.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
        let search = format!("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: {DIAL_SERVICE}\r\n\r\n");
        let mut location = None;
        let started = Instant::now();
        let mut buf = [0u8; 2048];
        let mut sent = 0;
        while location.is_none() && started.elapsed() < Duration::from_secs(8) {
            if sent < 4 && started.elapsed() >= Duration::from_secs(sent * 2) {
                socket.send_to(search.as_bytes(), "239.255.255.250:1900").unwrap();
                sent += 1;
            }
            let Ok((n, from)) = socket.recv_from(&mut buf) else { continue };
            let text = String::from_utf8_lossy(&buf[..n]).into_owned();
            if text.contains(&format!("USN: uuid:{uuid}::{DIAL_SERVICE}")) {
                eprintln!("answer from {from}:\n{text}");
                location = text.lines().find_map(|l| l.strip_prefix("LOCATION: ")).map(String::from);
            }
        }
        let location = location.expect("our DIAL server answered the M-SEARCH");
        assert!(location.ends_with(&format!(":{}/dial/dd.xml", server.port)), "{location}");

        let agent = local_agent();
        let response = agent.get(&location).call().unwrap();
        assert_eq!(response.status().as_u16(), 200);
        let app_url = response.headers().get("application-url").and_then(|v| v.to_str().ok()).expect("Application-URL").to_string();
        let description = response.into_body().read_to_string().unwrap();
        assert!(description.contains("<friendlyName>Zazabor discovery test</friendlyName>"), "{description}");
        assert!(app_url.ends_with(&format!(":{}/apps/", server.port)), "{app_url}");

        let app = agent.get(&format!("{app_url}YouTube")).header("Origin", "package:com.google.android.youtube").call().unwrap();
        assert_eq!(app.status().as_u16(), 200);
        assert_eq!(app.headers().get("access-control-allow-origin").and_then(|v| v.to_str().ok()), Some("package:com.google.android.youtube"));
        let xml = app.into_body().read_to_string().unwrap();
        eprintln!("{xml}");
        assert!(xml.contains("<screenId>test-screen</screenId>"), "{xml}");

        let launched = agent.post(&format!("{app_url}YouTube")).header("Content-Type", "text/plain; charset=utf-8").send("pairingCode=abc-123&theme=cl&v=tCDvOQI3pco").unwrap();
        assert_eq!(launched.status().as_u16(), 201);
        assert!(launched.headers().get("location").and_then(|v| v.to_str().ok()).unwrap().ends_with("/apps/YouTube/run"));
        // The lounge isn't running in this test, so the code waits for it.
        assert_eq!(state().as_ref().unwrap().pending_pairing, vec!["abc-123".to_string()]);
        let refused = agent.post(&format!("{app_url}YouTube")).header("Origin", "https://evil.example").send("pairingCode=x").unwrap();
        assert_eq!(refused.status().as_u16(), 403);
        super::super::testing::begin();
    }

    const REMOTE: &str = r#"
import asyncio, sys
from pyytlounge import YtLoungeApi, EventListener

class Listener(EventListener):
    async def playback_state_changed(self, e):
        print("onStateChange", e.state, e.current_time, e.duration, flush=True)
    async def now_playing_changed(self, e):
        print("nowPlaying", e.video_id, e.state, e.current_time, e.duration, flush=True)
    async def volume_changed(self, e):
        print("onVolumeChanged", e.volume, e.muted, flush=True)
    async def autoplay_changed(self, e):
        print("onAutoplayModeChanged", e.supported, flush=True)
    async def disconnected(self, e):
        print("disconnected", flush=True)

async def main():
    code, video = sys.argv[1], sys.argv[2]
    async with YtLoungeApi("Zazabor test remote", Listener()) as api:
        print("paired", await api.pair(code), api.screen_name, flush=True)
        print("connected", await api.connect(), flush=True)
        sub = asyncio.create_task(api.subscribe())
        await asyncio.sleep(2)
        print("sent setPlaylist", await api.play_video(video), flush=True)
        await asyncio.sleep(30)
        print("sent pause", await api.pause(), flush=True)
        await asyncio.sleep(4)
        print("sent getNowPlaying", await api.get_now_playing(), flush=True)
        await asyncio.sleep(3)
        sub.cancel()
        try:
            await api.disconnect()
        except Exception as e:
            print("disconnect failed", e, flush=True)

asyncio.run(main())
"#;

    /// Reads the first 5 s of `url`'s headers, as libVLC would open it. googlevideo's edges
    /// sometimes answer 5xx for a minute, so it tries three times.
    fn probe(url: &str) -> String {
        let mut last = String::new();
        for attempt in 0..3 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_secs(5));
            }
            let out = std::process::Command::new("ffprobe")
                .args(["-v", "error", "-read_intervals", "%+5", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "compact", url])
                .output()
                .expect("ffprobe on PATH");
            if out.status.success() {
                return String::from_utf8_lossy(&out.stdout).into_owned();
            }
            last = String::from_utf8_lossy(&out.stderr).chars().rev().take(300).collect::<String>().chars().rev().collect();
            eprintln!("ffprobe attempt {} failed: {last}", attempt + 1);
        }
        panic!("ffprobe failed: {last}");
    }

    /// The whole path against YouTube's real servers: register a screen, get a TV code, pair a
    /// pyytlounge "phone" with it, send a play command, and check the hub got a playable address.
    #[test]
    #[ignore = "talks to YouTube; needs YT_LOUNGE_PYTHON (python of a venv with pyytlounge) and ffprobe on PATH"]
    fn live_tv_code_pairing_and_play() {
        let python = std::env::var("YT_LOUNGE_PYTHON").expect("YT_LOUNGE_PYTHON");
        // A 10-second public clip.
        let video = std::env::var("YT_TEST_VIDEO").unwrap_or_else(|_| "tCDvOQI3pco".into());
        let generation = super::super::testing::begin();
        start(generation, &Settings { name: "Zazabor live test".into(), id: random_uuid() }).unwrap();

        let started = Instant::now();
        let code = loop {
            match new_tv_code() {
                Ok(code) => break code,
                Err(e) if started.elapsed() < Duration::from_secs(90) => eprintln!("waiting for the lounge: {e}"),
                Err(e) => panic!("no TV code: {e}"),
            }
        };
        eprintln!("TV code: {code}");
        assert_eq!(code.len(), 15);
        let identity = state().as_ref().unwrap().identity.clone().unwrap();
        eprintln!("screen id {}… saved in {}", &identity.screen_id[..6.min(identity.screen_id.len())], identity_file().display());

        let dir = std::env::temp_dir().join("zazabor-yt-remote");
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("remote.py");
        std::fs::write(&script, REMOTE).unwrap();
        let mut remote = std::process::Command::new(&python)
            .arg("-I")
            .arg(&script)
            .arg(code.replace(' ', ""))
            .arg(&video)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("python");

        let started = Instant::now();
        let url = loop {
            if let Some(url) = super::super::testing::current_url() {
                break url;
            }
            if started.elapsed() > Duration::from_secs(150) {
                let _ = remote.kill();
                let output = remote.wait_with_output().unwrap();
                panic!("the hub never got a play\n--- remote ---\n{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            }
            std::thread::sleep(Duration::from_millis(250));
        };
        let options = super::super::media_options(&url);
        let (title, sender) = {
            let slot = state();
            let s = slot.as_ref().unwrap();
            (s.playing.as_ref().map(|p| p.video_id.clone()), s.remotes.iter().map(|r| r.name.clone()).collect::<Vec<_>>())
        };
        eprintln!("hub play after {:?}: video {title:?} from {sender:?}\n  url {}…\n  options {:?}", started.elapsed(), &url[..url.len().min(90)], options.iter().map(|o| &o[..o.len().min(60)]).collect::<Vec<_>>());
        assert_eq!(title.as_deref(), Some(video.as_str()));
        let video_probe = probe(&url);
        eprintln!("ffprobe video: {video_probe}");
        assert!(video_probe.contains("codec_type=video"), "{video_probe}");
        for audio in options.iter().filter_map(|o| o.strip_prefix(":input-slave=")) {
            let audio_probe = probe(audio);
            eprintln!("ffprobe audio: {audio_probe}");
            assert!(audio_probe.contains("codec_type=audio"), "{audio_probe}");
        }

        let output = remote.wait_with_output().unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        eprintln!("--- what the remote saw ---\n{stdout}\n--- remote stderr (tail) ---\n{}", String::from_utf8_lossy(&output.stderr).lines().rev().take(15).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"));
        assert!(stdout.contains("paired True"), "pairing failed");
        assert!(stdout.contains("connected True"), "connect failed");
        assert!(stdout.contains(&format!("nowPlaying {video}")), "the remote never heard nowPlaying");
        assert!(stdout.contains("onStateChange"), "the remote never heard onStateChange");
        super::super::testing::begin();
    }

    #[test]
    fn maps_hub_states() {
        assert_eq!(code_of(PlayState::Loading), 3);
        assert_eq!(code_of(PlayState::Playing), 1);
        assert_eq!(code_of(PlayState::Paused), 2);
        assert_eq!(code_of(PlayState::Ended), 0);
        assert_eq!(code_of(PlayState::Idle), 4);
    }
}
