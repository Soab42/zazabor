//! The frame server: GStreamer decoders scaled to the size the page draws each clip at, keyed by
//! the clip that asks. Asking for the frame at time `t` reuses the last frame, reads forward
//! (the pipeline decodes a few frames ahead of the page) or does an accurate seek. A clip that
//! starts takes over an idle decoder of the same file (an earlier cut of it) instead of opening
//! the file again, so a reel cut from one video keeps a couple of decoders, not one per cut.
//! Frames are planar I420 with tight rows (the width is a multiple of 8), behind a 32-byte header.

use super::media::{self, Want};
use gst::prelude::*;
use gstreamer as gst;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Forward requests closer than this read on; farther ones seek.
const READ_AHEAD: f64 = 1.5;
/// Decoders kept open at most; the least recently used goes first.
const MAX_DECODERS: usize = 10;
/// How long a pull may wait for the decoder.
const PULL_TIMEOUT: Duration = Duration::from_secs(4);
/// Frames kept behind the newest one while reading forwards (asks a frame early don't seek).
const KEEP_FORWARD: usize = 2;
/// A decoder unused this long is free for another cut of its file to take over.
const ADOPT_IDLE: Duration = Duration::from_millis(400);
/// Memory for the stretch decoded ahead of a reversed clip.
const REVERSE_BYTES: usize = 64 * 1024 * 1024;

pub const HEADER_BYTES: usize = 32;
pub const FLAG_SAME: u32 = 1;
pub const FLAG_END: u32 = 2;

struct Frame {
    pts: f64,
    dur: f64,
    data: Vec<u8>,
}

struct Decoder {
    path: String,
    size: (u32, u32),
    pipeline: gst::Pipeline,
    sink: gst::Element,
    last: Option<Frame>,
    /// Frames decoded before `last`, oldest first (reading backwards serves them in turn).
    history: VecDeque<Frame>,
    keep: usize,
    ended: bool,
    frame_dur: f64,
}

impl Drop for Decoder {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

type Slot = Arc<Mutex<Option<Decoder>>>;

struct Entry {
    slot: Slot,
    used: Instant,
    path: String,
    size: (u32, u32),
    /// The source time last asked for.
    at: f64,
}

/// The decoders a page key may share: keys are `<prefix>:<clip>`, and preview and export each
/// have their own prefix.
fn group_of(key: &str) -> &str {
    key.rfind(':').map_or("", |i| &key[..=i])
}

/// How costly it is for a decoder at `at` to serve `t`: reading on is cheap, seeking isn't.
fn reach_cost(at: f64, t: f64) -> f64 {
    if t >= at && t - at < READ_AHEAD {
        t - at
    } else {
        10.0 + (t - at).abs()
    }
}

/// Picks the idle decoder (same group, file and size) best placed to serve `t`, if any.
fn adoptable<'a>(entries: impl Iterator<Item = (&'a String, &'a Entry)>, key: &str, path: &str, size: (u32, u32), t: f64, now: Instant) -> Option<String> {
    let group = group_of(key);
    entries
        .filter(|(k, e)| group_of(k) == group && e.path == path && e.size == size && now.duration_since(e.used) >= ADOPT_IDLE)
        .min_by(|a, b| reach_cost(a.1.at, t).total_cmp(&reach_cost(b.1.at, t)))
        .map(|(k, _)| k.clone())
}

fn pool() -> &'static Mutex<HashMap<String, Entry>> {
    static POOL: std::sync::OnceLock<Mutex<HashMap<String, Entry>>> = std::sync::OnceLock::new();
    POOL.get_or_init(Default::default)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The decode size for a source shown at most `max` big: aspect kept, never upscaled, the
/// width a multiple of 8 (tight I420 rows) and the height even.
pub fn decode_size(source: (u32, u32), max: (u32, u32)) -> (u32, u32) {
    let (sw, sh) = (source.0.max(8) as f64, source.1.max(2) as f64);
    let scale = (max.0.max(8) as f64 / sw).min(max.1.max(2) as f64 / sh).min(1.0);
    let w = ((sw * scale / 8.0).round() as u32 * 8).max(8);
    let h = ((sh * scale / 2.0).round() as u32 * 2).max(2);
    (w, h)
}

fn caps_for(size: (u32, u32), format: &str) -> String {
    format!("video/x-raw,format={format},width={},height={},pixel-aspect-ratio=1/1", size.0, size.1)
}

/// A decoder of `path` producing `size` frames of `format`, prerolled in `state`.
fn open(path: &str, size: (u32, u32), format: &str, state: gst::State) -> Result<(gst::Pipeline, gst::Element), String> {
    let chain = media::chain(&format!(
        // videoflip only takes 8-bit formats: 10-bit video (HDR phones, VP9 profile 2/3) is
        // converted first.
        "queue max-size-buffers=8 max-size-bytes=0 max-size-time=0 ! videoconvert ! videoflip video-direction=auto ! videoconvert ! videoscale add-borders=false ! {} ! appsink name=frames sync=false max-buffers=3 drop=false enable-last-sample=false",
        caps_for(size, format)
    ))?;
    let decoding = media::decoding(path, Want::Video, &chain)?;
    let bin = chain.downcast_ref::<gst::Bin>().ok_or("chain isn't a bin")?;
    let sink = bin.by_name("frames").ok_or("no appsink")?;
    let mut messages = Vec::new();
    if let Err(why) = decoding.start(state, 20, &mut messages) {
        let _ = decoding.pipeline.set_state(gst::State::Null);
        return Err(if why == media::NO_STREAM { "The file has no picture.".into() } else { why });
    }
    Ok((decoding.pipeline, sink))
}

fn covers(f: &Frame, t: f64) -> bool {
    t >= f.pts - 1e-4 && t < f.pts + f.dur - 1e-4
}

fn sample_frame(sample: &gst::Sample, frame_dur: f64) -> Option<Frame> {
    let buffer = sample.buffer()?;
    let pts = buffer.pts()?.nseconds() as f64 / 1e9;
    let dur = buffer.duration().map(|d| d.nseconds() as f64 / 1e9).filter(|d| *d > 0.0).unwrap_or(frame_dur);
    let map = buffer.map_readable().ok()?;
    Some(Frame { pts, dur, data: map.as_slice().to_vec() })
}

impl Decoder {
    fn new(path: &str, size: (u32, u32)) -> Result<Decoder, String> {
        let (pipeline, sink) = open(path, size, "I420", gst::State::Playing)?;
        let mut decoder = Decoder { path: path.into(), size, pipeline, sink, last: None, history: VecDeque::new(), keep: KEEP_FORWARD, ended: false, frame_dur: 1.0 / 30.0 };
        decoder.pull_next()?;
        if let Some(caps) = decoder.last.is_some().then(|| decoder.sink.static_pad("sink").and_then(|p| p.current_caps())).flatten() {
            if let Some(f) = caps.structure(0).and_then(|s| s.get::<gst::Fraction>("framerate").ok()).filter(|f| f.numer() > 0) {
                decoder.frame_dur = f.denom() as f64 / f.numer() as f64;
            }
        }
        Ok(decoder)
    }

    /// The next decoded frame becomes `last`; false at the end.
    fn pull_next(&mut self) -> Result<bool, String> {
        let timeout = PULL_TIMEOUT.as_nanos() as u64;
        let sample = self.sink.emit_by_name::<Option<gst::Sample>>("try-pull-sample", &[&timeout]);
        match sample.and_then(|s| sample_frame(&s, self.frame_dur)) {
            Some(frame) => {
                if let Some(previous) = self.last.replace(frame) {
                    if self.keep > 0 {
                        self.history.push_back(previous);
                        while self.history.len() > self.keep {
                            self.history.pop_front();
                        }
                    }
                }
                Ok(true)
            }
            None => {
                if let Some(why) = media::bus_error(&self.pipeline) {
                    return Err(why);
                }
                self.ended = true;
                Ok(false)
            }
        }
    }

    fn holds(&self, t: f64) -> bool {
        self.last.as_ref().is_some_and(|f| covers(f, t))
    }

    /// The frame showing at `t`: from the frames already decoded when it's among them, else by
    /// reading on or seeking. Going backwards (a reversed clip) it decodes a stretch before `t`
    /// and keeps it, so the frames before come without seeking each time.
    fn frame_at(&mut self, t: f64) -> Result<&Frame, String> {
        let t = t.max(0.0);
        if let Some(i) = self.history.iter().position(|f| covers(f, t)) {
            return Ok(&self.history[i]);
        }
        let behind = !self.holds(t) && self.last.as_ref().is_some_and(|f| t < f.pts - 1e-4);
        if behind {
            let bytes = self.last.as_ref().map_or(1, |f| f.data.len().max(1));
            self.keep = (REVERSE_BYTES / bytes).clamp(8, 60);
            self.history.clear();
            let from = (t - (self.keep as f64 - 2.0) * self.frame_dur).max(0.0);
            self.pipeline
                .seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE, gst::ClockTime::from_nseconds((from * 1e9) as u64))
                .map_err(|_| "The clip couldn't seek.".to_string())?;
            self.ended = false;
            self.last = None;
            while self.pull_next()? {
                let f = self.last.as_ref().expect("just pulled");
                if t < f.pts + f.dur - 1e-4 {
                    break;
                }
            }
            if self.last.is_none() {
                return Err("The clip has no picture there.".into());
            }
        } else {
            if !self.holds(t) && self.keep != KEEP_FORWARD {
                self.keep = KEEP_FORWARD;
                while self.history.len() > self.keep {
                    self.history.pop_front();
                }
            }
            self.seek_to(t)?;
        }
        Ok(self.last.as_ref().expect("a frame is there"))
    }

    /// Makes `last` the frame showing at `t` (seconds in the source).
    fn seek_to(&mut self, t: f64) -> Result<(), String> {
        let t = t.max(0.0);
        if self.holds(t) {
            return Ok(());
        }
        let ahead = self.last.as_ref().is_some_and(|f| t >= f.pts && t - f.pts < READ_AHEAD);
        if self.ended && self.last.as_ref().is_some_and(|f| t >= f.pts) {
            return Ok(());
        }
        if !ahead {
            self.history.clear();
            self.pipeline
                .seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE, gst::ClockTime::from_nseconds((t * 1e9) as u64))
                .map_err(|_| "The clip couldn't seek.".to_string())?;
            self.ended = false;
            self.last = None;
        }
        // Read on until the frame that covers t (an accurate seek lands on it or just before).
        while self.pull_next()? {
            let f = self.last.as_ref().expect("just pulled");
            if t < f.pts + f.dur - 1e-4 {
                break;
            }
        }
        if self.last.is_none() && t > 0.0 {
            // Past the last frame (durations round up): show the last one there is.
            self.pipeline
                .seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE, gst::ClockTime::from_nseconds(((t - 1.0).max(0.0) * 1e9) as u64))
                .map_err(|_| "The clip couldn't seek.".to_string())?;
            self.ended = false;
            while self.pull_next()? {}
        }
        if self.last.is_none() {
            return Err("The clip has no picture there.".into());
        }
        Ok(())
    }
}

/// The frame of `path` at `t` for the clip `key`, at most `max` big. `have` is the pts the page
/// already shows; when it's the same frame only the header comes back.
pub fn frame(key: &str, path: &str, t: f64, source: (u32, u32), max: (u32, u32), have: Option<f64>) -> Result<Vec<u8>, String> {
    let size = decode_size(source, max);
    let slot = {
        let mut pool = lock(pool());
        let now = Instant::now();
        if !pool.contains_key(key) {
            let adopt = if std::env::var_os("ZAZABOR_VIDEOEDIT_NO_ADOPT").is_some() { None } else { adoptable(pool.iter(), key, path, size, t, now) };
            if let Some(old) = adopt.and_then(|k| pool.remove(&k)) {
                pool.insert(key.to_string(), old);
            } else if pool.len() >= MAX_DECODERS {
                if let Some(oldest) = pool.iter().min_by_key(|(_, e)| e.used).map(|(k, _)| k.clone()) {
                    pool.remove(&oldest);
                }
            }
        }
        let entry = pool.entry(key.to_string()).or_insert_with(|| Entry { slot: Arc::default(), used: now, path: path.to_string(), size, at: t });
        entry.used = now;
        entry.path = path.to_string();
        entry.size = size;
        entry.at = t;
        entry.slot.clone()
    };
    let mut guard = lock(&slot);
    if guard.as_ref().is_some_and(|d| d.path != path || d.size != size) {
        *guard = None;
    }
    if guard.is_none() {
        *guard = Some(Decoder::new(path, size)?);
    }
    let decoder = guard.as_mut().expect("just opened");
    let built = decoder.frame_at(t).map(|frame| {
        let same = have.is_some_and(|h| (h - frame.pts).abs() < 1e-6);
        let flags = if same { FLAG_SAME } else { 0 };
        let mut out = Vec::with_capacity(HEADER_BYTES + if same { 0 } else { frame.data.len() });
        out.extend_from_slice(&size.0.to_le_bytes());
        out.extend_from_slice(&size.1.to_le_bytes());
        out.extend_from_slice(&frame.pts.to_le_bytes());
        out.extend_from_slice(&frame.dur.to_le_bytes());
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        if !same {
            out.extend_from_slice(&frame.data);
        }
        out
    });
    let mut out = match built {
        Ok(out) => out,
        Err(why) => {
            *guard = None;
            return Err(why);
        }
    };
    let decoder = guard.as_ref().expect("still open");
    if decoder.ended {
        out[24] |= FLAG_END as u8;
    }
    Ok(out)
}

/// Closes decoders: the given keys, or every key starting with `prefix`.
pub fn release(keys: &[String], prefix: Option<&str>) {
    let mut pool = lock(pool());
    pool.retain(|k, _| !keys.contains(k) && !prefix.is_some_and(|p| k.starts_with(p)));
}

// ---- thumbnail strips

/// `count` pictures `height` pixels tall, evenly spread over the clip, side by side in one JPEG.
/// Returns the JPEG and the width of one picture.
pub fn strip(path: &str, source: (u32, u32), duration: f64, height: u32, count: u32) -> Result<(Vec<u8>, u32), String> {
    let count = count.clamp(1, 400);
    let size = decode_size(source, (u32::MAX / 2, height.clamp(16, 512)));
    let (pipeline, sink) = open(path, size, "RGBx", gst::State::Paused)?;
    let (w, h) = (size.0 as usize, size.1 as usize);
    let mut sheet = image::RgbImage::new(size.0 * count, size.1);
    let step = if duration > 0.0 { duration / count as f64 } else { 0.0 };
    let mut last: Option<Vec<u8>> = None;
    for i in 0..count {
        let t = step * (i as f64 + 0.5);
        if i > 0 || t > 0.5 {
            let flags = gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT | gst::SeekFlags::SNAP_NEAREST;
            if pipeline.seek_simple(flags, gst::ClockTime::from_nseconds((t * 1e9) as u64)).is_ok() {
                let _ = pipeline.state(gst::ClockTime::from_seconds(5));
            }
        }
        let pixels = sink
            .emit_by_name::<Option<gst::Sample>>("pull-preroll", &[])
            .and_then(|s| s.buffer_owned())
            .and_then(|b| b.map_readable().ok().map(|m| m.as_slice().to_vec()));
        let pixels = match pixels.or_else(|| last.clone()) {
            Some(p) => p,
            None => continue,
        };
        let stride = pixels.len() / h.max(1);
        for y in 0..h {
            for x in 0..w {
                let o = y * stride + x * 4;
                if o + 2 < pixels.len() {
                    sheet.put_pixel(i * size.0 + x as u32, y as u32, image::Rgb([pixels[o], pixels[o + 1], pixels[o + 2]]));
                }
            }
        }
        last = Some(pixels);
    }
    let _ = pipeline.set_state(gst::State::Null);
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 78).encode_image(&sheet).map_err(|e| e.to_string())?;
    Ok((jpeg, size.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, size: (u32, u32), at: f64, idle_ms: u64, now: Instant) -> Entry {
        Entry { slot: Arc::default(), used: now - Duration::from_millis(idle_ms), path: path.into(), size, at }
    }

    #[test]
    fn a_new_cut_takes_over_an_idle_decoder_of_its_file() {
        let now = Instant::now();
        let mut pool: HashMap<String, Entry> = HashMap::new();
        // The cut playing now (busy), an earlier cut (idle, at 1.6 s), another file, the export's.
        pool.insert("ve1:a".into(), entry("/v/p.mp4", (544, 960), 3.0, 10, now));
        pool.insert("ve1:b".into(), entry("/v/p.mp4", (544, 960), 1.6, 900, now));
        pool.insert("ve1:c".into(), entry("/v/l.mp4", (544, 960), 2.0, 900, now));
        pool.insert("ve1:x:d".into(), entry("/v/p.mp4", (544, 960), 2.0, 900, now));
        assert_eq!(adoptable(pool.iter(), "ve1:new", "/v/p.mp4", (544, 960), 2.0, now), Some("ve1:b".into()));
        // A different size, or nothing idle: open a new one.
        assert_eq!(adoptable(pool.iter(), "ve1:new", "/v/p.mp4", (272, 480), 2.0, now), None);
        pool.remove("ve1:b");
        assert_eq!(adoptable(pool.iter(), "ve1:new", "/v/p.mp4", (544, 960), 2.0, now), None);
        // Export keys only share with export keys.
        assert_eq!(adoptable(pool.iter(), "ve1:x:e", "/v/p.mp4", (544, 960), 2.0, now), Some("ve1:x:d".into()));
    }

    #[test]
    fn reading_on_beats_seeking() {
        assert!(reach_cost(1.0, 1.2) < reach_cost(2.0, 1.2), "forward is cheap, backward seeks");
        assert!(reach_cost(1.0, 1.2) < reach_cost(-5.0, 1.2), "near beats far");
    }

    #[test]
    fn decode_size_keeps_aspect_and_alignment() {
        assert_eq!(decode_size((1080, 1920), (540, 960)), (544, 960));
        assert_eq!(decode_size((1920, 1080), (960, 960)), (960, 540));
        // Never larger than the source.
        assert_eq!(decode_size((640, 360), (1920, 1080)), (640, 360));
        let (w, h) = decode_size((1080, 1920), (300, 300));
        assert_eq!(w % 8, 0);
        assert_eq!(h % 2, 0);
        assert!(h <= 300);
    }
}
