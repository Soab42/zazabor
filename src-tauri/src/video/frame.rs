//! Decoded frames: libVLC's "vmem" callbacks write planar YUV 4:2:0 into a back buffer, and the
//! `cs://localhost/frame?after=<n>` route hands the newest picture to the webview's WebGL.

use std::ffi::{c_char, c_uint, c_void};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;
use tauri::http::{Response, StatusCode};

/// Frame numbers keep counting across players, so a waiting reader never stalls on a reset.
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
/// The frames of the open player; the route reads this without touching the player lock.
static CURRENT: Mutex<Option<Arc<Frames>>> = Mutex::new(None);

/// How long a request waits for a new picture before answering "nothing new".
const LONG_POLL: Duration = Duration::from_millis(250);
/// The chroma code in the frame header (1 = planar I420).
const CHROMA_I420: u32 = 1;

/// Locks a mutex even if a panicking thread poisoned it (libVLC callbacks must never unwind).
pub fn lock_ignore_poison<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// The size to decode at: fits `max` keeping the aspect ratio, never upscales, even sides.
pub fn fit_size(src_w: u32, src_h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let (sw, sh) = (src_w.max(2) as f64, src_h.max(2) as f64);
    let scale = (max_w as f64 / sw).min(max_h as f64 / sh).min(1.0);
    let even = |v: f64| (((v * scale) / 2.0).round() as u32 * 2).max(2);
    (even(sw), even(sh))
}

/// Luma row pitch for a visible width: a multiple of 32 (chroma gets half), so the visible
/// width, and with it the aspect ratio, stays exact while libVLC gets friendly alignment.
pub fn luma_pitch(width: u32) -> u32 {
    (width + 31) & !31
}

/// Byte offsets of the U and V planes and the total size for padded I420 planes.
pub fn plane_layout(pitch: u32, height: u32) -> (usize, usize, usize) {
    let y = pitch as usize * height as usize;
    let c = (pitch as usize / 2) * (height as usize / 2);
    (y, y + c, y + 2 * c)
}

/// The 16-byte header: width, height, chroma code and frame counter, all u32 little-endian.
pub fn header(width: u32, height: u32, counter: u64) -> [u8; 16] {
    let mut out = [0u8; 16];
    for (i, value) in [width, height, CHROMA_I420, counter as u32].into_iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    out
}

struct FrameState {
    width: u32,
    height: u32,
    pitch: u32,
    back: Vec<u8>,
    front: Vec<u8>,
    counter: u64,
}

pub struct Frames {
    /// The largest size frames are decoded at; libVLC scales down to it.
    max: (u32, u32),
    state: Mutex<FrameState>,
    ready: Condvar,
}

impl Frames {
    pub fn new(max_width: u32, max_height: u32) -> Self {
        Frames {
            max: (max_width, max_height),
            state: Mutex::new(FrameState {
                width: 0,
                height: 0,
                pitch: 0,
                back: Vec::new(),
                front: Vec::new(),
                counter: SEQUENCE.load(Ordering::Relaxed),
            }),
            ready: Condvar::new(),
        }
    }

    /// The decoded picture size, (0, 0) before the first frame.
    pub fn size(&self) -> (u32, u32) {
        let state = lock_ignore_poison(&self.state);
        (state.width, state.height)
    }
}

/// Makes `frames` what the frame route serves (None: nothing is playing).
pub fn set_current(frames: Option<Arc<Frames>>) {
    *lock_ignore_poison(&CURRENT) = frames;
}

fn frames_of<'a>(opaque: *mut c_void) -> &'a Frames {
    // SAFETY: opaque is the Arc<Frames> pointer the player keeps alive until libVLC has stopped.
    unsafe { &*(opaque as *const Frames) }
}

/// libVLC tells us the source size; we answer with the size and layout we want (I420).
pub unsafe extern "C" fn setup(
    opaque: *mut *mut c_void,
    chroma: *mut c_char,
    width: *mut c_uint,
    height: *mut c_uint,
    pitches: *mut c_uint,
    lines: *mut c_uint,
) -> c_uint {
    let frames = frames_of(*opaque);
    let (w, h) = fit_size(*width, *height, frames.max.0, frames.max.1);
    let pitch = luma_pitch(w);
    *width = w;
    *height = h;
    std::ptr::copy_nonoverlapping(b"I420".as_ptr(), chroma as *mut u8, 4);
    *pitches = pitch;
    *pitches.add(1) = pitch / 2;
    *pitches.add(2) = pitch / 2;
    *lines = h;
    *lines.add(1) = h / 2;
    *lines.add(2) = h / 2;
    let size = plane_layout(pitch, h).2;
    let mut state = lock_ignore_poison(&frames.state);
    state.width = w;
    state.height = h;
    state.pitch = pitch;
    state.back = vec![0; size];
    state.front = vec![0; size];
    1
}

pub unsafe extern "C" fn cleanup(_opaque: *mut c_void) {}

pub unsafe extern "C" fn lock(opaque: *mut c_void, planes: *mut *mut c_void) -> *mut c_void {
    let frames = frames_of(opaque);
    let mut state = lock_ignore_poison(&frames.state);
    let (u, v, _) = plane_layout(state.pitch, state.height);
    let base = state.back.as_mut_ptr();
    *planes = base as *mut c_void;
    *planes.add(1) = base.add(u) as *mut c_void;
    *planes.add(2) = base.add(v) as *mut c_void;
    std::ptr::null_mut()
}

pub unsafe extern "C" fn unlock(_opaque: *mut c_void, _picture: *mut c_void, _planes: *const *mut c_void) {}

pub unsafe extern "C" fn display(opaque: *mut c_void, _picture: *mut c_void) {
    let frames = frames_of(opaque);
    let mut state = lock_ignore_poison(&frames.state);
    let state = &mut *state;
    std::mem::swap(&mut state.back, &mut state.front);
    state.counter = SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    frames.ready.notify_all();
}

/// Header plus the planes repacked tightly for the visible size (drops the pitch padding).
fn pack(state: &FrameState) -> Vec<u8> {
    let (w, h, pitch) = (state.width as usize, state.height as usize, state.pitch as usize);
    let (u, v, _) = plane_layout(state.pitch, state.height);
    let mut body = Vec::with_capacity(16 + w * h * 3 / 2);
    body.extend_from_slice(&header(state.width, state.height, state.counter));
    for (offset, stride, width, rows) in [(0, pitch, w, h), (u, pitch / 2, w / 2, h / 2), (v, pitch / 2, w / 2, h / 2)] {
        if stride == width {
            body.extend_from_slice(&state.front[offset..offset + width * rows]);
        } else {
            for row in 0..rows {
                let start = offset + row * stride;
                body.extend_from_slice(&state.front[start..start + width]);
            }
        }
    }
    body
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .body(Vec::new())
        .expect("static response")
}

/// The newest frame after `after`, waiting briefly for one; 204 when there is nothing new.
pub fn response(after: u64) -> Response<Vec<u8>> {
    let Some(frames) = lock_ignore_poison(&CURRENT).clone() else {
        // Nothing is playing; don't spin the caller.
        std::thread::sleep(LONG_POLL);
        return empty(StatusCode::NO_CONTENT);
    };
    let state = lock_ignore_poison(&frames.state);
    let (state, _) = frames
        .ready
        .wait_timeout_while(state, LONG_POLL, |s| s.counter <= after)
        .unwrap_or_else(|e| e.into_inner());
    if state.counter <= after || state.width == 0 {
        return empty(StatusCode::NO_CONTENT);
    }
    let body = pack(&state);
    drop(state);
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/octet-stream")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .body(body)
        .expect("frame response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_keeps_aspect_and_never_upscales() {
        assert_eq!(fit_size(1920, 1080, 960, 540), (960, 540));
        assert_eq!(fit_size(1920, 1080, 4000, 4000), (1920, 1080));
        // Limited by height: 1000 wide stage, 300 tall.
        assert_eq!(fit_size(1920, 1080, 1000, 300), (534, 300));
        // Portrait.
        assert_eq!(fit_size(1080, 1920, 500, 500), (282, 500));
        // Sides are always even and at least 2.
        let (w, h) = fit_size(853, 479, 400, 400);
        assert!(w % 2 == 0 && h % 2 == 0);
        assert_eq!(fit_size(1, 1, 1, 1), (2, 2));
    }

    #[test]
    fn pitch_is_aligned_and_not_smaller_than_width() {
        assert_eq!(luma_pitch(534), 544);
        assert_eq!(luma_pitch(960), 960);
        assert_eq!(luma_pitch(2), 32);
        assert_eq!(plane_layout(64, 4), (256, 256 + 64, 256 + 128));
    }

    #[test]
    fn header_is_four_little_endian_words() {
        let h = header(0x0102, 3, 0x1_0000_0005);
        assert_eq!(&h[0..4], &[2, 1, 0, 0]);
        assert_eq!(&h[4..8], &[3, 0, 0, 0]);
        assert_eq!(&h[8..12], &[1, 0, 0, 0]);
        // The counter wraps to u32.
        assert_eq!(&h[12..16], &[5, 0, 0, 0]);
    }

    #[test]
    fn pack_drops_pitch_padding() {
        let (w, h, pitch) = (4u32, 2u32, 32u32);
        let (u, v, total) = plane_layout(pitch, h);
        let mut front = vec![0u8; total];
        for row in 0..2usize {
            for x in 0..4usize {
                front[row * 32 + x] = 10 + (row * 4 + x) as u8;
            }
        }
        front[u..u + 2].copy_from_slice(&[50, 51]);
        front[v..v + 2].copy_from_slice(&[60, 61]);
        let state = FrameState { width: w, height: h, pitch, back: Vec::new(), front, counter: 7 };
        let body = pack(&state);
        assert_eq!(body.len(), 16 + 12);
        assert_eq!(&body[16..], &[10, 11, 12, 13, 14, 15, 16, 17, 50, 51, 60, 61]);
    }
}
