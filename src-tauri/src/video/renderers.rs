//! Streaming to devices (Chromecast and other renderers) with libVLC's renderer discoverers.
//! Discoverers run on the shared instance and keep a list of devices; one device can be selected.
//! libVLC only honours a renderer when playback starts, so the UI re-opens the current media
//! after (un)selecting one, and `apply` attaches the selection to every new player.

use serde::Serialize;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use super::frame::lock_ignore_poison;
use super::vlc;

const EVENT_ITEM_ADDED: c_int = 0x502;
const EVENT_ITEM_DELETED: c_int = 0x503;
const CAN_AUDIO: c_int = 0x1;
const CAN_VIDEO: c_int = 0x2;

#[repr(C)]
struct libvlc_renderer_item_t {
    _private: [u8; 0],
}
#[repr(C)]
struct libvlc_renderer_discoverer_t {
    _private: [u8; 0],
}
#[repr(C)]
struct libvlc_rd_description_t {
    name: *mut c_char,
    longname: *mut c_char,
}
/// The leading fields of `libvlc_event_t` followed by the renderer events' shared payload.
#[repr(C)]
struct RendererEvent {
    kind: c_int,
    sender: *mut c_void,
    item: *mut libvlc_renderer_item_t,
}

#[link(name = "vlc")]
extern "C" {
    fn libvlc_renderer_discoverer_list_get(instance: *mut vlc::libvlc_instance_t, list: *mut *mut *mut libvlc_rd_description_t) -> usize;
    fn libvlc_renderer_discoverer_list_release(list: *mut *mut libvlc_rd_description_t, count: usize);
    fn libvlc_renderer_discoverer_new(instance: *mut vlc::libvlc_instance_t, name: *const c_char) -> *mut libvlc_renderer_discoverer_t;
    fn libvlc_renderer_discoverer_start(rd: *mut libvlc_renderer_discoverer_t) -> c_int;
    fn libvlc_renderer_discoverer_stop(rd: *mut libvlc_renderer_discoverer_t);
    fn libvlc_renderer_discoverer_release(rd: *mut libvlc_renderer_discoverer_t);
    fn libvlc_renderer_discoverer_event_manager(rd: *mut libvlc_renderer_discoverer_t) -> *mut vlc::libvlc_event_manager_t;
    fn libvlc_renderer_item_hold(item: *mut libvlc_renderer_item_t) -> *mut libvlc_renderer_item_t;
    fn libvlc_renderer_item_release(item: *mut libvlc_renderer_item_t);
    fn libvlc_renderer_item_name(item: *const libvlc_renderer_item_t) -> *const c_char;
    fn libvlc_renderer_item_type(item: *const libvlc_renderer_item_t) -> *const c_char;
    fn libvlc_renderer_item_flags(item: *const libvlc_renderer_item_t) -> c_int;
    fn libvlc_media_player_set_renderer(player: *mut vlc::libvlc_media_player_t, item: *mut libvlc_renderer_item_t) -> c_int;
}

struct Item(*mut libvlc_renderer_item_t);
// SAFETY: renderer items are reference counted and thread-safe in libVLC.
unsafe impl Send for Item {}
struct Discoverer {
    rd: *mut libvlc_renderer_discoverer_t,
    label: String,
}
// SAFETY: the discoverer is only touched under the DISCOVERERS lock.
unsafe impl Send for Discoverer {}

struct Device {
    id: u32,
    item: Item,
    name: String,
    kind: String,
    flags: c_int,
}

static DISCOVERERS: Mutex<Vec<Discoverer>> = Mutex::new(Vec::new());
static DEVICES: Mutex<Vec<Device>> = Mutex::new(Vec::new());
/// The selected device's id and a reference to its item (kept even if the device disappears).
static SELECTED: Mutex<Option<(u32, Item)>> = Mutex::new(None);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

unsafe fn text(ptr: *const c_char) -> String {
    if ptr.is_null() {
        String::new()
    } else {
        CStr::from_ptr(ptr).to_string_lossy().into_owned()
    }
}

/// libVLC's callback (its own thread): record the device and return.
unsafe extern "C" fn on_event(event: *const vlc::libvlc_event_t, _data: *mut c_void) {
    let event = &*(event as *const RendererEvent);
    match event.kind {
        EVENT_ITEM_ADDED => {
            let item = libvlc_renderer_item_hold(event.item);
            let device = Device {
                id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
                name: text(libvlc_renderer_item_name(item)),
                kind: text(libvlc_renderer_item_type(item)),
                flags: libvlc_renderer_item_flags(item),
                item: Item(item),
            };
            lock_ignore_poison(&DEVICES).push(device);
        }
        EVENT_ITEM_DELETED => {
            let mut devices = lock_ignore_poison(&DEVICES);
            if let Some(i) = devices.iter().position(|d| d.item.0 == event.item) {
                let gone = devices.remove(i);
                libvlc_renderer_item_release(gone.item.0);
            }
        }
        _ => {}
    }
}

/// Starts every renderer discoverer libVLC knows (once). Returns their readable names; empty
/// when this libVLC has no discovery plugin (e.g. no Chromecast support installed).
fn discover() -> Result<Vec<String>, String> {
    let instance = super::instance()?;
    let mut running = lock_ignore_poison(&DISCOVERERS);
    if !running.is_empty() {
        return Ok(running.iter().map(|d| d.label.clone()).collect());
    }
    // SAFETY: plain libVLC calls; names are read before the list is released.
    unsafe {
        let mut list: *mut *mut libvlc_rd_description_t = std::ptr::null_mut();
        let count = libvlc_renderer_discoverer_list_get(instance, &mut list);
        for i in 0..count {
            let description = &**list.add(i);
            let rd = libvlc_renderer_discoverer_new(instance, description.name);
            if rd.is_null() {
                continue;
            }
            let events = libvlc_renderer_discoverer_event_manager(rd);
            vlc::libvlc_event_attach(events, EVENT_ITEM_ADDED, on_event, std::ptr::null_mut());
            vlc::libvlc_event_attach(events, EVENT_ITEM_DELETED, on_event, std::ptr::null_mut());
            if libvlc_renderer_discoverer_start(rd) != 0 {
                libvlc_renderer_discoverer_release(rd);
                continue;
            }
            let label = if description.longname.is_null() { text(description.name) } else { text(description.longname) };
            running.push(Discoverer { rd, label });
        }
        if !list.is_null() {
            libvlc_renderer_discoverer_list_release(list, count);
        }
    }
    Ok(running.iter().map(|d| d.label.clone()).collect())
}

/// Stops searching and forgets the devices found (the selection stays).
pub fn stop_discovery() {
    let mut running = lock_ignore_poison(&DISCOVERERS);
    // SAFETY: each discoverer is stopped and released exactly once; releasing joins its threads,
    // so `on_event` cannot run afterwards.
    unsafe {
        for d in running.drain(..) {
            libvlc_renderer_discoverer_stop(d.rd);
            libvlc_renderer_discoverer_release(d.rd);
        }
        for d in lock_ignore_poison(&DEVICES).drain(..) {
            libvlc_renderer_item_release(d.item.0);
        }
    }
}

/// Stops searching and casting (the app is locking, or the instance is being recreated).
pub fn stop_all() {
    stop_discovery();
    select(None);
}

fn select(id: Option<u32>) -> bool {
    let mut selected = lock_ignore_poison(&SELECTED);
    // SAFETY: items are reference counted; we hold our own reference to the selected one.
    unsafe {
        let next = match id {
            None => None,
            Some(id) => match lock_ignore_poison(&DEVICES).iter().find(|d| d.id == id) {
                Some(device) => Some((id, Item(libvlc_renderer_item_hold(device.item.0)))),
                None => return false,
            },
        };
        if let Some((_, old)) = selected.take() {
            libvlc_renderer_item_release(old.0);
        }
        *selected = next;
    }
    true
}

/// Sends the next playback to the selected device. Called when a player is created, before play.
pub(super) fn apply(player: *mut vlc::libvlc_media_player_t) {
    if let Some((_, item)) = lock_ignore_poison(&SELECTED).as_ref() {
        // SAFETY: the player is fresh and valid; the item is held by SELECTED.
        unsafe {
            libvlc_media_player_set_renderer(player, item.0);
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct RendererInfo {
    id: u32,
    name: String,
    /// libVLC's type, e.g. "chromecast".
    kind: String,
    video: bool,
    audio: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct CastState {
    /// Readable names of the searches that are running; empty means casting isn't available.
    searching: Vec<String>,
    devices: Vec<RendererInfo>,
    selected: Option<u32>,
}

fn state() -> CastState {
    CastState {
        searching: lock_ignore_poison(&DISCOVERERS).iter().map(|d| d.label.clone()).collect(),
        devices: lock_ignore_poison(&DEVICES)
            .iter()
            .map(|d| RendererInfo { id: d.id, name: d.name.clone(), kind: d.kind.clone(), video: d.flags & CAN_VIDEO != 0, audio: d.flags & CAN_AUDIO != 0 })
            .collect(),
        selected: lock_ignore_poison(&SELECTED).as_ref().map(|(id, _)| *id),
    }
}

/// Starts searching for devices and returns what is known so far.
#[tauri::command]
pub async fn video_cast_discover() -> Result<CastState, String> {
    super::ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(|| discover().map(|_| state())).await.map_err(|e| e.to_string())?
}

/// Devices found so far (poll while the dialog is open).
#[tauri::command]
pub async fn video_cast_state() -> Result<CastState, String> {
    super::ensure_unlocked()?;
    Ok(state())
}

/// Picks the device for the next playback (`None` = play on this computer). The UI re-opens the
/// current media afterwards so the change takes effect.
#[tauri::command]
pub async fn video_cast_to(id: Option<u32>) -> Result<CastState, String> {
    super::ensure_unlocked()?;
    if !select(id) {
        return Err("That device is no longer available.".into());
    }
    Ok(state())
}

/// Stops searching for devices (the dialog closed).
#[tauri::command]
pub async fn video_cast_stop_discovery() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(stop_discovery).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Whatever plugins this machine has, discovery starts and stops cleanly and a device that
    /// doesn't exist can't be selected.
    #[test]
    #[ignore]
    fn live_discovery_starts_and_stops() {
        let names = discover().unwrap();
        eprintln!("renderer discoverers: {names:?}");
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(!select(Some(9999)));
        let s = state();
        assert_eq!(s.searching.len(), names.len());
        stop_all();
        assert!(state().searching.is_empty() && state().selected.is_none());
    }
}
