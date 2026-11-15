//! yt-dlp: turns a YouTube video id into addresses libVLC can play.
//!
//! Zazabor downloads yt-dlp once from its official GitHub release (`yt-dlp_linux`), checks it
//! against that release's `SHA2-256SUMS`, and keeps it under `cast::data_dir()`. YouTube breaks
//! old versions, so a copy older than about a month is replaced, and so is one that fails. A
//! `yt-dlp` on PATH is used only when the download itself fails.
//!
//! The pick, in order: one stream with both picture and sound up to 1080p (HLS is fine); else the
//! best avc1/vp9 video up to 1080p plus the best audio, played as the video with
//! `:input-slave=<audio>`; else format 18 (360p MP4).

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

const RELEASES: &str = "https://github.com/yt-dlp/yt-dlp/releases";
const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 3600);
/// A copy that fails is replaced only if it is at least this old (a private or removed video
/// fails too, and that shouldn't fetch 35 MB every time).
const RETRY_AGE: Duration = Duration::from_secs(6 * 3600);
const MAX_BINARY: u64 = 300 << 20;
const RUN_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_HEIGHT: i64 = 1080;

#[cfg(target_arch = "aarch64")]
const ASSET: &str = "yt-dlp_linux_aarch64";
#[cfg(not(target_arch = "aarch64"))]
const ASSET: &str = "yt-dlp_linux";

/// One download at a time.
static FETCH: Mutex<()> = Mutex::new(());

/// What libVLC opens for a video, and what the page shows about it.
#[derive(Clone, Debug, Default)]
pub struct Resolved {
    pub url: String,
    /// libVLC media options (`:input-slave=<audio>`, `:http-user-agent=…`).
    pub options: Vec<String>,
    pub title: Option<String>,
    pub channel: Option<String>,
    pub thumbnail: Option<String>,
    pub live: bool,
    pub duration_ms: i64,
    /// The formats picked (`22`, `137+140`…), for logs.
    pub formats: String,
}

/// A YouTube video id: 11 characters of [A-Za-z0-9_-].
pub fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Resolves `video_id` with yt-dlp (blocking; run it on a worker thread).
pub fn resolve(video_id: &str) -> Result<Resolved, String> {
    if !valid_id(video_id) {
        return Err("That isn't a YouTube video id.".into());
    }
    let (binary, ours) = ensure()?;
    match run(&binary, video_id) {
        Ok(json) => parse(&json),
        Err(first) if ours && age(&binary).is_none_or(|a| a >= RETRY_AGE) => {
            // An old yt-dlp is the usual reason YouTube stops working: get the newest and retry.
            eprintln!("[cast] yt-dlp failed ({first}); fetching the newest");
            let _guard = FETCH.lock().unwrap_or_else(|e| e.into_inner());
            match download(&local_path()) {
                Ok(()) => parse(&run(&binary, video_id)?),
                Err(e) => {
                    eprintln!("[cast] yt-dlp download failed: {e}");
                    Err(first)
                }
            }
        }
        Err(e) => Err(e),
    }
}

fn local_path() -> PathBuf {
    super::data_dir().join("yt-dlp")
}

fn age(path: &Path) -> Option<Duration> {
    let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    SystemTime::now().duration_since(modified).ok()
}

/// The yt-dlp to run, and whether it is Zazabor's own copy (which may be replaced).
pub fn ensure() -> Result<(PathBuf, bool), String> {
    let _guard = FETCH.lock().unwrap_or_else(|e| e.into_inner());
    let path = local_path();
    let have = path.is_file();
    if have && age(&path).is_some_and(|a| a < MAX_AGE) {
        return Ok((path, true));
    }
    match download(&path) {
        Ok(()) => Ok((path, true)),
        Err(e) => {
            eprintln!("[cast] yt-dlp download failed: {e}");
            if have {
                return Ok((path, true));
            }
            on_path().map(|p| (p, false)).ok_or_else(|| format!("Couldn't get yt-dlp: {e}"))
        }
    }
}

fn on_path() -> Option<PathBuf> {
    std::env::var_os("PATH")?.to_str()?.split(':').map(|dir| Path::new(dir).join("yt-dlp")).find(|p| p.is_file())
}

fn agent(redirects: u32) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(20)))
        .timeout_global(Some(Duration::from_secs(600)))
        .max_redirects(redirects)
        .http_status_as_error(false)
        .build()
        .into()
}

/// The newest release's tag, from where /releases/latest redirects to.
fn latest_tag() -> Result<String, String> {
    let response = agent(0).get(&format!("{RELEASES}/latest")).header("User-Agent", "Zazabor").call().map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    let location = response.headers().get("location").and_then(|v| v.to_str().ok()).ok_or_else(|| format!("GitHub answered {} without a release", response.status().as_u16()))?;
    let tag = location.rsplit("/tag/").next().filter(|_| location.contains("/tag/")).unwrap_or("");
    if tag.is_empty() || tag.len() > 40 || !tag.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) {
        return Err(format!("unexpected release address {location}"));
    }
    Ok(tag.to_string())
}

/// The SHA-256 the sums file lists for `asset`.
pub(crate) fn sum_for(sums: &str, asset: &str) -> Option<[u8; 32]> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hex = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        if name != asset || hex.len() != 64 {
            return None;
        }
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
        }
        Some(out)
    })
}

/// Downloads the newest yt-dlp to `path`, checked against the release's SHA2-256SUMS.
fn download(path: &Path) -> Result<(), String> {
    let tag = latest_tag()?;
    let base = format!("{RELEASES}/download/{tag}");
    let sums = agent(10).get(&format!("{base}/SHA2-256SUMS")).header("User-Agent", "Zazabor").call().map_err(|e| format!("couldn't get the checksums: {e}"))?;
    if sums.status().as_u16() != 200 {
        return Err(format!("the checksums answered {}", sums.status().as_u16()));
    }
    let sums = sums.into_body().with_config().limit(1 << 20).read_to_string().map_err(|e| e.to_string())?;
    let want = sum_for(&sums, ASSET).ok_or("the release lists no checksum for yt-dlp")?;

    let response = agent(10).get(&format!("{base}/{ASSET}")).header("User-Agent", "Zazabor").call().map_err(|e| format!("couldn't download yt-dlp: {e}"))?;
    if response.status().as_u16() != 200 {
        return Err(format!("the download answered {}", response.status().as_u16()));
    }
    let dir = path.parent().ok_or("no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let part = path.with_extension("part");
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut reader = response.into_body().into_with_config().limit(MAX_BINARY).reader();
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("the download stopped: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if hasher.finalize().as_slice() != want {
        let _ = std::fs::remove_file(&part);
        return Err("the download didn't match the published checksum".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&part, path).map_err(|e| e.to_string())?;
    let _ = std::fs::write(path.with_extension("version"), &tag);
    eprintln!("[cast] yt-dlp {tag} ready");
    Ok(())
}

/// Runs yt-dlp for the video's JSON (no download, no user config, no cookies).
fn run(binary: &Path, video_id: &str) -> Result<Value, String> {
    let mut child = Command::new(binary)
        .args(["--ignore-config", "--no-playlist", "--no-warnings", "--socket-timeout", "15", "-J", "--"])
        .arg(format!("https://www.youtube.com/watch?v={video_id}"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't run yt-dlp: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no output")?;
    let mut stderr = child.stderr.take().ok_or("no output")?;
    let out = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = stdout.read_to_end(&mut v);
        v
    });
    let err = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = (&mut stderr).take(64 * 1024).read_to_end(&mut v);
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        v
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > RUN_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("yt-dlp took too long".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    if !status.success() {
        let line = stderr.lines().rev().find(|l| l.contains("ERROR")).or_else(|| stderr.lines().last()).unwrap_or("").trim();
        return Err(if line.is_empty() { format!("yt-dlp failed ({status})") } else { line.to_string() });
    }
    serde_json::from_slice(&stdout).map_err(|e| format!("yt-dlp's answer wasn't JSON: {e}"))
}

/// Builds the result from yt-dlp's JSON.
pub(crate) fn parse(json: &Value) -> Result<Resolved, String> {
    let formats = json.get("formats").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let pick = pick(formats).ok_or("YouTube offered no stream Zazabor can play")?;
    let text = |key: &str| json.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let mut options = Vec::new();
    if let Some(audio) = &pick.audio {
        options.push(format!(":input-slave={audio}"));
    }
    if let Some(agent) = &pick.user_agent {
        options.push(format!(":http-user-agent={agent}"));
    }
    Ok(Resolved {
        url: pick.url,
        options,
        title: text("title"),
        channel: text("channel").or_else(|| text("uploader")),
        thumbnail: text("thumbnail").filter(|t| t.starts_with("https://")),
        live: json.get("is_live").and_then(Value::as_bool).unwrap_or(false),
        duration_ms: json.get("duration").and_then(Value::as_f64).map(|d| (d * 1000.0) as i64).unwrap_or(0),
        formats: pick.formats,
    })
}

#[derive(Debug, PartialEq)]
pub(crate) struct Pick {
    pub url: String,
    pub audio: Option<String>,
    pub user_agent: Option<String>,
    pub formats: String,
}

fn field<'a>(f: &'a Value, key: &str) -> &'a str {
    f.get(key).and_then(Value::as_str).unwrap_or("")
}

fn number(f: &Value, key: &str) -> f64 {
    f.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

/// "none" means the stream has no such track; a missing codec means yt-dlp doesn't know.
fn has(f: &Value, key: &str) -> Option<bool> {
    match field(f, key) {
        "" => None,
        "none" => Some(false),
        _ => Some(true),
    }
}

fn playable(f: &Value) -> bool {
    let protocol = field(f, "protocol");
    !field(f, "url").is_empty()
        && matches!(protocol, "https" | "http" | "m3u8" | "m3u8_native")
        && !f.get("has_drm").and_then(Value::as_bool).unwrap_or(false)
        && field(f, "ext") != "mhtml"
}

fn height(f: &Value) -> i64 {
    f.get("height").and_then(Value::as_i64).unwrap_or(0)
}

/// libVLC decodes these from YouTube's video-only streams (not AV1, to spare slow PCs).
fn good_video_codec(f: &Value) -> bool {
    let codec = field(f, "vcodec");
    codec.starts_with("avc1") || codec.starts_with("vp9") || codec.starts_with("vp09")
}

/// The formats to play, in the order the module comment gives.
pub(crate) fn pick(formats: &[Value]) -> Option<Pick> {
    let usable: Vec<&Value> = formats.iter().filter(|f| playable(f)).collect();
    let agent = |f: &Value| f.get("http_headers").and_then(|h| h.get("User-Agent")).and_then(Value::as_str).map(String::from);
    let id = |f: &Value| field(f, "format_id").to_string();
    let muxed = |f: &&&Value| has(f, "vcodec") == Some(true) && has(f, "acodec") == Some(true);

    // 1. One stream with sound and picture, up to 1080p (format 18 is the last resort).
    if let Some(f) = usable
        .iter()
        .filter(muxed)
        .filter(|f| field(f, "format_id") != "18" && height(f) <= MAX_HEIGHT)
        .max_by(|a, b| (height(a), number(a, "tbr") as i64).cmp(&(height(b), number(b, "tbr") as i64)))
    {
        return Some(Pick { url: field(f, "url").into(), audio: None, user_agent: agent(f), formats: id(f) });
    }

    // 2. The best video up to 1080p in a codec libVLC handles, plus the best audio.
    let direct = |f: &Value| matches!(field(f, "protocol"), "https" | "http");
    let video = usable
        .iter()
        .filter(|f| has(f, "acodec") == Some(false) && has(f, "vcodec") == Some(true) && good_video_codec(f) && height(f) <= MAX_HEIGHT && height(f) > 0)
        .max_by(|a, b| {
            let key = |f: &Value| (height(f), direct(f), field(f, "vcodec").starts_with("avc1"), number(f, "fps") as i64, number(f, "tbr") as i64);
            key(a).cmp(&key(b))
        });
    let audio = usable.iter().filter(|f| has(f, "vcodec") == Some(false) && has(f, "acodec") == Some(true)).max_by(|a, b| {
        // The original language first, then not the "drc" (dynamic range compressed) copy,
        // then a direct file, then the bitrate.
        let key = |f: &Value| {
            let original = f.get("language_preference").and_then(Value::as_i64).unwrap_or(0);
            (original, !field(f, "format_id").contains("drc"), direct(f), (number(f, "abr").max(number(f, "tbr")) * 10.0) as i64)
        };
        key(a).cmp(&key(b))
    });
    if let (Some(v), Some(a)) = (video, audio) {
        return Some(Pick { url: field(v, "url").into(), audio: Some(field(a, "url").into()), user_agent: agent(v), formats: format!("{}+{}", id(v), id(a)) });
    }

    // 3. Format 18, then anything with sound and picture.
    usable
        .iter()
        .find(|f| field(f, "format_id") == "18")
        .or_else(|| usable.iter().filter(muxed).min_by_key(|f| height(f)))
        .map(|f| Pick { url: field(f, "url").into(), audio: None, user_agent: agent(f), formats: id(f) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn f(id: &str, protocol: &str, vcodec: &str, acodec: &str, height: i64, tbr: f64) -> Value {
        json!({"format_id": id, "protocol": protocol, "vcodec": vcodec, "acodec": acodec, "height": height, "tbr": tbr, "url": format!("https://v/{id}"), "ext": "mp4"})
    }

    #[test]
    fn prefers_a_muxed_stream_up_to_1080p() {
        let formats = vec![
            f("18", "https", "avc1.42001E", "mp4a.40.2", 360, 500.0),
            f("95", "m3u8_native", "avc1.4d401f", "mp4a.40.2", 720, 1500.0),
            f("96", "m3u8_native", "avc1.640028", "mp4a.40.2", 1080, 4000.0),
            f("301", "m3u8_native", "avc1.640032", "mp4a.40.2", 1440, 9000.0),
            f("137", "https", "avc1.640028", "none", 1080, 4000.0),
            f("140", "https", "none", "mp4a.40.2", 0, 128.0),
        ];
        let p = pick(&formats).unwrap();
        assert_eq!(p.formats, "96");
        assert_eq!(p.audio, None);
    }

    #[test]
    fn falls_back_to_video_plus_audio() {
        let mut opus = f("251", "https", "none", "opus", 0, 140.0);
        opus["abr"] = json!(140.0);
        let mut drc = f("251-drc", "https", "none", "opus", 0, 150.0);
        drc["abr"] = json!(150.0);
        let formats = vec![
            json!({"format_id": "sb0", "protocol": "mhtml", "vcodec": "none", "acodec": "none", "ext": "mhtml", "url": "https://sb"}),
            f("18", "https", "avc1.42001E", "mp4a.40.2", 360, 500.0),
            f("399", "https", "av01.0.08M.08", "none", 1080, 2000.0),
            f("248", "https", "vp9", "none", 1080, 2500.0),
            f("137", "https", "avc1.640028", "none", 1080, 4000.0),
            f("313", "https", "vp9", "none", 2160, 18000.0),
            f("140", "https", "none", "mp4a.40.2", 0, 129.0),
            opus,
            drc,
        ];
        let p = pick(&formats).unwrap();
        assert_eq!(p.formats, "137+251");
        assert_eq!(p.url, "https://v/137");
        assert_eq!(p.audio.as_deref(), Some("https://v/251"));
    }

    #[test]
    fn prefers_the_original_language_audio() {
        let mut dub = f("140-0", "https", "none", "mp4a.40.2", 0, 256.0);
        dub["language_preference"] = json!(-1);
        let mut original = f("140-1", "https", "none", "mp4a.40.2", 0, 128.0);
        original["language_preference"] = json!(10);
        let formats = vec![f("136", "https", "avc1.4d401f", "none", 720, 1000.0), dub, original];
        assert_eq!(pick(&formats).unwrap().formats, "136+140-1");
    }

    #[test]
    fn last_resort_is_format_18() {
        let mut drm = f("22", "https", "avc1", "mp4a", 720, 1000.0);
        drm["has_drm"] = json!(true);
        let formats = vec![drm, f("18", "https", "avc1.42001E", "mp4a.40.2", 360, 500.0), f("137", "http_dash_segments", "avc1", "none", 1080, 4000.0)];
        assert_eq!(pick(&formats).unwrap().formats, "18");
        assert!(pick(&[]).is_none());
    }

    #[test]
    fn reads_the_video_details() {
        let mut v = f("137", "https", "avc1.640028", "none", 1080, 4000.0);
        v["http_headers"] = json!({"User-Agent": "Mozilla/5.0 test"});
        let json = json!({
            "title": "Clip", "channel": "Someone", "thumbnail": "https://i.ytimg.com/vi/x/maxresdefault.jpg", "duration": 9.5, "is_live": false,
            "formats": [v, f("140", "https", "none", "mp4a.40.2", 0, 128.0)]
        });
        let r = parse(&json).unwrap();
        assert_eq!(r.url, "https://v/137");
        assert_eq!(r.options, vec![":input-slave=https://v/140".to_string(), ":http-user-agent=Mozilla/5.0 test".to_string()]);
        assert_eq!((r.title.as_deref(), r.channel.as_deref(), r.duration_ms), (Some("Clip"), Some("Someone"), 9500));
        assert!(parse(&json!({"formats": []})).is_err());
    }

    #[test]
    fn reads_checksums() {
        let sums = "0000000000000000000000000000000000000000000000000000000000000000  yt-dlp\nabababababababababababababababababababababababababababababababab  yt-dlp_linux\n";
        assert_eq!(sum_for(sums, "yt-dlp_linux"), Some([0xab; 32]));
        assert_eq!(sum_for(sums, "yt-dlp_linux_aarch64"), None);
    }

    #[test]
    fn checks_ids() {
        assert!(valid_id("jNQXAC9IVRw"));
        assert!(!valid_id("--exec=rm -"));
        assert!(!valid_id("short"));
    }
}
