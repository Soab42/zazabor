//! Screens, microphones, speakers and cameras: what's plugged in, under names a person knows,
//! and what to make of one going away while recording. The mapping is pure (tested here); the
//! listing asks X (RandR monitors) and GStreamer's device monitor (PipeWire, PulseAudio, V4L2).

use super::pipeline::Mode;
use gst::prelude::*;
use gstreamer as gst;
use serde::Serialize;

// ---- screens ----------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    /// The RandR name ("eDP-1", "HDMI-1").
    pub name: String,
    /// What the page shows ("Laptop screen", "HDMI screen").
    pub label: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

/// A connector name in words.
pub fn screen_label(name: &str, index: usize) -> String {
    let upper = name.to_ascii_uppercase();
    let kind = if upper.starts_with("EDP") || upper.starts_with("LVDS") || upper.starts_with("DSI") {
        return "Laptop screen".into();
    } else if upper.starts_with("HDMI") {
        "HDMI"
    } else if upper.starts_with("DP") || upper.starts_with("DISPLAYPORT") {
        "DisplayPort"
    } else if upper.starts_with("DVI") {
        "DVI"
    } else if upper.starts_with("VGA") {
        "VGA"
    } else if name.is_empty() {
        return format!("Screen {}", index + 1);
    } else {
        return format!("Screen {} ({name})", index + 1);
    };
    format!("{kind} screen ({name})")
}

/// RandR's monitors (name, x, y, width, height, primary), left to right, labelled.
pub fn monitors_from(mut raw: Vec<(String, i32, i32, u32, u32, bool)>) -> Vec<Monitor> {
    raw.retain(|m| m.3 > 0 && m.4 > 0);
    raw.sort_by_key(|m| (m.1, m.2));
    raw.into_iter()
        .enumerate()
        .map(|(i, (name, x, y, width, height, primary))| Monitor { label: screen_label(&name, i), name, x, y, width, height, primary })
        .collect()
}

/// The box around every screen: "All screens".
pub fn bounds(monitors: &[Monitor]) -> Option<(i32, i32, u32, u32)> {
    let x0 = monitors.iter().map(|m| m.x).min()?;
    let y0 = monitors.iter().map(|m| m.y).min()?;
    let x1 = monitors.iter().map(|m| m.x + m.width as i32).max()?;
    let y1 = monitors.iter().map(|m| m.y + m.height as i32).max()?;
    Some((x0, y0, (x1 - x0) as u32, (y1 - y0) as u32))
}

/// Whether the part of the screen being recorded has no screen under it any more (its middle
/// isn't on any monitor). An empty list is a failed query, not an unplugged screen.
pub fn screen_gone(rect: (i32, i32, u32, u32), monitors: &[Monitor]) -> bool {
    if monitors.is_empty() {
        return false;
    }
    let (cx, cy) = (rect.0 + rect.2 as i32 / 2, rect.1 + rect.3 as i32 / 2);
    !monitors.iter().any(|m| cx >= m.x && cy >= m.y && cx < m.x + m.width as i32 && cy < m.y + m.height as i32)
}

// ---- sound ------------------------------------------------------------------------------------

/// What GStreamer's device monitor says about a sound device, from either provider (PipeWire's
/// `node.name`, PulseAudio's `internal-name`).
#[derive(Default, Debug)]
pub struct SoundProps {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    /// `device.profile.description`: "Digital Microphone", "HDMI / DisplayPort 1 Output".
    pub profile: Option<String>,
    pub api: Option<String>,
    pub bus: Option<String>,
    /// `media.class`: "Audio/Source/Virtual" for Easy Effects and the like.
    pub class: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    /// The PulseAudio source name `pulsesrc` takes.
    pub id: String,
    pub name: String,
    /// "built-in", "usb", "bluetooth", "virtual", "other".
    pub kind: &'static str,
    /// Something worth knowing about this one (Bluetooth headsets).
    pub hint: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    /// Its monitor source: what "System sound" records from it.
    pub id: String,
    pub name: String,
    pub kind: &'static str,
}

pub const BLUETOOTH_HINT: &str =
    "Bluetooth headsets record in call quality (mono, 16 kHz). Their microphone only works in headset mode; switch back to A2DP afterwards for the best sound.";

fn kind_of(p: &SoundProps) -> &'static str {
    let id = p.id.to_ascii_lowercase();
    let is = |v: &Option<String>, want: &str| v.as_deref().is_some_and(|v| v.eq_ignore_ascii_case(want));
    if id.starts_with("bluez") || is(&p.api, "bluez5") || is(&p.bus, "bluetooth") {
        "bluetooth"
    } else if p.class.as_deref().is_some_and(|c| c.contains("Virtual")) || id.contains("easyeffects") {
        "virtual"
    } else if is(&p.bus, "usb") || id.contains(".usb-") {
        "usb"
    } else if is(&p.api, "alsa") || id.starts_with("alsa_") {
        "built-in"
    } else {
        "other"
    }
}

/// "Blue Yeti Analog Stereo" → "Blue Yeti".
fn tidy(name: &str) -> String {
    let mut s = name.trim().to_string();
    for suffix in [" Analog Stereo", " Analog Mono", " Digital Stereo (IEC958)", " Mono", " Stereo"] {
        if let Some(cut) = s.strip_suffix(suffix) {
            s = cut.to_string();
        }
    }
    s
}

fn base_name(p: &SoundProps) -> String {
    tidy(p.description.as_deref().filter(|d| !d.is_empty()).unwrap_or(&p.display_name))
}

pub fn friendly_input(p: &SoundProps) -> Input {
    let kind = kind_of(p);
    let name = match kind {
        "built-in" => format!("{} (built-in)", p.profile.as_deref().filter(|d| !d.is_empty()).map_or_else(|| base_name(p), tidy)),
        "usb" => format!("{} (USB)", base_name(p)),
        "bluetooth" => format!("{} (Bluetooth headset)", base_name(p)),
        _ => base_name(p),
    };
    Input { id: p.id.clone(), name, kind, hint: (kind == "bluetooth").then(|| BLUETOOTH_HINT.to_string()) }
}

pub fn friendly_output(p: &SoundProps) -> Output {
    let kind = kind_of(p);
    let name = match kind {
        "built-in" => format!("{} (built-in)", p.profile.as_deref().filter(|d| !d.is_empty()).map_or_else(|| base_name(p), tidy)),
        "usb" => format!("{} (USB)", base_name(p)),
        "bluetooth" => format!("{} (Bluetooth)", base_name(p)),
        _ => base_name(p),
    };
    let id = if p.id.ends_with(".monitor") { p.id.clone() } else { format!("{}.monitor", p.id) };
    Output { id, name, kind }
}

/// Which sound source a pipeline error came from, by the element's path
/// ("/GstPipeline:pipeline0/GstPulseSrc:mic"): "mic" or "system"; None for anything else.
pub fn lost_input(path: &str) -> Option<&'static str> {
    match path.rsplit('/').next()?.rsplit(':').next()? {
        "mic" => Some("mic"),
        "sys" => Some("system"),
        _ => None,
    }
}

// ---- cameras ----------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraDevice {
    /// "/dev/video0", or "test" for the test picture.
    pub path: String,
    pub name: String,
    pub mode: Option<Mode>,
}

/// "HD Webcam: HD Webcam" → "HD Webcam".
pub fn camera_name(card: &str) -> String {
    match card.split_once(": ") {
        Some((a, b)) if a.trim() == b.trim() => a.trim().to_string(),
        _ => card.trim().to_string(),
    }
}

/// The mode to open a camera in: smooth first (24 fps or more), then nearest 720p (the bubble
/// never needs more), then MJPEG (it fits through USB 2 where raw 720p doesn't).
pub fn best_mode(modes: &[Mode]) -> Option<Mode> {
    modes.iter().copied().max_by_key(|m| (m.fps >= 24, -(m.height as i32 - 720).abs(), m.mjpeg, m.fps))
}

/// The fixed sizes and rates in a camera's caps.
pub fn modes_of(caps: &gst::CapsRef) -> Vec<Mode> {
    let mut out = Vec::new();
    for s in caps.iter() {
        let mjpeg = match s.name().as_str() {
            "image/jpeg" => true,
            "video/x-raw" => false,
            _ => continue,
        };
        let (Ok(width), Ok(height)) = (s.get::<i32>("width"), s.get::<i32>("height")) else { continue };
        let fps = if let Ok(f) = s.get::<gst::Fraction>("framerate") {
            vec![f]
        } else if let Ok(list) = s.get::<gst::List>("framerate") {
            list.iter().filter_map(|v| v.get::<gst::Fraction>().ok()).collect()
        } else {
            Vec::new()
        };
        if let Some(best) = fps.iter().filter(|f| f.denom() > 0).map(|f| f.numer() / f.denom()).max() {
            out.push(Mode { mjpeg, width: width as u32, height: height as u32, fps: best as u32 });
        }
    }
    out
}

// ---- listing ----------------------------------------------------------------------------------

#[derive(Default)]
pub struct Devices {
    pub inputs: Vec<Input>,
    pub outputs: Vec<Output>,
    pub cameras: Vec<CameraDevice>,
}

/// One device monitor for the app's life, started on first use and never stopped: starting and
/// stopping them over and over (each listing, each watch) is what GStreamer's PipeWire provider
/// handles worst.
fn device_monitor() -> Option<&'static gst::DeviceMonitor> {
    static MONITOR: std::sync::OnceLock<Option<gst::DeviceMonitor>> = std::sync::OnceLock::new();
    MONITOR
        .get_or_init(|| {
            let monitor = gst::DeviceMonitor::new();
            monitor.add_filter(Some("Audio/Source"), None);
            monitor.add_filter(Some("Audio/Sink"), None);
            monitor.add_filter(Some("Video/Source"), None);
            monitor.start().is_ok().then_some(monitor)
        })
        .as_ref()
}

fn props_of(device: &gst::Device) -> (SoundProps, Option<String>) {
    let s = device.properties();
    let get = |k: &str| s.as_ref().and_then(|s| s.get::<String>(k).ok());
    // Only what `pulsesrc` can open: PulseAudio's source names, or PipeWire's node names (the
    // same through pipewire-pulse). ALSA's own devices ("hw:0,7") are left out.
    let id = match device.type_().name() {
        "GstPulseDevice" if device.has_property("internal-name", None) => device.property::<String>("internal-name"),
        "GstPipeWireDevice" => get("node.name").unwrap_or_default(),
        _ => String::new(),
    };
    let props = SoundProps {
        id,
        display_name: device.display_name().to_string(),
        description: get("device.description").or_else(|| get("node.description")),
        profile: get("device.profile.description"),
        api: get("device.api"),
        bus: get("device.bus"),
        class: get("media.class"),
    };
    (props, get("device.class"))
}

/// Everything plugged in now. Only lists: nothing is opened for recording.
pub fn list(sound: bool, cameras: bool) -> Devices {
    let mut out = Devices::default();
    let Some(monitor) = device_monitor() else { return out };
    for device in monitor.devices() {
        let class = device.device_class().to_string();
        if class.starts_with("Video/Source") {
            if !cameras {
                continue;
            }
            let s = device.properties();
            let get = |k: &str| s.as_ref().and_then(|s| s.get::<String>(k).ok());
            let Some(path) = get("device.path").or_else(|| get("api.v4l2.path")).filter(|p| p.starts_with("/dev/video")) else { continue };
            if out.cameras.iter().any(|c| c.path == path) {
                continue;
            }
            let name = camera_name(&get("v4l2.device.card").unwrap_or_else(|| device.display_name().to_string()));
            let mode = device.caps().and_then(|c| best_mode(&modes_of(&c)));
            out.cameras.push(CameraDevice { path, name, mode });
            continue;
        }
        if !sound {
            continue;
        }
        let (props, device_class) = props_of(&device);
        if props.id.is_empty() {
            continue;
        }
        if class.starts_with("Audio/Source") {
            // A sink's monitor shows up as a source under PulseAudio: that's "System sound".
            if device_class.as_deref() == Some("monitor") || props.id.ends_with(".monitor") || out.inputs.iter().any(|i| i.id == props.id) {
                continue;
            }
            out.inputs.push(friendly_input(&props));
        } else if class.starts_with("Audio/Sink") {
            let output = friendly_output(&props);
            if !out.outputs.iter().any(|o| o.id == output.id) {
                out.outputs.push(output);
            }
        }
    }
    out
}

/// Watches for devices coming and going (and screens, polled through RandR) while the page
/// is open; `changed` is called after each change. Ends when `keep_going` turns false.
pub fn watch(display: String, keep_going: impl Fn() -> bool, changed: impl Fn()) {
    let bus = device_monitor().map(|m| m.bus());
    // What piled up while nobody watched was listed when the page opened.
    if let Some(bus) = &bus {
        while bus.pop().is_some() {}
    }
    let mut screens = super::x11::monitors(&display);
    let mut ticks = 0u32;
    while keep_going() {
        let mut dirty = false;
        match &bus {
            Some(bus) => {
                if let Some(message) = bus.timed_pop(gst::ClockTime::from_mseconds(250)) {
                    dirty = matches!(message.view(), gst::MessageView::DeviceAdded(_) | gst::MessageView::DeviceRemoved(_));
                }
            }
            None => std::thread::sleep(std::time::Duration::from_millis(250)),
        }
        ticks += 1;
        if ticks % 8 == 0 {
            let now = super::x11::monitors(&display);
            if now != screens {
                screens = now;
                dirty = true;
            }
        }
        if dirty {
            changed();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn sound(id: &str, display: &str, description: Option<&str>, profile: Option<&str>, api: Option<&str>, bus: Option<&str>, class: &str) -> SoundProps {
        SoundProps {
            id: id.into(),
            display_name: display.into(),
            description: description.map(Into::into),
            profile: profile.map(Into::into),
            api: api.map(Into::into),
            bus: bus.map(Into::into),
            class: Some(class.into()),
        }
    }

    #[test]
    fn monitors_are_listed_left_to_right_with_names_people_know() {
        let m = monitors_from(vec![
            ("HDMI-1".into(), 1920, 0, 1920, 1080, false),
            ("eDP-1".into(), 0, 0, 1920, 1080, true),
            ("DP-2".into(), 0, 0, 0, 0, false),
        ]);
        assert_eq!(m.len(), 2, "a monitor without a size is skipped");
        assert_eq!((m[0].label.as_str(), m[0].x, m[0].primary), ("Laptop screen", 0, true));
        assert_eq!((m[1].label.as_str(), m[1].x), ("HDMI screen (HDMI-1)", 1920));
        assert_eq!(screen_label("DP-3", 2), "DisplayPort screen (DP-3)");
        assert_eq!(screen_label("left", 0), "Screen 1 (left)");
        assert_eq!(bounds(&m), Some((0, 0, 3840, 1080)));
        assert_eq!(bounds(&[]), None);
    }

    #[test]
    fn a_recorded_screen_that_was_unplugged_is_noticed() {
        let both = monitors_from(vec![("eDP-1".into(), 0, 0, 1920, 1080, true), ("HDMI-1".into(), 1920, 0, 1920, 1080, false)]);
        let hdmi = (1920, 0, 1920, 1080);
        assert!(!screen_gone(hdmi, &both));
        assert!(screen_gone(hdmi, &both[..1]), "only the laptop screen is left");
        assert!(!screen_gone((100, 100, 640, 360), &both[..1]), "an area on the laptop screen is still there");
        assert!(!screen_gone(hdmi, &[]), "a failed query isn't an unplugged screen");
    }

    #[test]
    fn sound_devices_get_friendly_names() {
        let digital = sound(
            "alsa_input.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__hw_sofhdadsp_6__source",
            "Tiger Lake-H HD Audio Controller Digital Microphone",
            None,
            Some("Digital Microphone"),
            Some("alsa"),
            None,
            "Audio/Source",
        );
        let i = friendly_input(&digital);
        assert_eq!((i.name.as_str(), i.kind, i.hint.is_none()), ("Digital Microphone (built-in)", "built-in", true));

        let headset = sound("bluez_input.41_42_1A_2B_3C_4D.0", "Rockerz 110", Some("Rockerz 110"), None, Some("bluez5"), Some("bluetooth"), "Audio/Source");
        let i = friendly_input(&headset);
        assert_eq!((i.name.as_str(), i.kind), ("Rockerz 110 (Bluetooth headset)", "bluetooth"));
        assert!(i.hint.as_deref().is_some_and(|h| h.contains("16 kHz") && h.contains("A2DP")));
        // PulseAudio's name for the same headset.
        assert_eq!(kind_of(&sound("bluez_source.41_42_1A_2B_3C_4D.handsfree_head_unit", "Rockerz 110", None, None, None, None, "Audio/Source")), "bluetooth");

        let effects = sound("easyeffects_source", "Easy Effects Source", None, None, None, None, "Audio/Source/Virtual");
        assert_eq!(friendly_input(&effects), Input { id: "easyeffects_source".into(), name: "Easy Effects Source".into(), kind: "virtual", hint: None });

        let yeti = sound("alsa_input.usb-Blue_Microphones_Yeti-00.analog-stereo", "Yeti Stereo Microphone Analog Stereo", None, None, Some("alsa"), Some("usb"), "Audio/Source");
        assert_eq!(friendly_input(&yeti).name, "Yeti Stereo Microphone (USB)");

        let hdmi = sound("alsa_output.pci-0000_00_1f.3.HiFi__hw_sofhdadsp_3__sink", "Tiger Lake-H HDMI / DisplayPort 1 Output", None, Some("HDMI / DisplayPort 1 Output"), Some("alsa"), None, "Audio/Sink");
        let o = friendly_output(&hdmi);
        assert_eq!(o.id, "alsa_output.pci-0000_00_1f.3.HiFi__hw_sofhdadsp_3__sink.monitor");
        assert_eq!(o.name, "HDMI / DisplayPort 1 Output (built-in)");
    }

    #[test]
    fn errors_from_a_sound_source_are_told_apart() {
        assert_eq!(lost_input("/GstPipeline:pipeline0/GstPulseSrc:mic"), Some("mic"));
        assert_eq!(lost_input("/GstPipeline:pipeline3/GstPulseSrc:sys"), Some("system"));
        assert_eq!(lost_input("/GstPipeline:pipeline0/GstXImageSrc:ximagesrc0"), None);
        assert_eq!(lost_input(""), None);
    }

    /// Prints what's plugged in here (lists only; nothing is opened for recording).
    #[test]
    #[ignore]
    fn list_this_machine() {
        gst::init().unwrap();
        let d = list(true, true);
        for i in &d.inputs {
            eprintln!("mic    {:<40} {:<10} {}", i.name, i.kind, i.id);
        }
        for o in &d.outputs {
            eprintln!("output {:<40} {:<10} {}", o.name, o.kind, o.id);
        }
        for c in &d.cameras {
            eprintln!("camera {:<40} {:?} {}", c.name, c.mode, c.path);
        }
    }

    #[test]
    fn cameras_open_at_720p_mjpeg_when_they_can() {
        gst::init().unwrap();
        let caps = gst::Caps::from_str(
            "video/x-raw, format=YUY2, width=1280, height=720, framerate=10/1; \
             video/x-raw, format=YUY2, width=640, height=480, framerate=30/1; \
             image/jpeg, width=1280, height=720, framerate=30/1; \
             image/jpeg, width=640, height=480, framerate={ 30/1, 15/1 }; \
             image/jpeg, width=1920, height=1080, framerate=30/1",
        )
        .unwrap();
        let modes = modes_of(&caps);
        assert_eq!(modes.len(), 5);
        assert_eq!(best_mode(&modes), Some(Mode { mjpeg: true, width: 1280, height: 720, fps: 30 }));
        // Raw 720p at 10 fps loses to smooth 480p.
        let raw_only = [Mode { mjpeg: false, width: 1280, height: 720, fps: 10 }, Mode { mjpeg: false, width: 640, height: 480, fps: 30 }];
        assert_eq!(best_mode(&raw_only).map(|m| m.height), Some(480));
        assert_eq!(best_mode(&[]), None);
        assert_eq!(camera_name("HD Webcam: HD Webcam"), "HD Webcam");
        assert_eq!(camera_name("USB Capture HDMI"), "USB Capture HDMI");
    }
}
