//! Opening things that are not plain files: URLs and device addresses (MRLs), and the list of
//! video capture devices (webcams, TV cards) found under `/dev` with their names from sysfs.

use serde::Serialize;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::Path;
use std::time::{Duration, Instant};

use super::vlc;

/// True for `scheme://…` addresses (http, rtsp, v4l2, dvd, file…), false for file system paths.
pub fn is_location(path: &str) -> bool {
    let Some((scheme, _)) = path.split_once("://") else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

#[link(name = "vlc")]
extern "C" {
    fn libvlc_media_new_location(instance: *mut vlc::libvlc_instance_t, mrl: *const c_char) -> *mut vlc::libvlc_media_t;
}

/// A libVLC media for a path or an address; null when libVLC refuses it.
///
/// # Safety
/// `instance` must be a live libVLC instance.
pub(super) unsafe fn new_media(instance: *mut vlc::libvlc_instance_t, path: &str) -> *mut vlc::libvlc_media_t {
    let Ok(cpath) = CString::new(path) else {
        return std::ptr::null_mut();
    };
    if is_location(path) {
        libvlc_media_new_location(instance, cpath.as_ptr())
    } else {
        vlc::libvlc_media_new_path(instance, cpath.as_ptr())
    }
}

/// What a playlist address (M3U, PLS, XSPF…) contains.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PlaylistEntry {
    pub title: String,
    /// An address `video_open` accepts.
    pub mrl: String,
}

#[link(name = "vlc")]
extern "C" {
    fn libvlc_media_parse_with_options(media: *mut vlc::libvlc_media_t, flags: c_int, timeout: c_int) -> c_int;
    fn libvlc_media_get_parsed_status(media: *mut vlc::libvlc_media_t) -> c_int;
    fn libvlc_media_subitems(media: *mut vlc::libvlc_media_t) -> *mut c_void;
    fn libvlc_media_list_lock(list: *mut c_void);
    fn libvlc_media_list_unlock(list: *mut c_void);
    fn libvlc_media_list_count(list: *mut c_void) -> c_int;
    fn libvlc_media_list_item_at_index(list: *mut c_void, index: c_int) -> *mut vlc::libvlc_media_t;
    fn libvlc_media_list_release(list: *mut c_void);
    fn libvlc_media_get_mrl(media: *mut vlc::libvlc_media_t) -> *mut c_char;
    fn libvlc_media_get_meta(media: *mut vlc::libvlc_media_t, kind: c_int) -> *mut c_char;
    fn libvlc_free(ptr: *mut c_void);
}

const PARSE_NETWORK: c_int = 0x01;
const META_TITLE: c_int = 0;

/// Reads a libVLC-allocated string and frees it.
unsafe fn take_string(ptr: *mut c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let text = CStr::from_ptr(ptr).to_string_lossy().into_owned();
    libvlc_free(ptr as *mut c_void);
    Some(text)
}

/// Opens a playlist address and lists its entries. An address that is not a playlist gives one
/// entry: itself. Blocks up to `timeout` while libVLC fetches and parses it.
pub fn resolve_playlist(url: &str, timeout: Duration) -> Result<Vec<PlaylistEntry>, String> {
    let instance = super::instance()?;
    // SAFETY: plain libVLC calls; the media and the sub-item list are released before returning.
    unsafe {
        let media = new_media(instance, url);
        if media.is_null() {
            return Err("That address could not be opened.".into());
        }
        libvlc_media_parse_with_options(media, PARSE_NETWORK, timeout.as_millis() as c_int);
        let started = Instant::now();
        while libvlc_media_get_parsed_status(media) == 0 && started.elapsed() < timeout + Duration::from_secs(1) {
            std::thread::sleep(Duration::from_millis(25));
        }
        let mut entries = Vec::new();
        let list = libvlc_media_subitems(media);
        if !list.is_null() {
            libvlc_media_list_lock(list);
            for i in 0..libvlc_media_list_count(list) {
                let item = libvlc_media_list_item_at_index(list, i);
                if item.is_null() {
                    continue;
                }
                if let Some(mrl) = take_string(libvlc_media_get_mrl(item)) {
                    let title = take_string(libvlc_media_get_meta(item, META_TITLE)).filter(|t| !t.is_empty()).unwrap_or_else(|| mrl.clone());
                    entries.push(PlaylistEntry { title, mrl });
                }
                vlc::libvlc_media_release(item);
            }
            libvlc_media_list_unlock(list);
            libvlc_media_list_release(list);
        }
        vlc::libvlc_media_release(media);
        if entries.is_empty() {
            entries.push(PlaylistEntry { title: url.to_string(), mrl: url.to_string() });
        }
        Ok(entries)
    }
}

/// The entries of a playlist address (an IPTV list, an M3U on a web server…).
#[tauri::command]
pub async fn video_resolve_playlist(url: String) -> Result<Vec<PlaylistEntry>, String> {
    super::ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || resolve_playlist(&url, Duration::from_secs(8))).await.map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct CaptureDevice {
    /// e.g. `/dev/video0`.
    pub path: String,
    /// The camera's own name, e.g. "Integrated Camera".
    pub name: String,
    /// What to hand to `video_open`, e.g. `v4l2:///dev/video0`.
    pub mrl: String,
}

/// Lists `video<N>` nodes under `dev`, named from `<sys>/video<N>/name`. Nodes that are not a
/// device's main capture node (sysfs `index` other than 0, e.g. metadata streams) are skipped.
pub fn list_devices(dev: &Path, sys: &Path) -> Vec<CaptureDevice> {
    let Ok(entries) = std::fs::read_dir(dev) else {
        return Vec::new();
    };
    let mut found: Vec<(u32, CaptureDevice)> = entries
        .flatten()
        .filter_map(|entry| {
            let file = entry.file_name().to_string_lossy().into_owned();
            let number: u32 = file.strip_prefix("video")?.parse().ok()?;
            let node = sys.join(&file);
            let index = std::fs::read_to_string(node.join("index")).ok().and_then(|s| s.trim().parse::<u32>().ok());
            if index.is_some_and(|i| i != 0) {
                return None;
            }
            let name = std::fs::read_to_string(node.join("name"))
                .map(|s| s.trim().to_string())
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("Camera {}", number + 1));
            let path = format!("{}/{file}", dev.display());
            let mrl = format!("v4l2://{path}");
            Some((number, CaptureDevice { path, name, mrl }))
        })
        .collect();
    found.sort_by_key(|(number, _)| *number);
    found.into_iter().map(|(_, device)| device).collect()
}

#[tauri::command]
pub async fn video_capture_devices() -> Result<Vec<CaptureDevice>, String> {
    super::ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(|| list_devices(Path::new("/dev"), Path::new("/sys/class/video4linux")))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn urls_and_device_addresses_are_locations_paths_are_not() {
        for yes in ["http://a/b.mp4", "https://x", "rtsp://cam/stream", "v4l2:///dev/video0", "file:///tmp/a.mp4", "dvd://", "udp+x://1"] {
            assert!(is_location(yes), "{yes}");
        }
        for no in ["/home/a/b.mp4", "relative/x.mkv", "C:\\a\\b.mp4", "/tmp/odd://name.mp4", "://nothing", "1http://x", "a b://c", "plain"] {
            assert!(!is_location(no), "{no}");
        }
    }

    #[test]
    fn devices_come_from_a_fake_tree_with_sysfs_names() {
        let root = std::env::temp_dir().join(format!("zazabor-v4l-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (dev, sys) = (root.join("dev"), root.join("sys"));
        fs::create_dir_all(&dev).unwrap();
        for (node, name, index) in [("video0", "Integrated Camera\n", "0"), ("video1", "Integrated Camera\n", "1"), ("video10", "Capture Card", "0")] {
            fs::write(dev.join(node), "").unwrap();
            fs::create_dir_all(sys.join(node)).unwrap();
            fs::write(sys.join(node).join("name"), name).unwrap();
            fs::write(sys.join(node).join("index"), index).unwrap();
        }
        // No sysfs entry at all: still listed, with a generic name. Other files are ignored.
        fs::write(dev.join("video3"), "").unwrap();
        fs::write(dev.join("videox"), "").unwrap();
        fs::write(dev.join("null"), "").unwrap();

        let devices = list_devices(&dev, &sys);
        let summary: Vec<_> = devices.iter().map(|d| (d.name.as_str(), d.path.rsplit('/').next().unwrap())).collect();
        assert_eq!(summary, [("Integrated Camera", "video0"), ("Camera 4", "video3"), ("Capture Card", "video10")]);
        assert_eq!(devices[0].mrl, format!("v4l2://{}/video0", dev.display()));
        let _ = fs::remove_dir_all(&root);
    }

    /// `VIDEO_TEST_FILE=/a.mp4 cargo test live_playlist -- --ignored`: an M3U on disk lists its entries.
    #[test]
    #[ignore]
    fn live_playlist_lists_its_entries() {
        let file = std::env::var("VIDEO_TEST_FILE").expect("set VIDEO_TEST_FILE");
        let dir = std::env::temp_dir().join(format!("zazabor-m3u-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let m3u = dir.join("list.m3u");
        fs::write(&m3u, format!("#EXTM3U\n#EXTINF:-1,First channel\n{file}\n#EXTINF:-1,Second channel\n{file}\n")).unwrap();
        let url = url::Url::from_file_path(&m3u).unwrap();
        let entries = resolve_playlist(url.as_str(), Duration::from_secs(5)).unwrap();
        eprintln!("{entries:?}");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].title, "First channel");
        let single = resolve_playlist(&file, Duration::from_secs(5)).unwrap();
        assert_eq!(single.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_dev_folder_is_an_empty_list() {
        assert!(list_devices(Path::new("/nonexistent-zazabor"), Path::new("/nonexistent")).is_empty());
    }
}
