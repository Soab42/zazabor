//! Call audio through GStreamer. The SCO link carries 16-bit little-endian mono PCM at 8 kHz
//! (CVSD is encoded by the Bluetooth controller). The caller's voice goes appsrc → audioconvert /
//! audioresample → the speakers; the mic goes the other way into an appsink, read in the SCO
//! link's rhythm (`sco::pump`). With GStreamer's `webrtcdsp` plugin installed, the mic's echo of
//! the speakers is cancelled.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;

use gstreamer as gst;
use gstreamer::prelude::*;

/// The SCO link's format.
pub const CAPS: &str = "audio/x-raw,format=S16LE,rate=8000,channels=1,layout=interleaved";

/// At most this much mic audio (bytes; 200 ms) waits for the link: older audio is dropped so the
/// delay can't grow.
const MIC_BACKLOG: usize = 8000 * 2 / 5;

/// Where the audio comes from and goes to (gst-launch syntax).
#[derive(Clone, Debug)]
pub struct Ends {
    pub sink: String,
    pub source: String,
}

impl Ends {
    /// The desktop's default speakers and mic.
    pub fn system() -> Ends {
        Ends { sink: "autoaudiosink".into(), source: "autoaudiosrc".into() }
    }
}

fn init() -> Result<(), String> {
    static INIT: OnceLock<Result<(), String>> = OnceLock::new();
    INIT.get_or_init(|| gst::init().map_err(|e| format!("GStreamer didn't start: {e}"))).clone()
}

/// GStreamer's WebRTC echo canceller (gst-plugins-bad `webrtcdsp`) is installed.
pub fn echo_cancel_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| init().is_ok() && gst::ElementFactory::find("webrtcdsp").is_some() && gst::ElementFactory::find("webrtcechoprobe").is_some())
}

/// The two pipeline descriptions: (playback, capture). `probe` names the echo probe when echo
/// cancelling is on.
pub fn descriptions(ends: &Ends, probe: Option<&str>) -> (String, String) {
    let (probe_el, dsp_el) = match probe {
        Some(name) => (format!("webrtcechoprobe name={name} ! "), format!("webrtcdsp probe={name} ! ")),
        None => (String::new(), String::new()),
    };
    let playback = format!(
        "appsrc name=src is-live=true format=time do-timestamp=true block=false max-bytes=16000 caps=\"{CAPS}\" \
         ! queue max-size-time=200000000 leaky=downstream ! audioconvert ! volume name=vol ! {probe_el}audioconvert ! audioresample ! {}",
        ends.sink
    );
    let capture = format!(
        "{} ! queue max-size-time=200000000 leaky=downstream ! audioconvert ! audioresample ! capsfilter caps=\"{CAPS}\" \
         ! {dsp_el}appsink name=sink sync=false max-buffers=25 drop=true caps=\"{CAPS}\"",
        ends.source
    );
    (playback, capture)
}

/// A call's audio: the speakers' pipeline and the mic's.
pub struct Audio {
    playback: gst::Pipeline,
    capture: gst::Pipeline,
    src: gst::Element,
    volume: gst::Element,
    sink: gst::Element,
    mic: VecDeque<u8>,
    /// The mic has filled up enough to start sending it.
    primed: bool,
}

fn pipeline(desc: &str) -> Result<gst::Pipeline, String> {
    gst::parse_launch(desc)
        .map_err(|e| format!("Couldn't set up the call audio: {e}"))?
        .downcast::<gst::Pipeline>()
        .map_err(|_| "Couldn't set up the call audio.".to_string())
}

impl Audio {
    pub fn new(ends: &Ends, echo_cancel: bool) -> Result<Audio, String> {
        init()?;
        static N: AtomicU32 = AtomicU32::new(0);
        let probe = (echo_cancel && echo_cancel_available()).then(|| format!("zazabor-hfp-echo-{}", N.fetch_add(1, Ordering::Relaxed)));
        let (play, cap) = descriptions(ends, probe.as_deref());
        let playback = pipeline(&play)?;
        let capture = pipeline(&cap)?;
        let element = |p: &gst::Pipeline, name: &str| p.by_name(name).ok_or_else(|| format!("The call audio has no {name}."));
        let audio = Audio {
            src: element(&playback, "src")?,
            volume: element(&playback, "vol")?,
            sink: element(&capture, "sink")?,
            playback,
            capture,
            mic: VecDeque::new(),
            primed: false,
        };
        // Playback first: the echo canceller needs the probe there.
        audio.playback.set_state(gst::State::Playing).map_err(|_| "The speakers didn't start for the call.".to_string())?;
        audio.capture.set_state(gst::State::Playing).map_err(|_| "The microphone didn't start for the call.".to_string())?;
        Ok(audio)
    }

    /// Plays what the phone sent.
    pub fn play(&self, pcm: &[u8]) {
        let buffer = gst::Buffer::from_slice(pcm.to_vec());
        let _ = self.src.emit_by_name::<gst::FlowReturn>("push-buffer", &[&buffer]);
    }

    /// `n` bytes of mic audio for the phone: silence while muted or until enough came in.
    pub fn mic(&mut self, n: usize, muted: bool) -> Vec<u8> {
        while let Some(sample) = self.sink.emit_by_name::<Option<gst::Sample>>("try-pull-sample", &[&0u64]) {
            if let Some(map) = sample.buffer().and_then(|b| b.map_readable().ok()) {
                self.mic.extend(map.as_slice());
            }
        }
        if self.mic.len() > MIC_BACKLOG {
            // Keep whole samples.
            let drop = (self.mic.len() - MIC_BACKLOG / 2) & !1;
            self.mic.drain(..drop);
        }
        // Wait for a little backlog (20 ms) so the link isn't starved by the mic's own chunks.
        if !self.primed && self.mic.len() >= n.max(320) {
            self.primed = true;
        }
        if !self.primed || self.mic.len() < n {
            if self.mic.len() < n {
                self.primed = false;
            }
            return vec![0; n];
        }
        let out: Vec<u8> = self.mic.drain(..n).collect();
        if muted {
            vec![0; n]
        } else {
            out
        }
    }

    /// The speaker gain, 0-15 (HFP's scale).
    pub fn set_volume(&self, level: u8) {
        self.volume.set_property("volume", f64::from(level.min(15)) / 15.0);
    }

    /// The first error either pipeline reported, if any.
    pub fn error(&self) -> Option<String> {
        [&self.playback, &self.capture].into_iter().find_map(|p| {
            let bus = p.bus()?;
            let msg = bus.pop_filtered(&[gst::MessageType::Error])?;
            match msg.view() {
                gst::MessageView::Error(err) => Some(format!("Call audio stopped: {}", err.error())),
                _ => None,
            }
        })
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        let _ = self.capture.set_state(gst::State::Null);
        let _ = self.playback.set_state(gst::State::Null);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// No real speakers or mic: a test tone for the mic and a sink that drops everything.
    pub(crate) fn fake_ends() -> Ends {
        Ends { sink: "fakesink sync=false".into(), source: "audiotestsrc is-live=true wave=sine freq=440 volume=0.5".into() }
    }

    #[test]
    fn descriptions_with_and_without_echo_cancelling() {
        let (play, cap) = descriptions(&Ends::system(), None);
        assert!(play.starts_with("appsrc name=src") && play.ends_with("autoaudiosink"));
        assert!(cap.starts_with("autoaudiosrc") && cap.contains("appsink name=sink"));
        assert!(!play.contains("webrtc") && !cap.contains("webrtc"));
        let (play, cap) = descriptions(&Ends::system(), Some("p1"));
        assert!(play.contains("webrtcechoprobe name=p1 !"));
        assert!(cap.contains("webrtcdsp probe=p1 !"));
    }

    #[test]
    fn pipelines_run_with_fake_ends() {
        let mut audio = Audio::new(&fake_ends(), true).unwrap();
        audio.set_volume(9);
        let start = std::time::Instant::now();
        let mut heard = false;
        while start.elapsed() < std::time::Duration::from_secs(3) {
            audio.play(&[0u8; 48]);
            let mic = audio.mic(48, false);
            assert_eq!(mic.len(), 48);
            if mic.iter().any(|&b| b != 0) {
                heard = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        assert!(heard, "the test tone reached the mic side");
        assert!(audio.mic(48, true).iter().all(|&b| b == 0), "muted is silent");
        assert_eq!(audio.error(), None);
    }
}
