//! Network streams and IPTV playlists. A pasted M3U/M3U8 URL is downloaded and parsed into a list
//! of channels (`#EXTINF` entries); the channels are stored on disk (a big IPTV list would bloat
//! the settings file) and the UI keeps only the playlist's name and id.
//!
//! The download shells out to `curl` (HTTP and HTTPS only); the app has no HTTP client of its own.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::AppHandle;

use super::library;

/// Where libVLC can play from, as URL schemes.
const SCHEMES: &[&str] = &[
    "http", "https", "rtsp", "rtsps", "rtmp", "rtmps", "rtp", "udp", "mms", "mmsh", "mmst", "srt", "ftp",
];
const MAX_DOWNLOAD_BYTES: &str = "33554432";
const DOWNLOAD_SECONDS: &str = "25";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Channel {
    pub name: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// The `tvg-id` attribute, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Default, PartialEq)]
pub struct Parsed {
    /// From `#PLAYLIST:`.
    pub title: Option<String>,
    pub channels: Vec<Channel>,
    /// The text is an HLS media playlist (`#EXT-X-…`): one stream, not a list of channels.
    pub hls: bool,
    /// The text starts with `#EXTM3U` or has `#EXTINF` lines.
    pub is_m3u: bool,
}

fn has_stream_scheme(line: &str) -> bool {
    line.split_once("://").is_some_and(|(scheme, _)| SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()))
}

/// Attributes like `tvg-logo="http://x/y.png"` and the channel name after the last comma that is
/// outside quotes, from the text after `#EXTINF:`.
fn parse_extinf(rest: &str) -> (Vec<(String, String)>, String) {
    let mut attrs = Vec::new();
    let mut in_quotes = false;
    let mut name_at = None;
    for (i, c) in rest.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                name_at = Some(i + 1);
                break;
            }
            _ => {}
        }
    }
    let head = name_at.map_or(rest, |n| &rest[..n - 1]);
    let name = name_at.map(|n| rest[n..].trim().to_string()).unwrap_or_default();

    // `key="value"` or `key=value`, keys made of letters, digits, `-` and `_`.
    let chars: Vec<(usize, char)> = head.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        let start = i;
        while i < chars.len() && (chars[i].1.is_alphanumeric() || chars[i].1 == '-' || chars[i].1 == '_') {
            i += 1;
        }
        if i > start && i < chars.len() && chars[i].1 == '=' {
            let key = head[chars[start].0..chars[i].0].to_ascii_lowercase();
            i += 1;
            let value = if i < chars.len() && chars[i].1 == '"' {
                i += 1;
                let begin = i;
                while i < chars.len() && chars[i].1 != '"' {
                    i += 1;
                }
                let value = head[chars.get(begin).map_or(head.len(), |c| c.0)..chars.get(i).map_or(head.len(), |c| c.0)].to_string();
                i += 1;
                value
            } else {
                let begin = i;
                while i < chars.len() && !chars[i].1.is_whitespace() {
                    i += 1;
                }
                head[chars.get(begin).map_or(head.len(), |c| c.0)..chars.get(i).map_or(head.len(), |c| c.0)].to_string()
            };
            attrs.push((key, value));
        } else if i == start {
            i += 1;
        }
    }
    (attrs, name)
}

/// A readable name for an entry that has none: the last path segment, or the host.
fn name_from_url(url: &str) -> String {
    let after = url.split_once("://").map_or(url, |(_, rest)| rest);
    let path = after.split(['?', '#']).next().unwrap_or(after);
    let segment = path.trim_end_matches('/').rsplit('/').next().unwrap_or(path);
    let host = path.split('/').next().unwrap_or(path);
    let name = if segment.is_empty() || segment == host { host } else { segment };
    name.trim_start_matches('@').to_string()
}

/// Parses M3U/M3U8 text. Relative entries resolve against `base` (the playlist's own URL) and are
/// dropped without one; lines that are not a stream URL are skipped along with their `#EXTINF`.
pub fn parse_m3u(text: &str, base: Option<&url::Url>) -> Parsed {
    let mut out = Parsed::default();
    let mut pending: Option<Channel> = None;
    let mut group: Option<String> = None;
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(tag) = line.strip_prefix('#') {
            let upper = tag.to_ascii_uppercase();
            if upper.starts_with("EXTM3U") {
                out.is_m3u = true;
            } else if upper.starts_with("EXT-X-") {
                out.hls = true;
            } else if let Some(rest) = tag.get("EXTINF:".len()..).filter(|_| upper.starts_with("EXTINF:")) {
                out.is_m3u = true;
                let (attrs, name) = parse_extinf(rest);
                let attr = |key: &str| attrs.iter().find(|(k, v)| k == key && !v.is_empty()).map(|(_, v)| v.clone());
                pending = Some(Channel {
                    name: if name.is_empty() { attr("tvg-name").unwrap_or_default() } else { name },
                    url: String::new(),
                    logo: attr("tvg-logo"),
                    group: attr("group-title"),
                    id: attr("tvg-id"),
                });
            } else if let Some(rest) = tag.get("EXTGRP:".len()..).filter(|_| upper.starts_with("EXTGRP:")) {
                let rest = rest.trim();
                group = (!rest.is_empty()).then(|| rest.to_string());
            } else if let Some(rest) = tag.get("PLAYLIST:".len()..).filter(|_| upper.starts_with("PLAYLIST:")) {
                let rest = rest.trim();
                out.title = (!rest.is_empty()).then(|| rest.to_string());
            }
            continue;
        }
        // A URL line closes the pending #EXTINF, whether or not the URL turns out to be usable.
        let entry = pending.take();
        let entry_group = group.take();
        let url = if has_stream_scheme(line) {
            Some(line.to_string())
        } else if line.contains("://") || line.contains(char::is_whitespace) {
            None
        } else {
            base.and_then(|b| b.join(line).ok()).map(|u| u.to_string()).filter(|u| has_stream_scheme(u))
        };
        let Some(url) = url else { continue };
        let mut channel = entry.unwrap_or_default();
        if channel.name.is_empty() {
            channel.name = name_from_url(&url);
        }
        channel.url = url;
        channel.group = channel.group.or(entry_group);
        out.channels.push(channel);
    }
    out
}

/// Plain `http(s)` URLs that name a playlist file are downloaded and read as one; anything else
/// (a radio stream that never ends, an `rtsp://` camera) is played directly.
pub fn looks_like_playlist(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else { return false };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let path = parsed.path().to_ascii_lowercase();
    let query = parsed.query().unwrap_or("").to_ascii_lowercase();
    path.ends_with(".m3u") || path.ends_with(".m3u8") || path.ends_with("get.php") || path.contains("playlist") || query.contains("m3u")
}

fn download(url: &str) -> Result<String, String> {
    let output = Command::new("curl")
        .args(["--silent", "--show-error", "--location", "--fail", "--max-time", DOWNLOAD_SECONDS])
        .args(["--max-filesize", MAX_DOWNLOAD_BYTES, "--proto", "=http,https", "--proto-redir", "=http,https"])
        .args(["--user-agent", "CorePro", "--", url])
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "Couldn't download the playlist: curl isn't available.".to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.trim().lines().last().unwrap_or("").trim_start_matches("curl: ");
        return Err(if detail.is_empty() { "Couldn't download the playlist.".into() } else { format!("Couldn't download the playlist: {detail}") });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Ids name files, so only plain characters are allowed.
fn safe_id(id: &str) -> Option<&str> {
    (!id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then_some(id)
}

pub fn save_channels(dir: &Path, id: &str, channels: &[Channel]) -> Result<(), String> {
    let id = safe_id(id).ok_or("Invalid playlist id.")?;
    if library::write_json(&dir.join(format!("{id}.json")), &channels) {
        Ok(())
    } else {
        Err("Couldn't save the playlist.".into())
    }
}

pub fn load_channels(dir: &Path, id: &str) -> Result<Vec<Channel>, String> {
    let id = safe_id(id).ok_or("Invalid playlist id.")?;
    let bytes = std::fs::read(dir.join(format!("{id}.json"))).map_err(|_| "That playlist isn't stored any more.".to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// `"playlist"` (channels stored under the id) or `"stream"` (play the URL itself).
    pub kind: &'static str,
    pub title: Option<String>,
    pub count: usize,
}

fn import(dir: Option<&Path>, url: &str, id: &str, force: bool) -> Result<ImportResult, String> {
    let url = url.trim();
    let parsed_url = url::Url::parse(url).map_err(|_| "That isn't a valid address.".to_string())?;
    if !SCHEMES.contains(&parsed_url.scheme()) {
        return Err(format!("“{}” addresses can't be played.", parsed_url.scheme()));
    }
    let stream = ImportResult { kind: "stream", title: None, count: 0 };
    if !(looks_like_playlist(url) || force && matches!(parsed_url.scheme(), "http" | "https")) {
        return Ok(stream);
    }
    let text = download(url)?;
    let parsed = parse_m3u(&text, Some(&parsed_url));
    if parsed.hls {
        return Ok(stream);
    }
    if parsed.channels.is_empty() {
        return Err(if parsed.is_m3u { "That playlist has no playable entries." } else { "That address isn't a playlist." }.into());
    }
    let dir = dir.ok_or("Storage isn't ready.")?;
    save_channels(dir, id, &parsed.channels)?;
    Ok(ImportResult { kind: "playlist", title: parsed.title, count: parsed.channels.len() })
}

/// Reads what an address is. A playlist URL (`.m3u`, `.m3u8` or `force`) is downloaded, parsed and
/// its channels stored under `id`; a plain stream address is reported as a `stream`.
#[tauri::command]
pub async fn streams_import(app: AppHandle, url: String, id: String, force: Option<bool>) -> Result<ImportResult, String> {
    crate::ensure_unlocked()?;
    library::init(&app)?;
    tauri::async_runtime::spawn_blocking(move || import(library::streams_dir(), &url, &id, force.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())?
}

/// The stored channels of an imported playlist.
#[tauri::command]
pub async fn streams_channels(app: AppHandle, id: String) -> Result<Vec<Channel>, String> {
    crate::ensure_unlocked()?;
    library::init(&app)?;
    let dir = library::streams_dir().ok_or("Storage isn't ready.")?;
    tauri::async_runtime::spawn_blocking(move || load_channels(dir, &id)).await.map_err(|e| e.to_string())?
}

/// Deletes the stored channels of a playlist.
#[tauri::command]
pub async fn streams_forget(app: AppHandle, id: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    library::init(&app)?;
    let id = safe_id(&id).ok_or("Invalid playlist id.")?;
    if let Some(dir) = library::streams_dir() {
        let _ = std::fs::remove_file(dir.join(format!("{id}.json")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extinf_attributes_names_and_groups() {
        let text = "#EXTM3U x-tvg-url=\"http://epg\"\n#PLAYLIST:My TV\r\n\
            #EXTINF:-1 tvg-id=\"bbc.uk\" tvg-logo=\"http://x/l.png\" group-title=\"News, World\",BBC One, HD\r\n\
            http://host/bbc.m3u8\n\
            #EXTINF:-1,Plain Name\n#EXTGRP:Movies\nrtsp://cam/stream\n\
            #EXTVLCOPT:http-user-agent=x\nudp://@239.1.1.1:1234\n";
        let parsed = parse_m3u(text, None);
        assert!(parsed.is_m3u && !parsed.hls);
        assert_eq!(parsed.title.as_deref(), Some("My TV"));
        assert_eq!(parsed.channels.len(), 3);
        let first = &parsed.channels[0];
        assert_eq!(first.name, "BBC One, HD");
        assert_eq!(first.url, "http://host/bbc.m3u8");
        assert_eq!(first.id.as_deref(), Some("bbc.uk"));
        assert_eq!(first.logo.as_deref(), Some("http://x/l.png"));
        assert_eq!(first.group.as_deref(), Some("News, World"));
        assert_eq!(parsed.channels[1].name, "Plain Name");
        assert_eq!(parsed.channels[1].group.as_deref(), Some("Movies"));
        assert_eq!(parsed.channels[2].name, "239.1.1.1:1234", "unnamed entries are named after their address");
        assert_eq!(parsed.channels[2].group, None, "a group applies to one entry only");
    }

    #[test]
    fn relative_urls_resolve_against_the_playlist_url() {
        let base = url::Url::parse("http://iptv.example/lists/main.m3u").unwrap();
        let text = "#EXTM3U\n#EXTINF:-1,A\nchan/a.m3u8\n#EXTINF:-1,B\n/abs/b.ts\n#EXTINF:-1,C\n../c.ts\n";
        let urls: Vec<String> = parse_m3u(text, Some(&base)).channels.into_iter().map(|c| c.url).collect();
        assert_eq!(urls, ["http://iptv.example/lists/chan/a.m3u8", "http://iptv.example/abs/b.ts", "http://iptv.example/c.ts"]);
        assert!(parse_m3u(text, None).channels.is_empty(), "relative entries need a base");
    }

    #[test]
    fn bad_lines_are_skipped_without_shifting_names() {
        let text = "\u{feff}#EXTM3U\n\n#EXTINF:-1,Broken\nnot a url at all\n#EXTINF:-1,Good\nhttps://good/live\n\
            #EXTINF:-1,Odd scheme\njavascript://alert\nC:\\music\\a.mp3\n#EXTINF:oops\nhttp://after/x.ts\n";
        let channels = parse_m3u(text, None).channels;
        let pairs: Vec<(&str, &str)> = channels.iter().map(|c| (c.name.as_str(), c.url.as_str())).collect();
        assert_eq!(pairs, [("Good", "https://good/live"), ("x.ts", "http://after/x.ts")]);
    }

    #[test]
    fn hls_media_playlists_are_one_stream_not_channels() {
        let text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:9.9,\nhttp://h/seg1.ts\n#EXTINF:9.9,\nhttp://h/seg2.ts\n";
        let parsed = parse_m3u(text, None);
        assert!(parsed.hls && parsed.is_m3u);
        assert_eq!(parse_m3u("just text\nmore text", None), Parsed::default());
    }

    #[test]
    fn only_playlist_like_http_urls_are_downloaded() {
        assert!(looks_like_playlist("http://a/b/list.m3u"));
        assert!(looks_like_playlist("https://a/live.M3U8?token=1"));
        assert!(looks_like_playlist("http://panel/get.php?username=u&password=p&type=m3u_plus"));
        assert!(!looks_like_playlist("http://radio.example:8000/stream"));
        assert!(!looks_like_playlist("rtsp://cam/list.m3u"));
        assert!(!looks_like_playlist("not a url"));
    }

    #[test]
    fn plain_streams_are_not_downloaded_and_bad_addresses_are_refused() {
        assert_eq!(import(None, "rtsp://cam/stream", "x", false).unwrap().kind, "stream");
        assert_eq!(import(None, "http://radio:8000/live", "x", false).unwrap().kind, "stream");
        assert!(import(None, "ftp2://x/y", "x", false).is_err());
        assert!(import(None, "file:///etc/passwd", "x", true).is_err());
        assert!(import(None, "nonsense", "x", false).is_err());
    }

    #[test]
    fn channels_round_trip_on_disk_and_ids_cannot_escape() {
        let dir = std::env::temp_dir().join(format!("corepro-streams-{}", std::process::id()));
        let channels = vec![Channel { name: "A".into(), url: "http://a/1".into(), group: Some("G".into()), ..Channel::default() }];
        save_channels(&dir, "pl_1-a", &channels).unwrap();
        assert_eq!(load_channels(&dir, "pl_1-a").unwrap(), channels);
        assert!(save_channels(&dir, "../evil", &channels).is_err());
        assert!(load_channels(&dir, "a/b").is_err());
        assert!(load_channels(&dir, "missing").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
