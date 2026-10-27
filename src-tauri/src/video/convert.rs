//! Converting media to another format with libVLC's stream output (`:sout=#transcode{…}:std{…}`).
//! Each job runs on its own background player (no picture, no sound) and reports progress as
//! `video-convert` events: `{ id, progress, state, error, … }` with `state` one of `running`,
//! `done`, `failed` or `cancelled`.

use serde::Serialize;
use std::ffi::{c_int, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use super::frame::lock_ignore_poison;
use super::{capture, vlc};

const STATE_STOPPED: c_int = 5;
const STATE_ENDED: c_int = 6;
const STATE_ERROR: c_int = 7;
const POLL: Duration = Duration::from_millis(200);

/// A target format: the `transcode` options and the container libVLC writes it into. Audio is
/// MP3 through the "shine" encoder: libVLC 3's AAC encoder stalls with current FFmpeg builds
/// (no output), and its default MP3 encoder needs LAME, which distributions leave out.
struct Profile {
    id: &'static str,
    ext: &'static str,
    mux: &'static str,
    transcode: &'static str,
}

const PROFILES: [Profile; 4] = [
    Profile {
        id: "mp4",
        ext: "mp4",
        mux: "mp4",
        transcode: "vcodec=h264,venc=x264{preset=veryfast,crf=23},acodec=mp3,aenc=shine,ab=192,channels=2,samplerate=44100",
    },
    Profile {
        id: "mp4-720",
        ext: "mp4",
        mux: "mp4",
        transcode: "vcodec=h264,venc=x264{preset=veryfast,crf=25},height=720,acodec=mp3,aenc=shine,ab=160,channels=2,samplerate=44100",
    },
    Profile { id: "webm", ext: "webm", mux: "webm", transcode: "vcodec=VP90,vb=2500,acodec=opus,ab=128,channels=2,samplerate=48000" },
    Profile { id: "mp3", ext: "mp3", mux: "raw", transcode: "vcodec=none,acodec=mp3,aenc=shine,ab=192,channels=2,samplerate=44100" },
];

fn profile(id: &str) -> Result<&'static Profile, String> {
    PROFILES.iter().find(|p| p.id == id).ok_or_else(|| "That format isn't available.".to_string())
}

/// libVLC option values may be quoted; inside quotes `\` and `"` are escaped.
fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The `:sout=` chain for a profile writing to `dest`.
fn sout(profile: &Profile, dest: &Path) -> String {
    format!("#transcode{{{}}}:std{{access=file,mux={},dst={}}}", profile.transcode, profile.mux, quote(&dest.to_string_lossy()))
}

/// `dir/stem.ext`, or `dir/stem (2).ext`, … when that exists.
fn unique_dest(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    candidate
}

fn source_stem(source: &str) -> String {
    let name = if capture::is_location(source) {
        source.split(['?', '#']).next().unwrap_or(source).trim_end_matches('/').rsplit('/').next().unwrap_or("stream").to_string()
    } else {
        Path::new(source).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "converted".into())
    };
    let stem = Path::new(&name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or(name);
    let stem = stem.replace(['/', '\\'], "_");
    if stem.is_empty() { "converted".into() } else { stem }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub id: u32,
    pub source: String,
    pub dest: String,
    pub profile: String,
    /// 0–1.
    pub progress: f64,
    pub state: &'static str,
    pub error: Option<String>,
}

struct Entry {
    info: JobInfo,
    cancel: Arc<AtomicBool>,
}

static JOBS: Mutex<Vec<Entry>> = Mutex::new(Vec::new());
static NEXT_ID: AtomicU32 = AtomicU32::new(1);
static APP: OnceLock<AppHandle> = OnceLock::new();

/// A conversion is running, so the shared libVLC instance must not be recreated.
pub fn busy() -> bool {
    lock_ignore_poison(&JOBS).iter().any(|e| e.info.state == "running")
}

/// Cancels every running job (the app is locking). The jobs clean up on their own threads.
pub fn cancel_all() {
    for entry in lock_ignore_poison(&JOBS).iter() {
        entry.cancel.store(true, Ordering::SeqCst);
    }
}

fn update(id: u32, change: impl FnOnce(&mut JobInfo)) {
    let info = {
        let mut jobs = lock_ignore_poison(&JOBS);
        let Some(entry) = jobs.iter_mut().find(|e| e.info.id == id) else { return };
        change(&mut entry.info);
        entry.info.clone()
    };
    if let Some(app) = APP.get() {
        let _ = app.emit("video-convert", &info);
    }
}

/// Registers a job and starts it on a background thread.
pub fn start_job(source: &str, profile_id: &str, dest_dir: &Path, max_seconds: Option<u32>) -> Result<JobInfo, String> {
    let profile = profile(profile_id)?;
    if !dest_dir.is_dir() {
        return Err("The destination folder could not be found.".into());
    }
    if !capture::is_location(source) && !Path::new(source).is_file() {
        return Err("That file could not be found.".into());
    }
    let dest = unique_dest(dest_dir, &source_stem(source), profile.ext);
    let info = JobInfo {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
        source: source.to_string(),
        dest: dest.to_string_lossy().into_owned(),
        profile: profile.id.to_string(),
        progress: 0.0,
        state: "running",
        error: None,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    lock_ignore_poison(&JOBS).push(Entry { info: info.clone(), cancel: cancel.clone() });
    let (id, source, chain) = (info.id, source.to_string(), sout(profile, &dest));
    std::thread::Builder::new()
        .name(format!("video-convert-{id}"))
        .spawn(move || {
            let outcome = run(id, &source, &chain, &dest, max_seconds, &cancel);
            if !matches!(outcome, Outcome::Done) {
                let _ = std::fs::remove_file(&dest);
            }
            update(id, |j| match &outcome {
                Outcome::Done => {
                    j.progress = 1.0;
                    j.state = "done";
                }
                Outcome::Cancelled => j.state = "cancelled",
                Outcome::Failed(why) => {
                    j.state = "failed";
                    j.error = Some(why.clone());
                }
            });
        })
        .map_err(|e| e.to_string())?;
    Ok(info)
}

enum Outcome {
    Done,
    Cancelled,
    Failed(String),
}

const FAILED: &str = "The conversion didn't work. This format may not be supported by the installed VLC, or the file may be damaged.";

fn run(id: u32, source: &str, chain: &str, dest: &Path, max_seconds: Option<u32>, cancel: &AtomicBool) -> Outcome {
    let instance = match super::instance() {
        Ok(i) => i,
        Err(e) => return Outcome::Failed(e),
    };
    // SAFETY: plain libVLC calls on a player this function owns and releases before returning.
    unsafe {
        let media = capture::new_media(instance, source);
        if media.is_null() {
            return Outcome::Failed("libVLC could not open the source.".into());
        }
        let mut options = vec![format!(":sout={chain}")];
        if let Some(seconds) = max_seconds {
            options.push(format!(":stop-time={seconds}"));
        }
        for option in options {
            let option = CString::new(option).expect("no NUL in options");
            vlc::libvlc_media_add_option(media, option.as_ptr());
        }
        let player = vlc::libvlc_media_player_new_from_media(media);
        vlc::libvlc_media_release(media);
        if player.is_null() {
            return Outcome::Failed("libVLC could not create a converter.".into());
        }
        if vlc::libvlc_media_player_play(player) != 0 {
            vlc::libvlc_media_player_release(player);
            return Outcome::Failed(FAILED.into());
        }
        let mut last = 0.0;
        let outcome = loop {
            std::thread::sleep(POLL);
            if cancel.load(Ordering::SeqCst) {
                break Outcome::Cancelled;
            }
            let state = vlc::libvlc_media_player_get_state(player);
            let length = vlc::libvlc_media_player_get_length(player);
            let time = vlc::libvlc_media_player_get_time(player);
            let total = match max_seconds {
                Some(s) if length > 0 => length.min(s as i64 * 1000),
                Some(s) => s as i64 * 1000,
                None => length,
            };
            if total > 0 && time >= 0 {
                let progress = (time as f64 / total as f64).clamp(0.0, 0.99);
                if progress - last >= 0.005 {
                    last = progress;
                    update(id, |j| j.progress = progress);
                }
            }
            match state {
                STATE_ENDED => break Outcome::Done,
                STATE_STOPPED => break if time > 0 || last > 0.0 { Outcome::Done } else { Outcome::Failed(FAILED.into()) },
                STATE_ERROR => break Outcome::Failed(FAILED.into()),
                _ => {}
            }
        };
        // Stopping flushes and closes the output file.
        vlc::libvlc_media_player_stop(player);
        vlc::libvlc_media_player_release(player);
        match outcome {
            Outcome::Done if std::fs::metadata(dest).map(|m| m.len() == 0).unwrap_or(true) => Outcome::Failed(
                "No file was written. This copy of VLC may be missing the encoder or file type for this format.".into(),
            ),
            other => other,
        }
    }
}

#[tauri::command]
pub async fn video_convert_start(app: AppHandle, source: String, profile: String, dest_dir: String, max_seconds: Option<u32>) -> Result<JobInfo, String> {
    super::ensure_unlocked()?;
    let _ = APP.set(app);
    tauri::async_runtime::spawn_blocking(move || start_job(&source, &profile, Path::new(&dest_dir), max_seconds))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn video_convert_cancel(id: u32) -> Result<(), String> {
    super::ensure_unlocked()?;
    if let Some(entry) = lock_ignore_poison(&JOBS).iter().find(|e| e.info.id == id) {
        entry.cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// All jobs of this session, oldest first.
#[tauri::command]
pub async fn video_convert_jobs() -> Result<Vec<JobInfo>, String> {
    super::ensure_unlocked()?;
    Ok(lock_ignore_poison(&JOBS).iter().map(|e| e.info.clone()).collect())
}

/// Forgets jobs that are no longer running.
#[tauri::command]
pub async fn video_convert_clear() -> Result<(), String> {
    super::ensure_unlocked()?;
    lock_ignore_poison(&JOBS).retain(|e| e.info.state == "running");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sout_chains_name_the_codecs_container_and_a_quoted_destination() {
        let chain = sout(profile("mp4").unwrap(), Path::new("/tmp/out dir/a.mp4"));
        assert!(chain.starts_with("#transcode{vcodec=h264,"));
        assert!(chain.contains("acodec=mp3,aenc=shine"));
        assert!(chain.ends_with(":std{access=file,mux=mp4,dst=\"/tmp/out dir/a.mp4\"}"));
        let webm = sout(profile("webm").unwrap(), Path::new("/x/a.webm"));
        assert!(webm.contains("vcodec=VP90") && webm.contains("acodec=opus") && webm.contains("mux=webm"));
        let mp3 = sout(profile("mp3").unwrap(), Path::new("/x/a.mp3"));
        assert!(mp3.contains("vcodec=none") && mp3.contains("acodec=mp3"));
        assert!(profile("gif").is_err());
    }

    #[test]
    fn quotes_in_destinations_are_escaped() {
        assert_eq!(quote(r#"/a/"b"\c"#), r#""/a/\"b\"\\c""#);
    }

    #[test]
    fn names_come_from_the_source_and_never_overwrite() {
        assert_eq!(source_stem("/home/a/Holiday.2024.mkv"), "Holiday.2024");
        assert_eq!(source_stem("https://host/path/clip.m3u8?token=1"), "clip");
        let dir = std::env::temp_dir().join(format!("zazabor-convert-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.mp4"), "").unwrap();
        std::fs::write(dir.join("a (2).mp4"), "").unwrap();
        assert_eq!(unique_dest(&dir, "a", "mp4"), dir.join("a (3).mp4"));
        assert_eq!(unique_dest(&dir, "b", "mp4"), dir.join("b.mp4"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn jobs_refuse_missing_sources_folders_and_formats() {
        let tmp = std::env::temp_dir();
        assert!(start_job("/nonexistent/a.mp4", "mp4", &tmp, None).is_err());
        assert!(start_job("/nonexistent/a.mp4", "gif", &tmp, None).is_err());
        assert!(start_job("http://x/y.mp4", "mp4", Path::new("/nonexistent-dir"), None).is_err());
    }

    /// Converts a few seconds of a real file: `CONVERT_TEST_FILE=/a.mp4 CONVERT_TEST_DIR=/tmp/out
    /// cargo test live_conversion -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_conversion_writes_playable_files() {
        let file = std::env::var("CONVERT_TEST_FILE").expect("set CONVERT_TEST_FILE");
        let dir = PathBuf::from(std::env::var("CONVERT_TEST_DIR").expect("set CONVERT_TEST_DIR"));
        std::fs::create_dir_all(&dir).unwrap();
        for id in ["mp4", "mp4-720", "mp3", "webm"] {
            let job = start_job(&file, id, &dir, Some(3)).unwrap();
            let started = std::time::Instant::now();
            let finished = loop {
                let info = lock_ignore_poison(&JOBS).iter().find(|e| e.info.id == job.id).unwrap().info.clone();
                if info.state != "running" || started.elapsed() > Duration::from_secs(90) {
                    break info;
                }
                std::thread::sleep(Duration::from_millis(100));
            };
            eprintln!("{id}: {} in {:?} -> {} ({:?})", finished.state, started.elapsed(), finished.dest, finished.error);
            assert_eq!(finished.state, "done", "{id}: {:?}", finished.error);
            let bytes = std::fs::read(&finished.dest).unwrap();
            assert!(bytes.len() > 10_000, "{id}: {} bytes", bytes.len());
            if id.starts_with("mp4") {
                assert_eq!(&bytes[4..8], b"ftyp", "{id}: not an MP4");
            } else if id == "webm" {
                assert_eq!(&bytes[..4], &[0x1a, 0x45, 0xdf, 0xa3], "{id}: not a WebM file");
            } else {
                assert!(bytes.starts_with(b"ID3") || bytes[0] == 0xff, "{id}: not an MP3");
            }
        }
    }
}
