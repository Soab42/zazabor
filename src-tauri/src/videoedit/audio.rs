//! A clip's sound as PCM for the page (Web Audio plays and mixes it, and draws the waveform):
//! 16-bit stereo at 48 kHz. GStreamer decodes it; when GStreamer has no decoder for the audio
//! (AAC from phones needs gstreamer1.0-libav, not installed here), libVLC, which CorePro already
//! uses for playback, converts the sound to a WAV in the cache first.

use super::media::{self, Want};
use gst::prelude::*;
use gstreamer as gst;
use std::ffi::{c_char, c_int, c_void, CString};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
/// Longer sound than this isn't loaded (about 1.6 GB of PCM).
const MAX_SECONDS: f64 = 3.0 * 3600.0;

/// Interleaved S16LE PCM of the whole file, or None when it has no sound GStreamer can decode.
fn decode(path: &str) -> Result<Option<Vec<u8>>, String> {
    let chain = media::chain(&format!(
        "queue ! audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate={RATE},channels={CHANNELS},layout=interleaved ! appsink name=pcm sync=false"
    ))?;
    let decoding = media::decoding(path, Want::Audio, &chain)?;
    let sink = chain.downcast_ref::<gst::Bin>().and_then(|b| b.by_name("pcm")).ok_or("no appsink")?;
    let mut messages = Vec::new();
    let started = decoding.start(gst::State::Playing, 20, &mut messages);
    let pipeline = decoding.pipeline;
    if let Err(why) = started {
        let _ = pipeline.set_state(gst::State::Null);
        // No decoder for the sound (or no sound at all): let the caller decide.
        if why == media::NO_STREAM || !media::missing_plugins(&messages).is_empty() {
            return Ok(None);
        }
        return Err(why);
    }
    let mut out = Vec::new();
    let limit = (MAX_SECONDS * (RATE * CHANNELS * 2) as f64) as usize;
    let timeout = Duration::from_secs(10).as_nanos() as u64;
    loop {
        let Some(sample) = sink.emit_by_name::<Option<gst::Sample>>("try-pull-sample", &[&timeout]) else { break };
        if let Some(buffer) = sample.buffer() {
            if let Ok(map) = buffer.map_readable() {
                out.extend_from_slice(map.as_slice());
            }
        }
        if out.len() > limit {
            break;
        }
    }
    let error = media::bus_error(&pipeline);
    let _ = pipeline.set_state(gst::State::Null);
    match error {
        Some(why) if out.is_empty() => Err(why),
        _ => Ok(Some(out)),
    }
}

/// The PCM of `path`, through libVLC when GStreamer can't decode it. `cache` holds the WAVs.
pub fn pcm(path: &str, cache: &Path, has_audio: bool) -> Result<Vec<u8>, String> {
    if std::env::var_os("COREPRO_VIDEOEDIT_VLC_AUDIO").is_none() {
        if let Some(out) = decode(path)? {
            return Ok(out);
        }
    }
    if !has_audio {
        return Ok(Vec::new());
    }
    let wav = vlc_wav(path, cache)?;
    decode(&wav.to_string_lossy())?.ok_or_else(|| "The clip's sound couldn't be read.".into())
}

// ---- libVLC: its own instance, so the Video section's player and converter are left alone

// The video module declares these with its own pointer types; here they stay opaque.
#[allow(clashing_extern_declarations)]
#[link(name = "vlc")]
extern "C" {
    fn libvlc_new(argc: c_int, argv: *const *const c_char) -> *mut c_void;
    fn libvlc_release(instance: *mut c_void);
    fn libvlc_media_new_path(instance: *mut c_void, path: *const c_char) -> *mut c_void;
    fn libvlc_media_add_option(media: *mut c_void, option: *const c_char);
    fn libvlc_media_release(media: *mut c_void);
    fn libvlc_media_player_new_from_media(media: *mut c_void) -> *mut c_void;
    fn libvlc_media_player_play(player: *mut c_void) -> c_int;
    fn libvlc_media_player_get_state(player: *mut c_void) -> c_int;
    fn libvlc_media_player_stop(player: *mut c_void);
    fn libvlc_media_player_release(player: *mut c_void);
}

const STATE_ENDED: c_int = 6;
const STATE_ERROR: c_int = 7;

fn cache_name(path: &str) -> String {
    let meta = std::fs::metadata(path).ok();
    let stamp = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    let size = meta.map_or(0, |m| m.len());
    format!("{:016x}.wav", xxhash_rust::xxh3::xxh3_64(format!("{path}\n{size}\n{stamp}").as_bytes()))
}

/// The sound of `path` as a 48 kHz stereo WAV in `cache`, converted by libVLC once.
fn vlc_wav(path: &str, cache: &Path) -> Result<PathBuf, String> {
    let dest = cache.join(cache_name(path));
    if dest.is_file() {
        return Ok(dest);
    }
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let part = dest.with_extension("part.wav");
    let chain = format!(":sout=#transcode{{vcodec=none,acodec=s16l,channels={CHANNELS},samplerate={RATE}}}:std{{access=file,mux=wav,dst='{}'}}", part.to_string_lossy().replace('\'', "\\'"));
    let failed = || "The clip's sound couldn't be converted (libVLC).".to_string();
    // SAFETY: libVLC objects created here are released here, in reverse order.
    unsafe {
        let args: Vec<CString> = ["--quiet", "--no-xlib", "--no-video"].iter().map(|a| CString::new(*a).expect("no NUL")).collect();
        let argv: Vec<*const c_char> = args.iter().map(|a| a.as_ptr()).collect();
        let instance = libvlc_new(argv.len() as c_int, argv.as_ptr());
        if instance.is_null() {
            return Err("libVLC isn't available.".into());
        }
        let c_path = CString::new(path).map_err(|_| failed())?;
        let media = libvlc_media_new_path(instance, c_path.as_ptr());
        if media.is_null() {
            libvlc_release(instance);
            return Err(failed());
        }
        let option = CString::new(chain).map_err(|_| failed())?;
        libvlc_media_add_option(media, option.as_ptr());
        let player = libvlc_media_player_new_from_media(media);
        libvlc_media_release(media);
        let mut ok = false;
        if !player.is_null() && libvlc_media_player_play(player) == 0 {
            let deadline = Instant::now() + Duration::from_secs(1800);
            loop {
                std::thread::sleep(Duration::from_millis(100));
                let state = libvlc_media_player_get_state(player);
                if state == STATE_ENDED {
                    ok = true;
                    break;
                }
                if state == STATE_ERROR || Instant::now() > deadline {
                    break;
                }
            }
            libvlc_media_player_stop(player);
        }
        if !player.is_null() {
            libvlc_media_player_release(player);
        }
        libvlc_release(instance);
        if !ok || std::fs::metadata(&part).map_or(true, |m| m.len() <= 44) {
            let _ = std::fs::remove_file(&part);
            return Err(failed());
        }
    }
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}
