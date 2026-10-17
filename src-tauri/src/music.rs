//! Native music playback with GStreamer. Playing audio inside the webview tied pause and
//! resume to pipeline state changes on the UI thread, which froze the interface; here every
//! state change and fade happens on background threads.
//!
//! Two channels play independently: "show" for slideshows and "preview" for auditioning.

use gstreamer as gst;
use gstreamer::prelude::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

#[derive(Clone)]
struct Track {
    playbin: gst::Element,
    /// Bumped by every fade, so a newer fade cancels an older one.
    fades: Arc<AtomicU64>,
}

fn tracks() -> &'static Mutex<HashMap<String, Track>> {
    static TRACKS: OnceLock<Mutex<HashMap<String, Track>>> = OnceLock::new();
    TRACKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn initialized() -> Result<(), String> {
    static INIT: OnceLock<Result<(), String>> = OnceLock::new();
    INIT.get_or_init(|| gst::init().map_err(|e| e.to_string())).clone()
}

fn track(channel: &str) -> Option<Track> {
    tracks().lock().unwrap().get(channel).cloned()
}

/// Ramps the volume (blocking); returns false if a newer fade took over.
fn fade(track: &Track, to: f64, ms: u64) -> bool {
    const STEP_MS: u64 = 20;
    let generation = track.fades.fetch_add(1, Ordering::SeqCst) + 1;
    let from: f64 = track.playbin.property("volume");
    let steps = (ms / STEP_MS).max(1);
    for i in 1..=steps {
        if track.fades.load(Ordering::SeqCst) != generation {
            return false;
        }
        let t = i as f64 / steps as f64;
        track.playbin.set_property("volume", (from + (to - from) * t).max(0.0));
        std::thread::sleep(Duration::from_millis(STEP_MS));
    }
    true
}

fn fade_in_background(track: Track, to: f64, ms: u64, then: Option<gst::State>) {
    std::thread::spawn(move || {
        if fade(&track, to, ms) {
            if let Some(state) = then {
                let _ = track.playbin.set_state(state);
            }
        }
    });
}

fn stop_channel(channel: &str, fade_ms: u64) {
    if let Some(track) = tracks().lock().unwrap().remove(channel) {
        fade_in_background(track, 0.0, fade_ms, Some(gst::State::Null));
    }
}

/// Starts looping `path` on `channel`, fading in to `volume`. `start_fraction` (0–1) begins
/// part-way through, e.g. for previews. Fails if the file cannot be played.
#[tauri::command]
pub async fn music_play(channel: String, path: String, volume: f64, fade_ms: u64, start_fraction: Option<f64>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        initialized()?;
        stop_channel(&channel, 150);
        let uri = gst::glib::filename_to_uri(&path, None).map_err(|e| e.to_string())?;
        let playbin = gst::ElementFactory::make("playbin")
            .property("uri", uri.as_str())
            .property("volume", 0.0f64)
            .build()
            .map_err(|e| format!("GStreamer playbin is unavailable: {e}"))?;
        // Audio only: never open a window for album art.
        playbin.set_property_from_str("flags", "audio+soft-volume");
        // Queue the same file again just before it ends, for a gapless loop.
        let again = uri.to_string();
        playbin.connect("about-to-finish", false, move |args| {
            if let Ok(element) = args[0].get::<gst::Element>() {
                element.set_property("uri", again.as_str());
            }
            None
        });

        let bus = playbin.bus().ok_or("no bus")?;
        playbin.set_state(gst::State::Paused).map_err(|e| e.to_string())?;
        let ready = bus.timed_pop_filtered(gst::ClockTime::from_seconds(8), &[gst::MessageType::AsyncDone, gst::MessageType::Error]);
        let failure = match ready.as_ref().map(|m| m.view()) {
            Some(gst::MessageView::Error(err)) => Some(err.error().to_string()),
            Some(_) => None,
            None => Some("the file took too long to open".to_string()),
        };
        if let Some(reason) = failure {
            let _ = playbin.set_state(gst::State::Null);
            return Err(format!("Can't play this file: {reason}"));
        }
        // Nothing reads the bus from here on; don't let messages pile up.
        bus.set_flushing(true);

        if let (Some(fraction), Some(duration)) = (start_fraction, playbin.query_duration::<gst::ClockTime>()) {
            let position = gst::ClockTime::from_nseconds((duration.nseconds() as f64 * fraction.clamp(0.0, 0.95)) as u64);
            let _ = playbin.seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT, position);
        }
        playbin.set_state(gst::State::Playing).map_err(|e| e.to_string())?;

        let track = Track { playbin, fades: Arc::new(AtomicU64::new(0)) };
        tracks().lock().unwrap().insert(channel, track.clone());
        fade_in_background(track, volume, fade_ms, None);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn music_pause(channel: String, fade_ms: u64) {
    if let Some(track) = track(&channel) {
        fade_in_background(track, 0.0, fade_ms, Some(gst::State::Paused));
    }
}

#[tauri::command]
pub fn music_resume(channel: String, volume: f64, fade_ms: u64) {
    if let Some(track) = track(&channel) {
        std::thread::spawn(move || {
            let _ = track.playbin.set_state(gst::State::Playing);
            fade(&track, volume, fade_ms);
        });
    }
}

#[tauri::command]
pub fn music_volume(channel: String, volume: f64, fade_ms: u64) {
    if let Some(track) = track(&channel) {
        fade_in_background(track, volume, fade_ms, None);
    }
}

#[tauri::command]
pub fn music_stop(channel: String, fade_ms: u64) {
    stop_channel(&channel, fade_ms);
}

/// Seconds into the current pass of the (looping) track.
#[tauri::command]
pub fn music_position(channel: String) -> Option<f64> {
    let track = track(&channel)?;
    let position = track.playbin.query_position::<gst::ClockTime>()?;
    Some(position.nseconds() as f64 / 1e9)
}
