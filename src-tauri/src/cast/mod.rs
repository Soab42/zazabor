//! Cast to Zazabor: the PC shows up on the Wi-Fi as a screen a phone can send things to, like a
//! smart TV (docs/plans/cast-receiver.md). The protocols live in the submodules; this is the hub
//! they share: the receiver's on/off switch and settings, and the one cast session that plays.
//!
//! A protocol calls `play` with what to play. The hub hands it to the page (`cast-play`), which
//! asks the user if needed and opens it in the Video player. From then on the protocol drives the
//! player with `pause`/`seek`/`set_volume`/`stop` and reports `status` back to the phone. The
//! session ends when the phone stops it, another cast replaces it, or the user plays something
//! else in Zazabor.

pub mod castv2;
pub mod dlna;
pub mod http;
pub mod mdns;
pub mod mirror;
pub mod ssdp;
pub mod youtube;
pub mod ytdlp;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::video::control;

/// How long a new session may take to start playing before a page that never opened it counts
/// as a refusal.
const START_GRACE: Duration = Duration::from_secs(60);

/// Where a cast came from.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// Cast v2 (VLC's "Play on…").
    Cast,
    Dlna,
    Youtube,
    Mirror,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Cast => "Cast",
            Source::Dlna => "DLNA",
            Source::Youtube => "YouTube",
            Source::Mirror => "Screen mirroring",
        }
    }
}

/// What a phone asked to play.
#[derive(Clone, Debug, Default)]
pub struct Media {
    /// An address libVLC opens (http://…, or the local mirror stream).
    pub url: String,
    pub title: Option<String>,
    /// The artist, channel or album line under the title.
    pub subtitle: Option<String>,
    /// A picture for audio-only casts (http(s) URL).
    pub artwork: Option<String>,
    pub start_ms: i64,
    /// A live stream: no seeking, no length.
    pub live: bool,
    /// The sender says it sends sound only (VLC's LOAD has `contentType: audio/…` when its
    /// "Audio only" casting setting is on, or VLC for Android plays the video as audio).
    pub audio_only: bool,
    /// libVLC media options for this address (`:input-slave=…`, `:network-caching=…`).
    pub options: Vec<String>,
    /// The phone's name as the user knows it ("Pixel 7", "VLC on 192.168.1.20").
    pub sender: String,
    /// Stable key for "always allow" (`<source>:<device id or address>`).
    pub sender_key: String,
}

/// Sent to the page to open a cast.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlayRequest {
    pub session: u64,
    pub url: String,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub artwork: Option<String>,
    pub start_ms: i64,
    pub live: bool,
    /// No picture is coming: the page says why instead of showing a black screen.
    pub audio_only: bool,
    pub source: Source,
    pub source_label: &'static str,
    pub sender: String,
    pub sender_key: String,
}

/// What the player is doing with a session, as the protocols report it.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlayState {
    /// Waiting for the user to allow it, or for the player to open it.
    Loading,
    Buffering,
    Playing,
    Paused,
    /// Played to the end.
    Ended,
    /// Stopped, replaced, refused, or the user moved on: the session is over.
    Idle,
    Error,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: PlayState,
    pub time_ms: i64,
    pub length_ms: i64,
    /// 0–1 (the phone's scale; Zazabor's own goes to 2).
    pub volume: f64,
    pub muted: bool,
    pub error: Option<String>,
}

struct Session {
    id: u64,
    media: Media,
    source: Source,
    started: Instant,
    /// The player has opened this address at least once.
    opened: bool,
    /// It has played at least once (so "not playing" now means paused, not still loading).
    played: bool,
    declined: bool,
    /// The phone stopped it, or it ended for good.
    over: bool,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
/// Options by address, read by `video::open` (kept after the session so a re-open still works).
static OPTIONS: Mutex<Option<HashMap<String, Vec<String>>>> = Mutex::new(None);
/// A play request that arrived while no main window could take it.
static PENDING: Mutex<Option<PlayRequest>> = Mutex::new(None);
static APP: OnceLock<AppHandle> = OnceLock::new();

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn app() -> Option<&'static AppHandle> {
    APP.get()
}

// ---- the receiver's services ---------------------------------------------------------------

/// What the page configures.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// The name phones show ("Zazabor on desk").
    pub name: String,
    /// A stable id for this PC (a UUID made once by the page).
    pub id: String,
}

/// The running receiver, for the page.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub running: bool,
    pub name: String,
    pub addresses: Vec<String>,
    /// Each service and why it could not start, if it couldn't.
    pub services: Vec<ServiceInfo>,
    /// YouTube's "Link with TV code", once the lounge has one.
    pub tv_code: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub port: u16,
    pub error: Option<String>,
}

/// The receiver's generation: services stop when it changes.
static GENERATION: AtomicU64 = AtomicU64::new(0);
static INFO: Mutex<Option<Info>> = Mutex::new(None);
static SETTINGS: Mutex<Option<Settings>> = Mutex::new(None);
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// True while the receiver started as `generation` is still the one running.
pub fn alive(generation: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) == generation
}

pub fn settings() -> Option<Settings> {
    lock(&SETTINGS).clone()
}

/// Where the receiver keeps files (yt-dlp, the YouTube screen id).
pub fn data_dir() -> PathBuf {
    DATA_DIR.get().cloned().unwrap_or_else(std::env::temp_dir).join("cast")
}

pub fn init(app: AppHandle, data_dir: PathBuf) {
    let _ = APP.set(app);
    let _ = DATA_DIR.set(data_dir);
}

fn start(settings: Settings) -> Info {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    *lock(&SETTINGS) = Some(settings.clone());
    let mut services = Vec::new();

    let http = http::start(generation);
    let http_port = http.as_ref().map(|s| s.port).unwrap_or(0);
    let mut note = |id, label, result: Result<u16, String>| {
        let (port, error) = match result {
            Ok(port) => (port, None),
            Err(e) => (0, Some(e)),
        };
        services.push(ServiceInfo { id, label, port, error });
    };
    note("http", "Web server", http.map(|s| s.port));
    let cast = castv2::start(generation);
    let mirror = mirror::start(generation);
    let mut adverts = Vec::new();
    if http_port != 0 {
        adverts.extend(dlna::adverts(&settings));
        adverts.extend(youtube::adverts(&settings));
    }
    note("ssdp", "UPnP discovery", ssdp::start(generation, http_port, adverts).map(|_| 1900));
    note("dlna", "DLNA", if http_port != 0 { Ok(http_port) } else { Err("needs the web server".into()) });
    note("youtube", "YouTube", if http_port != 0 { youtube::start(generation, &settings).map(|_| http_port) } else { Err("needs the web server".into()) });
    let cast_port = cast.as_ref().ok().copied();
    let mirror_port = mirror.as_ref().ok().copied();
    note("cast", "Cast (VLC)", cast);
    note("mirror", "Screen mirroring", mirror);
    note("mdns", "Bonjour discovery", mdns::start(generation, &settings, cast_port, mirror_port).map(|_| 5353));

    Info { running: true, name: settings.name, addresses: local_addresses().iter().map(|a| a.to_string()).collect(), services, tv_code: None }
}

fn stop_services() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    ssdp::stop();
    mdns::stop();
    *lock(&SETTINGS) = None;
}

/// The PC's IPv4 addresses on the local network (no loopback, no link-local).
pub fn local_addresses() -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.ip() {
            IpAddr::V4(ip) if !ip.is_link_local() && !is_virtual(&i.name) => Some(ip),
            _ => None,
        })
        .collect();
    out.sort_by_key(|ip| !ip.is_private());
    out.dedup();
    out
}

/// Docker, libvirt and VPN bridges never lead to a phone.
pub(crate) fn is_virtual(interface: &str) -> bool {
    ["docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "lxc", "lxd", "tun", "tap", "zt", "tailscale", "wg"]
        .iter()
        .any(|p| interface.starts_with(p))
}

/// This PC's address as seen from `peer` (the interface that routes to it).
pub fn address_towards(peer: IpAddr) -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((peer, 9)).ok()?;
    socket.local_addr().ok().map(|a| a.ip())
}

// ---- the session ---------------------------------------------------------------------------

/// Starts playing `media` from `source`, replacing any cast playing now. Returns the session id.
pub fn play(source: Source, media: Media) -> u64 {
    let id = NEXT_SESSION.fetch_add(1, Ordering::SeqCst);
    {
        let mut options = lock(&OPTIONS);
        let map = options.get_or_insert_with(HashMap::new);
        if map.len() > 32 {
            map.clear();
        }
        map.insert(media.url.clone(), media.options.clone());
    }
    let request = PlayRequest {
        session: id,
        url: media.url.clone(),
        title: media.title.clone(),
        subtitle: media.subtitle.clone(),
        artwork: media.artwork.clone(),
        start_ms: media.start_ms,
        live: media.live,
        audio_only: media.audio_only,
        source,
        source_label: source.label(),
        sender: media.sender.clone(),
        sender_key: media.sender_key.clone(),
    };
    *lock(&SESSION) = Some(Session { id, media, source, started: Instant::now(), opened: false, played: false, declined: false, over: false });
    deliver(request);
    id
}

fn deliver(request: PlayRequest) {
    let Some(app) = APP.get() else { return };
    if app.get_webview_window("main").is_some() {
        let _ = app.emit_to("main", "cast-play", &request);
        // A window that is still loading picks it up with `cast_pending`.
        *lock(&PENDING) = Some(request);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    } else {
        *lock(&PENDING) = Some(request);
        crate::show_main(app, None);
    }
}

/// libVLC options for an address a cast opened (empty for anything else).
pub fn media_options(url: &str) -> Vec<String> {
    lock(&OPTIONS).as_ref().and_then(|m| m.get(url).cloned()).unwrap_or_default()
}

/// The session is still the one playing (not replaced or over).
pub fn is_current(session: u64) -> bool {
    lock(&SESSION).as_ref().is_some_and(|s| s.id == session && !s.over && !s.declined)
}

/// The cast that plays now, if any: its id and source.
pub fn current() -> Option<(u64, Source)> {
    lock(&SESSION).as_ref().filter(|s| !s.over && !s.declined).map(|s| (s.id, s.source))
}

pub fn status(session: u64) -> Status {
    let player = control::state();
    let (volume, muted) = control::volume(&player);
    let mut status = Status { state: PlayState::Idle, time_ms: 0, length_ms: 0, volume: volume.min(1.0), muted, error: None };
    let mut slot = lock(&SESSION);
    let Some(s) = slot.as_mut().filter(|s| s.id == session) else {
        return status;
    };
    if s.declined {
        status.error = Some("declined".into());
        return status;
    }
    if s.over {
        return status;
    }
    let mine = control::path(&player) == Some(s.media.url.as_str());
    if mine {
        s.opened = true;
        let (time, length) = control::position(&player);
        status.time_ms = time;
        status.length_ms = length;
        if let Some(error) = control::error(&player) {
            status.state = PlayState::Error;
            status.error = Some(error.to_string());
        } else if control::ended(&player) {
            status.state = PlayState::Ended;
        } else if control::is_playing(&player) {
            s.played = true;
            status.state = PlayState::Playing;
        } else if s.played {
            status.state = PlayState::Paused;
        } else {
            status.state = PlayState::Buffering;
        }
    } else if !s.opened && s.started.elapsed() < START_GRACE {
        status.state = PlayState::Loading;
    } else {
        // The user played something else, or closed the player.
        s.over = true;
    }
    status
}

fn with_current(session: u64, work: impl FnOnce(&Session)) -> bool {
    let slot = lock(&SESSION);
    match slot.as_ref() {
        Some(s) if s.id == session && !s.over && !s.declined => {
            work(s);
            true
        }
        _ => false,
    }
}

pub fn set_paused(session: u64, paused: bool) -> bool {
    with_current(session, |_| control::set_paused(paused))
}

pub fn seek(session: u64, ms: i64) -> bool {
    with_current(session, |_| control::seek(ms))
}

/// `volume` on the phone's 0–1 scale.
pub fn set_volume(session: u64, volume: f64) -> bool {
    with_current(session, |_| control::set_volume(volume.clamp(0.0, 1.0)))
}

pub fn set_muted(session: u64, muted: bool) -> bool {
    with_current(session, |_| control::set_muted(muted))
}

/// The phone stopped the cast: stop the player (if it still plays this) and end the session.
pub fn stop(session: u64) {
    let url = {
        let mut slot = lock(&SESSION);
        match slot.as_mut() {
            Some(s) if s.id == session => {
                s.over = true;
                Some(s.media.url.clone())
            }
            _ => None,
        }
    };
    if let Some(url) = url {
        std::thread::spawn(move || control::stop_if(&url));
        if let Some(app) = APP.get() {
            let _ = app.emit_to("main", "cast-stop", session);
        }
    }
}

// ---- commands ------------------------------------------------------------------------------

#[tauri::command]
pub async fn cast_receiver_start(settings: Settings) -> Result<Info, String> {
    crate::ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || {
        stop_services();
        let info = start(settings);
        *lock(&INFO) = Some(info.clone());
        Ok(info)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cast_receiver_stop() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        stop_services();
        *lock(&INFO) = None;
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cast_receiver_info() -> Info {
    let mut info = lock(&INFO).clone().unwrap_or_default();
    if info.running {
        info.addresses = local_addresses().iter().map(|a| a.to_string()).collect();
        info.tv_code = youtube::tv_code();
    }
    info
}

/// A play request the page missed while it was loading (taken once).
#[tauri::command]
pub fn cast_pending() -> Option<PlayRequest> {
    let pending = lock(&PENDING).take()?;
    is_current(pending.session).then_some(pending)
}

/// The page took the request (so `cast_pending` won't hand it out again).
#[tauri::command]
pub fn cast_taken(session: u64) {
    let mut pending = lock(&PENDING);
    if pending.as_ref().is_some_and(|p| p.session == session) {
        *pending = None;
    }
}

/// The user refused the cast.
#[tauri::command]
pub fn cast_decline(session: u64) {
    cast_taken(session);
    if let Some(s) = lock(&SESSION).as_mut().filter(|s| s.id == session) {
        s.declined = true;
    }
}

/// The user stopped the cast from Zazabor (the stage's "Stop casting" button).
#[tauri::command]
pub fn cast_end(session: u64) {
    stop(session);
}

/// A new YouTube "Link with TV code".
#[tauri::command]
pub async fn cast_youtube_code() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(youtube::new_tv_code).await.map_err(|e| e.to_string())?
}

/// This PC's name, for the default "Zazabor on ‹hostname›".
#[tauri::command]
pub fn cast_hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for its length; gethostname NUL-terminates within it on success.
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
    let name = if ok { String::from_utf8_lossy(&buf[..buf.iter().position(|&b| b == 0).unwrap_or(0)]).into_owned() } else { String::new() };
    let name = name.split('.').next().unwrap_or("").trim().to_string();
    if name.is_empty() { "this PC".into() } else { name }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// Starts a receiver generation without the page (for protocol tests).
    pub fn begin() -> u64 {
        GENERATION.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// The address of the cast playing now, and whether the sender said it is sound only.
    pub fn current_media() -> Option<(String, bool)> {
        lock(&SESSION).as_ref().filter(|s| !s.over).map(|s| (s.media.url.clone(), s.media.audio_only))
    }
}

/// A device found on the network is this PC's own receiver (VLC lists it as "‹name› (Zazabor)").
pub fn is_own_device(name: &str) -> bool {
    lock(&SETTINGS).as_ref().is_some_and(|s| name == s.name || name == format!("{} (Zazabor)", s.name))
}
