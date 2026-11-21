//! Reading the server: the crawl that turns category folders into catalog items (names only, fast,
//! newest folders first), looking inside one title's folder for its video and poster, and the
//! poster cache.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;

use super::catalog::{NewItem, Resolved};
use super::listing::{self, Category, Entry};
use super::names::{self, parse_name};

pub type Result<T> = std::result::Result<T, String>;

const MAX_DEPTH: usize = 4;
pub const POSTER_CAP: u64 = 300 << 20;

/// Turns the entries of a container folder into (titles found, folders to look into). Children of a
/// year folder are titles whatever they are called.
pub fn sort_entries(entries: Vec<Entry>, parent_is_year: bool) -> (Vec<Entry>, Vec<Entry>) {
    let (mut titles, mut containers) = (Vec::new(), Vec::new());
    for e in entries.into_iter().filter(|e| e.is_dir && !e.name.starts_with('.')) {
        if parent_is_year || names::is_title_folder(&e.name) {
            titles.push(e);
        } else {
            containers.push(e);
        }
    }
    containers.sort_by(|a, b| b.time.cmp(&a.time));
    (titles, containers)
}

pub fn new_item(e: &Entry, origin: &str, cat: &Category) -> NewItem {
    let p = parse_name(&e.name);
    NewItem {
        title: p.title,
        year: p.year,
        quality: p.quality,
        tags: p.tags,
        kind: if p.series || cat.series { "series" } else { "movie" }.to_string(),
        section: cat.section.clone(),
        category: cat.label.clone(),
        category_url: cat.url.clone(),
        folder_url: format!("{origin}{}", e.href),
        added: e.time,
        rank: p.rank,
    }
}

/// Walks a category, handing each folder's titles to `sink` as they are found. An error on the
/// category's own folder is returned; an error deeper down only makes the crawl `complete == false`.
pub fn walk(agent: &ureq::Agent, cat: &Category, sink: &mut dyn FnMut(Vec<NewItem>), cancelled: &dyn Fn() -> bool) -> Result<bool> {
    let mut complete = true;
    let mut stack: Vec<(String, usize, bool)> = vec![(cat.url.clone(), 0, false)];
    let mut first = true;
    while let Some((url, depth, parent_year)) = stack.pop() {
        if cancelled() {
            return Ok(false);
        }
        let entries = match listing::list(agent, &url) {
            Ok(e) => e,
            Err(err) if first => return Err(err),
            Err(err) => {
                eprintln!("[tv] {url}: {err}");
                complete = false;
                continue;
            }
        };
        first = false;
        let origin = listing::split_url(&url).map(|(o, _)| o).unwrap_or_default();
        let (titles, containers) = sort_entries(entries, parent_year);
        if !titles.is_empty() {
            sink(titles.iter().map(|e| new_item(e, &origin, cat)).collect());
        }
        if depth < MAX_DEPTH {
            // the stack pops the last one first: push the oldest first
            for c in containers.into_iter().rev() {
                let year = names::is_year_folder(&c.name);
                stack.push((format!("{origin}{}", c.href), depth + 1, year));
            }
        }
    }
    Ok(complete)
}

/// What a title's folder holds.
#[derive(Debug, PartialEq)]
pub struct Contents {
    pub video: Option<(String, u64)>,
    pub poster: Option<String>,
    pub kind: &'static str,
}

/// The video (the biggest file), the poster, and whether the folder is a series.
pub fn read_contents(entries: &[Entry]) -> Contents {
    let videos: Vec<&Entry> = entries.iter().filter(|e| !e.is_dir && names::is_video(&e.name)).collect();
    let dirs = entries.iter().filter(|e| e.is_dir).count();
    let images: Vec<(String, u64)> = entries.iter().filter(|e| !e.is_dir).map(|e| (e.name.clone(), e.size)).collect();
    let poster = names::pick_poster(&images).and_then(|i| entries.iter().find(|e| !e.is_dir && e.name == images[i].0)).map(|e| e.href.clone());
    let episodes = videos.iter().any(|e| names::season_episode(&e.name).is_some());
    let kind = if (videos.is_empty() && dirs > 0) || episodes { "series" } else { "movie" };
    let video = videos.iter().max_by_key(|e| e.size).map(|e| (e.href.clone(), e.size));
    Contents { video, poster, kind }
}

fn poster_dir(cache: &Path) -> PathBuf {
    cache.join("posters")
}

/// Downloads a poster, scales it to at most 720x1080 (the hero shows it full width) and keeps it as a JPEG.
pub fn save_poster(agent: &ureq::Agent, cache: &Path, id: &str, url: &str) -> Result<Option<PathBuf>> {
    let bytes = listing::get_bytes(agent, url, 12 << 20)?;
    let Ok(image) = image::load_from_memory(&bytes) else { return Ok(None) };
    let small = image.thumbnail(720, 1080).to_rgb8();
    let dir = poster_dir(cache);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Can't make the poster folder: {e}"))?;
    let path = dir.join(format!("{id}.jpg"));
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82).encode_image(&small).map_err(|e| format!("Can't encode a poster: {e}"))?;
    std::fs::write(&path, out).map_err(|e| format!("Can't save a poster: {e}"))?;
    static WRITES: AtomicUsize = AtomicUsize::new(0);
    if WRITES.fetch_add(1, Ordering::Relaxed) % 20 == 19 {
        prune(&dir, POSTER_CAP);
    }
    Ok(Some(path))
}

/// Deletes the oldest files of `dir` until it is under 90% of `cap` bytes.
pub fn prune(dir: &Path, cap: u64) -> u64 {
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_file().then(|| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= cap {
        return total;
    }
    files.sort_by_key(|f| f.0);
    for (_, size, path) in files {
        if total <= cap / 10 * 9 {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= size;
        }
    }
    total
}

pub fn dir_size(dir: &Path) -> (u64, usize) {
    let mut bytes = 0;
    let mut files = 0;
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if let Ok(m) = e.metadata() {
            if m.is_file() {
                bytes += m.len();
                files += 1;
            }
        }
    }
    (bytes, files)
}

/// The result of looking inside a folder.
pub fn inspect(agent: &ureq::Agent, cache: &Path, id: &str, folder_url: &str, title_tags: bool) -> Result<Resolved> {
    let entries = listing::list(agent, folder_url)?;
    let origin = listing::split_url(folder_url).map(|(o, _)| o).unwrap_or_default();
    let contents = read_contents(&entries);
    let mut resolved = Resolved { kind: Some(contents.kind.to_string()), ..Default::default() };
    if let Some((href, size)) = &contents.video {
        resolved.video_url = format!("{origin}{href}");
        resolved.size = *size as i64;
        if title_tags {
            if let Some(name) = entries.iter().find(|e| &e.href == href).map(|e| e.name.clone()) {
                resolved.tags = parse_name(&name).tags;
            }
        }
    }
    if let Some(href) = &contents.poster {
        // a failed download is a network problem: let the caller try again later
        if let Some(path) = save_poster(agent, cache, id, &format!("{origin}{href}"))? {
            resolved.poster = path.to_string_lossy().into_owned();
        }
    }
    Ok(resolved)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Episode {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Season {
    pub name: String,
    pub episodes: Vec<Episode>,
}

fn episodes_of(origin: &str, entries: &[Entry]) -> Vec<Episode> {
    let mut eps: Vec<Episode> = entries
        .iter()
        .filter(|e| !e.is_dir && names::is_video(&e.name))
        .map(|e| {
            let se = names::season_episode(&e.name);
            Episode { name: e.name.clone(), url: format!("{origin}{}", e.href), size: e.size, season: se.map(|s| s.0), episode: se.map(|s| s.1) }
        })
        .collect();
    eps.sort_by(|a, b| names::natural_cmp(&a.name, &b.name));
    eps
}

/// The seasons of a series folder: its sub-folders (each listed, six at a time), plus any episodes
/// lying directly in the folder.
pub fn seasons(agent: &ureq::Agent, folder_url: &str) -> Result<Vec<Season>> {
    let entries = listing::list(agent, folder_url)?;
    let origin = listing::split_url(folder_url).map(|(o, _)| o).unwrap_or_default();
    let mut dirs: Vec<&Entry> = entries.iter().filter(|e| e.is_dir).collect();
    dirs.sort_by(|a, b| names::natural_cmp(&a.name, &b.name));
    let mut out: Vec<Season> = Vec::new();
    let direct = episodes_of(&origin, &entries);
    if !direct.is_empty() {
        out.push(Season { name: "Episodes".into(), episodes: direct });
    }
    for chunk in dirs.chunks(6) {
        let found: Vec<Season> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|d| {
                    let origin = origin.clone();
                    scope.spawn(move || {
                        let list = listing::list(agent, &format!("{origin}{}", d.href)).unwrap_or_default();
                        Season { name: d.name.clone(), episodes: episodes_of(&origin, &list) }
                    })
                })
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        out.extend(found.into_iter().filter(|s| !s.episodes.is_empty()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str, time: i64) -> Entry {
        Entry { name: name.into(), href: format!("/x/{name}/"), is_dir: true, size: 0, time }
    }
    fn file(name: &str, size: u64) -> Entry {
        Entry { name: name.into(), href: format!("/x/m/{name}"), is_dir: false, size, time: 0 }
    }

    #[test]
    fn containers_and_titles() {
        let kids = vec![dir("(2025) 1080p", 5), dir("(1996) 1080p", 9), dir("Aachari Baa (2025) 720p", 1), dir("Danish Language", 7), file("x.jpg", 1)];
        let (titles, containers) = sort_entries(kids.clone(), false);
        assert_eq!(titles.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["Aachari Baa (2025) 720p"]);
        assert_eq!(containers.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["(1996) 1080p", "Danish Language", "(2025) 1080p"], "newest first");
        // inside a year folder everything is a title, even without a year
        let (titles, containers) = sort_entries(vec![dir("WrestleMania 32", 1), dir("Royal Rumble", 2)], true);
        assert_eq!((titles.len(), containers.len()), (2, 0));
    }

    #[test]
    fn items_from_entries() {
        let cat = Category { url: "http://h/a/".into(), label: "Korean".into(), section: "tv".into(), series: true, default_on: true };
        let item = new_item(&dir("18 Again (TV Series 2020) 720p [Dual Audio]", 123), "http://h", &cat);
        assert_eq!((item.title.as_str(), item.year, item.kind.as_str(), item.added), ("18 Again", Some(2020), "series", 123));
        assert_eq!(item.folder_url, "http://h/x/18 Again (TV Series 2020) 720p [Dual Audio]/");
        let movies = Category { series: false, section: "movies".into(), ..cat };
        assert_eq!(new_item(&dir("Anaconda (2025) 1080p AMZN", 1), "http://h", &movies).kind, "movie");
    }

    #[test]
    fn movie_folder_contents() {
        let entries = vec![file("sample.mkv", 10), file("28 Years Later (2025) 1080p BluRay x265.mkv", 2_118_709_125), file("a_AL_.jpg", 199_424), file("notes.txt", 3)];
        let c = read_contents(&entries);
        assert_eq!(c.kind, "movie");
        assert_eq!(c.video, Some(("/x/m/28 Years Later (2025) 1080p BluRay x265.mkv".to_string(), 2_118_709_125)));
        assert_eq!(c.poster.as_deref(), Some("/x/m/a_AL_.jpg"));
        let series = read_contents(&[dir("Season 1", 1), file("a_AL_.jpg", 61015), file("a_VL_.jpg", 242_862)]);
        assert_eq!((series.kind, series.video.is_none(), series.poster.as_deref()), ("series", true, Some("/x/m/a_VL_.jpg")));
        assert_eq!(read_contents(&[file("Show S01E01.mkv", 5)]).kind, "series");
    }

    #[test]
    fn prune_removes_the_oldest() {
        let dir = std::env::temp_dir().join(format!("zazabor-tv-prune-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..5 {
            std::fs::write(dir.join(format!("{i}.jpg")), vec![0u8; 100]).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        assert_eq!(dir_size(&dir), (500, 5));
        assert_eq!(prune(&dir, 1000), 500);
        let left = prune(&dir, 300);
        assert!(left <= 270 && left >= 200, "{left}");
        assert!(!dir.join("0.jpg").exists() && dir.join("4.jpg").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
