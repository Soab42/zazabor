//! Metadata of the current media for the Playback tab: tags and per-stream details.

use super::frame::lock_ignore_poison;
use super::vlc::{libvlc_media_player_t, libvlc_media_t};
use super::{ensure_unlocked, with_player, PLAYER};
use serde::Serialize;
use std::ffi::{c_char, c_int, c_uint, c_void, CStr};

/// libvlc_media_track_t from libVLC 3 (`vlc/libvlc_media.h`).
#[repr(C)]
struct MediaTrack {
    codec: u32,
    original_fourcc: u32,
    id: c_int,
    kind: c_int,
    profile: c_int,
    level: c_int,
    /// Union of audio / video / subtitle details; points at the matching struct.
    details: *mut c_void,
    bitrate: c_uint,
    language: *mut c_char,
    description: *mut c_char,
}

#[repr(C)]
struct VideoDetails {
    height: c_uint,
    width: c_uint,
    sar_num: c_uint,
    sar_den: c_uint,
    frame_rate_num: c_uint,
    frame_rate_den: c_uint,
}

#[repr(C)]
struct AudioDetails {
    channels: c_uint,
    rate: c_uint,
}

const TRACK_AUDIO: c_int = 0;
const TRACK_VIDEO: c_int = 1;
const TRACK_TEXT: c_int = 2;

const META_TITLE: c_int = 0;
const META_ARTIST: c_int = 1;
const META_GENRE: c_int = 2;
const META_ALBUM: c_int = 4;
const META_DATE: c_int = 8;

#[link(name = "vlc")]
extern "C" {
    fn libvlc_media_player_get_media(player: *mut libvlc_media_player_t) -> *mut libvlc_media_t;
    fn libvlc_media_release(media: *mut libvlc_media_t);
    fn libvlc_media_get_meta(media: *mut libvlc_media_t, meta: c_int) -> *mut c_char;
    fn libvlc_media_tracks_get(media: *mut libvlc_media_t, tracks: *mut *mut *mut MediaTrack) -> c_uint;
    fn libvlc_media_tracks_release(tracks: *mut *mut MediaTrack, count: c_uint);
    fn libvlc_media_get_codec_description(kind: c_int, codec: u32) -> *const c_char;
    fn libvlc_free(ptr: *mut c_void);
}

#[derive(Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    codec: String,
    language: Option<String>,
    /// Bits per second, 0 when unknown.
    bitrate: u32,
    width: u32,
    height: u32,
    fps: f32,
    channels: u32,
    sample_rate: u32,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaMeta {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
    date: Option<String>,
    /// File size in bytes (0 for streams).
    size: u64,
    /// Sum of the streams' bitrates in kbit/s, or the size over the length when unknown.
    bitrate_kbps: u32,
    video: Vec<StreamInfo>,
    audio: Vec<StreamInfo>,
    subtitles: Vec<StreamInfo>,
}

/// A fourcc such as `avc1` as text; non-printable bytes become `?`.
pub(crate) fn fourcc(code: u32) -> String {
    code.to_le_bytes()
        .iter()
        .map(|&b| if (0x20..0x7f).contains(&b) { b as char } else { '?' })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Total kbit/s from stream bitrates, falling back to the file size over the duration.
pub(crate) fn total_kbps(stream_bps: u64, size: u64, length_ms: i64) -> u32 {
    if stream_bps > 0 {
        (stream_bps / 1000) as u32
    } else if size > 0 && length_ms > 0 {
        ((size as f64 * 8.0) / (length_ms as f64 / 1000.0) / 1000.0) as u32
    } else {
        0
    }
}

/// # Safety
/// `ptr` must be null or a NUL-terminated string.
unsafe fn text(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let s = CStr::from_ptr(ptr).to_string_lossy().trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// # Safety
/// `media` must be a live media.
unsafe fn tag(media: *mut libvlc_media_t, meta: c_int) -> Option<String> {
    let ptr = libvlc_media_get_meta(media, meta);
    let value = text(ptr);
    if !ptr.is_null() {
        libvlc_free(ptr as *mut c_void);
    }
    value
}

/// Collects the details of the current media (empty when nothing plays).
pub(crate) fn collect() -> MediaMeta {
    let mut meta = MediaMeta::default();
    let (path, length) = match lock_ignore_poison(&PLAYER).as_ref() {
        // SAFETY: the handle is valid while the PLAYER lock is held.
        Some(p) => (p.path.clone(), unsafe { super::vlc::libvlc_media_player_get_length(p.handle) }),
        None => return meta,
    };
    meta.size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut total_bps = 0u64;
    with_player(|p| {
        // SAFETY: see with_player; the media from get_media is retained and released below, the
        // track array is released with libvlc_media_tracks_release, and strings are copied.
        unsafe {
            let media = libvlc_media_player_get_media(p);
            if media.is_null() {
                return;
            }
            meta.title = tag(media, META_TITLE);
            meta.artist = tag(media, META_ARTIST);
            meta.album = tag(media, META_ALBUM);
            meta.genre = tag(media, META_GENRE);
            meta.date = tag(media, META_DATE);
            let mut tracks: *mut *mut MediaTrack = std::ptr::null_mut();
            let count = libvlc_media_tracks_get(media, &mut tracks);
            for i in 0..count as usize {
                let t = &**tracks.add(i);
                let codec = text(libvlc_media_get_codec_description(t.kind, t.codec)).unwrap_or_else(|| fourcc(t.codec));
                let mut info = StreamInfo { codec, language: text(t.language), bitrate: t.bitrate, ..Default::default() };
                total_bps += t.bitrate as u64;
                match t.kind {
                    TRACK_VIDEO => {
                        if !t.details.is_null() {
                            let v = &*(t.details as *const VideoDetails);
                            info.width = v.width;
                            info.height = v.height;
                            if v.frame_rate_den > 0 {
                                info.fps = v.frame_rate_num as f32 / v.frame_rate_den as f32;
                            }
                        }
                        meta.video.push(info);
                    }
                    TRACK_AUDIO => {
                        if !t.details.is_null() {
                            let a = &*(t.details as *const AudioDetails);
                            info.channels = a.channels;
                            info.sample_rate = a.rate;
                        }
                        meta.audio.push(info);
                    }
                    TRACK_TEXT => meta.subtitles.push(info),
                    _ => {}
                }
            }
            if !tracks.is_null() {
                libvlc_media_tracks_release(tracks, count);
            }
            libvlc_media_release(media);
        }
    });
    meta.bitrate_kbps = total_kbps(total_bps, meta.size, length);
    meta
}

#[tauri::command]
pub async fn video_meta() -> Result<MediaMeta, String> {
    ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(collect).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn fourcc_and_bitrate_helpers() {
        assert_eq!(fourcc(u32::from_le_bytes(*b"avc1")), "avc1");
        assert_eq!(fourcc(u32::from_le_bytes([b'a', 0, 1, b'b'])), "a??b");
        assert_eq!(total_kbps(2_500_000, 0, 0), 2500);
        assert_eq!(total_kbps(0, 1_000_000, 8_000), 1000);
        assert_eq!(total_kbps(0, 0, 8_000), 0);
    }

    /// Live check: `VIDEO_TEST_FILE=/path cargo test live_panel -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_panel_backend_reads_meta_tracks_and_applies_effects() {
        let file = std::env::var("VIDEO_TEST_FILE").expect("set VIDEO_TEST_FILE");
        super::super::open(file, 640, 360, 0).unwrap();
        let started = Instant::now();
        while super::super::snapshot().length == 0 && started.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(100));
        }
        std::thread::sleep(Duration::from_millis(800));
        let meta = collect();
        eprintln!("{meta:?}");
        assert!(!meta.video.is_empty() && meta.video[0].width > 0, "no video stream: {meta:?}");
        assert!(!meta.audio.is_empty());
        assert!(meta.bitrate_kbps > 0 || meta.size == 0);
        let tracks = super::super::tracks::video_tracks_now();
        eprintln!("video tracks {tracks:?}");
        assert!(!tracks.tracks.is_empty());
        let info = super::super::fx::equalizer_info();
        let rock = info.presets.iter().find(|p| p.name == "Rock").unwrap();
        super::super::fx::apply_equalizer(true, rock.preamp, &rock.bands).unwrap();
        super::super::fx::apply_equalizer(false, 0.0, &[]).unwrap();
        let delays = super::super::fx::set_delays(Some(-250), Some(400));
        eprintln!("delays {delays:?}");
        assert_eq!(delays, Some((-250, 400)));
        super::super::stop_player();
    }
}
