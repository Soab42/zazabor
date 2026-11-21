//! Live TV: channels from the M3U / M3U8 playlists the user adds (a URL or a file). They are read
//! here (the page can't reach most servers), kept in `tv.db` with the user's favourites and the
//! channels watched last, and their logos are cached like posters. Nothing is fetched until the
//! user adds a playlist.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::catalog::{db_err, make_id, Result};

const LIST_LIMIT: u64 = 5 << 20;

#[derive(Debug, Clone, Deserialize)]
pub struct Source {
    pub id: String,
    /// An http(s) URL, a file:// URL or a path.
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Parsed {
    pub name: String,
    pub tvg_id: String,
    pub logo: String,
    pub group: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub source: String,
    pub name: String,
    pub tvg_id: String,
    /// The cached logo's file, when it is there.
    pub logo: Option<String>,
    pub has_logo: bool,
    pub group: String,
    pub url: String,
    pub fav: bool,
    pub watched: i64,
    /// "online", "offline" or "" (not checked).
    pub status: String,
}

/// `key="value"` pairs of an #EXTINF line, and the display name after the first comma outside quotes.
fn split_extinf(line: &str) -> (Vec<(String, String)>, String) {
    let body = line.trim_start_matches("#EXTINF:");
    let mut quoted = false;
    let mut comma = None;
    for (i, c) in body.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                comma = Some(i);
                break;
            }
            _ => {}
        }
    }
    let (head, name) = match comma {
        Some(i) => (&body[..i], body[i + 1..].trim().to_string()),
        None => (body, String::new()),
    };
    let mut attrs = Vec::new();
    let mut rest = head;
    while let Some(eq) = rest.find("=\"") {
        let key = rest[..eq].rsplit(|c: char| c.is_whitespace()).next().unwrap_or("").to_ascii_lowercase();
        let after = &rest[eq + 2..];
        let Some(end) = after.find('"') else { break };
        attrs.push((key, after[..end].trim().to_string()));
        rest = &after[end + 1..];
    }
    (attrs, name)
}

/// Reads an M3U / M3U8 playlist: each #EXTINF line with the URL line that follows it. Lines that
/// aren't http(s)/rtmp/rtsp/udp streams are skipped.
pub fn parse_m3u(text: &str) -> Vec<Parsed> {
    let mut out = Vec::new();
    let mut pending: Option<Parsed> = None;
    let mut group_line = String::new();
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("#EXTINF") {
            let (attrs, name) = split_extinf(line);
            let get = |k: &str| attrs.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone()).unwrap_or_default();
            let display = if name.is_empty() { get("tvg-name") } else { name };
            pending = Some(Parsed { name: display, tvg_id: get("tvg-id"), logo: get("tvg-logo"), group: get("group-title"), url: String::new() });
        } else if let Some(g) = line.strip_prefix("#EXTGRP:") {
            group_line = g.trim().to_string();
        } else if line.starts_with('#') {
            continue;
        } else {
            let scheme_ok = ["http://", "https://", "rtmp://", "rtsp://", "udp://", "mms://"].iter().any(|s| line.to_ascii_lowercase().starts_with(s));
            if let (Some(mut p), true) = (pending.take(), scheme_ok) {
                p.url = line.to_string();
                if p.group.is_empty() {
                    p.group = std::mem::take(&mut group_line);
                }
                if p.name.is_empty() {
                    p.name = p.tvg_id.clone();
                }
                if p.name.is_empty() {
                    p.name = line.to_string();
                }
                out.push(p);
            }
            group_line.clear();
        }
    }
    out
}

pub fn schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS channels (
           id TEXT PRIMARY KEY, source TEXT NOT NULL, name TEXT NOT NULL, tvg_id TEXT NOT NULL DEFAULT '',
           logo_url TEXT NOT NULL DEFAULT '', logo TEXT NOT NULL DEFAULT '', grp TEXT NOT NULL DEFAULT '',
           url TEXT NOT NULL, fav INTEGER NOT NULL DEFAULT 0, watched INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL DEFAULT '', checked INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS channels_source ON channels(source);",
    )
    .map_err(db_err)
}

/// Fetches a playlist: over HTTP(S) or from a file, at most 5 MB.
pub fn fetch(url: &str) -> Result<String> {
    let lower = url.to_ascii_lowercase();
    let bytes = if lower.starts_with("http://") || lower.starts_with("https://") {
        super::listing::get_bytes(&super::listing::agent(6, 20), url, LIST_LIMIT)?
    } else {
        let path = url.strip_prefix("file://").map(super::listing::decode).unwrap_or_else(|| url.to_string());
        let meta = std::fs::metadata(&path).map_err(|e| format!("Can't read {path}: {e}"))?;
        if meta.len() > LIST_LIMIT {
            return Err(format!("{path} is bigger than 5 MB: that's not a channel list"));
        }
        std::fs::read(&path).map_err(|e| format!("Can't read {path}: {e}"))?
    };
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Stores a source's channels, keeping favourites, watch times and checked status of the ones
/// that stay and dropping the ones the playlist no longer has. Returns the channel count.
pub fn store(conn: &mut Connection, source: &str, parsed: &[Parsed]) -> Result<usize> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut keep = Vec::new();
    {
        let mut up = tx
            .prepare(
                "INSERT INTO channels(id,source,name,tvg_id,logo_url,grp,url,pos) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(id) DO UPDATE SET name=?3, tvg_id=?4, logo_url=?5, grp=?6, pos=?8,
                   logo=CASE WHEN logo_url=?5 THEN logo ELSE '' END",
            )
            .map_err(db_err)?;
        for (pos, p) in parsed.iter().enumerate() {
            let id = make_id(&format!("{source}|{}", p.url));
            if keep.contains(&id) {
                continue;
            }
            up.execute(params![id, source, p.name, p.tvg_id, p.logo, p.group, p.url, pos as i64]).map_err(db_err)?;
            keep.push(id);
        }
    }
    let known: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM channels WHERE source=?1").map_err(db_err)?;
        let rows = stmt.query_map([source], |r| r.get::<_, String>(0)).map_err(db_err)?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for id in known.iter().filter(|id| !keep.contains(id)) {
        tx.execute("DELETE FROM channels WHERE id=?1", [id]).map_err(db_err)?;
    }
    tx.commit().map_err(db_err)?;
    Ok(keep.len())
}

pub fn remove_other_sources(conn: &Connection, keep: &[String]) {
    if keep.is_empty() {
        let _ = conn.execute("DELETE FROM channels", []);
        return;
    }
    let marks = vec!["?"; keep.len()].join(",");
    let _ = conn.execute(&format!("DELETE FROM channels WHERE source NOT IN ({marks})"), rusqlite::params_from_iter(keep.iter()));
}

pub fn list(conn: &Connection) -> Result<Vec<Channel>> {
    let mut stmt = conn.prepare("SELECT id,source,name,tvg_id,logo,logo_url,grp,url,fav,watched,status FROM channels ORDER BY source,pos").map_err(db_err)?;
    let rows = stmt
        .query_map([], |r| {
            let logo: String = r.get(4)?;
            let logo_url: String = r.get(5)?;
            Ok(Channel {
                id: r.get(0)?,
                source: r.get(1)?,
                name: r.get(2)?,
                tvg_id: r.get(3)?,
                has_logo: !logo_url.is_empty(),
                logo: (!logo.is_empty() && Path::new(&logo).exists()).then_some(logo),
                group: r.get(6)?,
                url: r.get(7)?,
                fav: r.get::<_, i64>(8)? == 1,
                watched: r.get(9)?,
                status: r.get(10)?,
            })
        })
        .map_err(db_err)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn set_fav(conn: &Connection, id: &str, on: bool) {
    let _ = conn.execute("UPDATE channels SET fav=?2 WHERE id=?1", params![id, on as i64]);
}

pub fn mark_watched(conn: &Connection, id: &str, now: i64) {
    let _ = conn.execute("UPDATE channels SET watched=?2 WHERE id=?1", params![id, now]);
}

pub fn set_status(conn: &Connection, id: &str, status: &str, now: i64) {
    let _ = conn.execute("UPDATE channels SET status=?2, checked=?3 WHERE id=?1", params![id, status, now]);
}

/// (url, logo_url, logo path, last checked) of a channel.
pub fn lookup(conn: &Connection, id: &str) -> Option<(String, String, String, i64)> {
    conn.query_row("SELECT url,logo_url,logo,checked FROM channels WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).ok()
}

pub fn set_logo(conn: &Connection, id: &str, path: &str) {
    let _ = conn.execute("UPDATE channels SET logo=?2 WHERE id=?1", params![id, path]);
}

pub fn clear_logos(conn: &Connection) {
    let _ = conn.execute("UPDATE channels SET logo=''", []);
}

/// Downloads a logo and keeps it as a small PNG (so transparency stays); None when it isn't a
/// picture this app reads (an SVG, say).
pub fn fetch_logo(dir: &Path, logo_url: &str) -> Result<Option<PathBuf>> {
    if !(logo_url.starts_with("http://") || logo_url.starts_with("https://")) {
        return Ok(None);
    }
    let path = dir.join(format!("{}.png", make_id(logo_url)));
    if path.exists() {
        return Ok(Some(path));
    }
    let bytes = super::listing::get_bytes(&super::listing::agent(4, 12), logo_url, 4 << 20)?;
    let Ok(image) = image::load_from_memory(&bytes) else { return Ok(None) };
    let small = image.thumbnail(192, 192);
    std::fs::create_dir_all(dir).map_err(|e| format!("Can't make the logo folder: {e}"))?;
    small.save_with_format(&path, image::ImageFormat::Png).map_err(|e| format!("Can't save a logo: {e}"))?;
    Ok(Some(path))
}

/// Does the stream answer? A GET whose body is never read, so it costs only the headers.
pub fn probe(url: &str) -> bool {
    let agent = super::listing::agent(3, 3);
    match agent.get(url).header("User-Agent", "Zazabor").call() {
        Ok(response) => (200..400).contains(&response.status().as_u16()),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\u{feff}#EXTM3U x-tvg-url=\"https://iptv-org.github.io/epg/guides/bd.xml\"
#EXTINF:-1 tvg-id=\"BTV.bd@SD\" tvg-name=\"BTV\" tvg-logo=\"https://i.imgur.com/abc.png\" group-title=\"General\",BTV (576p)
#EXTVLCOPT:http-referrer=https://example.com/
https://example.com/live/btv/index.m3u8
#EXTINF:-1 tvg-id=\"\" tvg-logo=\"\" group-title=\"News, Live\",Somoy TV, HD
http://10.0.0.5:8080/somoy.ts

#EXTINF:-1 tvg-name=\"Gazi TV\" group-title=\"\",
#EXTGRP:Sports
https://example.com/gazi.m3u8
#EXTINF:-1,No stream line follows
#EXTINF:-1,Local file
file:///etc/passwd
#EXTINF:-1,Plain
rtmp://example.com/live/plain
";

    #[test]
    fn reads_an_iptv_playlist() {
        let ch = parse_m3u(SAMPLE);
        assert_eq!(ch.len(), 4, "{ch:#?}");
        assert_eq!(ch[0], Parsed { name: "BTV (576p)".into(), tvg_id: "BTV.bd@SD".into(), logo: "https://i.imgur.com/abc.png".into(), group: "General".into(), url: "https://example.com/live/btv/index.m3u8".into() });
        assert_eq!((ch[1].name.as_str(), ch[1].group.as_str(), ch[1].url.as_str()), ("Somoy TV, HD", "News, Live", "http://10.0.0.5:8080/somoy.ts"));
        assert_eq!((ch[2].name.as_str(), ch[2].group.as_str()), ("Gazi TV", "Sports"));
        assert_eq!(ch[3].url, "rtmp://example.com/live/plain");
    }

    #[test]
    fn store_keeps_favourites_and_drops_gone_channels() {
        let mut c = Connection::open_in_memory().unwrap();
        schema(&c).unwrap();
        let ch = parse_m3u(SAMPLE);
        assert_eq!(store(&mut c, "s1", &ch).unwrap(), 4);
        let id = list(&c).unwrap()[0].id.clone();
        set_fav(&c, &id, true);
        mark_watched(&c, &id, 55);
        set_status(&c, &id, "offline", 9);
        assert_eq!(store(&mut c, "s1", &ch[..2]).unwrap(), 2);
        let now = list(&c).unwrap();
        assert_eq!(now.len(), 2);
        assert!(now[0].fav && now[0].watched == 55 && now[0].status == "offline");
        assert_eq!(store(&mut c, "s2", &ch[..1]).unwrap(), 1);
        assert_eq!(list(&c).unwrap().len(), 3);
        remove_other_sources(&c, &["s2".to_string()]);
        assert_eq!(list(&c).unwrap().len(), 1);
    }

    #[test]
    fn files_are_read_and_capped() {
        let dir = std::env::temp_dir().join(format!("zazabor-tv-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.m3u");
        std::fs::write(&file, SAMPLE).unwrap();
        assert_eq!(parse_m3u(&fetch(file.to_str().unwrap()).unwrap()).len(), 4);
        std::fs::write(&file, vec![b'a'; (LIST_LIMIT + 1) as usize]).unwrap();
        assert!(fetch(file.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
