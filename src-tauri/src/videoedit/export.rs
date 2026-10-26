//! Export: the page renders every frame at the output size, converts it to I420 in a shader and
//! sends it here; the sound mix comes first, as one PCM block. GStreamer encodes and muxes:
//! MP4 with H.264 from VA-API (constant QP: this driver refuses bitrate modes) and MP3, or WebM
//! with VP9 and Opus on the CPU. H.264 goes through `h264::Converter` because `mp4mux` needs
//! length-prefixed access units and `h264parse` isn't installed.

use super::h264::Converter;
use super::media;
use gst::prelude::*;
use gstreamer as gst;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// "mp4" (H.264 + MP3) or "webm" (VP9 + Opus).
    pub format: String,
    /// "high", "standard" or "small".
    pub quality: String,
    pub audio: bool,
}

#[derive(Serialize)]
pub struct Done {
    pub path: String,
    pub bytes: u64,
    pub seconds: f64,
    pub frames: u64,
}

/// What this system can export, for the dialog.
#[derive(Serialize)]
pub struct Encoders {
    pub h264: bool,
    pub mp3: bool,
    pub vp9: bool,
    pub opus: bool,
    pub aac: bool,
    pub hevc: bool,
}

fn has(name: &str) -> bool {
    gst::ElementFactory::find(name).is_some()
}

pub fn encoders() -> Result<Encoders, String> {
    media::init()?;
    Ok(Encoders {
        h264: has("vaapih264enc") && has("mp4mux"),
        mp3: has("lamemp3enc") && has("mpegaudioparse"),
        vp9: has("vp9enc") && has("webmmux"),
        opus: has("opusenc"),
        aac: has("avenc_aac") || has("voaacenc") || has("fdkaacenc"),
        // vaapih265enc is present here but fails to start at 1080p, and mp4mux would need a
        // HEVC converter too.
        hevc: false,
    })
}

struct Job {
    /// Writes the file.
    pipeline: gst::Pipeline,
    /// MP4: VA-API's encoder, feeding `pipeline` through the bridge.
    encode: Option<gst::Pipeline>,
    video: gst::Element,
    audio: Option<gst::Element>,
    fps: u32,
    frame_bytes: usize,
    frames: u64,
    part: PathBuf,
    dest: PathBuf,
    bridge: Option<JoinHandle<()>>,
    started: Instant,
}

fn jobs() -> &'static Mutex<HashMap<u32, Arc<Mutex<Job>>>> {
    static JOBS: std::sync::OnceLock<Mutex<HashMap<u32, Arc<Mutex<Job>>>>> = std::sync::OnceLock::new();
    JOBS.get_or_init(Default::default)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn job(id: u32) -> Result<Arc<Mutex<Job>>, String> {
    lock(jobs()).get(&id).cloned().ok_or_else(|| "The export was stopped.".to_string())
}

/// The quantizer (H.264) or constrained-quality level (VP9) for a quality name.
fn quantizer(quality: &str, vp9: bool) -> u32 {
    match (quality, vp9) {
        ("high", false) => 20,
        ("small", false) => 30,
        (_, false) => 25,
        ("high", true) => 24,
        ("small", true) => 40,
        (_, true) => 32,
    }
}

/// The pipelines: the muxing one (it writes the file), and for MP4 the encoding one before it.
/// They're separate because the encoder's appsink only hands out samples once its pipeline
/// plays, and a pipeline only plays once the file sink has data: in one pipeline that waits on
/// itself.
fn description(spec: &Spec) -> (String, Option<String>) {
    let (w, h, fps) = (spec.width, spec.height, spec.fps);
    let raw = format!("video/x-raw,format=I420,width={w},height={h},framerate={fps}/1,pixel-aspect-ratio=1/1");
    let frame = (w * h * 3 / 2) as u64;
    let pcm = "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved";
    let gop = fps * 2;
    let source = format!("appsrc name=video format=time block=true max-bytes={} caps=\"{raw}\" ! queue ! videoconvert", frame * 3);
    let audio_source = format!("appsrc name=audio format=time block=false max-bytes=0 caps=\"{pcm}\" ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=0 ! audioconvert ! audioresample");
    let mut parts = Vec::new();
    if spec.format == "webm" {
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(16);
        parts.push("webmmux name=mux ! filesink name=file".to_string());
        parts.push(format!(
            "{source} ! vp9enc deadline=1 cpu-used=8 threads={threads} row-mt=true tile-columns=2 end-usage=cq cq-level={} keyframe-max-dist={gop} ! queue ! mux.video_0",
            quantizer(&spec.quality, true)
        ));
        if spec.audio {
            parts.push(format!("{audio_source} ! opusenc bitrate=160000 ! queue ! mux.audio_0"));
        }
        (parts.join("  "), None)
    } else {
        parts.push("mp4mux name=mux faststart=true ! filesink name=file".to_string());
        parts.push("appsrc name=avc format=time ! queue ! mux.video_0".to_string());
        if spec.audio {
            parts.push(format!("{audio_source} ! lamemp3enc target=bitrate bitrate=192 cbr=true ! mpegaudioparse ! queue ! mux.audio_0"));
        }
        let encode = format!(
            "{source} ! video/x-raw,format=NV12 ! vaapih264enc init-qp={} keyframe-period={gop} max-bframes=0 aud=false ! video/x-h264,stream-format=byte-stream,alignment=au ! appsink name=encoded sync=false",
            quantizer(&spec.quality, false)
        );
        (parts.join("  "), Some(encode))
    }
}

/// Moves VA-API's byte-stream into the muxer's appsrc as AVC, until the encoder ends.
fn bridge(encoded: gst::Element, avc: gst::Element, size: (u32, u32), fps: u32) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut converter = Converter::default();
        let mut caps_set = false;
        while let Some(sample) = encoded.emit_by_name::<Option<gst::Sample>>("pull-sample", &[]) {
            let Some(buffer) = sample.buffer() else { continue };
            let Ok(map) = buffer.map_readable() else { continue };
            let unit = converter.convert(map.as_slice());
            if !caps_set {
                let Some(codec_data) = converter.codec_data() else { continue };
                let caps = gst::Caps::builder("video/x-h264")
                    .field("stream-format", "avc")
                    .field("alignment", "au")
                    .field("codec_data", gst::Buffer::from_slice(codec_data))
                    .field("width", size.0 as i32)
                    .field("height", size.1 as i32)
                    .field("framerate", gst::Fraction::new(fps as i32, 1))
                    .field("pixel-aspect-ratio", gst::Fraction::new(1, 1))
                    .build();
                avc.set_property("caps", &caps);
                caps_set = true;
            }
            if unit.data.is_empty() {
                continue;
            }
            let mut out = gst::Buffer::from_mut_slice(unit.data);
            {
                let out = out.get_mut().expect("new buffer");
                out.set_pts(buffer.pts());
                out.set_dts(buffer.dts().or(buffer.pts()));
                out.set_duration(buffer.duration());
                if !unit.keyframe {
                    out.set_flags(gst::BufferFlags::DELTA_UNIT);
                }
            }
            if avc.emit_by_name::<gst::FlowReturn>("push-buffer", &[&out]) != gst::FlowReturn::Ok {
                break;
            }
        }
        let _ = avc.emit_by_name::<gst::FlowReturn>("end-of-stream", &[]);
    })
}

static NEXT: AtomicU32 = AtomicU32::new(1);

pub fn begin(spec: Spec) -> Result<u32, String> {
    media::init()?;
    if spec.width % 8 != 0 || spec.height % 2 != 0 || spec.width < 16 || spec.height < 16 || spec.width > 4096 || spec.height > 4096 {
        return Err("That export size isn't supported.".into());
    }
    if !(1..=120).contains(&spec.fps) {
        return Err("That frame rate isn't supported.".into());
    }
    let available = encoders()?;
    if spec.format == "webm" && !available.vp9 {
        return Err("This system has no VP9 encoder (GStreamer's vpx plugin).".into());
    }
    if spec.format != "webm" && !available.h264 {
        return Err("This system has no H.264 encoder. VA-API (gstreamer1.0-vaapi) or x264 (gstreamer1.0-plugins-ugly) adds one.".into());
    }
    let dest = PathBuf::from(&spec.path);
    let part = dest.with_extension(format!("{}.part", dest.extension().map_or("mp4".into(), |e| e.to_string_lossy())));
    let parse = |d: &str| -> Result<gst::Pipeline, String> {
        gst::parse_launch(d).map_err(|e| e.to_string())?.downcast::<gst::Pipeline>().map_err(|_| "not a pipeline".to_string())
    };
    let (main, encode) = description(&spec);
    let pipeline = parse(&main)?;
    let encode = encode.as_deref().map(parse).transpose()?;
    let by = |p: &gst::Pipeline, name: &str| p.by_name(name).ok_or_else(|| format!("no {name}"));
    by(&pipeline, "file")?.set_property("location", part.to_string_lossy().to_string());
    let video = by(encode.as_ref().unwrap_or(&pipeline), "video")?;
    let audio = if spec.audio { Some(by(&pipeline, "audio")?) } else { None };
    let bridge_thread = match &encode {
        Some(e) => Some(bridge(by(e, "encoded")?, by(&pipeline, "avc")?, (spec.width, spec.height), spec.fps)),
        None => None,
    };
    let stop = |why: String| {
        for p in std::iter::once(&pipeline).chain(encode.as_ref()) {
            let _ = p.set_state(gst::State::Null);
        }
        why
    };
    for p in encode.iter().chain(std::iter::once(&pipeline)) {
        if p.set_state(gst::State::Playing).is_err() {
            let why = media::bus_error(p).unwrap_or_else(|| "The encoder couldn't start.".into());
            return Err(stop(why));
        }
    }
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let job = Job {
        pipeline,
        encode,
        video,
        audio,
        fps: spec.fps,
        frame_bytes: (spec.width * spec.height * 3 / 2) as usize,
        frames: 0,
        part,
        dest,
        bridge: bridge_thread,
        started: Instant::now(),
    };
    lock(jobs()).insert(id, Arc::new(Mutex::new(job)));
    Ok(id)
}

impl Job {
    fn error(&self) -> Option<String> {
        self.encode.as_ref().and_then(media::bus_error).or_else(|| media::bus_error(&self.pipeline))
    }

    fn stop(&self) {
        for p in self.encode.iter().chain(std::iter::once(&self.pipeline)) {
            let _ = p.set_state(gst::State::Null);
        }
    }
}

fn fail(id: u32, why: String) -> String {
    cancel(id);
    why
}

/// The whole sound mix: interleaved S16LE stereo at 48 kHz.
pub fn audio(id: u32, pcm: &[u8]) -> Result<(), String> {
    let job = job(id)?;
    let job = lock(&job);
    let Some(src) = job.audio.clone() else { return Ok(()) };
    // In pieces of one second, so the encoder can start while the rest is queued.
    let second = 48_000 * 4;
    let mut at = 0u64;
    for chunk in pcm.chunks(second) {
        let frames = (chunk.len() / 4) as u64;
        let mut buffer = gst::Buffer::from_slice(chunk.to_vec());
        {
            let b = buffer.get_mut().expect("new buffer");
            b.set_pts(gst::ClockTime::from_nseconds(at * 1_000_000_000 / 48_000));
            b.set_duration(gst::ClockTime::from_nseconds(frames * 1_000_000_000 / 48_000));
        }
        at += frames;
        if src.emit_by_name::<gst::FlowReturn>("push-buffer", &[&buffer]) != gst::FlowReturn::Ok {
            let why = job.error().unwrap_or_else(|| "The sound couldn't be encoded.".into());
            drop(job);
            return Err(fail(id, why));
        }
    }
    let _ = src.emit_by_name::<gst::FlowReturn>("end-of-stream", &[]);
    Ok(())
}

/// One I420 frame at the output size; blocks while the encoder catches up.
pub fn frame(id: u32, data: Vec<u8>) -> Result<u64, String> {
    let job = job(id)?;
    let mut job = lock(&job);
    if data.len() != job.frame_bytes {
        return Err(format!("A frame of {} bytes, not {}.", data.len(), job.frame_bytes));
    }
    if let Some(why) = job.error() {
        drop(job);
        return Err(fail(id, why));
    }
    let n = job.frames;
    let fps = job.fps as u64;
    let mut buffer = gst::Buffer::from_mut_slice(data);
    {
        let b = buffer.get_mut().expect("new buffer");
        b.set_pts(gst::ClockTime::from_nseconds(n * 1_000_000_000 / fps));
        b.set_duration(gst::ClockTime::from_nseconds((n + 1) * 1_000_000_000 / fps - n * 1_000_000_000 / fps));
    }
    if job.video.emit_by_name::<gst::FlowReturn>("push-buffer", &[&buffer]) != gst::FlowReturn::Ok {
        let why = job.error().unwrap_or_else(|| "The video couldn't be encoded.".into());
        drop(job);
        return Err(fail(id, why));
    }
    job.frames += 1;
    Ok(job.frames)
}

/// Ends the streams, waits for the file to be written and puts it in place.
pub fn finish(id: u32) -> Result<Done, String> {
    let job = job(id)?;
    let mut job = lock(&job);
    let _ = job.video.emit_by_name::<gst::FlowReturn>("end-of-stream", &[]);
    let bus = job.pipeline.bus().ok_or("no bus")?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let outcome = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break Err("The export didn't finish in time.".to_string());
        }
        match bus.timed_pop_filtered(gst::ClockTime::from_mseconds(left.as_millis().min(500) as u64), &[gst::MessageType::Eos, gst::MessageType::Error]) {
            Some(message) => match message.view() {
                gst::MessageView::Eos(_) => break Ok(()),
                gst::MessageView::Error(err) => break Err(err.error().to_string()),
                _ => {}
            },
            None => {
                if let Some(why) = job.encode.as_ref().and_then(media::bus_error) {
                    break Err(why);
                }
            }
        }
    };
    job.stop();
    if let Some(thread) = job.bridge.take() {
        let _ = thread.join();
    }
    let (part, dest, frames, started) = (job.part.clone(), job.dest.clone(), job.frames, job.started);
    drop(job);
    lock(jobs()).remove(&id);
    if let Err(why) = outcome {
        let _ = std::fs::remove_file(&part);
        return Err(why);
    }
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    Ok(Done {
        bytes: std::fs::metadata(&dest).map_or(0, |m| m.len()),
        path: dest.to_string_lossy().into_owned(),
        seconds: started.elapsed().as_secs_f64(),
        frames,
    })
}

/// Stops an export and removes what it wrote.
pub fn cancel(id: u32) {
    let Some(job) = lock(jobs()).remove(&id) else { return };
    let mut job = lock(&job);
    job.stop();
    // The bridge thread wakes up from pull-sample when the appsink goes to NULL.
    if let Some(thread) = job.bridge.take() {
        let _ = thread.join();
    }
    let _ = std::fs::remove_file(&job.part);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(format: &str, audio: bool) -> Spec {
        Spec { path: "/tmp/x.mp4".into(), width: 1080, height: 1920, fps: 30, format: format.into(), quality: "standard".into(), audio }
    }

    #[test]
    fn mp4_pipeline_bridges_vaapi_into_mp4mux() {
        let (mux, encode) = description(&spec("mp4", true));
        let encode = encode.unwrap();
        assert!(encode.contains("width=1080,height=1920,framerate=30/1"));
        assert!(encode.contains("vaapih264enc init-qp=25 keyframe-period=60 max-bframes=0"));
        assert!(encode.contains("appsink name=encoded"));
        assert!(mux.contains("appsrc name=avc format=time ! queue ! mux.video_0"));
        assert!(mux.contains("lamemp3enc"));
        assert!(!mux.contains("vaapih264enc"));
        assert!(!description(&spec("mp4", false)).0.contains("appsrc name=audio"));
    }

    #[test]
    fn webm_pipeline_encodes_vp9_and_opus() {
        let (d, encode) = description(&spec("webm", true));
        assert!(encode.is_none());
        assert!(d.contains("vp9enc"));
        assert!(d.contains("cq-level=32"));
        assert!(d.contains("opusenc"));
        assert!(!d.contains("vaapih264enc"));
    }

    #[test]
    fn quality_names_map_to_quantizers() {
        assert!(quantizer("high", false) < quantizer("standard", false));
        assert!(quantizer("standard", false) < quantizer("small", false));
        assert_eq!(quantizer("anything", true), 32);
    }
}
