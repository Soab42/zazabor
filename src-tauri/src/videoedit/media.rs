//! GStreamer plumbing shared by probing, frames, thumbnails and audio: a `uridecodebin` that
//! decodes only the kind of stream that's wanted (the other is parked on a fakesink still
//! encoded), and reading what went wrong from the bus.

use gst::prelude::*;
use gstreamer as gst;
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

/// Starts GStreamer once and steers decodebin away from decoders that can't work here.
pub fn init() -> Result<(), String> {
    static INIT: OnceLock<Result<(), String>> = OnceLock::new();
    INIT.get_or_init(|| {
        gst::init().map_err(|e| e.to_string())?;
        tune_decoders();
        Ok(())
    })
    .clone()
}

/// VA-API's VP9 and AV1 decoders need their parsers (plugins-bad) to split superframes; without
/// them decodebin still picks VA-API and gets "no valid frames". `vaapidecodebin` wraps every
/// VA-API decoder, so it goes too and decodebin picks the individual decoders (H.264 and HEVC
/// work without a parser: MP4 and Matroska hand them whole access units).
fn tune_decoders() {
    let registry = gst::Registry::get();
    let has = |name: &str| registry.lookup_feature(name).is_some();
    let demote = |name: &str| {
        if let Some(feature) = registry.lookup_feature(name) {
            feature.set_rank(gst::Rank::None);
        }
    };
    demote("vaapidecodebin");
    if !has("vp9parse") {
        demote("vaapivp9dec");
    }
    if !has("av1parse") {
        demote("vaapiav1dec");
    }
    if !has("vp8parse") {
        demote("vaapivp8dec");
    }
}

pub fn uri(path: &str) -> Result<String, String> {
    url::Url::from_file_path(path).map(String::from).map_err(|_| format!("Not a file path: {path}"))
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Want {
    Video,
    Audio,
}

/// Encoded elementary streams decodebin shouldn't decode when they aren't wanted. Containers
/// (video/quicktime, video/x-matroska, audio/x-wav…) must keep being opened.
fn is_elementary(s: &gst::StructureRef, video: bool) -> bool {
    let name = s.name().as_str();
    if video {
        if name == "video/mpeg" {
            return !s.get::<bool>("systemstream").unwrap_or(false);
        }
        matches!(
            name,
            "video/x-h264" | "video/x-h265" | "video/x-vp8" | "video/x-vp9" | "video/x-av1" | "video/x-divx" | "video/x-xvid"
                | "video/x-wmv" | "video/x-theora" | "video/x-dirac" | "video/x-prores" | "video/x-dv" | "image/jpeg" | "image/png"
        )
    } else {
        matches!(
            name,
            "audio/mpeg" | "audio/x-opus" | "audio/x-vorbis" | "audio/x-flac" | "audio/x-ac3" | "audio/x-eac3" | "audio/x-dts" | "audio/x-alac"
                | "audio/x-wma" | "audio/x-raw" | "audio/x-adpcm" | "audio/AMR" | "audio/AMR-WB" | "audio/x-alaw" | "audio/x-mulaw"
        )
    }
}

fn is_video_caps(caps: &gst::CapsRef) -> bool {
    caps.structure(0).is_some_and(|s| s.name().starts_with("video/") || s.name().starts_with("image/"))
}

/// A pipeline of `uridecodebin` feeding `chain` (a bin with a ghost sink pad) with the first
/// decoded stream of the wanted kind.
pub struct Decoding {
    pub pipeline: gst::Pipeline,
    /// decodebin exposed every stream it will.
    no_more_pads: Arc<AtomicBool>,
    /// The chain's sink, linked once a wanted stream showed up.
    wanted: gst::Pad,
}

/// `Decoding::start`'s error when the file has no stream of the wanted kind.
pub const NO_STREAM: &str = "no stream of that kind";

impl Decoding {
    /// Goes to `state`, giving up early when decodebin found nothing for the chain.
    pub fn start(&self, state: gst::State, seconds: u64, keep: &mut Vec<gst::Message>) -> Result<(), String> {
        let (done, wanted) = (self.no_more_pads.clone(), self.wanted.clone());
        wait_state_until(&self.pipeline, state, seconds, keep, &move || done.load(Ordering::SeqCst) && !wanted.is_linked())
    }
}

pub fn decoding(path: &str, want: Want, chain: &gst::Element) -> Result<Decoding, String> {
    init()?;
    if !Path::new(path).is_file() {
        return Err(format!("{} can't be found.", Path::new(path).file_name().map_or(path.into(), |n| n.to_string_lossy())));
    }
    let pipeline = gst::Pipeline::new();
    let source = gst::ElementFactory::make("uridecodebin").property("uri", uri(path)?).build().map_err(|e| e.to_string())?;
    pipeline.add(&source).map_err(|e| e.to_string())?;
    pipeline.add(chain).map_err(|e| e.to_string())?;
    // Unwanted streams stop at their encoded caps and end on a fakesink.
    source.connect("autoplug-continue", false, move |args| {
        let caps = args.get(2).and_then(|v| v.get::<gst::Caps>().ok());
        let stop = caps.as_ref().and_then(|c| c.structure(0)).is_some_and(|s| match want {
            Want::Video => is_elementary(s, false),
            Want::Audio => is_elementary(s, true),
        });
        Some((!stop).to_value())
    });
    let video_sink = chain.static_pad("sink").ok_or("chain has no sink")?;
    let wanted = video_sink.clone();
    let no_more_pads = Arc::new(AtomicBool::new(false));
    let done = no_more_pads.clone();
    source.connect_no_more_pads(move |_| done.store(true, Ordering::SeqCst));
    let weak = pipeline.downgrade();
    source.connect_pad_added(move |_, pad| {
        let Some(pipeline) = weak.upgrade() else { return };
        let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
        let raw = caps.structure(0).is_some_and(|s| s.name().ends_with("/x-raw"));
        let video = is_video_caps(&caps);
        let wanted = raw && (video == (want == Want::Video));
        if wanted && !video_sink.is_linked() {
            let _ = pad.link(&video_sink);
            return;
        }
        if let Ok(sink) = gst::ElementFactory::make("fakesink").property("sync", false).property("async", false).build() {
            if pipeline.add(&sink).is_ok() {
                let _ = sink.sync_state_with_parent();
                if let Some(sink_pad) = sink.static_pad("sink") {
                    let _ = pad.link(&sink_pad);
                }
            }
        }
    });
    Ok(Decoding { pipeline, no_more_pads, wanted })
}

/// A bin from a description, with its first unlinked sink pad ghosted as "sink".
pub fn chain(description: &str) -> Result<gst::Element, String> {
    init()?;
    let bin = gst::parse_bin_from_description(description, true).map_err(|e| e.to_string())?;
    Ok(bin.upcast())
}

/// The newest error on the bus, as text for a person.
pub fn bus_error(pipeline: &gst::Pipeline) -> Option<String> {
    let bus = pipeline.bus()?;
    let mut found = None;
    while let Some(message) = bus.pop_filtered(&[gst::MessageType::Error]) {
        if let gst::MessageView::Error(err) = message.view() {
            found = Some(err.error().to_string());
        }
    }
    found
}

/// Descriptions of missing decoders ("MPEG-4 AAC decoder") that decodebin asked for.
pub fn missing_plugins(messages: &[gst::Message]) -> Vec<String> {
    let mut out = Vec::new();
    for message in messages {
        if let gst::MessageView::Element(e) = message.view() {
            if let Some(s) = e.structure().filter(|s| s.name() == "missing-plugin") {
                if let Ok(name) = s.get::<String>("name") {
                    if !out.contains(&name) {
                        out.push(name);
                    }
                }
            }
        }
    }
    out
}

/// Waits for a state change (prerolling), collecting bus messages on the way.
pub fn wait_state(pipeline: &gst::Pipeline, state: gst::State, seconds: u64, keep: &mut Vec<gst::Message>) -> Result<(), String> {
    wait_state_until(pipeline, state, seconds, keep, &|| false)
}

fn wait_state_until(pipeline: &gst::Pipeline, state: gst::State, seconds: u64, keep: &mut Vec<gst::Message>, give_up: &dyn Fn() -> bool) -> Result<(), String> {
    pipeline.set_state(state).map_err(|_| failure(pipeline, keep))?;
    let bus = pipeline.bus().ok_or("no bus")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            return Err("The file took too long to open.".into());
        }
        if give_up() {
            return Err(NO_STREAM.into());
        }
        let Some(message) = bus.timed_pop(gst::ClockTime::from_mseconds(left.as_millis().min(100) as u64)) else {
            let (result, current, _) = pipeline.state(gst::ClockTime::ZERO);
            if result.is_ok() && current == state {
                return Ok(());
            }
            continue;
        };
        match message.view() {
            gst::MessageView::Error(_) => {
                keep.push(message.clone());
                return Err(failure(pipeline, keep));
            }
            gst::MessageView::AsyncDone(_) => {
                keep.push(message.clone());
                return Ok(());
            }
            _ => keep.push(message.clone()),
        }
    }
}

/// Why a pipeline couldn't start: a missing decoder first, else the error.
fn failure(pipeline: &gst::Pipeline, keep: &[gst::Message]) -> String {
    let missing = missing_plugins(keep);
    if !missing.is_empty() {
        return format!("This system has no {} (a GStreamer plugin).", missing.join(", "));
    }
    for message in keep.iter().rev() {
        if let gst::MessageView::Error(err) = message.view() {
            return err.error().to_string();
        }
    }
    bus_error(pipeline).unwrap_or_else(|| "The file couldn't be opened.".into())
}

// ---- probing

#[derive(Serialize, Clone, Debug, Default)]
pub struct VideoInfo {
    /// As shown: rotation and pixel aspect applied.
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: Option<String>,
    /// Degrees clockwise from the file's orientation tag.
    pub rotation: u32,
    /// False when no decoder for it is installed.
    pub decodable: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct AudioInfo {
    pub rate: u32,
    pub channels: u32,
    pub codec: Option<String>,
    pub decodable: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Probe {
    pub duration: f64,
    /// The file's size (for finding it again if it moves).
    pub bytes: u64,
    pub video: Option<VideoInfo>,
    pub audio: Option<AudioInfo>,
    /// Decoders GStreamer asked for and doesn't have.
    pub missing: Vec<String>,
}

fn rotation_of(tag: &str) -> u32 {
    match tag {
        "rotate-90" | "flip-rotate-90" => 90,
        "rotate-180" | "flip-rotate-180" => 180,
        "rotate-270" | "flip-rotate-270" => 270,
        _ => 0,
    }
}

/// Size as shown: pixel aspect applied to the width, then the rotation.
pub fn display_size(width: u32, height: u32, par: (i32, i32), rotation: u32) -> (u32, u32) {
    let w = if par.0 > 0 && par.1 > 0 && par.0 != par.1 { (width as f64 * par.0 as f64 / par.1 as f64).round() as u32 } else { width };
    if rotation == 90 || rotation == 270 {
        (height, w)
    } else {
        (w, height)
    }
}

/// Opens a file far enough to know its streams (one decoded frame per stream).
pub fn probe(path: &str) -> Result<Probe, String> {
    init()?;
    if !Path::new(path).is_file() {
        return Err("The file can't be found.".into());
    }
    let pipeline = gst::Pipeline::new();
    let source = gst::ElementFactory::make("uridecodebin").property("uri", uri(path)?).build().map_err(|e| e.to_string())?;
    pipeline.add(&source).map_err(|e| e.to_string())?;
    let pads: std::sync::Arc<std::sync::Mutex<Vec<gst::Pad>>> = Default::default();
    let weak = pipeline.downgrade();
    let seen = pads.clone();
    source.connect_pad_added(move |_, pad| {
        let Some(pipeline) = weak.upgrade() else { return };
        if let Ok(sink) = gst::ElementFactory::make("fakesink").property("sync", false).build() {
            if pipeline.add(&sink).is_ok() {
                let _ = sink.sync_state_with_parent();
                if let Some(sink_pad) = sink.static_pad("sink") {
                    let _ = pad.link(&sink_pad);
                    seen.lock().unwrap_or_else(|e| e.into_inner()).push(sink_pad);
                }
            }
        }
    });
    let mut messages = Vec::new();
    let started = wait_state(&pipeline, gst::State::Paused, 15, &mut messages);
    let mut out = Probe { missing: missing_plugins(&messages), bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0), ..Default::default() };
    if let Err(why) = started {
        let _ = pipeline.set_state(gst::State::Null);
        return Err(why);
    }
    out.duration = pipeline.query_duration::<gst::ClockTime>().map_or(0.0, |d| d.nseconds() as f64 / 1e9);
    if out.duration <= 0.0 {
        // Some parsers (MP3 without a Xing header) only estimate the length once data flows.
        let _ = pipeline.set_state(gst::State::Playing);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while out.duration <= 0.0 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
            out.duration = pipeline.query_duration::<gst::ClockTime>().map_or(0.0, |d| d.nseconds() as f64 / 1e9);
        }
        let _ = pipeline.set_state(gst::State::Paused);
    }
    let (mut video_codec, mut audio_codec, mut rotation) = (None, None, 0);
    if let Some(bus) = pipeline.bus() {
        while let Some(message) = bus.pop() {
            messages.push(message);
        }
    }
    for message in &messages {
        if let gst::MessageView::Tag(tag) = message.view() {
            let tags = tag.tags();
            if video_codec.is_none() {
                video_codec = tags.get::<gst::tags::VideoCodec>().map(|v| v.get().to_string());
            }
            if audio_codec.is_none() {
                audio_codec = tags.get::<gst::tags::AudioCodec>().map(|v| v.get().to_string());
            }
            if let Some(o) = tags.get::<gst::tags::ImageOrientation>() {
                rotation = rotation_of(o.get());
            }
        }
    }
    for pad in pads.lock().unwrap_or_else(|e| e.into_inner()).iter() {
        let Some(caps) = pad.current_caps() else { continue };
        let Some(s) = caps.structure(0) else { continue };
        let name = s.name().to_string();
        let raw = name.ends_with("/x-raw");
        if name.starts_with("video/") || name.starts_with("image/") {
            if out.video.is_some() {
                continue;
            }
            let (w, h) = (s.get::<i32>("width").unwrap_or(0).max(0) as u32, s.get::<i32>("height").unwrap_or(0).max(0) as u32);
            let par = s.get::<gst::Fraction>("pixel-aspect-ratio").map(|f| (f.numer(), f.denom())).unwrap_or((1, 1));
            let fps = s.get::<gst::Fraction>("framerate").ok().filter(|f| f.numer() > 0 && f.denom() > 0).map_or(0.0, |f| f.numer() as f64 / f.denom() as f64);
            let (width, height) = display_size(w, h, par, rotation);
            out.video = Some(VideoInfo { width, height, fps, codec: video_codec.clone(), rotation, decodable: raw });
        } else if name.starts_with("audio/") {
            if out.audio.is_some() {
                continue;
            }
            out.audio = Some(AudioInfo {
                rate: s.get::<i32>("rate").unwrap_or(0).max(0) as u32,
                channels: s.get::<i32>("channels").unwrap_or(0).max(0) as u32,
                codec: audio_codec.clone(),
                decodable: raw,
            });
        }
    }
    let _ = pipeline.set_state(gst::State::Null);
    // decodebin names a stream it can't decode only in the missing-plugin message.
    if out.audio.is_none() && out.missing.iter().any(|m| m.to_lowercase().contains("audio") || m.contains("AAC")) {
        out.audio = Some(AudioInfo { codec: out.missing.first().cloned(), ..Default::default() });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_size_applies_pixel_aspect_then_rotation() {
        assert_eq!(display_size(1920, 1080, (1, 1), 0), (1920, 1080));
        assert_eq!(display_size(1920, 1080, (1, 1), 90), (1080, 1920));
        assert_eq!(display_size(1440, 1080, (4, 3), 0), (1920, 1080));
        assert_eq!(display_size(720, 576, (16, 15), 270), (576, 768));
    }

    #[test]
    fn orientation_tags_turn_into_degrees() {
        assert_eq!(rotation_of("rotate-90"), 90);
        assert_eq!(rotation_of("flip-rotate-270"), 270);
        assert_eq!(rotation_of("rotate-0"), 0);
        assert_eq!(rotation_of("nonsense"), 0);
    }
}
