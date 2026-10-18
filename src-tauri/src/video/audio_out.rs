//! Audio output devices (speakers, headphones…): listing them for the audio quick menu and
//! switching the open player to another one.

use serde::Serialize;
use std::ffi::{c_char, c_void, CStr, CString};

use super::vlc::libvlc_media_player_t;
use super::{blocking, ensure_unlocked, wake, with_player};

#[repr(C)]
struct libvlc_audio_output_device_t {
    next: *mut libvlc_audio_output_device_t,
    device: *mut c_char,
    description: *mut c_char,
}

#[link(name = "vlc")]
extern "C" {
    fn libvlc_audio_output_device_enum(player: *mut libvlc_media_player_t) -> *mut libvlc_audio_output_device_t;
    fn libvlc_audio_output_device_list_release(list: *mut libvlc_audio_output_device_t);
    fn libvlc_audio_output_device_get(player: *mut libvlc_media_player_t) -> *mut c_char;
    fn libvlc_audio_output_device_set(player: *mut libvlc_media_player_t, module: *const c_char, device_id: *const c_char);
    fn libvlc_free(ptr: *mut c_void);
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AudioDevice {
    id: String,
    name: String,
    current: bool,
}

/// Turns raw (id, description) pairs into the list shown to the user: unnamed entries get a
/// readable name, repeated ids are dropped, and the one matching `current` is marked. When
/// libVLC does not say which is in use, the first entry (the system default) is.
pub fn build_devices(raw: Vec<(String, String)>, current: Option<&str>) -> Vec<AudioDevice> {
    let mut devices: Vec<AudioDevice> = Vec::new();
    for (id, description) in raw {
        if devices.iter().any(|d| d.id == id) {
            continue;
        }
        let name = if !description.trim().is_empty() {
            description.trim().to_string()
        } else if id.is_empty() {
            "Default".to_string()
        } else {
            id.clone()
        };
        devices.push(AudioDevice { id, name, current: false });
    }
    let marked = current.and_then(|c| devices.iter().position(|d| d.id == c));
    if let Some(i) = marked.or(if devices.is_empty() { None } else { Some(0) }) {
        devices[i].current = true;
    }
    devices
}

/// # Safety
/// `ptr` must be null or a NUL-terminated string.
unsafe fn text(ptr: *const c_char) -> String {
    if ptr.is_null() {
        String::new()
    } else {
        CStr::from_ptr(ptr).to_string_lossy().into_owned()
    }
}

fn list_devices() -> Vec<AudioDevice> {
    with_player(|p| {
        // SAFETY: the handle is valid while the PLAYER lock is held (see with_player); the list
        // and the current-device string are libVLC-owned and released exactly once below.
        unsafe {
            let head = libvlc_audio_output_device_enum(p);
            let mut raw = Vec::new();
            let mut node = head;
            while !node.is_null() {
                raw.push((text((*node).device), text((*node).description)));
                node = (*node).next;
            }
            if !head.is_null() {
                libvlc_audio_output_device_list_release(head);
            }
            let current = libvlc_audio_output_device_get(p);
            let current_id = if current.is_null() { None } else { Some(text(current)) };
            if !current.is_null() {
                libvlc_free(current as *mut c_void);
            }
            build_devices(raw, current_id.as_deref())
        }
    })
    .unwrap_or_default()
}

/// The output devices of the open player, the one in use marked `current`.
#[tauri::command]
pub async fn video_audio_devices() -> Result<Vec<AudioDevice>, String> {
    ensure_unlocked()?;
    blocking(|| Ok(list_devices())).await
}

/// Plays the open file's sound through another device (an `id` from `video_audio_devices`).
#[tauri::command]
pub async fn video_set_audio_device(id: String) -> Result<(), String> {
    ensure_unlocked()?;
    let id = CString::new(id).map_err(|e| e.to_string())?;
    blocking(move || {
        with_player(|p| {
            // SAFETY: see with_player; a null module keeps the current audio output module.
            unsafe { libvlc_audio_output_device_set(p, std::ptr::null(), id.as_ptr()) }
        })
        .ok_or_else(|| "Nothing is playing.".to_string())
    })
    .await?;
    wake();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn marks_the_current_device() {
        let list = build_devices(raw(&[("", "Default"), ("hw:0", "Speakers"), ("hw:1", "Headphones")]), Some("hw:1"));
        assert_eq!(list.iter().filter(|d| d.current).count(), 1);
        assert!(list[2].current && !list[0].current);
    }

    #[test]
    fn falls_back_to_the_first_when_current_is_unknown() {
        let list = build_devices(raw(&[("", "Default"), ("hw:0", "Speakers")]), None);
        assert!(list[0].current);
        let list = build_devices(raw(&[("a", "A"), ("b", "B")]), Some("gone"));
        assert!(list[0].current && !list[1].current);
        assert!(build_devices(Vec::new(), Some("x")).is_empty());
    }

    #[test]
    fn names_blank_entries_and_drops_repeats() {
        let list = build_devices(raw(&[("", " "), ("hw:0", ""), ("hw:0", "Again"), ("hw:2", "  Jack  ")]), Some(""));
        let names: Vec<&str> = list.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["Default", "hw:0", "Jack"]);
        assert!(list[0].current);
    }
}
