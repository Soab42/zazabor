//! Screen recording (Studio → Record, and `zazabor --record` from anywhere): the whole screen, a
//! window or an area, with the sound playing on the computer and the microphone, an optional
//! camera bubble, into an MP4 (VA-API H.264) or WebM (VP9) in ~/Videos/Recordings.
//!
//! A recording is two GStreamer pipelines (`pipeline.rs`): the capture pipeline grabs and encodes,
//! and a bridge thread per stream moves the encoded buffers into the muxer pipeline, converting
//! VA-API's H.264 on the way and starting the timestamps at zero. Pausing pauses the capture
//! pipeline; any time its clock kept running is taken off later timestamps, so a pause leaves no
//! gap and no frozen frame. Three small windows go with it: the recorder (`--record`), the area
//! picker over a still of the screen, and the control bar that floats while recording.

pub mod devices;
pub mod files;
pub mod pipeline;
mod x11;

use crate::videoedit::{h264::Converter, media};
use files::PauseClock;
use gst::prelude::*;
use gstreamer as gst;
use devices::Monitor;
use pipeline::{AudioCodec, Camera, CameraSource, Plan, Screen, Sound, VideoCodec};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

pub const WINDOW: &str = "recorder";
const AREA_WINDOW: &str = "recorder-area";
const BAR_WINDOW: &str = "recorder-pill";
const BAR_SIZE: (f64, f64) = (360.0, 56.0);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Tests replace every real sound, camera and microphone with test sources (debug builds only).
fn test_sources() -> bool {
    cfg!(debug_assertions) && std::env::var_os("ZAZABOR_RECORDER_TEST").is_some()
}

fn display() -> String {
    std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into())
}

fn wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t.eq_ignore_ascii_case("wayland")) || (std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("DISPLAY").is_none())
}

fn has(name: &str) -> bool {
    gst::ElementFactory::find(name).is_some()
}

// ---- what can be recorded --------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sources {
    pub monitors: Vec<Monitor>,
    pub windows: Vec<x11::WindowInfo>,
    pub mics: Vec<devices::Input>,
    /// Speakers and other outputs whose sound "System sound" can record instead of the default.
    pub outputs: Vec<devices::Output>,
    pub cameras: Vec<devices::CameraDevice>,
    /// Formats that can be written here: "mp4", "webm".
    pub formats: Vec<&'static str>,
    pub folder: String,
    pub free: Option<u64>,
    /// Recording needs an X11 session; on Wayland this says why it can't.
    pub unsupported: Option<String>,
}

/// The screens, left to right: RandR's monitors as they are now, else what the window system
/// last reported, else the whole X screen.
fn monitors(app: &tauri::AppHandle) -> Vec<Monitor> {
    let found = devices::monitors_from(x11::monitors(&display()));
    if !found.is_empty() {
        return found;
    }
    let reported = app.available_monitors().unwrap_or_default().into_iter().map(|m| (m.name().cloned().unwrap_or_default(), m.position().x, m.position().y, m.size().width, m.size().height, false));
    let found = devices::monitors_from(reported.collect());
    if !found.is_empty() {
        return found;
    }
    x11::screen_size(&display()).map(|(width, height)| vec![Monitor { name: String::new(), label: "Screen".into(), x: 0, y: 0, width, height, primary: true }]).unwrap_or_default()
}

fn formats() -> Vec<&'static str> {
    let mut out = Vec::new();
    if has("mp4mux") && (has("vaapih264enc") || has("x264enc")) {
        out.push("mp4");
    }
    if has("webmmux") && has("vp9enc") && has("opusenc") {
        out.push("webm");
    }
    out
}

/// Where recordings go: the folder set in Settings, else ~/Videos/Recordings.
fn folder(app: &tauri::AppHandle, custom: Option<&str>) -> PathBuf {
    if let Some(dir) = custom.filter(|d| !d.trim().is_empty() && Path::new(d).is_absolute()) {
        return PathBuf::from(dir);
    }
    let videos = app.path().video_dir().ok().or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Videos"))).unwrap_or_else(std::env::temp_dir);
    videos.join("Recordings")
}

#[tauri::command]
pub async fn recorder_sources(app: tauri::AppHandle, folder_path: Option<String>) -> Result<Sources, String> {
    crate::ensure_unlocked()?;
    media::init()?;
    let dir = folder(&app, folder_path.as_deref());
    let unsupported = wayland().then(|| "Screen recording needs an X11 session for now. On the login screen, pick “GNOME on Xorg” (the gear button), then record.".to_string());
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Only listed: in tests (ZAZABOR_RECORDER_TEST) a tone and a test picture are recorded.
        let mut devices = devices::list(true, true);
        if test_sources() {
            devices.inputs.insert(0, devices::Input { id: "test".into(), name: "Test tone".into(), kind: "other", hint: None });
            devices.cameras.insert(0, devices::CameraDevice { path: "test".into(), name: "Test picture".into(), mode: None });
        }
        Sources {
        monitors: monitors(&app2),
        windows: if wayland() { Vec::new() } else { x11::windows(&display()) },
        mics: devices.inputs,
        outputs: devices.outputs,
        cameras: devices.cameras,
        formats: formats(),
        free: files::free_space(&dir),
        folder: dir.to_string_lossy().into_owned(),
        unsupported,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// A still of part of the screen (JPEG), to draw an area on.
#[tauri::command]
pub async fn recorder_still(x: i32, y: i32, width: u32, height: u32) -> Result<tauri::ipc::Response, String> {
    crate::ensure_unlocked()?;
    media::init()?;
    tauri::async_runtime::spawn_blocking(move || grab_still(x, y, width, height)).await.map_err(|e| e.to_string())?.map(tauri::ipc::Response::new)
}

/// The still the area picker shows: taken before its window covers the screen.
static STILL: Mutex<Option<Vec<u8>>> = Mutex::new(None);

#[tauri::command]
pub fn recorder_area_still() -> Result<tauri::ipc::Response, String> {
    lock(&STILL).take().map(tauri::ipc::Response::new).ok_or_else(|| "No still of the screen.".to_string())
}

fn grab_still(x: i32, y: i32, width: u32, height: u32) -> Result<Vec<u8>, String> {
    {
        let d = format!(
            "ximagesrc display-name=\"{}\" use-damage=false show-pointer=false num-buffers=1 startx={x} starty={y} endx={} endy={} ! videoconvert ! jpegenc quality=85 ! appsink name=out sync=false",
            display().replace('"', ""),
            x + width as i32 - 1,
            y + height as i32 - 1
        );
        let pipeline = gst::parse_launch(&d).map_err(|e| e.to_string())?.downcast::<gst::Pipeline>().map_err(|_| "not a pipeline")?;
        let sink = pipeline.by_name("out").ok_or("no sink")?;
        pipeline.set_state(gst::State::Playing).map_err(|_| media::bus_error(&pipeline).unwrap_or_else(|| "The screen couldn't be read.".into()))?;
        let sample = sink.emit_by_name::<Option<gst::Sample>>("try-pull-sample", &[&(3 * gst::ClockTime::SECOND.nseconds())]);
        let _ = pipeline.set_state(gst::State::Null);
        let buffer = sample.and_then(|s| s.buffer_owned()).ok_or("The screen couldn't be read.")?;
        let map = buffer.map_readable().map_err(|e| e.to_string())?;
        Ok(map.as_slice().to_vec())
    }
}

// ---- the recording -------------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Target {
    Screen { monitor: usize },
    /// Every screen at once: the box around them all.
    All,
    Window { xid: u64 },
    Area { x: i32, y: i32, width: u32, height: u32 },
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartSpec {
    pub target: Target,
    pub system_sound: bool,
    pub mic: bool,
    pub mic_id: Option<String>,
    /// The output whose sound "System sound" records (its monitor source); none for the default.
    #[serde(default)]
    pub output_id: Option<String>,
    /// "bottom-right", "bottom-left", "top-right", "top-left"; none for no camera.
    pub camera: Option<String>,
    /// The camera's device ("/dev/video2"); none for the first one.
    #[serde(default)]
    pub camera_id: Option<String>,
    /// "standard", "smooth", "small".
    pub quality: String,
    /// "mp4" or "webm".
    pub format: String,
    pub countdown: bool,
    pub hide_bar: bool,
    pub folder: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "idle", "countdown", "recording", "paused", "finishing".
    pub phase: &'static str,
    pub countdown: u32,
    pub elapsed: f64,
    pub mic: bool,
    pub muted: bool,
    pub hide_bar: bool,
    pub warning: Option<String>,
    /// The window that started it (its label): the review shows there.
    pub origin: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub path: Option<String>,
    pub seconds: f64,
    pub bytes: u64,
    pub origin: String,
    pub discarded: bool,
    /// Why it stopped on its own (a window closed, the disk filled up), or why it failed.
    pub error: Option<String>,
}

struct Running {
    capture: gst::Pipeline,
    mux: gst::Pipeline,
    bridges: Vec<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    shifts: Arc<Mutex<Vec<Shift>>>,
    paused_at: Option<gst::ClockTime>,
    clock: PauseClock,
    part: PathBuf,
    dest: PathBuf,
    display: String,
    /// The part of the screen recorded, to notice its screen being unplugged.
    watch: Option<(i32, i32, u32, u32)>,
    /// Sound sources that went away ("mic", "system") and when, in recorded seconds.
    lost: Vec<(&'static str, f64)>,
}

#[derive(Default)]
struct State {
    status: Status,
    running: Option<Running>,
    /// Bumped by every start, so a countdown that was cancelled doesn't start anything.
    generation: u64,
    /// The last recording, for a window that opens after it finished.
    finished: Option<Finished>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = lock(&STATE);
    f(guard.get_or_insert_with(|| State { status: Status { phase: "idle", ..Default::default() }, ..Default::default() }))
}

fn emit_status(app: &tauri::AppHandle) {
    let status = with_state(|s| s.status.clone());
    let _ = app.emit("recorder-state", status);
}

#[tauri::command]
pub fn recorder_status() -> Status {
    with_state(|s| s.status.clone())
}

/// The last recording that finished (once), for a recorder window that opened after it.
#[tauri::command]
pub fn recorder_take_finished(window: tauri::Window) -> Option<Finished> {
    with_state(|s| if s.finished.as_ref().is_some_and(|f| f.origin == window.label() || f.origin.is_empty()) { s.finished.take() } else { None })
}

/// A pause's effect on timestamps: buffers from `from` (capture running time) on are `by` earlier.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shift {
    pub from: gst::ClockTime,
    pub by: gst::ClockTime,
}

/// Where a buffer captured at `pts` goes in the file: after `origin`, less every pause before it.
pub fn place(pts: gst::ClockTime, origin: gst::ClockTime, shifts: &[Shift]) -> Option<gst::ClockTime> {
    let taken: gst::ClockTime = shifts.iter().filter(|s| pts >= s.from).map(|s| s.by).sum();
    pts.checked_sub(origin)?.checked_sub(taken)
}

/// The plan for a request: what to grab, how big, which encoders, which sounds.
fn plan_for(app: &tauri::AppHandle, spec: &StartSpec) -> Result<Plan, String> {
    let display = display();
    let (screen, source) = match spec.target {
        Target::Screen { monitor } => {
            let all = monitors(app);
            let m = all.get(monitor).or_else(|| all.first()).ok_or("No screen was found to record.")?;
            (Screen::Rect { x: m.x, y: m.y, w: m.width & !1, h: m.height & !1 }, (m.width, m.height))
        }
        Target::All => {
            let (x, y, w, h) = devices::bounds(&monitors(app)).or_else(|| x11::screen_size(&display).map(|(w, h)| (0, 0, w, h))).ok_or("No screen was found to record.")?;
            (Screen::Rect { x, y, w: w & !1, h: h & !1 }, (w, h))
        }
        Target::Window { xid } => {
            let (_, _, w, h) = x11::window_rect(&display, xid).ok_or("That window has closed. Pick another one.")?;
            (Screen::Window { xid }, (w, h))
        }
        Target::Area { x, y, width, height } => {
            if width < 32 || height < 32 {
                return Err("That area is too small to record. Draw a bigger one.".into());
            }
            (Screen::Rect { x: x.max(0), y: y.max(0), w: width & !1, h: height & !1 }, (width, height))
        }
    };
    let (max, fps, qp, cq) = match spec.quality.as_str() {
        "smooth" => ((1920, 1080), 60, 24, 33),
        "small" => ((1280, 720), 30, 31, 40),
        _ => ((1920, 1080), 30, 24, 32),
    };
    let size = pipeline::output_size(source, max);
    let webm = spec.format == "webm";
    let (video, audio) = if webm {
        if !(has("vp9enc") && has("webmmux") && has("opusenc")) {
            return Err("WebM recording needs GStreamer's VP9 and Opus encoders.".into());
        }
        (VideoCodec::Vp9 { cq }, AudioCodec::Opus)
    } else {
        let video = if has("vaapih264enc") {
            VideoCodec::Vaapi { qp }
        } else if has("x264enc") {
            VideoCodec::X264 { qp: qp - 2 }
        } else {
            return Err("This computer has no H.264 encoder for MP4. Choose WebM under More options, or install gstreamer1.0-vaapi.".into());
        };
        let audio = if has("avenc_aac") {
            AudioCodec::Aac("avenc_aac bitrate=192000 ! aacparse")
        } else if has("fdkaacenc") {
            AudioCodec::Aac("fdkaacenc bitrate=192000 ! aacparse")
        } else {
            AudioCodec::Mp3
        };
        (video, audio)
    };
    let test = test_sources();
    let output = spec.output_id.clone().filter(|o| !o.is_empty()).unwrap_or_else(|| "@DEFAULT_MONITOR@".into());
    let system = spec.system_sound.then(|| if test { Sound::Test(440) } else { Sound::Pulse(output) });
    let mic = spec.mic.then(|| match (&spec.mic_id, test) {
        (_, true) => Sound::Test(880),
        (Some(id), false) if !id.is_empty() => Sound::Pulse(id.clone()),
        _ => Sound::Pulse("@DEFAULT_SOURCE@".into()),
    });
    if matches!(audio, AudioCodec::Mp3) && (system.is_some() || mic.is_some()) && !(has("lamemp3enc") && has("mpegaudioparse")) {
        return Err("This computer has no MP3 or AAC encoder for the sound. Choose WebM under More options.".into());
    }
    let camera = match spec.camera.as_deref().filter(|c| !c.is_empty()) {
        None => None,
        Some(corner) => {
            let (side, x, y) = pipeline::bubble(size, corner);
            let source = if test {
                CameraSource::Test
            } else {
                let cameras = devices::list(false, true).cameras;
                let chosen = spec.camera_id.as_ref().and_then(|id| cameras.iter().find(|c| &c.path == id)).or(cameras.first());
                let c = chosen.ok_or("No camera was found. Plug one in, or turn Camera off.")?;
                CameraSource::Device { path: c.path.clone(), mode: c.mode.filter(|m| !m.mjpeg || has("jpegdec")) }
            };
            Some(Camera { source, size: side, x, y })
        }
    };
    Ok(Plan { display, screen, size, fps, camera, system, mic, video, audio })
}

/// Cuts the camera picture to a circle with a soft edge: alpha outside it becomes 0.
fn round_bubble(buffer: &mut gst::BufferRef, side: u32) {
    let Ok(mut map) = buffer.map_writable() else { return };
    let data = map.as_mut_slice();
    let side = side as usize;
    if data.len() < side * side * 4 {
        return;
    }
    let r = side as f32 / 2.0;
    for y in 0..side {
        let dy = y as f32 + 0.5 - r;
        for x in 0..side {
            let dx = x as f32 + 0.5 - r;
            let edge = r - (dx * dx + dy * dy).sqrt();
            let a = edge.clamp(0.0, 1.0);
            let i = (y * side + x) * 4 + 3;
            data[i] = (data[i] as f32 * a) as u8;
        }
    }
}

fn parse(description: &str) -> Result<gst::Pipeline, String> {
    gst::parse_launch(description).map_err(|e| e.to_string())?.downcast::<gst::Pipeline>().map_err(|_| "not a pipeline".to_string())
}

/// Moves one encoded stream from the capture pipeline's appsink into the muxer's appsrc.
fn bridge(name: &'static str, sink: gst::Element, src: gst::Element, plan: &Plan, origin: Arc<Mutex<Option<gst::ClockTime>>>, shifts: Arc<Mutex<Vec<Shift>>>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    let vaapi = matches!(plan.video, VideoCodec::Vaapi { .. }) && name == "v";
    let (w, h, fps) = (plan.size.0, plan.size.1, plan.fps);
    let frame = (name == "v").then(|| gst::ClockTime::SECOND / fps.max(1) as u64);
    std::thread::Builder::new()
        .name(format!("recorder-{name}"))
        .spawn(move || {
            let mut converter = Converter::default();
            let mut caps_set = false;
            let mut waiting: Vec<gst::Sample> = Vec::new();
            let mut stopping_since: Option<Instant> = None;
            let (mut pulled, mut pushed) = (0u64, 0u64);
            let (mut leading, mut lead) = (name == "v", None::<gst::Buffer>);
            // Into the file; false (and the stream ended) when the muxer refuses it.
            let push = |src: &gst::Element, buffer: &gst::Buffer, pushed: &mut u64| {
                let flow = src.emit_by_name::<gst::FlowReturn>("push-buffer", &[buffer]);
                *pushed += 1;
                if flow != gst::FlowReturn::Ok {
                    eprintln!("Recording: the file's muxer refused the {name} stream ({flow:?})");
                    let _ = src.emit_by_name::<gst::FlowReturn>("end-of-stream", &[]);
                    return false;
                }
                true
            };
            loop {
                // Stopping: the capture pipeline was sent EOS; give it a moment, then give up, even
                // if something upstream keeps producing.
                if stop.load(Ordering::Relaxed) && stopping_since.get_or_insert_with(Instant::now).elapsed() > Duration::from_secs(4) {
                    break;
                }
                let sample = sink.emit_by_name::<Option<gst::Sample>>("try-pull-sample", &[&(100 * gst::ClockTime::MSECOND.nseconds())]);
                let Some(sample) = sample else {
                    // `eos` also reads true before the sink has started: only the end once something
                    // came through, or once a stop was asked for.
                    if sink.property::<bool>("eos") && (pulled > 0 || stop.load(Ordering::Relaxed)) {
                        break;
                    }
                    continue;
                };
                pulled += 1;
                // The video's first frame is where the file starts; sound waits for it.
                let start = {
                    let mut o = lock(&origin);
                    if o.is_none() && name == "v" {
                        *o = sample.buffer().and_then(|b| b.pts());
                    }
                    *o
                };
                let Some(start) = start else {
                    if waiting.len() < 400 {
                        waiting.push(sample);
                    }
                    continue;
                };
                for sample in waiting.drain(..).chain(std::iter::once(sample)) {
                    let Some(buffer) = sample.buffer() else { continue };
                    let Some(pts) = buffer.pts() else { continue };
                    let Some(at) = place(pts, start, &lock(&shifts)) else { continue };
                    let out = if vaapi {
                        let Ok(map) = buffer.map_readable() else { continue };
                        let unit = converter.convert(map.as_slice());
                        if !caps_set {
                            let Some(codec_data) = converter.codec_data() else { continue };
                            let caps = gst::Caps::builder("video/x-h264")
                                .field("stream-format", "avc")
                                .field("alignment", "au")
                                .field("codec_data", gst::Buffer::from_slice(codec_data))
                                .field("width", w as i32)
                                .field("height", h as i32)
                                .field("framerate", gst::Fraction::new(fps as i32, 1))
                                .field("pixel-aspect-ratio", gst::Fraction::new(1, 1))
                                .build();
                            src.set_property("caps", &caps);
                            caps_set = true;
                        }
                        if unit.data.is_empty() {
                            continue;
                        }
                        let mut out = gst::Buffer::from_mut_slice(unit.data);
                        if !unit.keyframe {
                            out.get_mut().expect("new buffer").set_flags(gst::BufferFlags::DELTA_UNIT);
                        }
                        out
                    } else {
                        if !caps_set {
                            if let Some(caps) = sample.caps() {
                                src.set_property("caps", caps.to_owned());
                            }
                            caps_set = true;
                        }
                        buffer.copy()
                    };
                    let mut out = out;
                    {
                        let o = out.get_mut().expect("own buffer");
                        o.set_pts(at);
                        o.set_dts(at);
                        // Without one the file's last frame would last no time at all.
                        o.set_duration(buffer.duration().or(frame));
                    }
                    // With the camera on, the compositor can hand out one frame of bare background
                    // before the screen arrives, stamped with the first real frame's time. That one
                    // is a keyframe too, so the black stand-in is dropped.
                    if leading {
                        match lead.take() {
                            None => {
                                lead = Some(out);
                                continue;
                            }
                            Some(first) => {
                                leading = false;
                                let replaced = first.pts() == Some(at) && !out.flags().contains(gst::BufferFlags::DELTA_UNIT);
                                if !replaced && !push(&src, &first, &mut pushed) {
                                    return;
                                }
                            }
                        }
                    }
                    if !push(&src, &out, &mut pushed) {
                        return;
                    }
                }
            }
            if let Some(first) = lead.take() {
                push(&src, &first, &mut pushed);
            }
            if cfg!(debug_assertions) {
                eprintln!("[recorder] {name}: {pulled} samples, {pushed} into the file");
            }
            let _ = src.emit_by_name::<gst::FlowReturn>("end-of-stream", &[]);
        })
        .expect("recorder bridge thread")
}

/// Builds and starts both pipelines.
fn launch(plan: &Plan, part: &Path) -> Result<Running, String> {
    let capture = parse(&pipeline::capture(plan))?;
    let mux = parse(&pipeline::mux(plan))?;
    let by = |p: &gst::Pipeline, n: &str| p.by_name(n).ok_or_else(|| format!("no {n}"));
    by(&mux, "file")?.set_property("location", part.to_string_lossy().to_string());
    if let Some(cam) = &plan.camera {
        let side = cam.size;
        if let Some(pad) = by(&capture, "bubble")?.static_pad("src") {
            pad.add_probe(gst::PadProbeType::BUFFER, move |_, info| {
                if let Some(gst::PadProbeData::Buffer(ref mut buffer)) = info.data {
                    round_bubble(buffer.make_mut(), side);
                }
                gst::PadProbeReturn::Ok
            });
        }
    }
    let stop = Arc::new(AtomicBool::new(false));
    let shifts = Arc::new(Mutex::new(Vec::new()));
    let origin = Arc::new(Mutex::new(None));
    let fail = |why: String| {
        stop.store(true, Ordering::Relaxed);
        let _ = capture.set_state(gst::State::Null);
        let _ = mux.set_state(gst::State::Null);
        let _ = std::fs::remove_file(part);
        why
    };
    if mux.set_state(gst::State::Playing).is_err() {
        return Err(fail(media::bus_error(&mux).unwrap_or_else(|| "The file couldn't be started.".into())));
    }
    if capture.set_state(gst::State::Playing).is_err() {
        return Err(fail(friendly(media::bus_error(&capture).unwrap_or_else(|| "The recording couldn't start.".into()))));
    }
    let mut bridges = vec![bridge("v", by(&capture, "v")?, by(&mux, "v")?, plan, origin.clone(), shifts.clone(), stop.clone())];
    if plan.has_audio() {
        bridges.push(bridge("a", by(&capture, "a")?, by(&mux, "a")?, plan, origin, shifts.clone(), stop.clone()));
    }
    let watch = match plan.screen {
        Screen::Rect { x, y, w, h } => Some((x, y, w, h)),
        Screen::Window { .. } => None,
    };
    Ok(Running {
        capture,
        mux,
        bridges,
        stop,
        shifts,
        paused_at: None,
        clock: PauseClock::default(),
        part: part.to_path_buf(),
        dest: PathBuf::new(),
        display: plan.display.clone(),
        watch,
        lost: Vec::new(),
    })
}

/// Reads the capture pipeline's errors. A microphone or speaker that went away ends only its own
/// branch (its source sends EOS; the mixer and the muxer carry on with the rest), so it's noted
/// and the recording goes on; anything else stops the recording.
fn check_bus(capture: &gst::Pipeline) -> (Vec<&'static str>, Option<String>) {
    let (mut lost, mut stop) = (Vec::new(), None);
    let Some(bus) = capture.bus() else { return (lost, stop) };
    while let Some(message) = bus.pop_filtered(&[gst::MessageType::Error]) {
        let gst::MessageView::Error(err) = message.view() else { continue };
        match message.src().and_then(|s| devices::lost_input(&s.path_string())) {
            Some(what) => lost.push(what),
            None => stop = Some(friendly(err.error().to_string())),
        }
    }
    (lost, stop)
}

/// "The microphone was disconnected at 1:05; the rest was recorded without it."
fn lost_note(lost: &[(&'static str, f64)]) -> Option<String> {
    let parts: Vec<String> = lost
        .iter()
        .map(|(what, at)| {
            let s = *at as u64;
            format!("{} was disconnected at {}:{:02}", if *what == "mic" { "The microphone" } else { "The speaker being recorded" }, s / 60, s % 60)
        })
        .collect();
    (!parts.is_empty()).then(|| format!("{}; the rest was recorded without it.", parts.join(", and ")))
}

/// GStreamer's errors in words a person can act on.
fn friendly(error: String) -> String {
    let lower = error.to_lowercase();
    if lower.contains("window") && (lower.contains("not") || lower.contains("bad")) {
        "The window being recorded closed.".into()
    } else if lower.contains("v4l2") || lower.contains("/dev/video") || lower.contains("device '/dev/video") {
        "The camera couldn't be opened. Another app may be using it.".into()
    } else if lower.contains("pulse") || lower.contains("audio") {
        format!("The sound couldn't be recorded ({error}). Try again without System sound or Microphone.")
    } else {
        error
    }
}

/// The capture pipeline's running time now.
fn running_time(p: &gst::Pipeline) -> Option<gst::ClockTime> {
    let clock = p.clock()?;
    clock.time()?.checked_sub(p.base_time()?)
}

/// Starts a recording: checks, the countdown (shown on the control bar), then the pipelines.
#[tauri::command]
pub async fn recorder_start(app: tauri::AppHandle, window: tauri::Window, spec: StartSpec) -> Result<(), String> {
    crate::ensure_unlocked()?;
    media::init()?;
    if wayland() {
        return Err("Screen recording needs an X11 session for now. On the login screen, pick “GNOME on Xorg”.".into());
    }
    if with_state(|s| s.status.phase != "idle" && s.status.phase != "") {
        return Err("A recording is already running.".into());
    }
    let dir = folder(&app, spec.folder.as_deref());
    if let Some(why) = files::space_problem(files::free_space(&dir)) {
        return Err(why);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("The Recordings folder couldn't be made: {e}"))?;
    let plan = { let app = app.clone(); let spec = spec.clone(); tauri::async_runtime::spawn_blocking(move || plan_for(&app, &spec)).await.map_err(|e| e.to_string())?? };
    let (y, mo, d, h, mi) = files::local_now();
    let dest = files::unique(&dir, &files::base_name(y, mo, d, h, mi), if plan.webm() { "webm" } else { "mp4" });
    let part = files::part_of(&dest);
    // Made here: Trim, Delete, Copy and Keep may act on it (a crash leaves the .part).
    remember(&part);
    remember(&dest);
    let origin = window.label().to_string();
    let generation = with_state(|s| {
        s.generation += 1;
        s.finished = None;
        s.status = Status { phase: "countdown", countdown: if spec.countdown { 3 } else { 0 }, mic: plan.mic.is_some(), hide_bar: spec.hide_bar, origin: origin.clone(), ..Default::default() };
        s.generation
    });
    open_bar(&app, &plan.screen, &plan.display);
    emit_status(&app);
    std::thread::spawn(move || {
        if spec.countdown {
            for n in (1..=3).rev() {
                with_state(|s| s.status.countdown = n);
                emit_status(&app);
                std::thread::sleep(Duration::from_secs(1));
                if with_state(|s| s.generation != generation || s.status.phase != "countdown") {
                    return;
                }
            }
        }
        match launch(&plan, &part) {
            Ok(mut running) => {
                running.dest = dest;
                running.clock.start_at(Instant::now());
                with_state(|s| {
                    s.running = Some(running);
                    s.status.phase = "recording";
                    s.status.countdown = 0;
                });
                emit_status(&app);
                tick(app, generation);
            }
            Err(why) => {
                with_state(|s| s.status = Status { phase: "idle", ..Default::default() });
                close_bar(&app);
                finish_event(&app, Finished { path: None, seconds: 0.0, bytes: 0, origin, discarded: true, error: Some(why) });
            }
        }
    });
    Ok(())
}

/// While recording: the timer, the free-space watch and errors from the capture pipeline.
fn tick(app: tauri::AppHandle, generation: u64) {
    std::thread::spawn(move || {
        let mut n = 0u32;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            n += 1;
            let mut stop_because: Option<String> = None;
            let alive = with_state(|s| {
                if s.generation != generation || s.running.is_none() {
                    return false;
                }
                let r = s.running.as_mut().expect("running");
                let elapsed = r.clock.elapsed_at(Instant::now()).as_secs_f64();
                s.status.elapsed = elapsed;
                let (lost, stop) = check_bus(&r.capture);
                for what in lost {
                    if !r.lost.iter().any(|(w, _)| *w == what) {
                        r.lost.push((what, elapsed));
                    }
                }
                stop_because = stop;
                // Every two seconds: is the screen being recorded still plugged in?
                if n % 8 == 0 && r.watch.is_some_and(|rect| devices::screen_gone(rect, &devices::monitors_from(x11::monitors(&r.display)))) {
                    stop_because = Some("The screen being recorded was disconnected, so the recording stopped there. It was saved.".into());
                }
                if n % 20 == 0 {
                    let free = r.dest.parent().and_then(files::free_space);
                    match free {
                        Some(b) if b < files::STOP_FREE => stop_because = Some("Recording stopped: the disk is almost full.".into()),
                        Some(b) if b < files::WARN_FREE => s.status.warning = Some(format!("Only {} left on the disk", files::human(b))),
                        _ => s.status.warning = None,
                    }
                }
                true
            });
            if !alive {
                return;
            }
            if let Some(why) = stop_because {
                finish(&app, false, Some(why));
                return;
            }
            emit_status(&app);
        }
    });
}

#[tauri::command]
pub fn recorder_pause(app: tauri::AppHandle) -> Result<(), String> {
    with_state(|s| {
        let r = s.running.as_mut().ok_or("Nothing is being recorded.")?;
        pause(r);
        s.status.phase = "paused";
        Ok::<(), String>(())
    })?;
    emit_status(&app);
    Ok(())
}

#[tauri::command]
pub fn recorder_resume(app: tauri::AppHandle) -> Result<(), String> {
    with_state(|s| {
        let r = s.running.as_mut().ok_or("Nothing is being recorded.")?;
        resume(r);
        s.status.phase = "recording";
        Ok::<(), String>(())
    })?;
    emit_status(&app);
    Ok(())
}

#[tauri::command]
pub fn recorder_mute(app: tauri::AppHandle, muted: bool) -> Result<(), String> {
    with_state(|s| {
        if let Some(vol) = s.running.as_ref().and_then(|r| r.capture.by_name("micvol")) {
            vol.set_property("mute", muted);
        }
        s.status.muted = muted;
    });
    emit_status(&app);
    Ok(())
}

/// Stops and keeps the recording (the review opens where it was started).
#[tauri::command]
pub fn recorder_stop(app: tauri::AppHandle) {
    finish(&app, false, None);
}

/// Stops and throws the recording away (also cancels the countdown).
#[tauri::command]
pub fn recorder_discard(app: tauri::AppHandle) {
    finish(&app, true, None);
}

fn finish(app: &tauri::AppHandle, discard: bool, error: Option<String>) {
    let (running, origin) = with_state(|s| {
        let running = s.running.take();
        let origin = s.status.origin.clone();
        if s.status.phase == "countdown" {
            s.generation += 1;
        }
        s.status = Status { phase: if running.is_some() { "finishing" } else { "idle" }, origin: origin.clone(), ..Default::default() };
        (running, origin)
    });
    emit_status(app);
    close_bar(app);
    let Some(mut r) = running else {
        with_state(|s| s.status.phase = "idle");
        emit_status(app);
        // Stopped in the countdown: nothing was recorded; the window that started it comes back.
        finish_event(app, Finished { path: None, seconds: 0.0, bytes: 0, origin, discarded: true, error });
        return;
    };
    // A microphone or speaker that went away is said after, with when.
    let error = error.or_else(|| lost_note(&r.lost));
    let app = app.clone();
    std::thread::spawn(move || {
        let seconds = r.clock.elapsed_at(Instant::now()).as_secs_f64();
        end(&mut r);
        let result = if discard {
            let _ = std::fs::remove_file(&r.part);
            Finished { path: None, seconds, bytes: 0, origin: origin.clone(), discarded: true, error: error.clone() }
        } else {
            match std::fs::rename(&r.part, &r.dest) {
                Ok(()) => Finished {
                    path: Some(r.dest.to_string_lossy().into_owned()),
                    seconds,
                    bytes: std::fs::metadata(&r.dest).map_or(0, |m| m.len()),
                    origin: origin.clone(),
                    discarded: false,
                    error: error.clone(),
                },
                Err(e) => Finished { path: None, seconds, bytes: 0, origin: origin.clone(), discarded: false, error: Some(format!("The recording couldn't be saved: {e}")) },
            }
        };
        with_state(|s| s.status = Status { phase: "idle", ..Default::default() });
        emit_status(&app);
        finish_event(&app, result);
    });
}

/// Ends both pipelines and finishes the file.
fn end(r: &mut Running) {
    // A paused pipeline doesn't pass EOS on; it plays for the moment it takes to end.
    if r.paused_at.is_some() {
        let _ = r.capture.set_state(gst::State::Playing);
    }
    r.stop.store(true, Ordering::Relaxed);
    r.capture.send_event(gst::event::Eos::new());
    for t in r.bridges.drain(..) {
        let _ = t.join();
    }
    let _ = r.capture.set_state(gst::State::Null);
    // The muxer finishes the file once both streams have ended.
    if let Some(bus) = r.mux.bus() {
        let _ = bus.timed_pop_filtered(gst::ClockTime::from_seconds(15), &[gst::MessageType::Eos, gst::MessageType::Error]);
    }
    let _ = r.mux.set_state(gst::State::Null);
}

/// Pauses the capture pipeline (see `recorder_pause`).
fn pause(r: &mut Running) {
    if r.paused_at.is_some() {
        return;
    }
    r.paused_at = running_time(&r.capture);
    let _ = r.capture.set_state(gst::State::Paused);
    r.clock.pause_at(Instant::now());
}

/// Resumes it; whatever time its clock didn't hold still is taken off what comes next.
fn resume(r: &mut Running) {
    let Some(paused_at) = r.paused_at.take() else { return };
    let _ = r.capture.set_state(gst::State::Playing);
    let _ = r.capture.state(gst::ClockTime::from_mseconds(500));
    if let Some(now) = running_time(&r.capture) {
        if let Some(gap) = now.checked_sub(paused_at).filter(|g| *g > gst::ClockTime::from_mseconds(40)) {
            lock(&r.shifts).push(Shift { from: now, by: gap });
        }
    }
    r.clock.start_at(Instant::now());
}

/// Recordings Zazabor made (also before a restart): the only files Trim, Delete, Copy and Keep
/// act on, whatever path the page sends. Kept in `recorder/known.json` in the app's data folder.
static KNOWN: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());
static KNOWN_FILE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
/// The newest this many are kept (older ones can still be handled in Files).
const KNOWN_MAX: usize = 2000;

/// Reads the list of recordings made before; called once at start.
pub fn init(data_dir: &Path) {
    let file = data_dir.join("recorder").join("known.json");
    if let Ok(list) = std::fs::read(&file).map_err(|_| ()).and_then(|b| serde_json::from_slice::<Vec<PathBuf>>(&b).map_err(|_| ())) {
        *KNOWN.lock().unwrap_or_else(|e| e.into_inner()) = list;
    }
    let _ = KNOWN_FILE.set(file);
}

fn remember(path: &Path) {
    let mut known = KNOWN.lock().unwrap_or_else(|e| e.into_inner());
    if known.iter().any(|p| p == path) {
        return;
    }
    known.push(path.to_path_buf());
    if known.len() > KNOWN_MAX {
        let extra = known.len() - KNOWN_MAX;
        known.drain(..extra);
    }
    if let (Some(file), Ok(bytes)) = (KNOWN_FILE.get(), serde_json::to_vec(&*known)) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = crate::fs::text::write_bytes(file, &bytes);
    }
}

fn is_known(path: &Path) -> bool {
    KNOWN.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|p| p == path)
}

/// Tells the windows a recording ended, and brings back the one that started it.
fn finish_event(app: &tauri::AppHandle, done: Finished) {
    if let Some(path) = &done.path {
        remember(Path::new(path));
    }
    let origin = app.get_webview_window(&done.origin);
    match &origin {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        None => {
            // The window that started it is gone: the recorder window shows the review.
            let mut done = done.clone();
            done.origin = WINDOW.into();
            with_state(|s| s.finished = Some(done));
            let _ = show_window(app);
            let _ = app.emit("recorder-finished", with_state(|s| s.finished.clone()));
            return;
        }
    }
    with_state(|s| s.finished = Some(done.clone()));
    let _ = app.emit("recorder-finished", Some(done));
}

// ---- windows ---------------------------------------------------------------------------------

fn window_json(module: &str, path: Option<String>) -> String {
    serde_json::json!({ "module": module, "path": path }).to_string()
}

/// The recorder window (`zazabor --record`): made once, then shown again.
pub fn show_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(app, WINDOW, tauri::WebviewUrl::App("index.html".into()))
        .title("Screen Recorder")
        .inner_size(460.0, 720.0)
        .min_inner_size(400.0, 560.0)
        .center()
        .focused(true)
        .background_color(tauri::webview::Color(0x1c, 0x1d, 0x21, 0xff))
        .initialization_script(format!("window.__ZAZABOR_WINDOW__ = {};", window_json("recorder", None)))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `zazabor --record` (or its shortcut): stops a recording that's running, else shows the recorder.
pub fn toggle(app: &tauri::AppHandle) {
    let phase = with_state(|s| s.status.phase);
    match phase {
        "recording" | "paused" => finish(app, false, None),
        "countdown" => finish(app, true, None),
        "finishing" => {}
        _ => {
            if let Err(err) = show_window(app) {
                eprintln!("Could not open the screen recorder: {err}");
            }
        }
    }
}

/// The floating control bar: bottom centre of what's recorded (below an area when there's room).
fn open_bar(app: &tauri::AppHandle, screen: &Screen, display: &str) {
    let (bw, bh) = BAR_SIZE;
    let monitor_of = |x: i32, y: i32| {
        monitors(app).into_iter().find(|m| x >= m.x && y >= m.y && x < m.x + m.width as i32 && y < m.y + m.height as i32).or_else(|| monitors(app).into_iter().next())
    };
    let (x, y) = match screen {
        Screen::Rect { x, y, w, h } => {
            let m = monitor_of(*x + *w as i32 / 2, *y + *h as i32 / 2);
            let (mx, my, mw, mh) = m.map_or((0, 0, 1920, 1080), |m| (m.x, m.y, m.width as i32, m.height as i32));
            let cx = (*x + *w as i32 / 2) as f64 - bw / 2.0;
            let below = (*y + *h as i32) as f64 + 12.0;
            let whole = *w as i32 >= mw - 8 && *h as i32 >= mh - 8;
            let y = if !whole && below + bh < (my + mh) as f64 - 8.0 { below } else { (my + mh) as f64 - bh - 28.0 };
            (cx.clamp(mx as f64 + 8.0, (mx + mw) as f64 - bw - 8.0), y)
        }
        Screen::Window { xid } => {
            let (wx, wy, ww, wh) = x11::window_rect(display, *xid).unwrap_or((0, 0, 1920, 1080));
            let m = monitor_of(wx + ww as i32 / 2, wy + wh as i32 / 2);
            let (mx, my, mw, mh) = m.map_or((0, 0, 1920, 1080), |m| (m.x, m.y, m.width as i32, m.height as i32));
            (mx as f64 + (mw as f64 - bw) / 2.0, (my + mh) as f64 - bh - 28.0)
        }
    };
    if let Some(w) = app.get_webview_window(BAR_WINDOW) {
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        let _ = w.show();
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(app, BAR_WINDOW, tauri::WebviewUrl::App("index.html".into()))
        .title("Recording")
        .inner_size(bw, bh)
        .min_inner_size(bw, bh)
        .max_inner_size(bw, bh)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .transparent(true)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .initialization_script(format!("window.__ZAZABOR_WINDOW__ = {};", window_json("recorder-pill", None)))
        .build();
    match built {
        Ok(w) => {
            // The web view asks for 200 pixels of height by default; the bar is a thin strip.
            let _ = w.with_webview(move |view| {
                use gtk::prelude::WidgetExt;
                view.inner().set_size_request(bw as i32, bh as i32);
            });
            let _ = w.set_size(tauri::LogicalSize::new(bw, bh));
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
        Err(err) => eprintln!("Could not open the recording bar: {err}"),
    }
}

fn close_bar(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(BAR_WINDOW) {
        let _ = w.destroy();
    }
}

static AREA_ORIGIN: Mutex<String> = Mutex::new(String::new());

/// The area picker: a still of the monitor, full screen, to drag a rectangle on.
#[tauri::command]
pub async fn recorder_pick_area(app: tauri::AppHandle, window: tauri::Window, monitor: usize) -> Result<(), String> {
    crate::ensure_unlocked()?;
    media::init()?;
    let all = monitors(&app);
    let m = all.get(monitor).or_else(|| all.first()).ok_or("No screen was found.")?.clone();
    // The still first: once the picker's window is up it would be in the picture.
    let (x, y, w, h) = (m.x, m.y, m.width, m.height);
    let still = tauri::async_runtime::spawn_blocking(move || grab_still(x, y, w, h)).await.map_err(|e| e.to_string())?;
    *lock(&STILL) = still.ok();
    *lock(&AREA_ORIGIN) = window.label().to_string();
    if let Some(w) = app.get_webview_window(AREA_WINDOW) {
        let _ = w.destroy();
    }
    let start = serde_json::json!({ "x": m.x, "y": m.y, "width": m.width, "height": m.height }).to_string();
    let w = tauri::WebviewWindowBuilder::new(&app, AREA_WINDOW, tauri::WebviewUrl::App("index.html".into()))
        .title("Choose an area")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(true)
        .inner_size(m.width as f64, m.height as f64)
        .background_color(tauri::webview::Color(0, 0, 0, 0xff))
        .initialization_script(format!("window.__ZAZABOR_WINDOW__ = {};", window_json("recorder-area", Some(start))))
        .build()
        .map_err(|e| e.to_string())?;
    let _ = w.set_position(tauri::PhysicalPosition::new(m.x, m.y));
    let _ = w.set_size(tauri::PhysicalSize::new(m.width, m.height));
    let _ = w.set_fullscreen(true);
    Ok(())
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

static WATCH_GEN: AtomicU64 = AtomicU64::new(0);

/// While the recorder page is open: "recorder-devices" whenever a screen, microphone, speaker or
/// camera comes or goes, so the page lists them again.
#[tauri::command]
pub fn recorder_watch(app: tauri::AppHandle) -> Result<(), String> {
    crate::ensure_unlocked()?;
    media::init()?;
    let generation = WATCH_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    std::thread::Builder::new()
        .name("recorder-devices".into())
        .spawn(move || devices::watch(display(), || WATCH_GEN.load(Ordering::Relaxed) == generation, || drop(app.emit("recorder-devices", ()))))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn recorder_unwatch() {
    WATCH_GEN.fetch_add(1, Ordering::Relaxed);
}

/// The area picker finished: the area (in screen pixels), or None when cancelled.
#[tauri::command]
pub fn recorder_area_done(app: tauri::AppHandle, area: Option<Area>) {
    let origin = lock(&AREA_ORIGIN).clone();
    if let Some(w) = app.get_webview_window(AREA_WINDOW) {
        let _ = w.destroy();
    }
    if let Some(w) = app.get_webview_window(&origin) {
        let _ = w.set_focus();
    }
    let _ = app.emit_to(origin.as_str(), "recorder-area", area);
}

// ---- recordings -------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub mtime: f64,
    /// Left by Zazabor stopping mid-recording: still playable; Keep gives it its name.
    pub recovered: bool,
}

#[tauri::command]
pub async fn recorder_list(app: tauri::AppHandle, folder_path: Option<String>) -> Result<Vec<Recording>, String> {
    crate::ensure_unlocked()?;
    let dir = folder(&app, folder_path.as_deref());
    let active = with_state(|s| s.running.as_ref().map(|r| r.part.clone()));
    Ok(files::list(&dir, active.as_deref())
        .into_iter()
        .map(|(path, recovered, bytes, mtime)| {
            let shown = if recovered { files::final_of(&path).unwrap_or(path.clone()) } else { path.clone() };
            Recording {
                name: shown.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                path: path.to_string_lossy().into_owned(),
                bytes,
                mtime,
                recovered,
            }
        })
        .collect())
}

/// Gives a recording left by a crash its name back.
#[tauri::command]
pub fn recorder_keep(path: String) -> Result<String, String> {
    crate::ensure_unlocked()?;
    let part = PathBuf::from(&path);
    if !is_known(&part) {
        return Err("That isn't one of your recordings.".into());
    }
    let wanted = files::final_of(&part).ok_or("That isn't a recording.")?;
    let ext = wanted.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "mp4".into());
    let stem = wanted.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Recording".into());
    let dest = files::unique(wanted.parent().unwrap_or(Path::new(".")), &stem, &ext);
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    remember(&dest);
    Ok(dest.to_string_lossy().into_owned())
}

fn is_recording_file(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let ext = if name.ends_with(".part") { files::final_of(path).and_then(|f| f.extension().map(|e| e.to_string_lossy().to_lowercase())) } else { path.extension().map(|e| e.to_string_lossy().to_lowercase()) };
    ext.is_some_and(|e| files::EXTENSIONS.contains(&e.as_str()))
}

/// Deletes a recording (only video files: this isn't a general delete).
#[tauri::command]
pub fn recorder_delete(path: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let p = PathBuf::from(&path);
    if !is_recording_file(&p) || !is_known(&p) {
        return Err("Only recordings can be deleted here.".into());
    }
    std::fs::remove_file(&p).map_err(|e| e.to_string())
}

/// Puts a recording on the clipboard as a file, so Files, chats and mail paste it as one.
#[tauri::command]
pub fn recorder_copy_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let p = PathBuf::from(&path);
    if !is_recording_file(&p) || !is_known(&p) || !p.is_file() {
        return Err("That recording isn't there any more.".into());
    }
    let uri = media::uri(&path)?;
    app.run_on_main_thread(move || {
        let cb = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
        let flags = gtk::TargetFlags::empty();
        let targets = [
            gtk::TargetEntry::new("x-special/gnome-copied-files", flags, 0),
            gtk::TargetEntry::new("text/uri-list", flags, 1),
            gtk::TargetEntry::new("UTF8_STRING", flags, 2),
            gtk::TargetEntry::new("text/plain;charset=utf-8", flags, 2),
        ];
        cb.set_with_data(&targets, move |_, data, info| match info {
            0 => data.set(&gtk::gdk::Atom::intern("x-special/gnome-copied-files"), 8, format!("copy\n{uri}").as_bytes()),
            1 => {
                data.set_uris(&[uri.as_str()]);
            }
            _ => {
                data.set_text(&path);
            }
        });
    })
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trimmed {
    pub path: String,
    pub bytes: u64,
}

/// Cuts a recording to `start`…`end` seconds in place, without encoding again.
#[tauri::command]
pub async fn recorder_trim(path: String, start: f64, end: f64) -> Result<Trimmed, String> {
    crate::ensure_unlocked()?;
    media::init()?;
    let src = PathBuf::from(&path);
    if !is_recording_file(&src) || !is_known(&src) || !src.is_file() {
        return Err("That recording isn't there any more.".into());
    }
    if !(end - start > 0.3) {
        return Err("Keep at least a moment of the recording.".into());
    }
    tauri::async_runtime::spawn_blocking(move || trim_file(&src, start.max(0.0), end)).await.map_err(|e| e.to_string())?
}

fn trim_file(src: &Path, start: f64, end: f64) -> Result<Trimmed, String> {
    let webm = src.extension().is_some_and(|e| e.eq_ignore_ascii_case("webm") || e.eq_ignore_ascii_case("mkv"));
    let probe = media::probe(&src.to_string_lossy())?;
    let tmp = src.with_file_name(format!(".{}.trim", src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
    let pipeline = parse(&pipeline::trim(webm, probe.audio.is_some()))?;
    pipeline.by_name("src").ok_or("no src")?.set_property("location", src.to_string_lossy().to_string());
    pipeline.by_name("file").ok_or("no file")?.set_property("location", tmp.to_string_lossy().to_string());
    // The streams are held before the muxer until the seek: a muxer that already started on the
    // file's beginning writes a second header after it and the file comes out broken.
    let go = Arc::new(AtomicBool::new(false));
    let held = Arc::new(AtomicU64::new(0));
    // A recording's fragments don't start on keyframes, so the seek lands a little before the
    // keyframe: the video is cut to start on it, and the sound from the same moment.
    let first_key = Arc::new(AtomicU64::new(u64::MAX));
    let queues: Vec<&str> = if probe.audio.is_some() { vec!["qv", "qa"] } else { vec!["qv"] };
    for name in &queues {
        let pad = pipeline.by_name(name).and_then(|q| q.static_pad("sink")).ok_or("no queue")?;
        let (go, held) = (go.clone(), held.clone());
        let counted = AtomicBool::new(false);
        pad.add_probe(gst::PadProbeType::BLOCK | gst::PadProbeType::BUFFER | gst::PadProbeType::BUFFER_LIST, move |_, _| {
            if go.load(Ordering::SeqCst) {
                return gst::PadProbeReturn::Remove;
            }
            if !counted.swap(true, Ordering::SeqCst) {
                held.fetch_add(1, Ordering::SeqCst);
            }
            gst::PadProbeReturn::Ok
        });
    }
    // Past the queues (the seek has flushed them), the video starts on its first keyframe...
    let video_out = pipeline.by_name("qv").and_then(|q| q.static_pad("src")).ok_or("no queue")?;
    let key = first_key.clone();
    video_out.add_probe(gst::PadProbeType::BUFFER, move |pad, info| {
        let Some(b) = info.buffer() else { return gst::PadProbeReturn::Pass };
        // A fragmented recording is resumed from its fragment's start, before the cut, and the
        // muxer clips whatever comes before it: the first keyframe that counts is inside it. The
        // recording's own keyframe flags aren't trusted here: an H.264 keyframe holds an IDR.
        let inside = b.pts().is_some_and(|pts| {
            pad.sticky_event::<gst::event::Segment>(0).is_some_and(|e| e.segment().downcast_ref::<gst::ClockTime>().is_some_and(|s| s.to_running_time(pts).is_some()))
        });
        let key_frame = if webm { !b.flags().contains(gst::BufferFlags::DELTA_UNIT) } else { b.map_readable().is_ok_and(|m| has_idr(m.as_slice())) };
        if !(inside && key_frame) {
            return gst::PadProbeReturn::Drop;
        }
        key.store(b.pts().map_or(0, |t| t.nseconds()), Ordering::SeqCst);
        gst::PadProbeReturn::Remove
    });
    // ...and the sound waits for it on its own queue's thread (the demuxer's keeps going).
    if let Some(pad) = pipeline.by_name("qa").and_then(|q| q.static_pad("src")) {
        let first_key = first_key.clone();
        pad.add_probe(gst::PadProbeType::BUFFER, move |_, info| {
            let Some(pts) = info.buffer().and_then(|b| b.pts()) else { return gst::PadProbeReturn::Pass };
            let deadline = Instant::now() + Duration::from_secs(10);
            while first_key.load(Ordering::SeqCst) == u64::MAX && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            let key = first_key.load(Ordering::SeqCst);
            if key != u64::MAX && pts.nseconds() < key {
                gst::PadProbeReturn::Drop
            } else {
                gst::PadProbeReturn::Remove
            }
        });
    }
    let fail = |why: String| {
        let _ = pipeline.set_state(gst::State::Null);
        let _ = std::fs::remove_file(&tmp);
        why
    };
    let _ = pipeline.set_state(gst::State::Paused);
    let deadline = Instant::now() + Duration::from_secs(10);
    // The demuxer feeds every stream from one thread: once one is held, nothing moves.
    while held.load(Ordering::SeqCst) == 0 {
        if let Some(why) = media::bus_error(&pipeline) {
            return Err(fail(why));
        }
        if Instant::now() > deadline {
            return Err(fail("The recording couldn't be read.".into()));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    go.store(true, Ordering::SeqCst);
    let ns = |s: f64| gst::ClockTime::from_nseconds((s * 1e9) as u64);
    let flags = gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT | gst::SeekFlags::SNAP_AFTER;
    // Straight to the demuxer: the muxer's own segment is in bytes.
    let seek = gst::event::Seek::new(1.0, flags, gst::SeekType::Set, ns(start), gst::SeekType::Set, ns(end));
    if !pipeline.by_name("d").is_some_and(|d| d.send_event(seek)) {
        return Err(fail("The recording couldn't be cut there.".into()));
    }
    let _ = pipeline.set_state(gst::State::Playing);
    let bus = pipeline.bus().ok_or("no bus")?;
    let done = bus.timed_pop_filtered(gst::ClockTime::from_seconds(600), &[gst::MessageType::Eos, gst::MessageType::Error]);
    if !matches!(done.as_ref().map(|m| m.view()), Some(gst::MessageView::Eos(_))) {
        let why = media::bus_error(&pipeline).unwrap_or_else(|| "Cutting the recording failed.".into());
        return Err(fail(why));
    }
    let _ = pipeline.set_state(gst::State::Null);
    std::fs::rename(&tmp, src).map_err(|e| e.to_string())?;
    Ok(Trimmed { path: src.to_string_lossy().into_owned(), bytes: std::fs::metadata(src).map_or(0, |m| m.len()) })
}

/// Whether an H.264 sample (4-byte length-prefixed NAL units, as recordings store them) holds an
/// IDR slice: a picture that needs no other.
fn has_idr(data: &[u8]) -> bool {
    let mut at = 0;
    while at + 4 < data.len() {
        let len = u32::from_be_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]) as usize;
        if data[at + 4] & 0x1f == 5 {
            return true;
        }
        at += 4 + len;
    }
    false
}

// ---- the microphone meter ---------------------------------------------------------------------

static METER: Mutex<Option<(gst::Pipeline, u64)>> = Mutex::new(None);
static METER_GEN: AtomicU64 = AtomicU64::new(0);

/// Listens to a microphone and sends its level ("recorder-level", dB) ten times a second.
#[tauri::command]
pub fn recorder_meter_start(app: tauri::AppHandle, mic_id: Option<String>) -> Result<(), String> {
    crate::ensure_unlocked()?;
    media::init()?;
    recorder_meter_stop();
    let source = if test_sources() {
        "audiotestsrc is-live=true wave=sine freq=880 volume=0.25".to_string()
    } else {
        let id = mic_id.filter(|m| !m.is_empty()).unwrap_or_else(|| "@DEFAULT_SOURCE@".into());
        format!("pulsesrc device=\"{}\"", id.replace('"', ""))
    };
    let pipeline = parse(&format!("{source} ! audioconvert ! level interval=100000000 post-messages=true ! fakesink sync=false"))?;
    pipeline.set_state(gst::State::Playing).map_err(|_| media::bus_error(&pipeline).unwrap_or_else(|| "The microphone couldn't be opened.".into()))?;
    let generation = METER_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    let bus = pipeline.bus().ok_or("no bus")?;
    *lock(&METER) = Some((pipeline, generation));
    std::thread::spawn(move || {
        while METER_GEN.load(Ordering::Relaxed) == generation {
            let Some(message) = bus.timed_pop(gst::ClockTime::from_mseconds(200)) else { continue };
            if let gst::MessageView::Element(e) = message.view() {
                if let Some(s) = e.structure().filter(|s| s.name() == "level") {
                    if let Ok(list) = s.get::<gst::glib::ValueArray>("rms") {
                        let db = list.iter().filter_map(|v| v.get::<f64>().ok()).fold(f64::NEG_INFINITY, f64::max);
                        let _ = app.emit("recorder-level", db.max(-90.0));
                    }
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn recorder_meter_stop() {
    METER_GEN.fetch_add(1, Ordering::Relaxed);
    if let Some((pipeline, _)) = lock(&METER).take() {
        let _ = pipeline.set_state(gst::State::Null);
    }
}

// ---- the desktop shortcut ---------------------------------------------------------------------

#[tauri::command]
pub fn recorder_shortcut() -> crate::notes::quick::Shortcut {
    crate::notes::quick::shortcut_status(&crate::notes::quick::RECORD)
}

#[tauri::command]
pub fn recorder_set_shortcut(binding: Option<String>) -> Result<crate::notes::quick::Shortcut, String> {
    crate::notes::quick::set_shortcut(&crate::notes::quick::RECORD, binding)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(secs: u64) -> gst::ClockTime {
        gst::ClockTime::from_seconds(secs)
    }

    #[test]
    fn timestamps_start_at_the_first_frame_and_leave_pauses_out() {
        // Recording started at 2 s of running time; paused from 10 s to 25 s, and the clock kept
        // running through that pause (15 s are taken off what came after).
        let shifts = [Shift { from: s(25), by: s(15) }];
        assert_eq!(place(s(2), s(2), &shifts), Some(s(0)));
        assert_eq!(place(s(9), s(2), &shifts), Some(s(7)));
        assert_eq!(place(s(25), s(2), &shifts), Some(s(8)));
        assert_eq!(place(s(30), s(2), &shifts), Some(s(13)));
        // Before the first frame: dropped.
        assert_eq!(place(s(1), s(2), &shifts), None);
        // Two pauses add up.
        let two = [Shift { from: s(25), by: s(15) }, Shift { from: s(40), by: s(5) }];
        assert_eq!(place(s(41), s(2), &two), Some(s(19)));
        // A clock that held still through the pause leaves nothing to take off.
        assert_eq!(place(s(30), s(2), &[]), Some(s(28)));
    }

    #[test]
    fn the_bubble_is_a_circle() {
        gst::init().unwrap();
        let side = 8u32;
        let mut buffer = gst::Buffer::from_mut_slice(vec![255u8; (side * side * 4) as usize]);
        round_bubble(buffer.get_mut().unwrap(), side);
        let map = buffer.map_readable().unwrap();
        let alpha = |x: usize, y: usize| map[(y * side as usize + x) * 4 + 3];
        assert_eq!(alpha(0, 0), 0, "corners are cut");
        assert_eq!(alpha(4, 4), 255, "the middle stays");
        assert_eq!(map[0], 255, "colour isn't touched");
    }

    #[test]
    fn requests_parse_from_the_page() {
        let spec: StartSpec = serde_json::from_value(serde_json::json!({
            "target": { "kind": "area", "x": 10, "y": 20, "width": 640, "height": 360 },
            "systemSound": true, "mic": false, "micId": null, "camera": "bottom-right",
            "quality": "standard", "format": "mp4", "countdown": true, "hideBar": false, "folder": null
        }))
        .unwrap();
        assert!(matches!(spec.target, Target::Area { x: 10, y: 20, width: 640, height: 360 }));
        let w: Target = serde_json::from_value(serde_json::json!({ "kind": "window", "xid": 58720257u64 })).unwrap();
        assert!(matches!(w, Target::Window { xid: 58720257 }));
        assert!(matches!(serde_json::from_value(serde_json::json!({ "kind": "all" })).unwrap(), Target::All));
        assert!(spec.output_id.is_none() && spec.camera_id.is_none(), "older pages leave them out");
    }

    #[test]
    fn keyframes_are_found_by_their_idr_slice() {
        let unit = |kind: u8, len: usize| {
            let mut v = (len as u32 + 1).to_be_bytes().to_vec();
            v.push(0x60 | kind);
            v.extend(std::iter::repeat_n(0xAB, len));
            v
        };
        assert!(has_idr(&[unit(6, 9), unit(5, 40)].concat()), "SEI then IDR");
        assert!(!has_idr(&unit(1, 40)), "a P slice");
        assert!(!has_idr(&[]));
    }

    #[test]
    fn a_lost_microphone_is_noted_and_the_recording_goes_on() {
        media::init().unwrap();
        let p = parse("audiotestsrc name=sys ! audiomixer name=mix ! fakesink  audiotestsrc name=mic ! mix.").unwrap();
        let _ = p.set_state(gst::State::Ready);
        let error = |name: &str| {
            let e = p.by_name(name).unwrap();
            let _ = e.post_message(gst::message::Error::builder(gst::ResourceError::NotFound, "The device went away").src(&e).build());
        };
        error("mic");
        assert_eq!(check_bus(&p), (vec!["mic"], None));
        error("sys");
        error("mix");
        let (lost, stop) = check_bus(&p);
        assert_eq!(lost, vec!["system"]);
        assert!(stop.is_some(), "anything else stops the recording");
        let _ = p.set_state(gst::State::Null);
        assert_eq!(lost_note(&[("mic", 65.4)]).as_deref(), Some("The microphone was disconnected at 1:05; the rest was recorded without it."));
        assert_eq!(lost_note(&[]), None);
    }

    /// A real recording of a nested display with test tones: `ZAZABOR_RECORDER_LIVE=:20` and
    /// `ZAZABOR_RECORDER_OUT=/path/file.mp4` (never the real display: it's an explicit choice).
    #[test]
    #[ignore]
    fn live_recording_with_a_pause() {
        let (Ok(display), Ok(out)) = (std::env::var("ZAZABOR_RECORDER_LIVE"), std::env::var("ZAZABOR_RECORDER_OUT")) else { return };
        media::init().unwrap();
        let webm = out.ends_with(".webm");
        // ZAZABOR_RECORDER_WINDOW=xid,width,height records that window instead of the screen.
        let window: Option<Vec<u32>> = std::env::var("ZAZABOR_RECORDER_WINDOW").ok().map(|w| w.split(',').filter_map(|n| n.parse().ok()).collect());
        let (screen, size) = match window.as_deref() {
            Some(&[xid, w, h]) => (Screen::Window { xid: xid as u64 }, (w, h)),
            _ => (Screen::Rect { x: 0, y: 0, w: 1920, h: 1080 }, (1920, 1080)),
        };
        let side = size.0.min(size.1) / 4;
        let plan = Plan {
            display,
            screen,
            size,
            fps: 30,
            camera: std::env::var_os("ZAZABOR_RECORDER_CAMERA").map(|_| Camera { source: CameraSource::Test, size: side, x: (size.0 - side - 8) as i32, y: (size.1 - side - 8) as i32 }),
            system: Some(Sound::Test(440)),
            mic: Some(Sound::Test(880)),
            video: if webm { VideoCodec::Vp9 { cq: 32 } } else { VideoCodec::Vaapi { qp: 24 } },
            audio: if webm { AudioCodec::Opus } else { AudioCodec::Mp3 },
        };
        let part = PathBuf::from(&out);
        let mut r = launch(&plan, &part).unwrap();
        r.clock.start_at(Instant::now());
        std::thread::sleep(Duration::from_secs(1));
        eprintln!("capture {:?} mux {:?} error {:?}", r.capture.state(gst::ClockTime::ZERO), r.mux.state(gst::ClockTime::ZERO), media::bus_error(&r.capture));
        std::thread::sleep(Duration::from_secs(2));
        pause(&mut r);
        std::thread::sleep(Duration::from_secs(3));
        resume(&mut r);
        std::thread::sleep(Duration::from_secs(1));
        // The microphone goes away: its source reports an error and ends; the rest goes on.
        let mic = r.capture.by_name("mic").unwrap();
        let _ = mic.post_message(gst::message::Error::builder(gst::ResourceError::NotFound, "The device went away").src(&mic).build());
        mic.send_event(gst::event::Eos::new());
        std::thread::sleep(Duration::from_secs(2));
        assert_eq!(check_bus(&r.capture), (vec!["mic"], None), "a lost microphone doesn't stop the recording");
        let t0 = Instant::now();
        end(&mut r);
        eprintln!("ended in {:?}, recorded {:?}, shifts {:?}", t0.elapsed(), r.clock.elapsed_at(Instant::now()), lock(&r.shifts));
        let probe = media::probe(&out).unwrap();
        eprintln!("duration {:.2} s, {} bytes, video {:?}, audio {:?}", probe.duration, probe.bytes, probe.video.is_some(), probe.audio.is_some());
        assert!((5.0..7.5).contains(&probe.duration), "a 6 s recording with a 3 s pause: {}", probe.duration);
        // Cut 1 s to 4 s out of it: no encoding, starting on the first keyframe from 1 s.
        let cut = trim_file(&part, 1.0, 4.0).unwrap();
        let trimmed = media::probe(&out).unwrap();
        eprintln!("trimmed: {:.2} s, {} bytes", trimmed.duration, cut.bytes);
        assert!((2.8..3.3).contains(&trimmed.duration), "kept 3 s: {}", trimmed.duration);
        // It starts on a keyframe: the first sample is one.
        let first = gst::parse_launch(&format!("filesrc location=\"{out}\" ! qtdemux name=d d.video_0 ! queue ! appsink name=s sync=false d.audio_0 ! queue ! fakesink sync=false")).unwrap().downcast::<gst::Pipeline>().unwrap();
        let _ = first.set_state(gst::State::Playing);
        let sample = first.by_name("s").unwrap().emit_by_name::<Option<gst::Sample>>("try-pull-sample", &[&(5 * gst::ClockTime::SECOND.nseconds())]).unwrap();
        let _ = first.set_state(gst::State::Null);
        assert!(!sample.buffer().unwrap().flags().contains(gst::BufferFlags::DELTA_UNIT), "the cut starts on a keyframe");
        assert!(trimmed.video.is_some() && trimmed.audio.is_some());
    }

    #[test]
    fn only_recordings_can_be_deleted() {
        assert!(is_recording_file(Path::new("/r/Recording 2026-10-27 15.30.mp4")));
        assert!(is_recording_file(Path::new("/r/.Recording 2026-10-27 15.30.webm.part")));
        assert!(!is_recording_file(Path::new("/home/me/.bashrc")));
        assert!(!is_recording_file(Path::new("/r/notes.part")));
    }
}
