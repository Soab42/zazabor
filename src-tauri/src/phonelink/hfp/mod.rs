//! Bluetooth calls (docs/plans/phone-link.md §2): Zazabor is the phone's hands-free unit, like a
//! car kit. It registers the HFP hands-free profile with BlueZ (`bluez.rs`), talks AT commands
//! with the phone over the RFCOMM socket (`at.rs`, `session.rs`), and carries the call's audio
//! over a SCO socket (`sco.rs`) through the speakers and mic (`audio.rs`).
//!
//! PipeWire holds the hands-free role by default; switching calls on writes a WirePlumber drop-in
//! that hands the role over and restarts WirePlumber (`wireplumber.rs`). Nothing here runs until
//! the user switches calls on (config `phone.calls`).
//!
//! Events: `phone-bt` → [`BtState`] on every call or connection change, `phone-ring` →
//! [`at::LiveCall`] when a call starts ringing.

pub mod at;
mod audio;
mod bluez;
mod sco;
mod session;
mod wireplumber;

use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use at::{Event, LiveCall, Request};
use session::Session;

/// A phone the PC paired with, for calls (`BtPhone`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BtPhone {
    pub address: String,
    pub name: String,
    pub paired: bool,
    /// Its hands-free link is up: calls go through it.
    pub connected: bool,
    /// Percent (the phone reports 0-5, so steps of 20).
    pub battery: Option<u8>,
    /// 0-4.
    pub signal: Option<u8>,
    pub carrier: Option<String>,
    /// The same phone on the Wi-Fi link, matched by name.
    pub phone_id: Option<String>,
}

/// Everything the page shows about Bluetooth calls (`BtState`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BtState {
    pub enabled: bool,
    /// A Bluetooth adapter is there and powered.
    pub available: bool,
    /// The WirePlumber drop-in is in place.
    pub drop_in: bool,
    pub devices: Vec<BtPhone>,
    pub calls: Vec<LiveCall>,
    /// The call's audio should be on the PC (otherwise the phone keeps it).
    pub audio_on_pc: bool,
    /// The audio link is running right now.
    pub audio_live: bool,
    pub muted: bool,
    /// Speaker volume, 0-15.
    pub volume: u8,
    /// The last thing that went wrong (readable), cleared by the next command.
    pub error: Option<String>,
}

struct Inner {
    enabled: bool,
    session: Option<Arc<Session>>,
    adapters: Vec<bluez::Adapter>,
    devices: Vec<bluez::Device>,
    audio_on_pc: bool,
    muted: bool,
    volume: u8,
    error: Option<String>,
    /// The running call audio.
    audio: Option<Arc<sco::Flags>>,
    /// Stops the SCO listener.
    listener: Option<Arc<AtomicBool>>,
    /// The phone the user asked to connect: it may replace the connected one.
    wanted: Option<String>,
    /// A check whether to open the audio link from here is waiting.
    audio_check: bool,
}

static STATE: Mutex<Inner> = Mutex::new(Inner {
    enabled: false,
    session: None,
    adapters: Vec::new(),
    devices: Vec::new(),
    audio_on_pc: true,
    muted: false,
    volume: 10,
    error: None,
    audio: None,
    listener: None,
    wanted: None,
    audio_check: false,
});

/// Switching calls on or off runs one at a time.
static SWITCH: Mutex<()> = Mutex::new(());
static APP: OnceLock<AppHandle> = OnceLock::new();

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---- the Wi-Fi link: names --------------------------------------------------------------------

/// The Wi-Fi link's phone (phoneId) whose Bluetooth name is `bt_name`.
fn linked_phone(bt_name: &str) -> Option<String> {
    super::phone_named(bt_name).map(|(phone_id, _, _)| phone_id)
}

/// A caller's name from the phone's contacts (the Wi-Fi link's cache).
fn caller_name(phone_id: Option<&str>, number: &str) -> Option<String> {
    if number.is_empty() {
        return None;
    }
    super::contact_name(phone_id, number)
}

// ---- state ------------------------------------------------------------------------------------

fn current() -> Option<Arc<Session>> {
    lock(&STATE).session.clone().filter(|s| !s.is_closed())
}

fn is_current(session: &Arc<Session>) -> bool {
    lock(&STATE).session.as_ref().is_some_and(|s| Arc::ptr_eq(s, session))
}

/// Names the calls the phone didn't name, from the contacts.
fn named(calls: Vec<LiveCall>, phone_id: Option<&str>) -> Vec<LiveCall> {
    calls
        .into_iter()
        .map(|mut c| {
            if c.name.is_none() {
                c.name = caller_name(phone_id, &c.number);
            }
            c
        })
        .collect()
}

fn state() -> BtState {
    let inner = lock(&STATE);
    let session = inner.session.clone().filter(|s| !s.is_closed());
    let (enabled, devices, adapters) = (inner.enabled, inner.devices.clone(), inner.adapters.clone());
    let (audio_on_pc, audio_live, muted, volume, error) = (inner.audio_on_pc, inner.audio.is_some(), inner.muted, inner.volume, inner.error.clone());
    drop(inner);

    struct Live {
        calls: Vec<LiveCall>,
        battery: Option<u8>,
        signal: Option<u8>,
        carrier: Option<String>,
    }
    let live = session.as_ref().and_then(|s| {
        s.with_hf(|hf| hf.connected().then(|| Live { calls: hf.calls().to_vec(), battery: hf.battery(), signal: hf.signal(), carrier: hf.carrier().map(str::to_string) }))
    });
    let phone = |address: &str, name: &str, paired: bool| {
        let this = session.as_ref().filter(|s| s.address.eq_ignore_ascii_case(address)).and(live.as_ref());
        BtPhone {
            address: address.to_string(),
            name: name.to_string(),
            paired,
            connected: this.is_some(),
            battery: this.and_then(|l| l.battery),
            signal: this.and_then(|l| l.signal),
            carrier: this.and_then(|l| l.carrier.clone()),
            phone_id: linked_phone(name),
        }
    };
    let mut phones: Vec<BtPhone> = devices
        .iter()
        .filter(|d| d.is_phone() || session.as_ref().is_some_and(|s| s.device == d.path))
        .map(|d| phone(&d.address, &d.name, d.paired))
        .collect();
    if let Some(s) = &session {
        if !phones.iter().any(|p| p.address.eq_ignore_ascii_case(&s.address)) {
            phones.push(phone(&s.address, &s.name, true));
        }
    }
    let phone_id = session.as_ref().and_then(|s| linked_phone(&s.name));
    BtState {
        enabled,
        available: adapters.iter().any(|a| a.powered),
        drop_in: wireplumber::config_home().is_some_and(|h| wireplumber::present(&h)),
        devices: phones,
        calls: named(live.map(|l| l.calls).unwrap_or_default(), phone_id.as_deref()),
        audio_on_pc,
        audio_live,
        muted,
        volume,
        error,
    }
}

fn emit() {
    if let Some(app) = APP.get() {
        let _ = app.emit("phone-bt", state());
    }
}

fn set_error(error: Option<String>) {
    lock(&STATE).error = error;
}

/// Reads the adapters and devices from BlueZ again.
fn refresh_devices() -> Result<(), String> {
    let (adapters, devices) = bluez::objects()?;
    let mut inner = lock(&STATE);
    inner.adapters = adapters;
    inner.devices = devices;
    Ok(())
}

/// BlueZ said something changed: read the devices again (once for a burst of signals).
fn devices_changed() {
    static PENDING: AtomicBool = AtomicBool::new(false);
    if PENDING.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(300));
        PENDING.store(false, Ordering::Release);
        if refresh_devices().is_ok() {
            emit();
        }
    });
}

// ---- config -----------------------------------------------------------------------------------

fn config_path() -> Option<std::path::PathBuf> {
    APP.get().and_then(|app| app.path().app_config_dir().ok()).map(|d| d.join("config.json"))
}

/// `phone.calls` in `config.json`.
fn calls_setting() -> bool {
    config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.pointer("/phone/calls").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// Sets `phone.calls` in `config.json`, keeping everything else. The page should set it in its
/// own copy too, so its next save keeps it.
fn save_setting(on: bool) {
    let Some(path) = config_path() else { return };
    let mut json = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or_else(|| json!({}));
    if !json.is_object() {
        return;
    }
    if !json.get("phone").is_some_and(Value::is_object) {
        json["phone"] = json!({});
    }
    json["phone"]["calls"] = on.into();
    let tmp = path.with_extension("json.calls.tmp");
    if let Ok(text) = serde_json::to_string_pretty(&json) {
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

// ---- switching calls on and off ---------------------------------------------------------------

/// Waits for the restarted WirePlumber to come back without the hands-free role.
fn wait_for_pipewire() -> Result<(), String> {
    let start = Instant::now();
    std::thread::sleep(Duration::from_millis(800));
    loop {
        let (adapters, _) = bluez::objects()?;
        // PipeWire registers the audio gateway again once it's back.
        let back = adapters.iter().any(|a| a.uuids.iter().any(|u| u.eq_ignore_ascii_case(bluez::HFP_AG)));
        if !bluez::hf_taken(&adapters) && (back || start.elapsed() > Duration::from_secs(6)) {
            // It registers its roles one after the other: look once more.
            std::thread::sleep(Duration::from_millis(600));
            if !bluez::hf_taken(&bluez::objects()?.0) {
                return Ok(());
            }
        }
        if start.elapsed() > Duration::from_secs(12) {
            return Err("PipeWire still holds the Bluetooth hands-free role after restarting WirePlumber, so Zazabor can't take calls.".into());
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

fn handlers() -> bluez::Handlers {
    bluez::Handlers {
        connect: Box::new(new_connection),
        disconnect: Box::new(|path| {
            if let Some(s) = current().filter(|s| s.device == path) {
                s.close();
            }
        }),
        release: Box::new(|| {
            if let Some(s) = current() {
                s.close();
            }
        }),
    }
}

fn switch_on() -> Result<(), String> {
    if lock(&STATE).enabled {
        return Ok(());
    }
    let home = wireplumber::config_home().ok_or("Couldn't find the home folder.")?;
    let (adapters, _) = bluez::objects()?;
    if adapters.is_empty() {
        return Err("This PC has no Bluetooth adapter.".into());
    }
    let changed = wireplumber::write(&home, wireplumber::detect())?;
    if changed || bluez::hf_taken(&adapters) {
        wireplumber::restart()?;
        wait_for_pipewire()?;
    }
    bluez::register(handlers(), at::SDP_FEATURES)?;
    let _ = bluez::watch(devices_changed);
    lock(&STATE).enabled = true;
    refresh_devices()?;
    // A phone already connected to the PC gets its hands-free link now (the next ones connect
    // by themselves: the profile auto-connects).
    let phone = lock(&STATE).devices.iter().find(|d| d.is_phone() && d.gateway && d.connected).map(|d| d.path.clone());
    if let Some(path) = phone {
        std::thread::spawn(move || {
            if let Err(e) = bluez::connect(&path) {
                eprintln!("Bluetooth calls: couldn't connect the phone: {e}");
            }
        });
    }
    Ok(())
}

fn switch_off() -> Result<(), String> {
    let (session, audio, listener) = {
        let mut inner = lock(&STATE);
        inner.enabled = false;
        inner.wanted = None;
        (inner.session.take(), inner.audio.take(), inner.listener.take())
    };
    if let Some(flags) = audio {
        flags.stop.store(true, Ordering::Relaxed);
    }
    if let Some(stop) = listener {
        stop.store(true, Ordering::Relaxed);
    }
    if let Some(session) = session {
        session.close();
    }
    bluez::unwatch();
    bluez::unregister();
    if let Some(home) = wireplumber::config_home() {
        if wireplumber::remove(&home)? {
            wireplumber::restart()?;
        }
    }
    Ok(())
}

fn enable(on: bool) -> Result<BtState, String> {
    let _switch = lock(&SWITCH);
    let result = if on { switch_on() } else { switch_off() };
    match &result {
        Ok(()) => {
            set_error(None);
            save_setting(on);
        }
        Err(e) => {
            set_error(Some(e.clone()));
            if on {
                // Leave nothing half-done behind (the drop-in stays only while calls are on).
                let _ = switch_off();
            }
        }
    }
    let _ = refresh_devices();
    emit();
    result.map(|()| state())
}

/// Turns calls on at startup when the user left them on.
pub fn init(app: AppHandle) {
    let _ = APP.set(app);
    if calls_setting() {
        std::thread::spawn(|| {
            if let Err(e) = enable(true) {
                eprintln!("Bluetooth calls didn't start: {e}");
            }
        });
    }
}

// ---- a phone's link ---------------------------------------------------------------------------

/// BlueZ handed over a phone's hands-free link.
fn new_connection(path: String, fd: OwnedFd) -> Result<(), String> {
    {
        let inner = lock(&STATE);
        if !inner.enabled {
            return Err("Bluetooth calls are off in Zazabor.".into());
        }
        if let Some(s) = inner.session.as_ref().filter(|s| !s.is_closed()) {
            if s.device != path && inner.wanted.as_deref() != Some(path.as_str()) {
                return Err("Another phone is connected for calls.".into());
            }
            s.close();
        }
    }
    std::thread::Builder::new().name("hfp".into()).spawn(move || run_session(path, fd)).map(|_| ()).map_err(|e| e.to_string())
}

/// "/org/bluez/hci0/dev_11_22_33_44_55_66" → "11:22:33:44:55:66".
fn address_from_path(path: &str) -> String {
    path.rsplit('/').next().and_then(|p| p.strip_prefix("dev_")).map(|a| a.replace('_', ":")).unwrap_or_default()
}

fn run_session(path: String, fd: OwnedFd) {
    let _ = refresh_devices();
    let (address, name, adapter, volume) = {
        let inner = lock(&STATE);
        let device = inner.devices.iter().find(|d| d.path == path);
        let address = device.map(|d| d.address.clone()).unwrap_or_else(|| address_from_path(&path));
        let name = device.map(|d| d.name.clone()).unwrap_or_else(|| address.clone());
        let adapter_path = device.map(|d| d.adapter.clone()).unwrap_or_else(|| path.rsplit_once('/').map(|(a, _)| a.to_string()).unwrap_or_default());
        let adapter = inner.adapters.iter().find(|a| a.path == adapter_path).or(inner.adapters.first()).map(|a| a.address.clone()).unwrap_or_default();
        (address, name, adapter, inner.volume)
    };
    let hf = at::Hf::new(volume, audio::echo_cancel_available());
    let session = Session::new(path, address, name, adapter, fd, hf);
    {
        let mut inner = lock(&STATE);
        inner.session = Some(session.clone());
        inner.wanted = None;
    }
    start_listener(&session);
    emit();
    session.run(on_event);

    // The link closed.
    let (audio, listener) = {
        let mut inner = lock(&STATE);
        if inner.session.as_ref().is_some_and(|s| Arc::ptr_eq(s, &session)) {
            inner.session = None;
            inner.audio_on_pc = true;
            (inner.audio.take(), inner.listener.take())
        } else {
            (None, None)
        }
    };
    if let Some(flags) = audio {
        flags.stop.store(true, Ordering::Relaxed);
    }
    if let Some(stop) = listener {
        stop.store(true, Ordering::Relaxed);
    }
    emit();
}

fn on_event(session: &Arc<Session>, event: Event) {
    match event {
        Event::Connected => {
            set_error(None);
            emit();
            follow_audio(session);
        }
        Event::Failed(why) => {
            set_error(Some(why));
            session.close();
        }
        Event::Changed => {
            emit();
            follow_audio(session);
        }
        Event::Ring(call) => {
            let phone_id = linked_phone(&session.name);
            let call = named(vec![call], phone_id.as_deref()).remove(0);
            if let Some(app) = APP.get() {
                let _ = app.emit("phone-ring", &call);
            }
        }
        Event::Volume(level) => {
            let mut inner = lock(&STATE);
            inner.volume = level;
            if let Some(flags) = &inner.audio {
                flags.volume.store(level, Ordering::Relaxed);
            }
        }
        Event::Rejected(why) => {
            set_error(Some(why));
            emit();
        }
    }
}

// ---- call audio -------------------------------------------------------------------------------

/// Listens for the phone's audio link while its hands-free link is up.
fn start_listener(session: &Arc<Session>) {
    let Some(adapter) = sco::parse_addr(&session.adapter) else { return };
    let listener = match sco::Listener::new(&adapter) {
        Ok(l) => l,
        Err(e) => {
            // Zazabor opens the audio link itself then (`follow_audio`).
            eprintln!("Bluetooth calls: can't listen for call audio: {e}");
            return;
        }
    };
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(old) = lock(&STATE).listener.replace(stop.clone()) {
        old.store(true, Ordering::Relaxed);
    }
    let session = session.clone();
    let _ = std::thread::Builder::new().name("hfp-sco".into()).spawn(move || {
        while !stop.load(Ordering::Relaxed) && !session.is_closed() {
            match listener.accept(500) {
                Ok(Some((fd, peer))) => {
                    let ours = sco::format_addr(&peer).eq_ignore_ascii_case(&session.address);
                    let wanted = {
                        let inner = lock(&STATE);
                        inner.audio_on_pc && inner.audio.is_none()
                    };
                    // Anything else (another device, or the user keeping the audio on the phone)
                    // is turned down by closing it.
                    if ours && wanted && sco::authorize(&fd).is_ok() {
                        start_audio(&session, fd);
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    eprintln!("Bluetooth calls: the audio listener stopped: {e}");
                    break;
                }
            }
        }
    });
}

/// Runs the call's audio over `fd` until it closes or is stopped.
fn start_audio(session: &Arc<Session>, fd: OwnedFd) {
    let flags = {
        let mut inner = lock(&STATE);
        if inner.audio.is_some() || !inner.session.as_ref().is_some_and(|s| Arc::ptr_eq(s, session)) {
            return;
        }
        let flags = Arc::new(sco::Flags::new(inner.muted, inner.volume));
        inner.audio = Some(flags.clone());
        flags
    };
    emit();
    let _ = std::thread::Builder::new().name("hfp-audio".into()).spawn(move || {
        let result = audio::Audio::new(&audio::Ends::system(), true).and_then(|mut audio| sco::pump(&fd, &mut audio, &flags));
        drop(fd);
        {
            let mut inner = lock(&STATE);
            if inner.audio.as_ref().is_some_and(|f| Arc::ptr_eq(f, &flags)) {
                inner.audio = None;
            }
            if let Err(e) = result {
                inner.error = Some(e);
            }
        }
        emit();
    });
}

fn stop_audio() {
    if let Some(flags) = lock(&STATE).audio.take() {
        flags.stop.store(true, Ordering::Relaxed);
    }
}

/// Opens the audio link from the PC.
fn open_audio(session: &Arc<Session>) {
    let session = session.clone();
    std::thread::spawn(move || {
        let (Some(adapter), Some(phone)) = (sco::parse_addr(&session.adapter), sco::parse_addr(&session.address)) else { return };
        match sco::connect(&adapter, &phone) {
            Ok(fd) => start_audio(&session, fd),
            Err(e) => {
                set_error(Some(format!("Couldn't bring the call's audio to the PC: {e}")));
                emit();
            }
        }
    });
}

/// The call's audio follows the calls: none without a call; with one that talks and the audio
/// wanted here, the phone normally opens the link itself; if it hasn't after a moment, Zazabor
/// does.
fn follow_audio(session: &Arc<Session>) {
    let calls = session.with_hf(|hf| hf.calls().to_vec());
    if calls.is_empty() {
        stop_audio();
        lock(&STATE).audio_on_pc = true;
        return;
    }
    {
        let mut inner = lock(&STATE);
        let wants = inner.audio_on_pc && calls.iter().any(|c| c.state.has_audio());
        if !wants || inner.audio.is_some() || inner.audio_check {
            return;
        }
        inner.audio_check = true;
    }
    let session = session.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(2500));
        let go = {
            let mut inner = lock(&STATE);
            inner.audio_check = false;
            let talking = session.with_hf(|hf| hf.calls().iter().any(|c| c.state.has_audio()));
            inner.audio_on_pc && inner.audio.is_none() && talking && !session.is_closed()
        };
        if go && is_current(&session) {
            open_audio(&session);
        }
    });
}

// ---- commands ---------------------------------------------------------------------------------

fn session_or_err() -> Result<Arc<Session>, String> {
    current().ok_or_else(|| "No phone is connected for calls.".to_string())
}

fn ask(request: Request) -> Result<(), String> {
    let session = session_or_err()?;
    set_error(None);
    for event in session.request(request)? {
        on_event(&session, event);
    }
    Ok(())
}

#[tauri::command]
pub async fn phone_bt_state() -> Result<BtState, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _ = refresh_devices();
        state()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn phone_bt_enable(on: bool) -> Result<BtState, String> {
    if on {
        crate::ensure_unlocked()?;
    }
    tauri::async_runtime::spawn_blocking(move || enable(on)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn phone_bt_connect(address: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !lock(&STATE).enabled {
            return Err("Turn on Bluetooth calls first.".to_string());
        }
        refresh_devices()?;
        let path = lock(&STATE).devices.iter().find(|d| d.address.eq_ignore_ascii_case(&address)).map(|d| d.path.clone()).ok_or("That phone isn't paired with this PC.")?;
        if let Some(old) = current().filter(|s| s.device != path) {
            let _ = bluez::disconnect(&old.device);
            old.close();
        }
        lock(&STATE).wanted = Some(path.clone());
        let result = bluez::connect(&path);
        if let Err(e) = &result {
            set_error(Some(e.clone()));
            emit();
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens the desktop's Bluetooth settings (to pair a phone).
#[tauri::command]
pub fn phone_bt_settings() -> Result<(), String> {
    let candidates: [&[&str]; 6] = [
        &["gnome-control-center", "bluetooth"],
        &["systemsettings", "kcm_bluetooth"],
        &["kcmshell6", "kcm_bluetooth"],
        &["kcmshell5", "bluetooth"],
        &["blueman-manager"],
        &["blueberry"],
    ];
    for cmd in candidates {
        match std::process::Command::new(cmd[0]).args(&cmd[1..]).stdin(std::process::Stdio::null()).spawn() {
            Ok(mut child) => {
                // Reap it when it exits.
                std::thread::spawn(move || child.wait());
                return Ok(());
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("Couldn't open the Bluetooth settings: {e}")),
        }
    }
    Err("Couldn't find the Bluetooth settings. Pair the phone in your desktop's settings.".into())
}

/// Calls `number` (an empty number calls the last one again). The audio comes to the PC.
#[tauri::command]
/// Without a Bluetooth connection the call goes through the Zazabor Link app on `phone_id` (or
/// the connected phone that shares calls); the audio then stays on the phone.
pub async fn phone_call_dial(number: String, phone_id: Option<String>) -> Result<(), String> {
    if current().is_none() {
        let number = number.trim();
        if number.is_empty() {
            return Err("Type a number to call.".into());
        }
        return super::call_via_app(phone_id.as_deref(), "dial", Some(number));
    }
    lock(&STATE).audio_on_pc = true;
    ask(if number.trim().is_empty() { Request::Redial } else { Request::Dial(number) })
}

#[tauri::command]
pub async fn phone_call_answer(phone_id: Option<String>) -> Result<(), String> {
    if current().is_none() {
        return super::call_via_app(phone_id.as_deref(), "answer", None);
    }
    lock(&STATE).audio_on_pc = true;
    ask(Request::Answer)
}

#[tauri::command]
pub async fn phone_call_hangup(phone_id: Option<String>) -> Result<(), String> {
    if current().is_none() {
        return super::call_via_app(phone_id.as_deref(), "end", None);
    }
    ask(Request::Hangup)
}

#[tauri::command]
pub async fn phone_call_decline(phone_id: Option<String>) -> Result<(), String> {
    if current().is_none() {
        return super::call_via_app(phone_id.as_deref(), "end", None);
    }
    ask(Request::Decline)
}

#[tauri::command]
pub async fn phone_call_dtmf(digit: String) -> Result<(), String> {
    let digit = digit.trim().chars().next().ok_or("Which key?")?;
    ask(Request::Dtmf(digit))
}

/// AT+CHLD: 0 drops the held or waiting call, 1 ends the active call and takes the other, 2 swaps.
#[tauri::command]
pub async fn phone_call_hold(action: u8) -> Result<(), String> {
    ask(Request::Hold(action))
}

/// Moves the call's audio to the PC or back to the phone.
#[tauri::command]
pub async fn phone_call_audio(on_pc: bool) -> Result<(), String> {
    let session = session_or_err()?;
    lock(&STATE).audio_on_pc = on_pc;
    if on_pc {
        let talking = session.with_hf(|hf| hf.calls().iter().any(|c| c.state.has_audio() || c.state == at::CallState::Held));
        if talking && lock(&STATE).audio.is_none() {
            open_audio(&session);
        }
    } else {
        stop_audio();
    }
    emit();
    Ok(())
}

/// Mutes the PC's mic for the phone.
#[tauri::command]
pub async fn phone_call_mute(on: bool) -> Result<(), String> {
    {
        let mut inner = lock(&STATE);
        inner.muted = on;
        if let Some(flags) = &inner.audio {
            flags.muted.store(on, Ordering::Relaxed);
        }
    }
    emit();
    Ok(())
}

/// The speaker volume, 0-15; the phone hears about it too.
#[tauri::command]
pub async fn phone_call_volume(level: u8) -> Result<(), String> {
    let level = level.min(15);
    {
        let mut inner = lock(&STATE);
        inner.volume = level;
        if let Some(flags) = &inner.audio {
            flags.volume.store(level, Ordering::Relaxed);
        }
    }
    if current().is_some_and(|s| s.with_hf(|hf| hf.connected())) {
        ask(Request::Volume(level))?;
    }
    emit();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_from_a_device_path() {
        assert_eq!(address_from_path("/org/bluez/hci0/dev_11_22_33_44_55_66"), "11:22:33:44:55:66");
        assert_eq!(address_from_path("/org/bluez/hci0"), "");
    }

    #[test]
    fn state_serializes_as_the_plan_says() {
        let state = BtState {
            enabled: true,
            available: true,
            drop_in: true,
            devices: vec![BtPhone { address: "A".into(), name: "Pixel".into(), paired: true, connected: true, battery: Some(80), signal: Some(3), carrier: Some("Robi".into()), phone_id: None }],
            calls: vec![],
            audio_on_pc: true,
            audio_live: false,
            muted: false,
            volume: 10,
            error: None,
        };
        let v = serde_json::to_value(&state).unwrap();
        for key in ["enabled", "available", "dropIn", "devices", "calls", "audioOnPc", "audioLive", "muted", "volume", "error"] {
            assert!(v.get(key).is_some(), "{key}");
        }
        let phone = &v["devices"][0];
        for key in ["address", "name", "paired", "connected", "battery", "signal", "carrier", "phoneId"] {
            assert!(phone.get(key).is_some(), "{key}");
        }
    }
}
