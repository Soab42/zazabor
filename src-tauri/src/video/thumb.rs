//! Video thumbnails (`cs://localhost/vthumb?p=<path>&s=<px>&t=<mtime ms>`): one JPEG frame from
//! about 10% into the file, made by a short-lived libVLC player that decodes straight to RGB at
//! the target size, and cached on disk like the photo renders.

use rayon::ThreadPool;
use std::ffi::{c_char, c_uint, c_void, CString};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::http::{Request, Response, StatusCode};
use tauri::UriSchemeResponder;
use xxhash_rust::xxh3::xxh3_64;

use super::frame::{fit_size, lock_ignore_poison};
use super::{instance, list::is_video, vlc};
use crate::protocol;
use crate::scan::unix_seconds;

/// Bump to invalidate every cached video thumbnail (2: dark frames after a seek are skipped).
const CACHE_VERSION: u32 = 2;
const TIMEOUT: Duration = Duration::from_secs(6);
const DEFAULT_SIZE: u32 = 320;
const JPEG_QUALITY: u8 = 82;

static POOL: OnceLock<ThreadPool> = OnceLock::new();
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// At most two thumbnails decode at once; each is a whole libVLC pipeline.
fn pool() -> &'static ThreadPool {
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .thread_name(|i| format!("vthumb-{i}"))
            .start_handler(|_| {
                #[cfg(unix)]
                // SAFETY: setpriority only adjusts the scheduling priority of the calling thread.
                unsafe {
                    libc::setpriority(libc::PRIO_PROCESS, 0, 10);
                }
            })
            .build()
            .expect("failed to build thumbnail pool")
    })
}

/// Entry point for the `vthumb` route.
pub fn serve(request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    pool().spawn(move || responder.respond(respond(&request)));
}

fn respond(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if crate::lock::is_locked() {
        return protocol::error(StatusCode::FORBIDDEN, "locked");
    }
    let (mut path, mut size) = (None, DEFAULT_SIZE);
    for (key, value) in url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes()) {
        match key.as_ref() {
            "p" => path = Some(PathBuf::from(value.into_owned())),
            "s" => size = value.parse().unwrap_or(DEFAULT_SIZE),
            _ => {}
        }
    }
    let Some(path) = path else {
        return protocol::error(StatusCode::BAD_REQUEST, "missing path");
    };
    if !is_video(&path) {
        return protocol::error(StatusCode::FORBIDDEN, "unsupported file type");
    }
    let Some(dir) = protocol::cache_dir() else {
        return protocol::error(StatusCode::INTERNAL_SERVER_ERROR, "cache unavailable");
    };
    match cached_thumbnail(&path, size.clamp(32, 1600), dir) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "image/jpeg")
            .header("Access-Control-Allow-Origin", "*")
            // URLs include the file's mtime, so a given URL's content never changes.
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .body(bytes)
            .unwrap_or_else(|_| protocol::error(StatusCode::INTERNAL_SERVER_ERROR, "response")),
        Err(e) => protocol::error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

/// The cache file name stem for a thumbnail of `path` at `size`.
fn cache_stem(path: &Path, len: u64, mtime: f64, size: u32) -> String {
    let key = format!("vthumb|{CACHE_VERSION}|{}|{len}|{mtime}|{size}", path.display());
    format!("{:016x}", xxh3_64(key.as_bytes()))
}

fn cached_thumbnail(path: &Path, size: u32, cache_dir: &Path) -> Result<Vec<u8>, String> {
    let meta = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let stem = cache_stem(path, meta.len(), unix_seconds(meta.modified()), size);
    let file = cache_dir.join(format!("{stem}.jpg"));
    if let Ok(bytes) = fs::read(&file) {
        return Ok(bytes);
    }
    let jpeg = render(path, size)?;
    // Write to a unique temp file then rename, so concurrent requests never see a partial file.
    let tmp = cache_dir.join(format!("{stem}.{}.{}.tmp", std::process::id(), TMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
    if fs::write(&tmp, &jpeg).is_ok() && fs::rename(&tmp, &file).is_err() {
        let _ = fs::remove_file(&tmp);
    }
    Ok(jpeg)
}

/// One decoded BGRA picture, double-buffered like the playback frames.
struct Picture {
    max: u32,
    state: Mutex<PictureState>,
    ready: Condvar,
}

#[derive(Default)]
struct PictureState {
    width: u32,
    height: u32,
    back: Vec<u8>,
    front: Vec<u8>,
    counter: u64,
}

fn picture_of<'a>(opaque: *mut c_void) -> &'a Picture {
    // SAFETY: opaque is the Arc<Picture> pointer the Thumbnailer keeps alive until libVLC is released.
    unsafe { &*(opaque as *const Picture) }
}

unsafe extern "C" fn setup(
    opaque: *mut *mut c_void,
    chroma: *mut c_char,
    width: *mut c_uint,
    height: *mut c_uint,
    pitches: *mut c_uint,
    lines: *mut c_uint,
) -> c_uint {
    let picture = picture_of(*opaque);
    let (w, h) = fit_size(*width, *height, picture.max, picture.max);
    *width = w;
    *height = h;
    std::ptr::copy_nonoverlapping(b"RV32".as_ptr(), chroma as *mut u8, 4);
    *pitches = w * 4;
    *lines = h;
    let mut state = lock_ignore_poison(&picture.state);
    state.width = w;
    state.height = h;
    state.back = vec![0; (w * h * 4) as usize];
    state.front = vec![0; (w * h * 4) as usize];
    1
}

unsafe extern "C" fn cleanup(_opaque: *mut c_void) {}

unsafe extern "C" fn lock(opaque: *mut c_void, planes: *mut *mut c_void) -> *mut c_void {
    let mut state = lock_ignore_poison(&picture_of(opaque).state);
    *planes = state.back.as_mut_ptr() as *mut c_void;
    std::ptr::null_mut()
}

unsafe extern "C" fn unlock(_opaque: *mut c_void, _picture: *mut c_void, _planes: *const *mut c_void) {}

unsafe extern "C" fn display(opaque: *mut c_void, _picture: *mut c_void) {
    let picture = picture_of(opaque);
    let mut state = lock_ignore_poison(&picture.state);
    let state = &mut *state;
    std::mem::swap(&mut state.back, &mut state.front);
    state.counter += 1;
    picture.ready.notify_all();
}

/// A short-lived player; dropping it stops and frees everything (the Arc outlives libVLC).
struct Thumbnailer {
    player: *mut vlc::libvlc_media_player_t,
    picture: Arc<Picture>,
}

impl Drop for Thumbnailer {
    fn drop(&mut self) {
        // SAFETY: the player was created by us and is released exactly once, here.
        unsafe {
            vlc::libvlc_media_player_stop(self.player);
            vlc::libvlc_media_player_release(self.player);
        }
    }
}

impl Thumbnailer {
    fn start(path: &Path, size: u32) -> Result<Self, String> {
        let instance = instance()?;
        let cpath = CString::new(path.to_string_lossy().into_owned()).map_err(|e| e.to_string())?;
        let picture = Arc::new(Picture { max: size, state: Mutex::new(PictureState::default()), ready: Condvar::new() });
        // SAFETY: plain libVLC calls; the opaque pointer stays valid because `picture` is stored
        // next to the player and dropped only after the player is released.
        unsafe {
            let media = vlc::libvlc_media_new_path(instance, cpath.as_ptr());
            if media.is_null() {
                return Err("libVLC could not open the file".into());
            }
            vlc::libvlc_media_add_option(media, c":no-audio".as_ptr());
            let player = vlc::libvlc_media_player_new_from_media(media);
            vlc::libvlc_media_release(media);
            if player.is_null() {
                return Err("libVLC could not create a player".into());
            }
            let thumbnailer = Thumbnailer { player, picture };
            let opaque = Arc::as_ptr(&thumbnailer.picture) as *mut c_void;
            vlc::libvlc_video_set_callbacks(player, Some(lock), Some(unlock), Some(display), opaque);
            vlc::libvlc_video_set_format_callbacks(player, Some(setup), Some(cleanup));
            if vlc::libvlc_media_player_play(player) != 0 {
                return Err("libVLC could not start playback".into());
            }
            Ok(thumbnailer)
        }
    }

    fn state(&self) -> i32 {
        // SAFETY: the player is valid for the lifetime of self.
        unsafe { vlc::libvlc_media_player_get_state(self.player) }
    }

    fn counter(&self) -> u64 {
        lock_ignore_poison(&self.picture.state).counter
    }

    /// Polls `done` until it is true, failing at the deadline or when playback ends or breaks.
    fn wait(&self, deadline: Instant, what: &str, done: impl Fn(&Self) -> bool) -> Result<(), String> {
        loop {
            if done(self) {
                return Ok(());
            }
            // Stopped, ended or error.
            if self.state() >= 5 {
                return Err(format!("the video stopped before {what}"));
            }
            if Instant::now() >= deadline {
                return Err(format!("timed out waiting for {what}"));
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }
}

/// Where to grab the frame: 10% in, but at least 2 s, and always inside the video.
pub fn pick_time(length_ms: i64) -> i64 {
    (length_ms / 10).max(2000).min((length_ms - 250).max(0))
}

/// Decodes one frame near the 10% mark and encodes it as JPEG.
fn render(path: &Path, size: u32) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + TIMEOUT;
    let thumb = Thumbnailer::start(path, size)?;
    thumb.wait(deadline, "playback", |t| t.state() == vlc::STATE_PLAYING)?;
    // SAFETY (all calls below): the player is valid for the lifetime of `thumb`.
    thumb.wait(deadline, "the length", |t| unsafe { vlc::libvlc_media_player_get_length(t.player) } > 0)?;
    let length = unsafe { vlc::libvlc_media_player_get_length(thumb.player) };
    let target = pick_time(length);
    let baseline = thumb.counter();
    unsafe { vlc::libvlc_media_player_set_time(thumb.player, target) };
    // Frames still in flight from before the seek are told apart by the playback clock having
    // moved near the target. Right after a seek decoders often hand out black frames until the
    // next keyframe, so dark frames are skipped for a while, keeping the brightest one seen.
    let mut seen = baseline;
    let mut best: Option<(f32, u32, u32, Vec<u8>)> = None;
    let mut dark_until: Option<Instant> = None;
    loop {
        let state = lock_ignore_poison(&thumb.picture.state);
        let (state, _) = thumb
            .picture
            .ready
            .wait_timeout_while(state, Duration::from_millis(40), |s| s.counter <= seen)
            .unwrap_or_else(|e| e.into_inner());
        let near = unsafe { vlc::libvlc_media_player_get_time(thumb.player) } >= target - 1000;
        if state.counter > seen && near {
            seen = state.counter;
            let light = brightness(&state.front);
            if best.as_ref().is_none_or(|b| light > b.0) {
                best = Some((light, state.width, state.height, state.front.clone()));
            }
            let until = *dark_until.get_or_insert_with(|| Instant::now() + DARK_SKIP);
            if light >= DARK_ENOUGH || Instant::now() >= until {
                drop(state);
                let (_, w, h, bgra) = best.take().expect("a frame was kept");
                return encode_jpeg(&bgra_to_rgb(&bgra), w, h);
            }
        }
        drop(state);
        if Instant::now() >= deadline {
            return match best {
                Some((_, w, h, bgra)) => encode_jpeg(&bgra_to_rgb(&bgra), w, h),
                None => Err("timed out waiting for a frame".into()),
            };
        }
    }
}

/// Frames darker than this (mean of R, G, B on a 0–255 scale) are probably not the picture yet.
const DARK_ENOUGH: f32 = 14.0;
/// How long to keep looking past dark frames before settling for the brightest one.
const DARK_SKIP: Duration = Duration::from_millis(1500);

/// Mean brightness of a BGRA picture, sampled on a sparse grid.
fn brightness(bgra: &[u8]) -> f32 {
    let (mut sum, mut n) = (0u64, 0u64);
    for px in bgra.chunks_exact(4).step_by(97) {
        sum += px[0] as u64 + px[1] as u64 + px[2] as u64;
        n += 3;
    }
    if n == 0 { 0.0 } else { sum as f32 / n as f32 }
}

#[cfg(test)]
pub fn render_for_test(path: &Path, size: u32) -> Result<Vec<u8>, String> {
    render(path, size)
}

fn bgra_to_rgb(bgra: &[u8]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(bgra.len() / 4 * 3);
    for px in bgra.chunks_exact(4) {
        rgb.extend_from_slice(&[px[2], px[1], px[0]]);
    }
    rgb
}

fn encode_jpeg(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .encode(rgb, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_ten_percent_but_at_least_two_seconds() {
        assert_eq!(pick_time(600_000), 60_000);
        assert_eq!(pick_time(10_000), 2_000);
        // Short clips stay inside the video.
        assert_eq!(pick_time(1_000), 750);
        assert_eq!(pick_time(100), 0);
    }

    #[test]
    fn cache_keys_depend_on_every_input() {
        let p = Path::new("/v/a.mp4");
        let base = cache_stem(p, 10, 1.0, 320);
        assert_eq!(base, cache_stem(p, 10, 1.0, 320));
        assert_ne!(base, cache_stem(p, 11, 1.0, 320));
        assert_ne!(base, cache_stem(p, 10, 2.0, 320));
        assert_ne!(base, cache_stem(p, 10, 1.0, 160));
        assert_ne!(base, cache_stem(Path::new("/v/b.mp4"), 10, 1.0, 320));
    }

    #[test]
    fn converts_bgra_to_rgb_and_encodes_jpeg() {
        assert_eq!(bgra_to_rgb(&[1, 2, 3, 255, 4, 5, 6, 255]), [3, 2, 1, 6, 5, 4]);
        let jpeg = encode_jpeg(&[200; 4 * 4 * 3], 4, 4).unwrap();
        assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
    }
}
