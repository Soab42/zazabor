//! Side-panel effects: the equalizer, audio and subtitle delays, and the OpenSubtitles helpers
//! (file hash, a locked-down HTTPS request through `curl`, subtitle download).
//!
//! libVLC keeps equalizer and delays per media player, and a new player is made for every file,
//! so the UI re-applies them whenever a file opens.

use super::vlc::libvlc_media_player_t;
use super::{blocking, ensure_unlocked, wake, with_player};
use serde::Serialize;
use std::ffi::{c_char, c_int, c_uint, CStr};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[repr(C)]
pub struct libvlc_equalizer_t {
    _private: [u8; 0],
}

#[link(name = "vlc")]
extern "C" {
    fn libvlc_audio_equalizer_get_preset_count() -> c_uint;
    fn libvlc_audio_equalizer_get_preset_name(index: c_uint) -> *const c_char;
    fn libvlc_audio_equalizer_get_band_count() -> c_uint;
    fn libvlc_audio_equalizer_get_band_frequency(index: c_uint) -> f32;
    fn libvlc_audio_equalizer_new() -> *mut libvlc_equalizer_t;
    fn libvlc_audio_equalizer_new_from_preset(index: c_uint) -> *mut libvlc_equalizer_t;
    fn libvlc_audio_equalizer_release(eq: *mut libvlc_equalizer_t);
    fn libvlc_audio_equalizer_set_preamp(eq: *mut libvlc_equalizer_t, preamp: f32) -> c_int;
    fn libvlc_audio_equalizer_get_preamp(eq: *mut libvlc_equalizer_t) -> f32;
    fn libvlc_audio_equalizer_set_amp_at_index(eq: *mut libvlc_equalizer_t, amp: f32, band: c_uint) -> c_int;
    fn libvlc_audio_equalizer_get_amp_at_index(eq: *mut libvlc_equalizer_t, band: c_uint) -> f32;
    fn libvlc_media_player_set_equalizer(player: *mut libvlc_media_player_t, eq: *mut libvlc_equalizer_t) -> c_int;
    fn libvlc_audio_set_delay(player: *mut libvlc_media_player_t, delay: i64) -> c_int;
    fn libvlc_audio_get_delay(player: *mut libvlc_media_player_t) -> i64;
    fn libvlc_video_set_spu_delay(player: *mut libvlc_media_player_t, delay: i64) -> c_int;
    fn libvlc_video_get_spu_delay(player: *mut libvlc_media_player_t) -> i64;
}

/// The most a delay may be, either way, in milliseconds.
const MAX_DELAY_MS: i64 = 60_000;
/// Equalizer gain limits in dB (libVLC's own range).
const MAX_GAIN_DB: f32 = 20.0;

/// Milliseconds as libVLC's microseconds, limited to ±60 s.
pub(crate) fn delay_us(ms: i64) -> i64 {
    ms.clamp(-MAX_DELAY_MS, MAX_DELAY_MS) * 1000
}

/// libVLC's microseconds as whole milliseconds.
pub(crate) fn delay_ms(us: i64) -> i64 {
    us / 1000
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct EqPreset {
    pub(crate) index: u32,
    pub(crate) name: String,
    pub(crate) preamp: f32,
    pub(crate) bands: Vec<f32>,
}

#[derive(Serialize, Debug, Clone)]
pub struct EqInfo {
    /// Centre frequency of each band in Hz.
    pub(crate) frequencies: Vec<f32>,
    pub(crate) presets: Vec<EqPreset>,
}

/// Reads the preamp and band amplitudes, then frees the equalizer.
///
/// # Safety
/// `eq` must be a live equalizer from libVLC (or null, which yields `None`).
unsafe fn read_equalizer(eq: *mut libvlc_equalizer_t, bands: c_uint) -> Option<(f32, Vec<f32>)> {
    if eq.is_null() {
        return None;
    }
    let amps = (0..bands).map(|b| libvlc_audio_equalizer_get_amp_at_index(eq, b)).collect();
    let preamp = libvlc_audio_equalizer_get_preamp(eq);
    libvlc_audio_equalizer_release(eq);
    Some((preamp, amps))
}

pub(crate) fn equalizer_info() -> EqInfo {
    // SAFETY: the preset and band queries are static tables; every equalizer made here is
    // read and released by `read_equalizer`, and names are libVLC-owned NUL-terminated strings.
    unsafe {
        let band_count = libvlc_audio_equalizer_get_band_count();
        let frequencies = (0..band_count).map(|b| libvlc_audio_equalizer_get_band_frequency(b)).collect();
        let presets = (0..libvlc_audio_equalizer_get_preset_count())
            .filter_map(|index| {
                let name = libvlc_audio_equalizer_get_preset_name(index);
                if name.is_null() {
                    return None;
                }
                let name = CStr::from_ptr(name).to_string_lossy().into_owned();
                let (preamp, bands) = read_equalizer(libvlc_audio_equalizer_new_from_preset(index), band_count)?;
                Some(EqPreset { index, name, preamp, bands })
            })
            .collect();
        EqInfo { frequencies, presets }
    }
}

/// Applies (or, when `enabled` is false, removes) the equalizer on the current player.
pub(crate) fn apply_equalizer(enabled: bool, preamp: f32, bands: &[f32]) -> Result<(), String> {
    with_player(|p| {
        // SAFETY: see with_player; the equalizer is released after libVLC copied its settings.
        unsafe {
            if !enabled {
                libvlc_media_player_set_equalizer(p, std::ptr::null_mut());
                return Ok(());
            }
            let eq = libvlc_audio_equalizer_new();
            if eq.is_null() {
                return Err("The equalizer could not be created.".to_string());
            }
            libvlc_audio_equalizer_set_preamp(eq, preamp.clamp(-MAX_GAIN_DB, MAX_GAIN_DB));
            let count = libvlc_audio_equalizer_get_band_count() as usize;
            for (i, gain) in bands.iter().take(count).enumerate() {
                libvlc_audio_equalizer_set_amp_at_index(eq, gain.clamp(-MAX_GAIN_DB, MAX_GAIN_DB), i as c_uint);
            }
            let status = libvlc_media_player_set_equalizer(p, eq);
            libvlc_audio_equalizer_release(eq);
            if status == 0 {
                Ok(())
            } else {
                Err("The equalizer could not be applied.".to_string())
            }
        }
    })
    .unwrap_or(Ok(()))
}

/// Sets the audio and/or subtitle delay (ms) and returns what libVLC now reports for both.
pub(crate) fn set_delays(audio_ms: Option<i64>, subtitle_ms: Option<i64>) -> Option<(i64, i64)> {
    with_player(|p| {
        // SAFETY: see with_player.
        unsafe {
            if let Some(ms) = audio_ms {
                libvlc_audio_set_delay(p, delay_us(ms));
            }
            if let Some(ms) = subtitle_ms {
                libvlc_video_set_spu_delay(p, delay_us(ms));
            }
            (delay_ms(libvlc_audio_get_delay(p)), delay_ms(libvlc_video_get_spu_delay(p)))
        }
    })
}

#[tauri::command]
pub async fn video_eq_info() -> Result<EqInfo, String> {
    ensure_unlocked()?;
    Ok(equalizer_info())
}

#[tauri::command]
pub async fn video_set_equalizer(enabled: bool, preamp: f32, bands: Vec<f32>) -> Result<(), String> {
    ensure_unlocked()?;
    apply_equalizer(enabled, preamp, &bands)
}

#[tauri::command]
pub async fn video_set_audio_delay(ms: i64) -> Result<(), String> {
    ensure_unlocked()?;
    set_delays(Some(ms), None);
    wake();
    Ok(())
}

#[tauri::command]
pub async fn video_set_subtitle_delay(ms: i64) -> Result<(), String> {
    ensure_unlocked()?;
    set_delays(None, Some(ms));
    wake();
    Ok(())
}

// ---- OpenSubtitles -------------------------------------------------------------------------

const API_BASE: &str = "https://api.opensubtitles.com/api/v1";
const USER_AGENT: &str = "Zazabor v1.0";
const HASH_CHUNK: u64 = 64 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct FileHash {
    hash: String,
    size: u64,
}

/// OpenSubtitles' movie hash: the file size plus the little-endian u64 words of the first and
/// last 64 KiB, wrapping.
pub(crate) fn movie_hash(path: &Path) -> Result<FileHash, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("Could not read the video: {e}"))?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size < HASH_CHUNK {
        return Err("This file is too small to hash.".into());
    }
    let mut sum = size;
    let mut chunk = vec![0u8; HASH_CHUNK as usize];
    for start in [0, size - HASH_CHUNK] {
        file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        file.read_exact(&mut chunk).map_err(|e| e.to_string())?;
        for word in chunk.chunks_exact(8) {
            sum = sum.wrapping_add(u64::from_le_bytes(word.try_into().expect("8 bytes")));
        }
    }
    Ok(FileHash { hash: format!("{sum:016x}"), size })
}

#[tauri::command]
pub async fn video_file_hash(path: String) -> Result<FileHash, String> {
    ensure_unlocked()?;
    blocking(move || movie_hash(Path::new(&path))).await
}

/// A value for a curl config file's quoted string.
fn curl_quote(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\0' => {}
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Runs curl with its options read from stdin (so keys and tokens never show in `ps`).
fn run_curl(config: &str) -> Result<Vec<u8>, String> {
    let mut child = Command::new("curl")
        .args(["-q", "-K", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "The online source needs curl, which could not be started.".to_string())?;
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(config.as_bytes())
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let why = String::from_utf8_lossy(&output.stderr);
        let why = why.lines().next().unwrap_or("").trim();
        return Err(if why.is_empty() { "The online request failed.".to_string() } else { format!("The online request failed: {why}") });
    }
    Ok(output.stdout)
}

fn is_token(value: &str, extra: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && value.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

/// An API path such as `/subtitles?query=x`; no scheme, no host, no spaces.
fn valid_api_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && path.len() <= 2048
        && path.chars().all(|c| c.is_ascii_alphanumeric() || "/_?&=.,%:-+".contains(c))
}

#[derive(Serialize, Debug)]
pub struct OnlineReply {
    status: u16,
    body: String,
}

/// Builds the curl config for an API call (pure, so it can be tested).
fn api_config(method: &str, path: &str, api_key: &str, token: Option<&str>, body: Option<&str>) -> Result<String, String> {
    if method != "GET" && method != "POST" {
        return Err("Unsupported request.".into());
    }
    if !valid_api_path(path) || !is_token(api_key, "") || token.is_some_and(|t| !is_token(t, "._-")) {
        return Err("Invalid request.".into());
    }
    let mut config = format!(
        "silent\nshow-error\nmax-time = 30\nmax-filesize = 3000000\nuser-agent = {}\nurl = {}\nrequest = \"{method}\"\nheader = \"Accept: application/json\"\nheader = {}\n",
        curl_quote(USER_AGENT),
        curl_quote(&format!("{API_BASE}{path}")),
        curl_quote(&format!("Api-Key: {api_key}")),
    );
    if let Some(token) = token {
        config.push_str(&format!("header = {}\n", curl_quote(&format!("Authorization: Bearer {token}"))));
    }
    if let Some(body) = body {
        config.push_str("header = \"Content-Type: application/json\"\n");
        config.push_str(&format!("data = {}\n", curl_quote(body)));
    }
    config.push_str("write-out = \"\\n%{http_code}\"\n");
    Ok(config)
}

/// Splits curl's output (body, newline, status code).
fn split_reply(output: &[u8]) -> Result<OnlineReply, String> {
    let text = String::from_utf8_lossy(output);
    let (body, status) = text.rsplit_once('\n').ok_or("The online reply was empty.")?;
    let status = status.trim().parse().map_err(|_| "The online reply was not understood.".to_string())?;
    Ok(OnlineReply { status, body: body.to_string() })
}

/// One call to the OpenSubtitles REST API (v1); only that host is ever contacted.
#[tauri::command]
pub async fn video_online_request(
    method: String,
    path: String,
    api_key: String,
    token: Option<String>,
    body: Option<String>,
) -> Result<OnlineReply, String> {
    ensure_unlocked()?;
    let config = api_config(&method, &path, &api_key, token.as_deref(), body.as_deref())?;
    blocking(move || split_reply(&run_curl(&config)?)).await
}

/// Only OpenSubtitles hosts may be downloaded from.
fn allowed_download(url: &str) -> bool {
    let Ok(url) = url::Url::parse(url) else { return false };
    let Some(host) = url.host_str() else { return false };
    url.scheme() == "https"
        && ["opensubtitles.com", "opensubtitles.org"]
            .iter()
            .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// A safe file name with a subtitle extension.
fn subtitle_file_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || " .-_()[]".contains(c) { c } else { '_' })
        .collect();
    let clean = clean.trim_matches(|c: char| c == '.' || c == ' ');
    let clean = if clean.is_empty() { "subtitle" } else { clean };
    let lower = clean.to_lowercase();
    if [".srt", ".vtt", ".ass", ".ssa"].iter().any(|e| lower.ends_with(e)) {
        clean.to_string()
    } else {
        format!("{clean}.srt")
    }
}

/// Downloads a subtitle file into a cache folder and returns its path.
#[tauri::command]
pub async fn video_online_download(url: String, name: String) -> Result<String, String> {
    ensure_unlocked()?;
    if !allowed_download(&url) {
        return Err("That download address is not allowed.".into());
    }
    blocking(move || {
        let dir: PathBuf = std::env::temp_dir().join("zazabor-subtitles");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let target = dir.join(subtitle_file_name(&name));
        let config = format!(
            "silent\nshow-error\nfail\nlocation\nmax-time = 60\nmax-filesize = 5000000\nuser-agent = {}\nurl = {}\noutput = {}\n",
            curl_quote(USER_AGENT),
            curl_quote(&url),
            curl_quote(&target.to_string_lossy()),
        );
        run_curl(&config)?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_convert_between_milliseconds_and_microseconds() {
        assert_eq!(delay_us(250), 250_000);
        assert_eq!(delay_us(-1500), -1_500_000);
        assert_eq!(delay_us(10_000_000), 60_000_000);
        assert_eq!(delay_us(-10_000_000), -60_000_000);
        assert_eq!(delay_ms(250_000), 250);
        assert_eq!(delay_ms(delay_us(-50)), -50);
    }

    #[test]
    fn libvlc_lists_equalizer_presets() {
        let info = equalizer_info();
        assert_eq!(info.frequencies.len(), 10);
        assert!(info.frequencies.windows(2).all(|w| w[0] < w[1]));
        let names: Vec<&str> = info.presets.iter().map(|p| p.name.as_str()).collect();
        assert!(names.contains(&"Flat") && names.contains(&"Rock") && names.contains(&"Classical"), "{names:?}");
        assert!(info.presets.iter().all(|p| p.bands.len() == 10));
        let flat = info.presets.iter().find(|p| p.name == "Flat").unwrap();
        assert!(flat.bands.iter().all(|b| b.abs() < 0.01));
        let rock = info.presets.iter().find(|p| p.name == "Rock").unwrap();
        assert!(rock.bands.iter().any(|b| b.abs() > 1.0));
    }

    #[test]
    fn movie_hash_matches_the_reference_algorithm() {
        let dir = std::env::temp_dir().join(format!("zazabor-fx-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.bin");
        let size = 200_000usize;
        let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        std::fs::write(&file, &data).unwrap();
        let mut expected = size as u64;
        for range in [0..65536, size - 65536..size] {
            for word in data[range].chunks_exact(8) {
                expected = expected.wrapping_add(u64::from_le_bytes(word.try_into().unwrap()));
            }
        }
        let got = movie_hash(&file).unwrap();
        assert_eq!(got.size, size as u64);
        assert_eq!(got.hash, format!("{expected:016x}"));
        std::fs::write(&file, b"tiny").unwrap();
        assert!(movie_hash(&file).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn requests_are_limited_to_the_api() {
        assert!(valid_api_path("/subtitles?query=a%20b&languages=en"));
        assert!(!valid_api_path("//evil.example/x"));
        assert!(!valid_api_path("https://evil.example"));
        assert!(!valid_api_path("/a b"));
        assert!(api_config("DELETE", "/x", "key", None, None).is_err());
        assert!(api_config("GET", "/x", "ke\"y", None, None).is_err());
        let config = api_config("POST", "/login", "abc123", Some("t.k-n"), Some("{\"a\":\"b\\c\"}")).unwrap();
        assert!(config.contains("data = \"{\\\"a\\\":\\\"b\\\\c\\\"}\""));
        assert!(config.contains("Api-Key: abc123"));
        assert!(allowed_download("https://dl.opensubtitles.com/x.srt"));
        assert!(allowed_download("https://www.opensubtitles.org/x"));
        assert!(!allowed_download("http://dl.opensubtitles.com/x"));
        assert!(!allowed_download("https://opensubtitles.com.evil.example/x"));
        assert!(!allowed_download("file:///etc/passwd"));
    }

    #[test]
    fn subtitle_names_are_safe() {
        assert_eq!(subtitle_file_name("../../etc/passwd"), "_.._etc_passwd.srt");
        assert_eq!(subtitle_file_name("Show S01E02.ass"), "Show S01E02.ass");
        assert_eq!(subtitle_file_name(""), "subtitle.srt");
        assert_eq!(curl_quote("a\"b\n"), "\"a\\\"b\\n\"");
        let reply = split_reply(b"{\"x\":1}\n200").unwrap();
        assert_eq!((reply.status, reply.body.as_str()), (200, "{\"x\":1}"));
    }
}
