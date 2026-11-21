//! Talking to a DhakaFlix server (nginx with h5ai directory listings) and reading what it says:
//! the front page's links (the categories), and a folder's children.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

pub type Result<T> = std::result::Result<T, String>;

/// One child of a folder.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// The decoded name, without a trailing "/".
    pub name: String,
    /// The server's own (percent-encoded) path, with a trailing "/" for a folder.
    pub href: String,
    pub is_dir: bool,
    pub size: u64,
    /// Modified time in Unix ms.
    pub time: i64,
}

/// A category of the front page: a folder tree of movies or episodes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub url: String,
    pub label: String,
    /// "movies", "tv", "animation" or "indian": which page of the section shows it.
    pub section: String,
    /// Its folders hold series (seasons and episodes) rather than single films.
    pub series: bool,
    pub default_on: bool,
}

/// What the front page lists when it can't be read (the server as of 2026).
pub const DEFAULTS: [(&str, &str); 19] = [
    ("http://172.16.50.14/DHAKA-FLIX-14/Animation%20Movies/", "Animation Movies"),
    ("http://172.16.50.14/DHAKA-FLIX-14/Animation%20Movies%20%281080p%29/", "Animation Movies 1080p"),
    ("http://172.16.50.14/DHAKA-FLIX-14/English%20Movies%20%281080p%29/", "English Movies 1080p"),
    ("http://172.16.50.14/DHAKA-FLIX-14/Hindi%20Movies/", "Hindi Movies"),
    ("http://172.16.50.14/DHAKA-FLIX-14/IMDb%20Top-250%20Movies/", "IMDb Top 250"),
    ("http://172.16.50.14/DHAKA-FLIX-14/KOREAN%20TV%20%26%20WEB%20Series/", "Korean TV & Web Series"),
    ("http://172.16.50.14/DHAKA-FLIX-14/SOUTH%20INDIAN%20MOVIES/Hindi%20Dubbed/", "South Indian Hindi Dubbed"),
    ("http://172.16.50.14/DHAKA-FLIX-14/SOUTH%20INDIAN%20MOVIES/South%20Movies/", "South Indian Movies"),
    ("http://172.16.50.7/DHAKA-FLIX-7/3D%20Movies/", "3D Movies"),
    ("http://172.16.50.7/DHAKA-FLIX-7/English%20Movies/", "English Movies"),
    ("http://172.16.50.7/DHAKA-FLIX-7/Foreign%20Language%20Movies/", "Foreign Language Movies"),
    ("http://172.16.50.7/DHAKA-FLIX-7/Kolkata%20Bangla%20Movies/", "Kolkata Bangla Movies"),
    ("http://172.16.50.12/DHAKA-FLIX-12/TV-WEB-Series/", "TV & Web Series"),
    ("http://172.16.50.10/DHAKA-FLIX-10/Anime%20%26%20Cartoon%20TV%20Series/", "Anime & Cartoon TV Series"),
    ("http://172.16.50.10/DHAKA-FLIX-10/Awards%20%26%20TV%20Shows/", "Awards & TV Shows"),
    ("http://172.16.50.10/DHAKA-FLIX-10/Documentary/", "Documentary"),
    ("http://172.16.50.10/DHAKA-FLIX-10/WWE%20%26%20AEW%20Wrestling/", "WWE & AEW Wrestling"),
    ("http://172.16.50.10/DHAKA-FLIX-10/Tutorial/", "Tutorial"),
    ("http://172.16.50.7/DHAKA-FLIX-7/Kolkata%20Bangla%20Movies/Satyajit%20Ray%20Films/", "Satyajit Ray Films"),
];

pub fn agent(connect: u64, global: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(connect)))
        .timeout_global(Some(Duration::from_secs(global)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// The LAN: a short connect timeout, so a PC off the ISP's network learns it quickly.
pub fn lan_agent() -> ureq::Agent {
    agent(4, 20)
}

pub fn get_bytes(agent: &ureq::Agent, url: &str, limit: u64) -> Result<Vec<u8>> {
    let response = agent.get(url).header("User-Agent", "Zazabor").call().map_err(|e| format!("Couldn't reach {url}: {e}"))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("{url} answered {status}"));
    }
    response.into_body().with_config().limit(limit).read_to_vec().map_err(|e| format!("The download from {url} stopped: {e}"))
}

pub fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// ("http://host", "/path/") of a URL.
pub fn split_url(url: &str) -> Option<(String, String)> {
    let start = url.find("://")? + 3;
    match url[start..].find('/') {
        Some(i) => Some((url[..start + i].to_string(), url[start + i..].to_string())),
        None => Some((url.to_string(), "/".to_string())),
    }
}

/// The children of the folder at `href`, from h5ai's JSON answer (which also lists the folder's
/// ancestors and their siblings: only what sits one level below `href` is kept).
pub fn parse_listing_json(body: &str, folder_href: &str) -> Result<Vec<Entry>> {
    let value: Value = serde_json::from_str(body).map_err(|e| format!("The listing wasn't JSON: {e}"))?;
    let items = value.get("items").and_then(Value::as_array).ok_or("The listing had no items")?;
    let mut out = Vec::new();
    for item in items {
        let Some(href) = item.get("href").and_then(Value::as_str) else { continue };
        let Some(rest) = href.strip_prefix(folder_href) else { continue };
        let name = rest.trim_end_matches('/');
        if name.is_empty() || name.contains('/') {
            continue;
        }
        out.push(Entry {
            name: decode(name),
            href: href.to_string(),
            is_dir: href.ends_with('/'),
            size: item.get("size").and_then(Value::as_u64).unwrap_or(0),
            time: item.get("time").and_then(Value::as_i64).unwrap_or(0),
        });
    }
    Ok(out)
}

/// The plain nginx / h5ai HTML listing, for a server whose JSON API is off: `<a href="...">`
/// links one level below `folder_href` (no sizes or times there).
pub fn parse_listing_html(body: &str, folder_href: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    for (href, _) in anchors(body) {
        let path = match split_url(&href) {
            Some((_, p)) if href.contains("://") => p,
            _ => href.clone(),
        };
        let abs = if path.starts_with('/') { path } else { format!("{folder_href}{path}") };
        let Some(rest) = abs.strip_prefix(folder_href) else { continue };
        let name = rest.trim_end_matches('/');
        if name.is_empty() || name.contains('/') || name.contains('?') || name.starts_with('#') || name == ".." || name == "." {
            continue;
        }
        if out.iter().any(|e: &Entry| e.href == abs) {
            continue;
        }
        out.push(Entry { name: decode(name), href: abs.clone(), is_dir: abs.ends_with('/'), size: 0, time: 0 });
    }
    out
}

/// Lists a folder given by its full URL: tries the JSON API, then the HTML page.
pub fn list(agent: &ureq::Agent, folder_url: &str) -> Result<Vec<Entry>> {
    let (origin, href) = split_url(folder_url).ok_or("Not a folder URL")?;
    let payload = serde_json::json!({ "action": "get", "items": { "href": href, "what": 1 } }).to_string();
    let response = agent
        .post(folder_url)
        .header("Content-Type", "application/json")
        .header("User-Agent", "Zazabor")
        .send(payload.as_str())
        .map_err(|e| format!("Couldn't reach {origin}: {e}"))?;
    if response.status().as_u16() == 200 {
        let body = response.into_body().with_config().limit(32 << 20).read_to_string().map_err(|e| format!("The listing stopped: {e}"))?;
        if let Ok(entries) = parse_listing_json(&body, &href) {
            if !entries.is_empty() || body.contains("\"items\"") {
                return Ok(entries);
            }
        }
    }
    let page = get_bytes(agent, folder_url, 32 << 20)?;
    Ok(parse_listing_html(&String::from_utf8_lossy(&page), &href))
}

/// The `<a href>` links of a page with their text.
pub fn anchors(html: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<a ").map(|i| i + from) {
        let Some(gt) = lower[i..].find('>').map(|g| g + i) else { break };
        let tag = &html[i..gt];
        let tag_lower = &lower[i..gt];
        let end = lower[gt..].find("</a>").map(|e| e + gt).unwrap_or(gt);
        if let Some(h) = tag_lower.find("href=") {
            let rest = &tag[h + 5..];
            let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'');
            let value = match quote {
                Some(q) => rest[1..].split(q).next().unwrap_or(""),
                None => rest.split(|c: char| c.is_whitespace()).next().unwrap_or(""),
            };
            let text = html[gt + 1..end].split('<').map(|part| part.split_once('>').map_or(part, |(_, t)| t)).collect::<String>();
            out.push((value.trim().to_string(), text.split_whitespace().collect::<Vec<_>>().join(" ")));
        }
        from = gt + 1;
    }
    out
}

/// Which page of the section a category belongs to, and whether it holds series.
pub fn classify(label: &str, url: &str) -> (String, bool) {
    let l = format!("{} {}", label, decode(url)).to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| l.contains(w));
    let series = has(&["series", " tv", "tv ", "shows", "wwe", "aew", "wrestling"]) && !has(&["movies"]);
    let section = if has(&["anime", "cartoon", "animation"]) {
        "animation"
    } else if has(&["bangla", "kolkata", "hindi", "south indian", "south movies"]) {
        "indian"
    } else if series || has(&["documentary"]) {
        "tv"
    } else {
        "movies"
    };
    (section.to_string(), series)
}

fn category(url: &str, label: &str) -> Category {
    let (section, series) = classify(label, url);
    Category { url: url.to_string(), label: label.to_string(), section, series, default_on: !label.to_lowercase().contains("tutorial") }
}

/// The categories a front page links to: folders on the servers (any host) except games and
/// software, folders inside another listed folder, and links that leave the site.
pub fn discover(html: &str, portal: &str) -> Vec<Category> {
    let mut found: Vec<Category> = Vec::new();
    for (href, text) in anchors(html) {
        let url = if href.starts_with("http://") || href.starts_with("https://") {
            href
        } else if href.starts_with('/') {
            match split_url(portal) {
                Some((origin, _)) => format!("{origin}{href}"),
                None => continue,
            }
        } else {
            continue;
        };
        let Some((origin, path)) = split_url(&url) else { continue };
        let segments = path.trim_matches('/').split('/').filter(|s| !s.is_empty()).count();
        let lower = decode(&url).to_lowercase();
        if !path.ends_with('/') || segments < 2 || lower.contains("youtube") || lower.contains("games") || lower.contains("software") || origin.contains("google") {
            continue;
        }
        if found.iter().any(|c| c.url == url) {
            continue;
        }
        let label = if text.is_empty() { decode(path.trim_end_matches('/').rsplit('/').next().unwrap_or("")) } else { text };
        found.push(category(&url, label.trim()));
    }
    let urls: Vec<String> = found.iter().map(|c| c.url.clone()).collect();
    found.retain(|c| !urls.iter().any(|u| u != &c.url && c.url.starts_with(u.as_str())));
    found
}

pub fn default_categories() -> Vec<Category> {
    let mut all: Vec<Category> = DEFAULTS.iter().map(|(u, l)| category(u, l)).collect();
    let urls: Vec<String> = all.iter().map(|c| c.url.clone()).collect();
    all.retain(|c| !urls.iter().any(|u| u != &c.url && c.url.starts_with(u.as_str())));
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: &str = r#"{"items":[
      {"href":"\/","time":1790417341000,"size":null,"managed":false,"fetched":false},
      {"href":"\/DHAKA-FLIX-14\/","time":1792698295000,"size":null,"managed":true,"fetched":true},
      {"href":"\/DHAKA-FLIX-14\/English%20Movies%20%281080p%29\/","time":1768509892000,"size":null,"managed":true,"fetched":true},
      {"href":"\/DHAKA-FLIX-14\/English%20Movies%20%281080p%29\/%282025%29%201080p\/","time":1779222295000,"size":null,"managed":true,"fetched":true},
      {"href":"\/DHAKA-FLIX-14\/English%20Movies%20%281080p%29\/%282025%29%201080p\/28%20Years%20Later%20%282025%29%201080p%20%5BDual%20Audio%5D\/","time":1759104648000,"size":null,"managed":true,"fetched":false},
      {"href":"\/DHAKA-FLIX-14\/English%20Movies%20%281080p%29\/%282025%29%201080p\/28%20Years%20Later%20%282025%29%201080p%20%5BDual%20Audio%5D\/a_AL_.jpg","time":1753963965000,"size":199424,"managed":false,"fetched":false},
      {"href":"\/DHAKA-FLIX-14\/English%20Movies%20%281080p%29\/%281996%29%201080p\/","time":1754955796000,"size":null,"managed":true,"fetched":false}
    ]}"#;

    #[test]
    fn json_keeps_only_the_children() {
        let year = "/DHAKA-FLIX-14/English%20Movies%20%281080p%29/%282025%29%201080p/";
        let kids = parse_listing_json(JSON, year).unwrap();
        assert_eq!(kids.len(), 1, "{kids:?}");
        assert_eq!(kids[0].name, "28 Years Later (2025) 1080p [Dual Audio]");
        assert!(kids[0].is_dir);
        assert_eq!(kids[0].time, 1759104648000);
        let movie = format!("{year}28%20Years%20Later%20%282025%29%201080p%20%5BDual%20Audio%5D/");
        let files = parse_listing_json(JSON, &movie).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].name.as_str(), files[0].is_dir, files[0].size), ("a_AL_.jpg", false, 199424));
        let top = parse_listing_json(JSON, "/DHAKA-FLIX-14/English%20Movies%20%281080p%29/").unwrap();
        assert_eq!(top.len(), 2);
        assert!(parse_listing_json("<html>", "/").is_err());
    }

    #[test]
    fn html_fallback() {
        let page = r#"<a href="../">..</a><a href="/DHAKA-FLIX-14/Hindi%20Movies/%282025%29/">(2025)/</a>
            <a href="Movie.mkv">Movie.mkv</a> <a href="?sort=name">x</a>"#;
        let kids = parse_listing_html(page, "/DHAKA-FLIX-14/Hindi%20Movies/");
        let names: Vec<_> = kids.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["(2025)", "Movie.mkv"]);
        assert!(kids[0].is_dir && !kids[1].is_dir);
    }

    #[test]
    fn front_page_categories() {
        let page = r#"<ul>
          <li><a class="x" href="http://172.16.50.7/DHAKA-FLIX-7/English%20Movies/">English Movies</a></li>
          <li><a href='http://172.16.50.14/DHAKA-FLIX-14/KOREAN%20TV%20%26%20WEB%20Series/'>Korean <b>TV</b> Series</a></li>
          <li><a href="http://172.16.50.14/DHAKA-FLIX-14/SOUTH%20INDIAN%20MOVIES/South%20Movies/">South Indian Movies</a></li>
          <li><a href="http://172.16.50.10/DHAKA-FLIX-10/Anime%20%26%20Cartoon%20TV%20Series/">Anime</a></li>
          <li><a href="http://172.16.50.10/DHAKA-FLIX-10/Tutorial/">Tutorial</a></li>
          <li><a href="http://172.16.50.8/DHAKA-FLIX-8/PC%20Games/">PC Games</a></li>
          <li><a href="http://172.16.50.8/DHAKA-FLIX-8/Software/">Software</a></li>
          <li><a href="https://www.youtube.com/@ZikrullahTV/videos">YT</a></li>
          <li><a href="http://172.16.50.7/DHAKA-FLIX-7/Kolkata%20Bangla%20Movies/">Bangla</a></li>
          <li><a href="http://172.16.50.7/DHAKA-FLIX-7/Kolkata%20Bangla%20Movies/Satyajit%20Ray%20Films/">Satyajit Ray</a></li>
          <li><a href="index.html">Home</a></li></ul>"#;
        let cats = discover(page, "http://172.16.50.14");
        let labels: Vec<_> = cats.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, vec!["English Movies", "Korean TV Series", "South Indian Movies", "Anime", "Tutorial", "Bangla"]);
        assert_eq!(cats[0].section, "movies");
        assert!(cats[1].series && cats[1].section == "tv");
        assert_eq!(cats[2].section, "indian");
        assert_eq!(cats[3].section, "animation");
        assert!(!cats[4].default_on && cats[0].default_on);
        assert_eq!(cats[5].section, "indian");
    }

    #[test]
    fn defaults_are_sane() {
        let all = default_categories();
        assert_eq!(all.len(), 18);
        assert!(all.iter().all(|c| c.url.starts_with("http://172.16.50.") && c.url.ends_with('/')));
        let ranked = all.iter().find(|c| c.label == "IMDb Top 250").unwrap();
        assert_eq!(ranked.section, "movies");
        assert!(all.iter().find(|c| c.label.starts_with("WWE")).unwrap().series);
    }

    #[test]
    fn urls_and_escapes() {
        assert_eq!(split_url("http://172.16.50.14/DHAKA-FLIX-14/A%20B/").unwrap(), ("http://172.16.50.14".to_string(), "/DHAKA-FLIX-14/A%20B/".to_string()));
        assert_eq!(decode("A%20Big%20%E2%80%94%20x%"), "A Big — x%");
    }
}
