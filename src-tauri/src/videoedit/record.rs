//! Voice-over recording: the default microphone (PulseAudio/PipeWire) into a WAV file, with a
//! level meter. WebKitGTK's own microphone access is off in Zazabor's webview, so GStreamer does
//! it. Tests and the nested test display set `ZAZABOR_TEST_AUDIO_SOURCE` to record a test tone
//! instead of a real microphone.

use super::media;
use gst::prelude::*;
use gstreamer as gst;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

struct Recorder {
    pipeline: gst::Pipeline,
    path: String,
    started: Instant,
    /// The loudest peak since the meter last asked, as f32 bits (0…1).
    peak: Arc<AtomicU32>,
}

#[derive(Serialize)]
pub struct Recorded {
    pub path: String,
    pub seconds: f64,
}

fn recorders() -> &'static Mutex<HashMap<u64, Recorder>> {
    static R: OnceLock<Mutex<HashMap<u64, Recorder>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn source() -> &'static str {
    if std::env::var_os("ZAZABOR_TEST_AUDIO_SOURCE").is_some() {
        "audiotestsrc is-live=true wave=sine freq=330 volume=0.3"
    } else {
        "pulsesrc"
    }
}

/// Starts recording into `path` (a .wav); returns the recording's id.
pub fn start(path: &str) -> Result<u64, String> {
    media::init()?;
    if let Some(dir) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let description = format!(
        "{} ! queue ! audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate=48000,channels=1 ! level name=meter interval=50000000 post-messages=true ! wavenc ! filesink name=out",
        source()
    );
    let pipeline = gst::parse_launch(&description)
        .map_err(|e| format!("The microphone couldn't be opened: {e}"))?
        .downcast::<gst::Pipeline>()
        .map_err(|_| "Not a pipeline".to_string())?;
    pipeline.by_name("out").ok_or("no filesink")?.set_property("location", path);
    let peak = Arc::new(AtomicU32::new(0));
    // The meter's readings come as bus messages; keep the loudest until the page asks.
    if let Some(bus) = pipeline.bus() {
        let peak = peak.clone();
        let _ = bus.set_sync_handler(move |_, message| {
            if let gst::MessageView::Element(e) = message.view() {
                if let Some(s) = e.structure().filter(|s| s.name() == "level") {
                    if let Ok(list) = s.get::<gst::glib::ValueArray>("peak") {
                        let db = list.iter().filter_map(|v| v.get::<f64>().ok()).fold(f64::NEG_INFINITY, f64::max);
                        let linear = 10f64.powf(db / 20.0).clamp(0.0, 1.0) as f32;
                        let _ = peak.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |old| Some(f32::from_bits(old).max(linear).to_bits()));
                    }
                }
            }
            gst::BusSyncReply::Pass
        });
    }
    let mut messages = Vec::new();
    if let Err(why) = media::wait_state(&pipeline, gst::State::Playing, 8, &mut messages) {
        let _ = pipeline.set_state(gst::State::Null);
        let _ = std::fs::remove_file(path);
        return Err(format!("The microphone couldn't start: {why}"));
    }
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    lock(recorders()).insert(id, Recorder { pipeline, path: path.into(), started: Instant::now(), peak });
    Ok(id)
}

/// The loudest moment since the last call (0…1), for the meter.
pub fn level(id: u64) -> Result<f32, String> {
    let map = lock(recorders());
    let r = map.get(&id).ok_or("That recording has stopped.")?;
    Ok(f32::from_bits(r.peak.swap(0, Ordering::Relaxed)))
}

/// Stops and finishes the file; `keep` false throws it away.
pub fn stop(id: u64, keep: bool) -> Result<Recorded, String> {
    let r = lock(recorders()).remove(&id).ok_or("That recording has stopped.")?;
    let seconds = r.started.elapsed().as_secs_f64();
    // End of stream writes the WAV header's sizes.
    r.pipeline.send_event(gst::event::Eos::new());
    if let Some(bus) = r.pipeline.bus() {
        let _ = bus.timed_pop_filtered(gst::ClockTime::from_seconds(3), &[gst::MessageType::Eos, gst::MessageType::Error]);
    }
    let _ = r.pipeline.set_state(gst::State::Null);
    std::thread::sleep(Duration::from_millis(20));
    if !keep {
        let _ = std::fs::remove_file(&r.path);
    }
    Ok(Recorded { path: r.path, seconds })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_a_test_tone_into_a_wav() {
        std::env::set_var("ZAZABOR_TEST_AUDIO_SOURCE", "1");
        if media::init().is_err() {
            return;
        }
        let path = std::env::temp_dir().join(format!("zazabor-voice-{}.wav", std::process::id()));
        let id = start(path.to_str().unwrap()).unwrap();
        std::thread::sleep(Duration::from_millis(600));
        let peak = level(id).unwrap();
        let done = stop(id, true).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(peak > 0.1, "meter read {peak}");
        assert!(done.seconds > 0.5);
        assert_eq!(&bytes[0..4], b"RIFF");
        // About 0.6 s of 48 kHz mono 16-bit sound, plus the header.
        assert!(bytes.len() > 40_000, "{} bytes", bytes.len());
        assert!(level(id).is_err());
    }
}
