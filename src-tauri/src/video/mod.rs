//! Video playback through libVLC. Frames are decoded into memory (libVLC's "vmem" callbacks, see
//! `frame`) and the webview draws them with WebGL under its own controls. One player exists at a
//! time; its state is pushed to the UI as `video-state` events.
//!
//! libVLC calls our event callback on its own threads, so the callback only records a flag and
//! wakes a worker thread. The worker builds the state snapshot and emits it (also every 250 ms
//! while playing), which keeps libVLC player calls out of libVLC's own callbacks.

pub mod capture;
pub mod convert;
mod frame;
mod list;
pub mod options;
pub mod renderers;
mod thumb;
mod vlc;

use serde::Serialize;
use std::ffi::{c_char, c_int, c_void, CString};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, Once, OnceLock};
use std::time::Duration;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Emitter, UriSchemeResponder};

use frame::{lock_ignore_poison, Frames};
pub use list::VideoFile;

const EVENTS: [c_int; 10] = [
    vlc::EVENT_PLAYING,
    vlc::EVENT_PAUSED,
    vlc::EVENT_STOPPED,
    vlc::EVENT_END_REACHED,
    vlc::EVENT_ENCOUNTERED_ERROR,
    vlc::EVENT_LENGTH_CHANGED,
    vlc::EVENT_VOUT,
    vlc::EVENT_ES_ADDED,
    vlc::EVENT_ES_DELETED,
    vlc::EVENT_ES_SELECTED,
];
const TICK: Duration = Duration::from_millis(250);
const CANT_PLAY: &str = "This file can't be played. It may be damaged or use a format that isn't supported.";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Track {
    id: i32,
    name: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    path: Option<String>,
    playing: bool,
    time: i64,
    length: i64,
    ended: bool,
    volume: f64,
    muted: bool,
    rate: f64,
    audio_tracks: Vec<Track>,
    audio_track: i32,
    subtitle_tracks: Vec<Track>,
    subtitle_track: i32,
    video_width: u32,
    video_height: u32,
    error: Option<String>,
}

struct Instance(*mut vlc::libvlc_instance_t);
// SAFETY: libVLC instances are thread-safe; the pointer is only handed to libVLC calls.
unsafe impl Send for Instance {}

struct Player {
    handle: *mut vlc::libvlc_media_player_t,
    /// libVLC's callbacks point into this; it stays alive until the player is released.
    frames: Arc<Frames>,
    path: String,
}

// SAFETY: the raw pointer is only used under the PLAYER lock; libVLC itself is thread-safe.
unsafe impl Send for Player {}

impl Drop for Player {
    fn drop(&mut self) {
        // SAFETY: the handle is ours and released exactly once. Detaching first guarantees no
        // callback runs afterwards; stop() joins the decoder, so no vmem callback can use
        // `frames` once the fields are dropped after this function returns.
        unsafe {
            let events = vlc::libvlc_media_player_event_manager(self.handle);
            for kind in EVENTS {
                vlc::libvlc_event_detach(events, kind, on_event, std::ptr::null_mut());
            }
            vlc::libvlc_media_player_stop(self.handle);
            vlc::libvlc_media_player_release(self.handle);
        }
    }
}

static INSTANCE: Mutex<Option<Instance>> = Mutex::new(None);
static PLAYER: Mutex<Option<Player>> = Mutex::new(None);
static APP: OnceLock<AppHandle> = OnceLock::new();
static WORKER: Once = Once::new();
/// Set by the event callback, consumed by the worker.
static WAKE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());
static ENDED: AtomicBool = AtomicBool::new(false);
static ERROR: Mutex<Option<String>> = Mutex::new(None);
/// 0–125, as libVLC counts it. Kept across files.
static VOLUME: AtomicU32 = AtomicU32::new(100);
static MUTED: AtomicBool = AtomicBool::new(false);
static RATE: AtomicU32 = AtomicU32::new(0x3f80_0000); // 1.0f32
/// Volume and mute are re-applied once audio output exists (libVLC may drop them before that).
static AUDIO_APPLIED: AtomicBool = AtomicBool::new(false);

fn rate() -> f32 {
    f32::from_bits(RATE.load(Ordering::Relaxed))
}

/// The shared libVLC instance, created on first use. Hardware decoding is requested with
/// `--avcodec-hw=any` (see `options`); if libVLC rejects the options we retry without. When the
/// wanted options changed and nothing plays or converts, the instance is recreated first.
pub(crate) fn instance() -> Result<*mut vlc::libvlc_instance_t, String> {
    let mut slot = lock_ignore_poison(&INSTANCE);
    if let Some(i) = slot.as_ref() {
        if !(options::pending() && idle()) {
            return Ok(i.0);
        }
        renderers::stop_all();
        // SAFETY: players and media hold their own references; ours is released exactly once.
        unsafe { options::libvlc_release(i.0) };
        *slot = None;
    }
    let create = |args: &[String]| {
        let args: Vec<CString> = args.iter().map(|a| CString::new(a.as_str()).expect("option without NUL")).collect();
        let argv: Vec<*const c_char> = args.iter().map(|a| a.as_ptr()).collect();
        // SAFETY: argv points at NUL-terminated strings that outlive the call.
        unsafe { vlc::libvlc_new(argv.len() as c_int, argv.as_ptr()) }
    };
    let base: Vec<String> = ["--quiet", "--no-xlib", "--no-video-title-show"].iter().map(|a| a.to_string()).collect();
    let wanted = options::wanted();
    let mut ptr = create(&[base.clone(), wanted.args()].concat());
    if ptr.is_null() {
        ptr = create(&base);
    }
    if ptr.is_null() {
        return Err("libVLC could not start. Is VLC installed?".into());
    }
    options::mark_applied(wanted);
    *slot = Some(Instance(ptr));
    Ok(ptr)
}

/// Nothing is playing or converting, so the instance may be recreated.
fn idle() -> bool {
    let no_player = match PLAYER.try_lock() {
        Ok(player) => player.is_none(),
        Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner().is_none(),
        Err(std::sync::TryLockError::WouldBlock) => false,
    };
    no_player && !convert::busy()
}

fn wake() {
    *lock_ignore_poison(&WAKE.0) = true;
    WAKE.1.notify_one();
}

/// libVLC's player event callback (runs on libVLC threads: record, wake, return).
unsafe extern "C" fn on_event(event: *const vlc::libvlc_event_t, _data: *mut c_void) {
    match (*event).kind {
        vlc::EVENT_END_REACHED => ENDED.store(true, Ordering::SeqCst),
        vlc::EVENT_ENCOUNTERED_ERROR => *lock_ignore_poison(&ERROR) = Some(CANT_PLAY.into()),
        _ => {}
    }
    wake();
}

fn start_worker(app: AppHandle) {
    let _ = APP.set(app);
    WORKER.call_once(|| {
        std::thread::Builder::new()
            .name("video-state".into())
            .spawn(|| loop {
                let timed_out = {
                    let guard = lock_ignore_poison(&WAKE.0);
                    let (mut guard, result) = WAKE
                        .1
                        .wait_timeout_while(guard, TICK, |woken| !*woken)
                        .unwrap_or_else(|e| e.into_inner());
                    *guard = false;
                    result.timed_out()
                };
                let state = snapshot();
                if state.playing && !AUDIO_APPLIED.swap(true, Ordering::SeqCst) {
                    apply_audio();
                }
                if !timed_out || state.playing {
                    emit(&state);
                }
            })
            .expect("failed to start the video state thread");
    });
}

fn emit(state: &PlaybackState) {
    if let Some(app) = APP.get() {
        let _ = app.emit("video-state", state);
    }
}

fn apply_audio() {
    if let Some(p) = lock_ignore_poison(&PLAYER).as_ref() {
        // SAFETY: the handle is valid while the PLAYER lock is held.
        unsafe {
            vlc::libvlc_audio_set_volume(p.handle, VOLUME.load(Ordering::Relaxed) as c_int);
            vlc::libvlc_audio_set_mute(p.handle, MUTED.load(Ordering::Relaxed) as c_int);
        }
    }
}

/// Reads a libVLC track list, dropping the "Disable" entry (id -1) and freeing the list.
///
/// # Safety
/// `list` must be null or a list returned by libVLC that has not been released.
unsafe fn read_tracks(list: *mut vlc::libvlc_track_description_t) -> Vec<Track> {
    let mut tracks = Vec::new();
    let mut node = list;
    while !node.is_null() {
        let entry = &*node;
        if entry.id >= 0 {
            let name = if entry.name.is_null() {
                format!("Track {}", entry.id)
            } else {
                std::ffi::CStr::from_ptr(entry.name).to_string_lossy().into_owned()
            };
            tracks.push(Track { id: entry.id, name });
        }
        node = entry.next;
    }
    if !list.is_null() {
        vlc::libvlc_track_description_list_release(list);
    }
    tracks
}

fn snapshot() -> PlaybackState {
    let mut state = PlaybackState {
        path: None,
        playing: false,
        time: 0,
        length: 0,
        ended: ENDED.load(Ordering::SeqCst),
        volume: VOLUME.load(Ordering::Relaxed) as f64 / 100.0,
        muted: MUTED.load(Ordering::Relaxed),
        rate: rate() as f64,
        audio_tracks: Vec::new(),
        audio_track: -1,
        subtitle_tracks: Vec::new(),
        subtitle_track: -1,
        video_width: 0,
        video_height: 0,
        error: lock_ignore_poison(&ERROR).clone(),
    };
    if let Some(p) = lock_ignore_poison(&PLAYER).as_ref() {
        // SAFETY: the handle is valid while the PLAYER lock is held.
        unsafe {
            let h = p.handle;
            state.path = Some(p.path.clone());
            state.playing = vlc::libvlc_media_player_get_state(h) == vlc::STATE_PLAYING;
            state.length = vlc::libvlc_media_player_get_length(h).max(0);
            state.time = vlc::libvlc_media_player_get_time(h).max(0);
            if state.ended {
                state.time = state.length;
            }
            state.audio_tracks = read_tracks(vlc::libvlc_audio_get_track_description(h));
            state.audio_track = vlc::libvlc_audio_get_track(h);
            state.subtitle_tracks = read_tracks(vlc::libvlc_video_get_spu_description(h));
            state.subtitle_track = vlc::libvlc_video_get_spu(h);
            let (w, hgt) = p.frames.size();
            state.video_width = w;
            state.video_height = hgt;
        }
    }
    state
}

fn ensure_unlocked() -> Result<(), String> {
    crate::ensure_unlocked()
}

/// Runs blocking libVLC work off the async runtime's threads.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

pub(crate) fn with_player<T>(work: impl FnOnce(*mut vlc::libvlc_media_player_t) -> T) -> Option<T> {
    // SAFETY (of the closure's use): the handle is valid while the PLAYER lock is held.
    lock_ignore_poison(&PLAYER).as_ref().map(|p| work(p.handle))
}

fn open(path: String, max_width: u32, max_height: u32, start_at: i64) -> Result<(), String> {
    // Web addresses and device MRLs (http://…, v4l2:///dev/video0) are opened as they are.
    if !capture::is_location(&path) && !Path::new(&path).is_file() {
        return Err("That file could not be found.".into());
    }
    // New instance options take effect now: the old player is about to be replaced anyway.
    if options::pending() {
        stop_player();
    }
    let instance = instance()?;
    let mut slot = lock_ignore_poison(&PLAYER);
    frame::set_current(None);
    // Dropping the old player detaches its events first, so it cannot flag the new file.
    drop(slot.take());
    ENDED.store(false, Ordering::SeqCst);
    *lock_ignore_poison(&ERROR) = None;
    RATE.store(1.0f32.to_bits(), Ordering::Relaxed);
    AUDIO_APPLIED.store(false, Ordering::SeqCst);

    // A missing or tiny size would decode a postage stamp; fall back to 1080p.
    let (max_width, max_height) = if max_width < 64 || max_height < 64 { (1920, 1080) } else { (max_width, max_height) };
    let frames = Arc::new(Frames::new(max_width, max_height));
    // SAFETY: plain libVLC calls. The opaque pointer is the Arc inside `Player`, which outlives
    // libVLC's use of it (see Player::drop).
    unsafe {
        let media = capture::new_media(instance, &path);
        if media.is_null() {
            return Err("libVLC could not open the file".into());
        }
        if start_at > 0 {
            let option = CString::new(format!(":start-time={:.3}", start_at as f64 / 1000.0)).expect("digits");
            vlc::libvlc_media_add_option(media, option.as_ptr());
        }
        let handle = vlc::libvlc_media_player_new_from_media(media);
        vlc::libvlc_media_release(media);
        if handle.is_null() {
            return Err("libVLC could not create a player".into());
        }
        let player = Player { handle, frames: frames.clone(), path };
        let opaque = Arc::as_ptr(&frames) as *mut c_void;
        vlc::libvlc_video_set_callbacks(handle, Some(frame::lock), Some(frame::unlock), Some(frame::display), opaque);
        vlc::libvlc_video_set_format_callbacks(handle, Some(frame::setup), Some(frame::cleanup));
        let events = vlc::libvlc_media_player_event_manager(handle);
        for kind in EVENTS {
            vlc::libvlc_event_attach(events, kind, on_event, std::ptr::null_mut());
        }
        vlc::libvlc_audio_set_volume(handle, VOLUME.load(Ordering::Relaxed) as c_int);
        vlc::libvlc_audio_set_mute(handle, MUTED.load(Ordering::Relaxed) as c_int);
        renderers::apply(handle);
        if vlc::libvlc_media_player_play(handle) != 0 {
            return Err("libVLC could not start playback".into());
        }
        *slot = Some(player);
    }
    frame::set_current(Some(frames));
    drop(slot);
    wake();
    Ok(())
}

/// Stops playback and unloads the file when the app locks. Frames stop flowing at once; the
/// player itself is torn down on a thread so the caller is never held up by libVLC.
pub fn stop_all() {
    convert::cancel_all();
    renderers::stop_all();
    frame::set_current(None);
    std::thread::spawn(stop_player);
}

fn stop_player() {
    frame::set_current(None);
    drop(lock_ignore_poison(&PLAYER).take());
    ENDED.store(false, Ordering::SeqCst);
    *lock_ignore_poison(&ERROR) = None;
    wake();
}

#[tauri::command]
pub async fn video_open(app: AppHandle, path: String, max_width: u32, max_height: u32, start_at: i64) -> Result<(), String> {
    ensure_unlocked()?;
    start_worker(app);
    blocking(move || open(path, max_width, max_height, start_at)).await
}

#[tauri::command]
pub async fn video_set_paused(paused: bool) -> Result<(), String> {
    ensure_unlocked()?;
    with_player(|p| {
        // SAFETY: see with_player.
        unsafe { vlc::libvlc_media_player_set_pause(p, paused as c_int) }
    });
    wake();
    Ok(())
}

#[tauri::command]
pub async fn video_stop() -> Result<(), String> {
    ensure_unlocked()?;
    blocking(|| {
        stop_player();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn video_seek(time: i64) -> Result<(), String> {
    ensure_unlocked()?;
    with_player(|p| {
        // SAFETY: see with_player.
        unsafe { vlc::libvlc_media_player_set_time(p, time.max(0)) }
    });
    wake();
    Ok(())
}

#[tauri::command]
pub async fn video_set_volume(volume: f64) -> Result<(), String> {
    ensure_unlocked()?;
    let value = (volume * 100.0).round().clamp(0.0, 125.0) as u32;
    VOLUME.store(value, Ordering::Relaxed);
    with_player(|p| {
        // SAFETY: see with_player.
        unsafe { vlc::libvlc_audio_set_volume(p, value as c_int) }
    });
    wake();
    Ok(())
}

#[tauri::command]
pub async fn video_set_muted(muted: bool) -> Result<(), String> {
    ensure_unlocked()?;
    MUTED.store(muted, Ordering::Relaxed);
    with_player(|p| {
        // SAFETY: see with_player.
        unsafe { vlc::libvlc_audio_set_mute(p, muted as c_int) }
    });
    wake();
    Ok(())
}

#[tauri::command]
pub async fn video_set_rate(rate: f64) -> Result<(), String> {
    ensure_unlocked()?;
    let rate = (rate as f32).clamp(0.25, 4.0);
    RATE.store(rate.to_bits(), Ordering::Relaxed);
    with_player(|p| {
        // SAFETY: see with_player.
        unsafe { vlc::libvlc_media_player_set_rate(p, rate) }
    });
    wake();
    Ok(())
}

#[tauri::command]
pub async fn video_set_audio_track(id: i32) -> Result<(), String> {
    ensure_unlocked()?;
    with_player(|p| {
        // SAFETY: see with_player.
        unsafe { vlc::libvlc_audio_set_track(p, id) }
    });
    wake();
    Ok(())
}

#[tauri::command]
pub async fn video_set_subtitle_track(id: i32) -> Result<(), String> {
    ensure_unlocked()?;
    with_player(|p| {
        // SAFETY: see with_player.
        unsafe { vlc::libvlc_video_set_spu(p, id) }
    });
    wake();
    Ok(())
}

#[tauri::command]
pub async fn video_add_subtitle(path: String) -> Result<(), String> {
    ensure_unlocked()?;
    let uri = url::Url::from_file_path(&path).map_err(|_| "That subtitle path is not valid.".to_string())?;
    let uri = CString::new(uri.as_str()).map_err(|e| e.to_string())?;
    blocking(move || {
        with_player(|p| {
            // SAFETY: see with_player; the URI is NUL-terminated.
            let status = unsafe { vlc::libvlc_media_player_add_slave(p, vlc::SLAVE_SUBTITLE, uri.as_ptr(), true) };
            if status == 0 {
                Ok(())
            } else {
                Err("The subtitle file could not be loaded.".to_string())
            }
        })
        .unwrap_or_else(|| Err("Nothing is playing.".to_string()))
    })
    .await?;
    wake();
    Ok(())
}

#[tauri::command]
pub async fn video_state() -> Result<PlaybackState, String> {
    ensure_unlocked()?;
    Ok(snapshot())
}

#[tauri::command]
pub async fn video_list(folder: String) -> Result<Vec<VideoFile>, String> {
    ensure_unlocked()?;
    blocking(move || list::list_videos(Path::new(&folder))).await
}

/// Entry point for the `frame` route: `?after=<n>` long-polls for a newer picture.
pub fn serve_frame(request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    // Requests block up to 250 ms each; a small dedicated pool keeps them off the image pools.
    let pool = POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(3)
            .thread_name(|i| format!("vframe-{i}"))
            .build()
            .expect("failed to build frame pool")
    });
    pool.spawn(move || {
        if crate::lock::is_locked() {
            return responder.respond(crate::protocol::error(StatusCode::FORBIDDEN, "locked"));
        }
        let after = url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .find(|(key, _)| key == "after")
            .and_then(|(_, value)| value.parse().ok())
            .unwrap_or(0);
        let response: Response<Vec<u8>> = frame::response(after);
        responder.respond(response)
    });
}

/// Entry point for the `vthumb` route.
pub fn serve_thumb(request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    thumb::serve(request, responder)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live check against a real file: `VIDEO_TEST_FILE=/path/to.mp4 cargo test live -- --ignored`.
    #[test]
    #[ignore]
    fn live_playback_delivers_frames_and_a_thumbnail() {
        let file = std::env::var("VIDEO_TEST_FILE").expect("set VIDEO_TEST_FILE");
        open(file.clone(), 640, 360, 0).unwrap();
        let mut after = 0;
        let mut seen = 0;
        let started = std::time::Instant::now();
        while seen < 30 && started.elapsed() < Duration::from_secs(10) {
            let response = frame::response(after);
            if response.status() == StatusCode::OK {
                let body = response.body();
                let word = |i: usize| u32::from_le_bytes(body[i * 4..i * 4 + 4].try_into().unwrap());
                let (w, h) = (word(0), word(1));
                assert!(w <= 642 && h <= 362 && w % 2 == 0 && h % 2 == 0);
                assert_eq!(body.len(), 16 + (w * h * 3 / 2) as usize);
                after = word(3) as u64;
                seen += 1;
            }
        }
        let state = snapshot();
        eprintln!("frames {seen} in {:?}; state {state:?}", started.elapsed());
        assert!(seen >= 30, "only {seen} frames");
        assert!(state.length > 0 && state.video_width > 0);
        stop_player();
        let jpeg = thumb::render_for_test(Path::new(&file), 320).unwrap();
        assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
        eprintln!("thumbnail {} bytes", jpeg.len());
    }
}
