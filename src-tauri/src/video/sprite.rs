//! Seek-bar previews: while a video plays, a background libVLC player (fast seeking, no audio)
//! grabs one small frame every few seconds and caches each as a JPEG on disk. The UI asks for a
//! frame with `cs://localhost/vthumb?p=<path>&i=<index>&iv=<interval>` (404 until it exists) and
//! shows the nearest one it has. Frames come coarse first (every 8th, then every 4th…), so the
//! whole bar is covered early and fills in.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use xxhash_rust::xxh3::xxh3_64;

use super::thumb::{bgra_to_rgb, encode_jpeg, Thumbnailer};
use super::{blocking, ensure_unlocked};
use crate::protocol;
use crate::scan::unix_seconds;

/// Bump to invalidate every cached sprite frame.
const CACHE_VERSION: u32 = 1;
/// The long edge of a preview frame in pixels.
pub const FRAME_SIZE: u32 = 160;
pub const MAX_FRAMES: i64 = 120;
const MIN_INTERVAL_MS: i64 = 2000;
/// Per frame: how long to wait for the decoder, and how long to look past black frames.
const FRAME_TIMEOUT: Duration = Duration::from_millis(2500);
const DARK_SKIP: Duration = Duration::from_millis(250);
const START_TIMEOUT: Duration = Duration::from_secs(8);
/// A frame that fails this many times in a row ends the job (the file likely can't seek).
const MAX_FAILURES: u32 = 4;
/// Cached sprite frames beyond this many are deleted, oldest first (about 50 films).
const MAX_CACHED_FRAMES: usize = 6000;
/// Media options for quick seeks in a player nobody watches.
const FAST_OPTIONS: [&std::ffi::CStr; 3] = [c":input-fast-seek", c":avcodec-skiploopfilter=4", c":avcodec-fast"];

/// The newest job's number; an older job stops as soon as it sees a different value.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// How a video of a given length is sampled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    pub interval_ms: i64,
    pub count: u32,
}

/// One frame every `interval_ms`, at most `MAX_FRAMES` in all, never closer than 2 s.
pub fn plan(length_ms: i64) -> Option<Plan> {
    if length_ms <= 0 {
        return None;
    }
    let interval_ms = ((length_ms + MAX_FRAMES - 1) / MAX_FRAMES).max(MIN_INTERVAL_MS);
    let count = ((length_ms + interval_ms - 1) / interval_ms).max(1) as u32;
    Some(Plan { interval_ms, count })
}

/// Where in the video frame `index` is taken: the middle of its slot, always inside the video.
pub fn frame_time(plan: Plan, length_ms: i64, index: u32) -> i64 {
    (index as i64 * plan.interval_ms + plan.interval_ms / 2).min((length_ms - 250).max(0))
}

/// The order to fill frames in: every 8th, then the rest of every 4th, 2nd, and finally all.
pub fn fill_order(count: u32) -> Vec<u32> {
    let mut order = Vec::with_capacity(count as usize);
    let mut seen = vec![false; count as usize];
    for stride in [8usize, 4, 2, 1] {
        for i in (0..count).step_by(stride) {
            if !seen[i as usize] {
                seen[i as usize] = true;
                order.push(i);
            }
        }
    }
    order
}

fn stem(path: &Path, len: u64, mtime: f64, interval_ms: i64) -> String {
    let key = format!("vsprite|{CACHE_VERSION}|{}|{len}|{mtime}|{interval_ms}|{FRAME_SIZE}", path.display());
    format!("{:016x}", xxh3_64(key.as_bytes()))
}

fn frame_path(cache_dir: &Path, path: &Path, interval_ms: i64, index: u32) -> Option<PathBuf> {
    let meta = fs::metadata(path).ok()?;
    let stem = stem(path, meta.len(), unix_seconds(meta.modified()), interval_ms);
    Some(cache_dir.join("vsprite").join(format!("{stem}-{index}.jpg")))
}

/// A cached frame's JPEG bytes, if it has been made.
pub fn read_frame(path: &Path, interval_ms: i64, index: u32, cache_dir: &Path) -> Option<Vec<u8>> {
    fs::read(frame_path(cache_dir, path, interval_ms, index)?).ok()
}

/// Deletes the oldest cached frames once there are more than `max`.
fn prune(dir: &Path, max: usize) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= max {
        return;
    }
    files.sort();
    for (_, file) in &files[..files.len() - max] {
        let _ = fs::remove_file(file);
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpriteInfo {
    path: String,
    interval_ms: i64,
    count: u32,
    /// Indexes that already exist on disk.
    ready: Vec<u32>,
}

#[derive(Serialize, Clone)]
struct SpriteFrame {
    path: String,
    index: u32,
}

/// Starts (or resumes) generating preview frames for the open video; frames announce themselves
/// with `video-sprite` events `{ path, index }`. Starting another video stops the previous job.
#[tauri::command]
pub async fn video_sprite_start(app: AppHandle, path: String, length: i64) -> Result<Option<SpriteInfo>, String> {
    ensure_unlocked()?;
    let Some(plan) = plan(length) else { return Ok(None) };
    let Some(cache) = protocol::cache_dir() else { return Ok(None) };
    blocking(move || {
        let file = PathBuf::from(&path);
        let dir = cache.join("vsprite");
        let _ = fs::create_dir_all(&dir);
        prune(&dir, MAX_CACHED_FRAMES);
        let exists = |i: u32| frame_path(cache, &file, plan.interval_ms, i).is_some_and(|p| p.is_file());
        let ready: Vec<u32> = (0..plan.count).filter(|&i| exists(i)).collect();
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let missing: Vec<u32> = fill_order(plan.count).into_iter().filter(|i| !ready.contains(i)).collect();
        if !missing.is_empty() {
            let job_path = file.clone();
            std::thread::Builder::new()
                .name("vsprite".into())
                .spawn(move || {
                    #[cfg(unix)]
                    // SAFETY: setpriority only adjusts the scheduling priority of the calling thread.
                    unsafe {
                        libc::setpriority(libc::PRIO_PROCESS, 0, 12);
                    }
                    run(app, generation, job_path, length, plan, missing, cache);
                })
                .map_err(|e| e.to_string())?;
        }
        Ok(Some(SpriteInfo { path, interval_ms: plan.interval_ms, count: plan.count, ready }))
    })
    .await
}

/// Stops generating (the video was closed).
#[tauri::command]
pub async fn video_sprite_stop() -> Result<(), String> {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

fn run(app: AppHandle, generation: u64, path: PathBuf, length: i64, plan: Plan, indexes: Vec<u32>, cache: &Path) {
    let live = || GENERATION.load(Ordering::SeqCst) == generation && !crate::lock::is_locked();
    let Ok(thumb) = Thumbnailer::start_with(&path, FRAME_SIZE, &FAST_OPTIONS) else { return };
    if thumb.wait_ready(Instant::now() + START_TIMEOUT).is_err() {
        return;
    }
    let mut failures = 0;
    for index in indexes {
        if !live() {
            return;
        }
        let grabbed = thumb.grab(frame_time(plan, length, index), Instant::now() + FRAME_TIMEOUT, DARK_SKIP);
        let Ok((w, h, bgra)) = grabbed else {
            failures += 1;
            if failures >= MAX_FAILURES {
                return;
            }
            continue;
        };
        failures = 0;
        let Ok(jpeg) = encode_jpeg(&bgra_to_rgb(&bgra), w, h) else { continue };
        let Some(target) = frame_path(cache, &path, plan.interval_ms, index) else { return };
        // Write to a temp name then rename, so a request never reads half a file.
        let tmp = target.with_extension("tmp");
        if fs::write(&tmp, &jpeg).is_err() || fs::rename(&tmp, &target).is_err() {
            let _ = fs::remove_file(&tmp);
            continue;
        }
        if live() {
            let _ = app.emit("video-sprite", SpriteFrame { path: path.to_string_lossy().into_owned(), index });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_cover_the_video_with_at_most_120_frames() {
        assert_eq!(plan(0), None);
        assert_eq!(plan(-5), None);
        // Short clips: a frame every 2 s.
        assert_eq!(plan(30_000), Some(Plan { interval_ms: 2000, count: 15 }));
        assert_eq!(plan(1_000), Some(Plan { interval_ms: 2000, count: 1 }));
        // A two-hour film: 120 frames a minute apart.
        assert_eq!(plan(7_200_000), Some(Plan { interval_ms: 60_000, count: 120 }));
        let p = plan(7_201_000).unwrap();
        assert!(p.count as i64 <= MAX_FRAMES && p.interval_ms * p.count as i64 >= 7_201_000);
    }

    #[test]
    fn frames_are_taken_mid_slot_and_inside_the_video() {
        let p = plan(30_000).unwrap();
        assert_eq!(frame_time(p, 30_000, 0), 1000);
        assert_eq!(frame_time(p, 30_000, 3), 7000);
        assert_eq!(frame_time(p, 30_000, 14), 29_000);
        assert_eq!(frame_time(p, 29_000, 14), 28_750);
        assert_eq!(frame_time(p, 500, 0), 250);
        assert_eq!(frame_time(p, 100, 0), 0);
    }

    #[test]
    fn fill_order_is_coarse_first_and_complete() {
        let order = fill_order(20);
        assert_eq!(&order[..3], &[0, 8, 16]);
        let mut sorted = order.clone();
        sorted.sort();
        assert_eq!(sorted, (0..20).collect::<Vec<_>>());
        assert_eq!(fill_order(1), vec![0]);
        assert!(fill_order(0).is_empty());
    }

    #[test]
    fn cache_names_depend_on_the_video_and_the_sampling() {
        let p = Path::new("/v/a.mp4");
        let base = stem(p, 10, 1.0, 5000);
        assert_eq!(base, stem(p, 10, 1.0, 5000));
        assert_ne!(base, stem(p, 10, 1.0, 6000));
        assert_ne!(base, stem(p, 11, 1.0, 5000));
        assert_ne!(base, stem(p, 10, 2.0, 5000));
    }

    #[test]
    fn prune_keeps_the_newest_files() {
        let dir = std::env::temp_dir().join(format!("vsprite-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for i in 0..5 {
            fs::write(dir.join(format!("{i}.jpg")), [i as u8]).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        prune(&dir, 2);
        let mut left: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["3.jpg", "4.jpg"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Live check: `VIDEO_TEST_FILE=/path/to.mp4 cargo test sprite_live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn sprite_live_generates_frames_on_a_real_file() {
        let file = PathBuf::from(std::env::var("VIDEO_TEST_FILE").expect("set VIDEO_TEST_FILE"));
        let started = Instant::now();
        let thumb = Thumbnailer::start_with(&file, FRAME_SIZE, &FAST_OPTIONS).unwrap();
        let length = thumb.wait_ready(Instant::now() + START_TIMEOUT).unwrap();
        let plan = plan(length).unwrap();
        let mut made = 0;
        for index in fill_order(plan.count).into_iter().take(8) {
            let (w, h, bgra) = thumb
                .grab(frame_time(plan, length, index), Instant::now() + FRAME_TIMEOUT, DARK_SKIP)
                .unwrap_or_else(|e| panic!("frame {index}: {e}"));
            assert!(w <= FRAME_SIZE && h <= FRAME_SIZE);
            let jpeg = encode_jpeg(&bgra_to_rgb(&bgra), w, h).unwrap();
            assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
            made += 1;
        }
        eprintln!("{made} frames of {plan:?} (length {length} ms) in {:?}", started.elapsed());
        assert_eq!(made, 8.min(plan.count));
    }
}
