//! Export: the page renders every frame at the output size, converts it to I420 in a shader and
//! sends it here; the sound mix comes first, as one PCM block. GStreamer encodes and muxes:
//! MP4 with H.264 from VA-API (constant QP: this driver refuses bitrate modes) and MP3, or WebM
//! with VP9 and Opus on the CPU. H.264 goes through `h264::Converter` because `mp4mux` needs
//! length-prefixed access units and `h264parse` isn't installed. When the user has added more
//! encoders (gstreamer1.0-plugins-ugly, -libav, -bad, or an NVIDIA driver), MP4 can use x264,
//! NVENC or HEVC instead, and AAC sound.

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
    /// MP4's video encoder: "vaapi", "x264", "nvh264", "x265" or "nvh265" (empty: the best one).
    #[serde(default)]
    pub codec: String,
}

#[derive(Serialize)]
pub struct Done {
    pub path: String,
    pub bytes: u64,
    pub seconds: f64,
    pub frames: u64,
}

/// One of MP4's video encoders, for the dialog.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Codec {
    pub id: &'static str,
    pub label: &'static str,
    pub available: bool,
    /// What adds it when it isn't there: a package, or a sentence.
    pub needs: &'static str,
}

/// What this system can export, for the dialog.
#[derive(Serialize, Debug)]
pub struct Encoders {
    pub h264: bool,
    pub mp3: bool,
    pub vp9: bool,
    pub opus: bool,
    pub aac: bool,
    pub hevc: bool,
    pub codecs: Vec<Codec>,
    /// Packages that would add codecs (decoders included), for "Install codecs".
    pub missing: Vec<&'static str>,
}

fn has(name: &str) -> bool {
    gst::ElementFactory::find(name).is_some()
}

/// NVIDIA's encoders register only with a driver; this checks one really starts.
fn starts(name: &str) -> bool {
    let Ok(element) = gst::ElementFactory::make(name).build() else { return false };
    let ok = element.set_state(gst::State::Ready).is_ok();
    let _ = element.set_state(gst::State::Null);
    ok
}

/// The encoders, given which GStreamer elements exist (`has`) and which NVIDIA ones start.
pub fn encoders_with(has: &dyn Fn(&str) -> bool, starts: &dyn Fn(&str) -> bool) -> Encoders {
    let mux = has("mp4mux");
    let hevc_parse = has("h265parse");
    let codecs = vec![
        // vaapih265enc is present here but fails to start at 1080p, so VA-API is H.264 only.
        Codec { id: "vaapi", label: "H.264 · graphics card (VA-API)", available: mux && has("vaapih264enc"), needs: "gstreamer1.0-vaapi" },
        Codec { id: "x264", label: "H.264 · x264 (processor)", available: mux && has("x264enc"), needs: "gstreamer1.0-plugins-ugly" },
        Codec { id: "nvh264", label: "H.264 · NVIDIA (NVENC)", available: mux && has("nvh264enc") && starts("nvh264enc"), needs: "an NVIDIA graphics card and its driver" },
        Codec { id: "x265", label: "HEVC · x265 (processor)", available: mux && hevc_parse && has("x265enc"), needs: "gstreamer1.0-plugins-bad" },
        Codec { id: "nvh265", label: "HEVC · NVIDIA (NVENC)", available: mux && hevc_parse && has("nvh265enc") && starts("nvh265enc"), needs: "an NVIDIA graphics card and its driver" },
    ];
    let mut missing = Vec::new();
    if !has("avenc_aac") || !has("avdec_aac") || !has("avdec_h264") {
        missing.push("gstreamer1.0-libav");
    }
    if !has("x264enc") {
        missing.push("gstreamer1.0-plugins-ugly");
    }
    Encoders {
        h264: codecs.iter().any(|c| c.available && (c.id == "vaapi" || c.id.ends_with("264"))),
        mp3: has("lamemp3enc") && has("mpegaudioparse"),
        vp9: has("vp9enc") && has("webmmux"),
        opus: has("opusenc"),
        aac: has("avenc_aac") || has("voaacenc") || has("fdkaacenc"),
        hevc: codecs.iter().any(|c| c.available && c.id.ends_with("265")),
        codecs,
        missing,
    }
}

pub fn encoders() -> Result<Encoders, String> {
    media::init()?;
    Ok(encoders_with(&has, &starts))
}

/// The MP4 encoder to use: the one asked for if it's there, else the first that is.
fn pick_codec(e: &Encoders, wanted: &str) -> Option<&'static str> {
    e.codecs.iter().find(|c| c.id == wanted && c.available).or_else(|| e.codecs.iter().find(|c| c.available)).map(|c| c.id)
}

/// MP4's sound encoder: AAC when there's one, else MP3.
fn aac_chain(has: &dyn Fn(&str) -> bool) -> Option<&'static str> {
    if has("avenc_aac") {
        Some("avenc_aac bitrate=192000 ! aacparse")
    } else if has("fdkaacenc") {
        Some("fdkaacenc bitrate=192000 ! aacparse")
    } else if has("voaacenc") {
        Some("voaacenc bitrate=192000 ! aacparse")
    } else {
        None
    }
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
fn description(spec: &Spec, codec: &str, aac: Option<&str>) -> (String, Option<String>) {
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
        if spec.audio {
            let sound = aac.unwrap_or("lamemp3enc target=bitrate bitrate=192 cbr=true ! mpegaudioparse");
            parts.push(format!("{audio_source} ! {sound} ! queue ! mux.audio_0"));
        }
        let q = quantizer(&spec.quality, false);
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(16);
        match codec {
            // Straight into the muxer: x264 writes AVC, and h265parse makes HVC1.
            "x264" => {
                parts.push(format!("{source} ! video/x-raw,format=I420 ! x264enc pass=qual quantizer={q} speed-preset=faster threads={threads} key-int-max={gop} bframes=0 ! video/x-h264,stream-format=avc,alignment=au,profile=high ! queue ! mux.video_0"));
                (parts.join("  "), None)
            }
            "x265" => {
                parts.push(format!("{source} ! video/x-raw,format=I420 ! x265enc speed-preset=faster qp={q} key-int-max={gop} ! h265parse ! video/x-h265,stream-format=hvc1,alignment=au ! queue ! mux.video_0"));
                (parts.join("  "), None)
            }
            "nvh265" => {
                parts.push(format!("{source} ! nvh265enc rc-mode=constqp qp-const={q} gop-size={gop} bframes=0 ! h265parse ! video/x-h265,stream-format=hvc1,alignment=au ! queue ! mux.video_0"));
                (parts.join("  "), None)
            }
            // Byte-stream H.264 (VA-API, NVENC): through the AVC converter and the bridge.
            _ => {
                parts.push("appsrc name=avc format=time ! queue ! mux.video_0".to_string());
                let encoder = if codec == "nvh264" {
                    format!("video/x-raw,format=I420 ! nvh264enc rc-mode=constqp qp-const={q} gop-size={gop} bframes=0 aud=false")
                } else {
                    format!("video/x-raw,format=NV12 ! vaapih264enc init-qp={q} keyframe-period={gop} max-bframes=0 aud=false")
                };
                let encode = format!("{source} ! {encoder} ! video/x-h264,stream-format=byte-stream,alignment=au ! appsink name=encoded sync=false");
                (parts.join("  "), Some(encode))
            }
        }
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
    let codec = pick_codec(&available, &spec.codec);
    if spec.format != "webm" && codec.is_none() {
        return Err("This system has no H.264 encoder. VA-API (gstreamer1.0-vaapi) or x264 (gstreamer1.0-plugins-ugly) adds one.".into());
    }
    let dest = PathBuf::from(&spec.path);
    let part = dest.with_extension(format!("{}.part", dest.extension().map_or("mp4".into(), |e| e.to_string_lossy())));
    let parse = |d: &str| -> Result<gst::Pipeline, String> {
        gst::parse_launch(d).map_err(|e| e.to_string())?.downcast::<gst::Pipeline>().map_err(|_| "not a pipeline".to_string())
    };
    let (main, encode) = description(&spec, codec.unwrap_or("vaapi"), aac_chain(&has));
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
        Spec { path: "/tmp/x.mp4".into(), width: 1080, height: 1920, fps: 30, format: format.into(), quality: "standard".into(), audio, codec: String::new() }
    }

    /// A system with exactly these elements (NVIDIA's start only if listed in `nv`).
    fn system(names: &'static [&'static str], nv: bool) -> Encoders {
        encoders_with(&|n| names.contains(&n), &move |_| nv)
    }

    #[test]
    fn mp4_pipeline_bridges_vaapi_into_mp4mux() {
        let (mux, encode) = description(&spec("mp4", true), "vaapi", None);
        let encode = encode.unwrap();
        assert!(encode.contains("width=1080,height=1920,framerate=30/1"));
        assert!(encode.contains("vaapih264enc init-qp=25 keyframe-period=60 max-bframes=0"));
        assert!(encode.contains("appsink name=encoded"));
        assert!(mux.contains("appsrc name=avc format=time ! queue ! mux.video_0"));
        assert!(mux.contains("lamemp3enc"));
        assert!(!mux.contains("vaapih264enc"));
        assert!(!description(&spec("mp4", false), "vaapi", None).0.contains("appsrc name=audio"));
    }

    #[test]
    fn webm_pipeline_encodes_vp9_and_opus() {
        let (d, encode) = description(&spec("webm", true), "vaapi", None);
        assert!(encode.is_none());
        assert!(d.contains("vp9enc"));
        assert!(d.contains("cq-level=32"));
        assert!(d.contains("opusenc"));
        assert!(!d.contains("vaapih264enc"));
    }

    #[test]
    fn this_machine_offers_vaapi_and_names_what_adds_more() {
        let e = system(&["mp4mux", "vaapih264enc", "lamemp3enc", "mpegaudioparse", "vp9enc", "webmmux", "opusenc", "aacparse"], false);
        assert!(e.h264 && !e.aac && !e.hevc);
        assert_eq!(e.missing, vec!["gstreamer1.0-libav", "gstreamer1.0-plugins-ugly"]);
        assert_eq!(pick_codec(&e, "x264"), Some("vaapi"), "an unavailable choice falls back");
        assert!(!e.codecs.iter().find(|c| c.id == "nvh264").unwrap().available);
    }

    #[test]
    fn after_installing_codecs_x264_aac_and_hevc_appear() {
        let names: &[&str] = &["mp4mux", "vaapih264enc", "x264enc", "x265enc", "h265parse", "avenc_aac", "avdec_aac", "avdec_h264", "lamemp3enc", "mpegaudioparse", "opusenc"];
        let e = system(names, false);
        assert!(e.aac && e.hevc && e.missing.is_empty());
        assert_eq!(pick_codec(&e, "x264"), Some("x264"));
        assert_eq!(aac_chain(&|n| names.contains(&n)), Some("avenc_aac bitrate=192000 ! aacparse"));
        let (mux, encode) = description(&Spec { codec: "x264".into(), ..spec("mp4", true) }, "x264", Some("avenc_aac bitrate=192000 ! aacparse"));
        assert!(encode.is_none(), "x264 writes AVC itself");
        assert!(mux.contains("x264enc pass=qual quantizer=25") && mux.contains("stream-format=avc") && mux.contains("avenc_aac"));
        let (mux, _) = description(&spec("mp4", true), "x265", None);
        assert!(mux.contains("x265enc") && mux.contains("h265parse") && mux.contains("lamemp3enc"));
    }

    #[test]
    fn nvenc_is_offered_only_when_its_driver_starts() {
        let names: &[&str] = &["mp4mux", "nvh264enc", "nvh265enc", "h265parse"];
        assert!(!system(names, false).h264);
        let e = system(names, true);
        assert!(e.h264 && e.hevc);
        assert_eq!(pick_codec(&e, ""), Some("nvh264"));
        let (mux, encode) = description(&spec("mp4", false), "nvh264", None);
        assert!(encode.unwrap().contains("nvh264enc rc-mode=constqp") && mux.contains("appsrc name=avc"));
    }

    #[test]
    fn quality_names_map_to_quantizers() {
        assert!(quantizer("high", false) < quantizer("standard", false));
        assert!(quantizer("standard", false) < quantizer("small", false));
        assert_eq!(quantizer("anything", true), 32);
    }
}
