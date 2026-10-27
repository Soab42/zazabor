//! The GStreamer descriptions a recording runs. The capture pipeline grabs the screen (and the
//! camera bubble and the sound), encodes them and ends in two appsinks, `v` and `a`; the muxer
//! pipeline takes them back through appsrcs into an MP4 or WebM file. They're two pipelines for
//! the same reason as the Video Editor's export: VA-API writes H.264 as a byte-stream that
//! `mp4mux` can't take, and the parser that converts it (`h264parse`) isn't installed here, so the
//! bridge between them converts each access unit (`videoedit::h264`).

use serde::Serialize;

/// What part of the screen is recorded.
#[derive(Clone, Debug, PartialEq)]
pub enum Screen {
    /// A rectangle of the X screen in pixels: a whole monitor, or an area.
    Rect { x: i32, y: i32, w: u32, h: u32 },
    /// One window, followed as it moves.
    Window { xid: u64 },
}

/// Where a sound comes from.
#[derive(Clone, Debug, PartialEq)]
pub enum Sound {
    /// A PulseAudio/PipeWire source (`@DEFAULT_MONITOR@` is what plays on the speakers).
    Pulse(String),
    /// A tone, for tests: nothing real is recorded.
    Test(u32),
}

#[derive(Clone, Debug, PartialEq)]
pub enum CameraSource {
    /// A V4L2 camera, in the mode picked for it (`devices::best_mode`) when its modes are known.
    Device { path: String, mode: Option<Mode> },
    /// A moving test picture, for tests: the real camera is never opened.
    Test,
}

/// One way a camera can send pictures.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Mode {
    pub mjpeg: bool,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

/// The webcam bubble: a circle of `size` pixels at (`x`, `y`) on the recording.
#[derive(Clone, Debug, PartialEq)]
pub struct Camera {
    pub source: CameraSource,
    pub size: u32,
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum VideoCodec {
    /// H.264 on the graphics card, constant quality `qp` (lower is better).
    Vaapi { qp: u32 },
    /// H.264 on the processor (gstreamer1.0-plugins-ugly), constant quantizer.
    X264 { qp: u32 },
    /// VP9 for WebM, constant quality level.
    Vp9 { cq: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AudioCodec {
    Mp3,
    /// The AAC encoder chain that's installed (gst-libav or another).
    Aac(&'static str),
    Opus,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    /// The X display to capture (`:0`, or a nested test display).
    pub display: String,
    pub screen: Screen,
    /// The recording's size (even) and frame rate.
    pub size: (u32, u32),
    pub fps: u32,
    pub camera: Option<Camera>,
    pub system: Option<Sound>,
    pub mic: Option<Sound>,
    pub video: VideoCodec,
    pub audio: AudioCodec,
}

impl Plan {
    pub fn has_audio(&self) -> bool {
        self.system.is_some() || self.mic.is_some()
    }

    pub fn webm(&self) -> bool {
        matches!(self.video, VideoCodec::Vp9 { .. })
    }
}

/// The recording's size for a source of `source` pixels under a quality's limit: the same shape,
/// never larger than the source or `max`, with even sides (encoders need them).
pub fn output_size(source: (u32, u32), max: (u32, u32)) -> (u32, u32) {
    let (sw, sh) = (source.0.max(16) as f64, source.1.max(16) as f64);
    // The limit is a box in the source's orientation: a portrait area fits 1080 wide, 1920 high.
    let (mw, mh) = if sh > sw { (max.1.min(max.0) as f64, max.0.max(max.1) as f64) } else { (max.0 as f64, max.1 as f64) };
    let scale = (mw / sw).min(mh / sh).min(1.0);
    let even = |v: f64| ((v.round() as u32) & !1).max(16);
    (even(sw * scale), even(sh * scale))
}

/// The camera bubble's size and place for a recording of `size`, in a corner.
pub fn bubble(size: (u32, u32), corner: &str) -> (u32, i32, i32) {
    let side = ((size.0.min(size.1) as f64 * 0.24).round() as u32).clamp(96, 360) & !1;
    let margin = ((size.0.min(size.1) as f64) * 0.03).round().max(12.0) as i32;
    let right = size.0 as i32 - side as i32 - margin;
    let bottom = size.1 as i32 - side as i32 - margin;
    let (x, y) = match corner {
        "top-left" => (margin, margin),
        "top-right" => (right, margin),
        "bottom-left" => (margin, bottom),
        _ => (right, bottom),
    };
    (side, x.max(0), y.max(0))
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace(['"', '\\'], ""))
}

/// `name` ("sys", "mic") is how an error is traced back to the device (`devices::lost_input`).
fn sound_source(sound: &Sound, name: &str) -> String {
    match sound {
        Sound::Pulse(device) => format!("pulsesrc device={} name={name}", quote(device)),
        Sound::Test(freq) => format!("audiotestsrc is-live=true wave=sine freq={freq} volume=0.25 name={name}"),
    }
}

/// The capture pipeline: everything up to the encoded streams in `appsink name=v` and `name=a`.
pub fn capture(plan: &Plan) -> String {
    let (w, h) = plan.size;
    let fps = plan.fps;
    let grab = match &plan.screen {
        Screen::Rect { x, y, w: rw, h: rh } => format!(
            "ximagesrc display-name={} use-damage=false show-pointer=true startx={x} starty={y} endx={} endy={}",
            quote(&plan.display),
            x + *rw as i32 - 1,
            y + *rh as i32 - 1
        ),
        Screen::Window { xid } => format!("ximagesrc display-name={} use-damage=false show-pointer=true xid={xid}", quote(&plan.display)),
    };
    // A window can change size while it's recorded: the borders keep its shape in a fixed frame.
    let screen = format!(
        "{grab} ! video/x-raw,framerate={fps}/1 ! queue max-size-buffers=4 max-size-bytes=0 max-size-time=0 leaky=downstream ! videoconvert ! videoscale add-borders=true ! video/x-raw,width={w},height={h},pixel-aspect-ratio=1/1"
    );
    let encode = match plan.video {
        VideoCodec::Vaapi { qp } => format!(
            "videoconvert ! video/x-raw,format=NV12 ! vaapih264enc init-qp={qp} keyframe-period={fps} max-bframes=0 aud=false ! video/x-h264,stream-format=byte-stream,alignment=au"
        ),
        VideoCodec::X264 { qp } => format!(
            "videoconvert ! video/x-raw,format=I420 ! x264enc pass=qual quantizer={qp} speed-preset=veryfast tune=zerolatency key-int-max={fps} bframes=0 ! video/x-h264,stream-format=avc,alignment=au"
        ),
        VideoCodec::Vp9 { cq } => {
            let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(16);
            format!(
                "videoconvert ! video/x-raw,format=I420 ! vp9enc deadline=1 cpu-used=8 threads={threads} row-mt=true end-usage=cq cq-level={cq} keyframe-max-dist={fps} lag-in-frames=0"
            )
        }
    };
    let sink_v = "queue max-size-buffers=0 max-size-bytes=0 max-size-time=0 ! appsink name=v sync=false";
    let mut parts = Vec::new();
    match &plan.camera {
        None => parts.push(format!("{screen} ! {encode} ! {sink_v}")),
        Some(cam) => {
            let source = match &cam.source {
                CameraSource::Device { path, mode: None } => format!("v4l2src device={}", quote(path)),
                CameraSource::Device { path, mode: Some(m) } if m.mjpeg => {
                    format!("v4l2src device={} ! image/jpeg,width={},height={},framerate={}/1 ! jpegdec", quote(path), m.width, m.height, m.fps)
                }
                CameraSource::Device { path, mode: Some(m) } => format!("v4l2src device={} ! video/x-raw,width={},height={},framerate={}/1", quote(path), m.width, m.height, m.fps),
                CameraSource::Test => "videotestsrc is-live=true pattern=ball".to_string(),
            };
            let s = cam.size;
            parts.push(format!(
                // The rate is fixed here: left open, the compositor starts at its default 25 fps
                // until the screen arrives, and the encoder's second SPS breaks GStreamer decoders.
                // On Stop the screen keeps its last frame until the camera ends too, so the file
                // doesn't end on a black one. (Not both pads: then it never ends.)
                "compositor name=comp background=black sink_0::xpos=0 sink_0::ypos=0 sink_0::zorder=0 sink_0::repeat-after-eos=true sink_1::xpos={} sink_1::ypos={} sink_1::zorder=1 ! video/x-raw,width={w},height={h},framerate={fps}/1,pixel-aspect-ratio=1/1 ! {encode} ! {sink_v}",
                cam.x, cam.y
            ));
            parts.push(format!("{screen} ! comp.sink_0"));
            // `bubble` is where the circle is cut (an alpha mask written in place, see `mod.rs`).
            parts.push(format!(
                "{source} ! queue max-size-buffers=2 leaky=downstream ! videoconvert ! aspectratiocrop aspect-ratio=1/1 ! videoscale ! video/x-raw,width={s},height={s},pixel-aspect-ratio=1/1 ! videoconvert ! video/x-raw,format=BGRA ! identity name=bubble ! comp.sink_1"
            ));
        }
    }
    if plan.has_audio() {
        let encode = match plan.audio {
            AudioCodec::Mp3 => "lamemp3enc target=bitrate bitrate=192 cbr=true ! mpegaudioparse".to_string(),
            AudioCodec::Aac(chain) => chain.to_string(),
            AudioCodec::Opus => "opusenc bitrate=128000".to_string(),
        };
        let raw = "audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2";
        let sink_a = format!("audioconvert ! {encode} ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=0 ! appsink name=a sync=false");
        let system = plan.system.as_ref().map(|s| format!("{} ! queue ! {raw}", sound_source(s, "sys")));
        // The microphone has its own volume element, muted from the control bar.
        let mic = plan.mic.as_ref().map(|s| format!("{} ! queue ! {raw} ! volume name=micvol", sound_source(s, "mic")));
        match (system, mic) {
            (Some(a), Some(b)) => {
                parts.push(format!("audiomixer name=mix ! {sink_a}"));
                parts.push(format!("{a} ! mix."));
                parts.push(format!("{b} ! mix."));
            }
            (Some(one), None) | (None, Some(one)) => parts.push(format!("{one} ! {sink_a}")),
            (None, None) => {}
        }
    }
    parts.join("  ")
}

/// The muxer pipeline: the encoded streams from appsrcs `v` and `a` into the file.
/// MP4s are fragmented every second, so a recording cut short by a crash still plays.
pub fn mux(plan: &Plan) -> String {
    let mut parts = vec![if plan.webm() {
        "webmmux name=mux streamable=false ! filesink name=file".to_string()
    } else {
        "mp4mux name=mux fragment-duration=1000 ! filesink name=file".to_string()
    }];
    parts.push("appsrc name=v format=time ! queue ! mux.video_0".to_string());
    if plan.has_audio() {
        parts.push("appsrc name=a format=time ! queue ! mux.audio_0".to_string());
    }
    parts.join("  ")
}

/// Cuts a finished recording from `start` to `end` seconds without encoding again: the muxer
/// takes the same streams from the demuxer (the cut starts at the keyframe before `start`; a
/// recording has one every second). The queues `qv` and `qa` are where the streams are held
/// until the seek (see `mod.rs`).
pub fn trim(webm: bool, has_audio: bool) -> String {
    let (demux, mux) = if webm { ("matroskademux", "webmmux") } else { ("qtdemux", "mp4mux") };
    let mut parts = vec![format!("filesrc name=src ! {demux} name=d  {mux} name=mux ! filesink name=file")];
    // Unbounded queues: the demuxer feeds both from one thread and a recording stores about a
    // second of one stream at a time, so a full queue would stop the other and the muxer with it.
    let queue = |name: &str| format!("queue name={name} max-size-buffers=0 max-size-bytes=0 max-size-time=0");
    parts.push(format!("d.video_0 ! {} ! mux.video_0", queue("qv")));
    if has_audio {
        // MP3 in MP4 needs its parser for the caps the muxer wants; Opus and AAC pass through.
        let parse = if webm { "" } else { "mpegaudioparse ! " };
        parts.push(format!("d.audio_0 ! {} ! {parse}mux.audio_0", queue("qa")));
    }
    parts.join("  ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(screen: Screen) -> Plan {
        Plan {
            display: ":20".into(),
            screen,
            size: (1280, 720),
            fps: 30,
            camera: None,
            system: Some(Sound::Pulse("@DEFAULT_MONITOR@".into())),
            mic: None,
            video: VideoCodec::Vaapi { qp: 24 },
            audio: AudioCodec::Mp3,
        }
    }

    #[test]
    fn an_area_is_cut_from_the_screen_with_inclusive_ends() {
        let d = capture(&plan(Screen::Rect { x: 100, y: 50, w: 640, h: 360 }));
        assert!(d.contains("ximagesrc display-name=\":20\" use-damage=false show-pointer=true startx=100 starty=50 endx=739 endy=409"), "{d}");
        assert!(d.contains("video/x-raw,framerate=30/1"));
        assert!(d.contains("videoscale add-borders=true ! video/x-raw,width=1280,height=720"));
        assert!(d.contains("vaapih264enc init-qp=24 keyframe-period=30 max-bframes=0 aud=false"));
        assert!(d.contains("appsink name=v sync=false"));
    }

    #[test]
    fn a_second_monitor_and_all_screens_are_cut_from_the_x_screen() {
        // HDMI-1 to the right of the laptop screen.
        let d = capture(&plan(Screen::Rect { x: 1920, y: 0, w: 1920, h: 1080 }));
        assert!(d.contains("startx=1920 starty=0 endx=3839 endy=1079"), "{d}");
        // All screens: the box around both, scaled down to fit 1080p.
        let mut all = plan(Screen::Rect { x: 0, y: 0, w: 3840, h: 1080 });
        all.size = output_size((3840, 1080), (1920, 1080));
        let d = capture(&all);
        assert!(d.contains("startx=0 starty=0 endx=3839 endy=1079"));
        assert!(d.contains("video/x-raw,width=1920,height=540"), "{d}");
    }

    #[test]
    fn a_window_follows_its_xid() {
        let d = capture(&plan(Screen::Window { xid: 0x3a00007 }));
        assert!(d.contains(&format!("xid={}", 0x3a00007)));
        assert!(!d.contains("startx"));
    }

    #[test]
    fn sounds_mix_only_when_there_are_two() {
        let mut p = plan(Screen::Rect { x: 0, y: 0, w: 1920, h: 1080 });
        let one = capture(&p);
        assert!(one.contains("pulsesrc device=\"@DEFAULT_MONITOR@\""));
        assert!(!one.contains("audiomixer"));
        assert!(one.contains("lamemp3enc target=bitrate bitrate=192 cbr=true ! mpegaudioparse"));
        p.mic = Some(Sound::Test(880));
        let two = capture(&p);
        assert!(two.contains("audiomixer name=mix"));
        assert!(two.contains("audiotestsrc is-live=true wave=sine freq=880"));
        assert!(two.contains("volume name=micvol ! mix."));
        p.system = None;
        p.mic = None;
        let none = capture(&p);
        assert!(!none.contains("appsink name=a"));
        assert!(!mux(&p).contains("appsrc name=a"));
    }

    #[test]
    fn the_camera_bubble_goes_through_the_compositor() {
        let mut p = plan(Screen::Rect { x: 0, y: 0, w: 1920, h: 1080 });
        p.camera = Some(Camera { source: CameraSource::Test, size: 240, x: 1016, y: 456 });
        let d = capture(&p);
        assert!(d.contains("compositor name=comp background=black sink_0::xpos=0 sink_0::ypos=0 sink_0::zorder=0 sink_0::repeat-after-eos=true sink_1::xpos=1016 sink_1::ypos=456 sink_1::zorder=1 ! "));
        // A fixed rate out of the compositor, or the encoder starts at 25 fps and changes its SPS.
        assert!(d.contains("sink_1::zorder=1 ! video/x-raw,width=1280,height=720,framerate=30/1,pixel-aspect-ratio=1/1 ! "));
        assert!(d.contains("! comp.sink_0"));
        assert!(d.contains("videotestsrc is-live=true pattern=ball"));
        assert!(d.contains("aspectratiocrop aspect-ratio=1/1 ! videoscale ! video/x-raw,width=240,height=240"));
        assert!(d.contains("identity name=bubble ! comp.sink_1"));
        p.camera = Some(Camera { source: CameraSource::Device { path: "/dev/video0".into(), mode: None }, size: 240, x: 0, y: 0 });
        assert!(capture(&p).contains("v4l2src device=\"/dev/video0\" ! queue"));
        // In its best mode: MJPEG is decoded first.
        let mode = Some(Mode { mjpeg: true, width: 1280, height: 720, fps: 30 });
        p.camera = Some(Camera { source: CameraSource::Device { path: "/dev/video2".into(), mode }, size: 240, x: 0, y: 0 });
        assert!(capture(&p).contains("v4l2src device=\"/dev/video2\" ! image/jpeg,width=1280,height=720,framerate=30/1 ! jpegdec ! queue"));
    }

    #[test]
    fn webm_uses_vp9_and_opus() {
        let mut p = plan(Screen::Rect { x: 0, y: 0, w: 1920, h: 1080 });
        p.video = VideoCodec::Vp9 { cq: 32 };
        p.audio = AudioCodec::Opus;
        let d = capture(&p);
        assert!(d.contains("vp9enc deadline=1 cpu-used=8"));
        assert!(d.contains("cq-level=32 keyframe-max-dist=30"));
        assert!(d.contains("opusenc bitrate=128000"));
        assert!(mux(&p).starts_with("webmmux"));
        assert!(trim(true, true).contains("matroskademux"));
    }

    #[test]
    fn mp4_is_fragmented_so_a_crash_leaves_a_playable_file() {
        let p = plan(Screen::Rect { x: 0, y: 0, w: 1920, h: 1080 });
        let m = mux(&p);
        assert!(m.starts_with("mp4mux name=mux fragment-duration=1000"));
        assert!(m.contains("appsrc name=a format=time ! queue ! mux.audio_0"));
        let t = trim(false, true);
        assert!(t.contains("qtdemux name=d") && t.contains("mpegaudioparse ! mux.audio_0"));
    }

    #[test]
    fn output_sizes_keep_the_shape_are_even_and_never_grow() {
        assert_eq!(output_size((2560, 1440), (1920, 1080)), (1920, 1080));
        assert_eq!(output_size((1366, 768), (1920, 1080)), (1366, 768));
        assert_eq!(output_size((1001, 601), (1920, 1080)), (1000, 600));
        assert_eq!(output_size((3840, 2160), (1280, 720)), (1280, 720));
        // A tall area fits the box turned on its side.
        assert_eq!(output_size((1080, 2400), (1920, 1080)), (864, 1920));
    }

    #[test]
    fn the_bubble_sits_in_its_corner() {
        let (side, x, y) = bubble((1920, 1080), "bottom-right");
        assert_eq!(side, 258);
        assert_eq!((x, y), (1920 - 258 - 32, 1080 - 258 - 32));
        assert_eq!(bubble((1920, 1080), "top-left").1, 32);
    }
}
