//! Chapters of the open file (from the container: MKV, MP4, DVD…), for the Bookmarks tab and the
//! seek bar's ticks.

use serde::Serialize;
use std::ffi::{c_char, c_int, c_uint, CStr};

use super::vlc::libvlc_media_player_t;
use super::{blocking, ensure_unlocked, wake, with_player};

#[repr(C)]
struct libvlc_chapter_description_t {
    time_offset: i64,
    duration: i64,
    name: *mut c_char,
}

#[link(name = "vlc")]
extern "C" {
    fn libvlc_media_player_get_full_chapter_descriptions(
        player: *mut libvlc_media_player_t,
        title: c_int,
        chapters: *mut *mut *mut libvlc_chapter_description_t,
    ) -> c_int;
    fn libvlc_chapter_descriptions_release(chapters: *mut *mut libvlc_chapter_description_t, count: c_uint);
    fn libvlc_media_player_set_chapter(player: *mut libvlc_media_player_t, chapter: c_int);
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    index: u32,
    name: String,
    /// Start and length in milliseconds.
    start: i64,
    duration: i64,
}

/// Some muxers name chapters by their start time ("00:07:58.895"); that is no name.
fn is_timecode(name: &str) -> bool {
    name.len() >= 5 && name.contains(':') && name.chars().all(|c| c.is_ascii_digit() || c == ':' || c == '.')
}

/// A chapter as the container names it, or "Chapter N" when it has no usable name.
pub fn chapter_name(raw: &str, index: u32) -> String {
    let name = raw.trim();
    if name.is_empty() || is_timecode(name) {
        format!("Chapter {}", index + 1)
    } else {
        name.to_string()
    }
}

/// Builds the list from (start, duration, name) triples: negative values are clamped, and
/// chapters starting at or past the end of the file (`length` > 0) are dropped.
pub fn build_chapters(raw: Vec<(i64, i64, String)>, length: i64) -> Vec<Chapter> {
    raw.into_iter()
        .enumerate()
        .filter(|(_, (start, _, _))| length <= 0 || *start < length)
        .map(|(i, (start, duration, name))| Chapter {
            index: i as u32,
            name: chapter_name(&name, i as u32),
            start: start.max(0),
            duration: duration.max(0),
        })
        .collect()
}

fn list_chapters() -> Vec<Chapter> {
    with_player(|p| {
        // SAFETY: the handle is valid while the PLAYER lock is held (see with_player). The array
        // is allocated by libVLC and released once with the count it returned.
        unsafe {
            let mut array: *mut *mut libvlc_chapter_description_t = std::ptr::null_mut();
            let count = libvlc_media_player_get_full_chapter_descriptions(p, -1, &mut array);
            if count <= 0 || array.is_null() {
                return Vec::new();
            }
            let mut raw = Vec::with_capacity(count as usize);
            for i in 0..count as usize {
                let entry = *array.add(i);
                if entry.is_null() {
                    continue;
                }
                let name = if (*entry).name.is_null() { String::new() } else { CStr::from_ptr((*entry).name).to_string_lossy().into_owned() };
                raw.push(((*entry).time_offset, (*entry).duration, name));
            }
            libvlc_chapter_descriptions_release(array, count as c_uint);
            build_chapters(raw, libvlc_length(p))
        }
    })
    .unwrap_or_default()
}

/// # Safety
/// `p` must be a valid player handle.
unsafe fn libvlc_length(p: *mut libvlc_media_player_t) -> i64 {
    super::vlc::libvlc_media_player_get_length(p).max(0)
}

/// The open file's chapters; empty when it has none.
#[tauri::command]
pub async fn video_chapters() -> Result<Vec<Chapter>, String> {
    ensure_unlocked()?;
    blocking(|| Ok(list_chapters())).await
}

/// Jumps to a chapter (an `index` from `video_chapters`).
#[tauri::command]
pub async fn video_set_chapter(index: u32) -> Result<(), String> {
    ensure_unlocked()?;
    with_player(|p| {
        // SAFETY: see with_player.
        unsafe { libvlc_media_player_set_chapter(p, index as c_int) }
    });
    wake();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_unnamed_chapters_by_number() {
        assert_eq!(chapter_name("  ", 0), "Chapter 1");
        assert_eq!(chapter_name("Opening", 4), "Opening");
        assert_eq!(chapter_name(" Intro ", 1), "Intro");
        assert_eq!(chapter_name("00:07:58.895", 1), "Chapter 2");
        assert_eq!(chapter_name("Part 1: 2024", 0), "Part 1: 2024");
    }

    #[test]
    fn builds_a_clean_list() {
        let list = build_chapters(vec![(0, 60_000, "".into()), (60_000, 30_000, "Act 1".into()), (90_000, 10, "Past the end".into())], 90_000);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], Chapter { index: 0, name: "Chapter 1".into(), start: 0, duration: 60_000 });
        assert_eq!(list[1].name, "Act 1");
        // Unknown length keeps everything; negatives are clamped.
        let list = build_chapters(vec![(-5, -1, "x".into()), (100, 5, "y".into())], 0);
        assert_eq!((list[0].start, list[0].duration, list.len()), (0, 0, 2));
    }

    /// Live check against a file with chapters: `VIDEO_CHAPTER_FILE=/path/to.mkv cargo test chapters_live -- --ignored --nocapture`.
    /// Files without chapters pass too (an empty list is a valid answer).
    #[test]
    #[ignore]
    fn chapters_live_reads_a_real_file() {
        let file = std::env::var("VIDEO_CHAPTER_FILE").or_else(|_| std::env::var("VIDEO_TEST_FILE")).expect("set VIDEO_CHAPTER_FILE");
        super::super::open(file, 640, 360, 0).unwrap();
        let started = std::time::Instant::now();
        let mut list = Vec::new();
        while started.elapsed() < std::time::Duration::from_secs(8) {
            std::thread::sleep(std::time::Duration::from_millis(250));
            list = list_chapters();
            if !list.is_empty() {
                break;
            }
        }
        eprintln!("{} chapters: {list:?}", list.len());
        for pair in list.windows(2) {
            assert!(pair[0].start <= pair[1].start, "chapters out of order");
        }
        super::super::stop_player();
    }
}
