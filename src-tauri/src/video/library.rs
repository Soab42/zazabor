//! The video library: folders of videos found under the photo-discovery roots, cached on disk so
//! the UI has them instantly, plus the shared media-info cache (durations, resolution, tags and
//! cover art read through libVLC's parser, remembered by path, size and modification time).
//!
//! `video_library` returns the last scan; `video_library_refresh` rescans in the background and
//! emits `"video-library"` (once for the files, again when durations are known).

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::ffi::{c_char, c_int, c_uint, c_void, CStr, CString};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use super::frame::lock_ignore_poison;
use super::list::{is_video, natural_cmp};
use super::vlc::{libvlc_media_tracks_get, libvlc_media_tracks_release, MediaTrack};
use super::{instance, vlc};
use crate::scan::{self, unix_seconds};

/// Smaller videos are clips and screen captures of a few seconds, not library material.
const MIN_VIDEO_BYTES: u64 = 1024 * 1024;
/// libVLC's own limit for reading a local file's headers.
const PARSE_TIMEOUT_MS: c_int = 3000;
const PARSE_FETCH_LOCAL: c_int = 0x02;
/// Entries kept in the info cache before files that were not seen this launch are dropped.
const MAX_CACHED: usize = 60_000;

// ---- libVLC's media parser (not in `vlc.rs`, which belongs to the player) -------------------

#[repr(C)]
struct VideoTrack {
    height: c_uint,
    width: c_uint,
}

const TRACK_VIDEO: c_int = 1;
const META_TITLE: c_int = 0;
const META_ARTIST: c_int = 1;
const META_GENRE: c_int = 2;
const META_ALBUM: c_int = 4;
const META_TRACK_NUMBER: c_int = 5;
const META_DATE: c_int = 8;
const META_ARTWORK_URL: c_int = 15;
const META_ALBUM_ARTIST: c_int = 23;

#[link(name = "vlc")]
extern "C" {
    fn libvlc_media_parse_with_options(media: *mut vlc::libvlc_media_t, flags: c_int, timeout: c_int) -> c_int;
    fn libvlc_media_get_parsed_status(media: *mut vlc::libvlc_media_t) -> c_int;
    fn libvlc_media_get_duration(media: *mut vlc::libvlc_media_t) -> i64;
    fn libvlc_media_get_meta(media: *mut vlc::libvlc_media_t, meta: c_int) -> *mut c_char;
    fn libvlc_free(ptr: *mut c_void);
}

/// What the parser knows about a file; empty strings and zeros mean "not known".
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// Milliseconds.
    pub duration: i64,
    pub width: u32,
    pub height: u32,
    pub has_video: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub year: u32,
    pub track: u32,
    /// An image file with the cover art: embedded art libVLC extracted, or `cover.jpg` and friends.
    pub cover: Option<String>,
}

/// The first four digits of a date ("2019-05-01", "2019").
pub fn parse_year(date: &str) -> u32 {
    let digits: String = date.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 4 {
        digits[..4].parse().unwrap_or(0)
    } else {
        0
    }
}

/// "3" or "3/12" → 3.
pub fn parse_track(number: &str) -> u32 {
    number.trim().split('/').next().and_then(|n| n.trim().parse().ok()).unwrap_or(0)
}

const COVER_NAMES: &[&str] = &["cover", "folder", "front", "albumart", "album"];
const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

/// A cover image next to the files of an album (`cover.jpg`, `Folder.PNG`…).
pub fn folder_cover(dir: &Path) -> Option<String> {
    let entries = fs::read_dir(dir).ok()?;
    let mut best: Option<(usize, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let (Some(stem), Some(ext)) = (path.file_stem().and_then(|s| s.to_str()), scan::extension(&path)) else {
            continue;
        };
        if !COVER_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let Some(rank) = COVER_NAMES.iter().position(|n| n.eq_ignore_ascii_case(stem)) else { continue };
        if best.as_ref().map_or(true, |(r, _)| rank < *r) {
            best = Some((rank, path));
        }
    }
    best.map(|(_, p)| p.to_string_lossy().into_owned())
}

/// The local path of a `file://` artwork URL; `attachment://` and web URLs are not files.
fn artwork_path(url: &str) -> Option<String> {
    let path = url::Url::parse(url).ok()?.to_file_path().ok()?;
    path.is_file().then(|| path.to_string_lossy().into_owned())
}

/// Reads one string of the media's metadata.
///
/// # Safety
/// `media` must be a live libVLC media.
unsafe fn read_meta(media: *mut vlc::libvlc_media_t, id: c_int) -> String {
    let raw = libvlc_media_get_meta(media, id);
    if raw.is_null() {
        return String::new();
    }
    let value = CStr::from_ptr(raw).to_string_lossy().trim().to_string();
    libvlc_free(raw as *mut c_void);
    value
}

/// Parses a local file with libVLC (about 3 s at most). With `art`, libVLC also extracts embedded
/// cover art; this is only wanted for music.
pub fn parse_file(path: &Path, art: bool) -> MediaInfo {
    let mut info = MediaInfo::default();
    let Ok(instance) = instance() else { return info };
    let Ok(cpath) = CString::new(path.to_string_lossy().as_bytes()) else { return info };
    // SAFETY: plain libVLC calls on a media we create and release here; every returned string
    // and track list is freed with libVLC's own functions.
    unsafe {
        let media = vlc::libvlc_media_new_path(instance, cpath.as_ptr());
        if media.is_null() {
            return info;
        }
        let flags = if art { PARSE_FETCH_LOCAL } else { 0 };
        if libvlc_media_parse_with_options(media, flags, PARSE_TIMEOUT_MS) == 0 {
            let started = Instant::now();
            let limit = Duration::from_millis(PARSE_TIMEOUT_MS as u64 + 500);
            while libvlc_media_get_parsed_status(media) == 0 && started.elapsed() < limit {
                std::thread::sleep(Duration::from_millis(8));
            }
        }
        info.duration = libvlc_media_get_duration(media).max(0);
        let mut tracks: *mut *mut MediaTrack = std::ptr::null_mut();
        let count = libvlc_media_tracks_get(media, &mut tracks);
        for i in 0..count as usize {
            let track = &**tracks.add(i);
            if track.kind == TRACK_VIDEO && !track.details.is_null() && !info.has_video {
                info.has_video = true;
                let video = &*(track.details as *const VideoTrack);
                info.width = video.width;
                info.height = video.height;
            }
        }
        if !tracks.is_null() {
            libvlc_media_tracks_release(tracks, count);
        }
        if art {
            info.title = read_meta(media, META_TITLE);
            // Without a title tag libVLC reports the file name.
            if path.file_name().is_some_and(|n| n.to_string_lossy() == info.title) {
                info.title.clear();
            }
            info.artist = read_meta(media, META_ARTIST);
            info.album = read_meta(media, META_ALBUM);
            info.album_artist = read_meta(media, META_ALBUM_ARTIST);
            info.genre = read_meta(media, META_GENRE);
            info.year = parse_year(&read_meta(media, META_DATE));
            info.track = parse_track(&read_meta(media, META_TRACK_NUMBER));
            info.cover = artwork_path(&read_meta(media, META_ARTWORK_URL))
                .or_else(|| path.parent().and_then(folder_cover));
        }
        vlc::libvlc_media_release(media);
    }
    info
}

// ---- the persistent info cache -----------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    size: u64,
    mtime: f64,
    info: MediaInfo,
}

/// Parsed file info by path; an entry only counts while the file's size and mtime still match.
#[derive(Default)]
pub struct InfoCache {
    entries: HashMap<String, Entry>,
    dirty: bool,
}

impl InfoCache {
    pub fn get(&self, path: &str, size: u64, mtime: f64) -> Option<&MediaInfo> {
        match self.entries.get(path) {
            Some(e) if e.size == size && e.mtime == mtime => Some(&e.info),
            _ => None,
        }
    }

    pub fn put(&mut self, path: &str, size: u64, mtime: f64, info: MediaInfo) {
        self.entries.insert(path.to_string(), Entry { size, mtime, info });
        self.dirty = true;
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Where this module keeps its files; set on the first command.
struct Files {
    info: PathBuf,
    video_library: PathBuf,
    music_library: PathBuf,
    streams: PathBuf,
}

static FILES: OnceLock<Files> = OnceLock::new();
static CACHE: Mutex<Option<InfoCache>> = Mutex::new(None);
static REFRESHING_VIDEOS: AtomicBool = AtomicBool::new(false);

/// Resolves the storage paths (once) from the app's cache and data folders.
pub(super) fn init(app: &AppHandle) -> Result<(), String> {
    if FILES.get().is_some() {
        return Ok(());
    }
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let _ = FILES.set(Files {
        info: cache.join("media-info.json"),
        video_library: cache.join("video-library.json"),
        music_library: cache.join("music-library.json"),
        streams: data.join("streams"),
    });
    Ok(())
}

pub(super) fn music_library_file() -> Option<&'static Path> {
    FILES.get().map(|f| f.music_library.as_path())
}

pub(super) fn streams_dir() -> Option<&'static Path> {
    FILES.get().map(|f| f.streams.as_path())
}

fn with_cache<R>(f: impl FnOnce(&mut InfoCache) -> R) -> R {
    let mut slot = lock_ignore_poison(&CACHE);
    let cache = slot.get_or_insert_with(|| {
        let entries: HashMap<String, Entry> = FILES
            .get()
            .and_then(|files| fs::read(&files.info).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        InfoCache { entries, dirty: false }
    });
    f(cache)
}

fn save_cache() {
    let Some(files) = FILES.get() else { return };
    with_cache(|cache| {
        if !cache.dirty {
            return;
        }
        // Drop the oldest-looking surplus rather than growing without bound.
        if cache.entries.len() > MAX_CACHED {
            let surplus: Vec<String> = cache.entries.keys().skip(MAX_CACHED).cloned().collect();
            for key in surplus {
                cache.entries.remove(&key);
            }
        }
        if write_json(&files.info, &cache.entries) {
            cache.dirty = false;
        }
    });
}

/// Writes a file atomically (temp file, then rename).
pub(super) fn write_json<T: Serialize>(file: &Path, value: &T) -> bool {
    let Ok(json) = serde_json::to_vec(value) else { return false };
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, json).and_then(|_| fs::rename(&tmp, file)).is_ok()
}

/// A file to look up: its identity for the cache, and whether music tags and art are wanted.
#[derive(Clone)]
pub struct FileRef {
    pub path: String,
    pub size: u64,
    pub mtime: f64,
    pub art: bool,
}

impl FileRef {
    pub fn of(path: &Path, art: bool) -> Option<FileRef> {
        let meta = fs::metadata(path).ok().filter(|m| m.is_file())?;
        Some(FileRef { path: path.to_string_lossy().into_owned(), size: meta.len(), mtime: unix_seconds(meta.modified()), art })
    }
}

/// At most two files are parsed at once, here and everywhere else.
fn parse_pool() -> &'static rayon::ThreadPool {
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .thread_name(|i| format!("vparse-{i}"))
            .start_handler(|_| {
                #[cfg(unix)]
                // SAFETY: setpriority only adjusts the scheduling priority of the calling thread.
                unsafe {
                    libc::setpriority(libc::PRIO_PROCESS, 0, 10);
                }
            })
            .build()
            .expect("failed to build parser pool")
    })
}

/// The cached info of files that have been parsed already (never parses).
pub fn cached_infos(files: &[FileRef]) -> Vec<Option<MediaInfo>> {
    with_cache(|c| files.iter().map(|f| c.get(&f.path, f.size, f.mtime).cloned()).collect())
}

/// The info of each file, parsing the ones the cache doesn't know. `progress` is called after
/// each batch of parsed files with how many are done.
pub fn infos(files: &[FileRef], mut progress: impl FnMut(usize)) -> Vec<MediaInfo> {
    let misses: Vec<usize> = with_cache(|c| {
        (0..files.len()).filter(|&i| c.get(&files[i].path, files[i].size, files[i].mtime).is_none()).collect()
    });
    for (done, batch) in misses.chunks(40).enumerate() {
        let parsed: Vec<MediaInfo> = parse_pool().install(|| {
            batch.par_iter().map(|&i| parse_file(Path::new(&files[i].path), files[i].art)).collect()
        });
        with_cache(|c| {
            for (&i, info) in batch.iter().zip(parsed) {
                c.put(&files[i].path, files[i].size, files[i].mtime, info);
            }
        });
        save_cache();
        progress(done * 40 + batch.len());
    }
    with_cache(|c| files.iter().map(|f| c.get(&f.path, f.size, f.mtime).cloned().unwrap_or_default()).collect())
}

// ---- the video library -------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibVideo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub mtime: f64,
    /// Milliseconds; 0 until parsed.
    pub duration: i64,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibFolder {
    pub name: String,
    pub path: String,
    pub videos: Vec<LibVideo>,
    /// The newest modification time among its videos.
    pub latest: f64,
}

/// Finds folders holding videos of 1 MB or more under `roots`, newest first, without any
/// durations (see `fill_cached`).
pub fn discover_videos(roots: &[PathBuf]) -> Vec<LibFolder> {
    let roots: Vec<(PathBuf, usize)> = roots.iter().map(|r| (r.clone(), scan::MAX_DISCOVERY_DEPTH)).collect();
    let files = scan::walk_files(&roots, |path, meta| is_video(path) && meta.len() >= MIN_VIDEO_BYTES);
    let mut groups: BTreeMap<PathBuf, Vec<LibVideo>> = BTreeMap::new();
    for (path, meta) in files {
        let Some(parent) = path.parent() else { continue };
        groups.entry(parent.to_path_buf()).or_default().push(LibVideo {
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            size: meta.len(),
            mtime: unix_seconds(meta.modified()),
            duration: 0,
            width: 0,
            height: 0,
        });
    }
    let mut folders: Vec<LibFolder> = groups
        .into_iter()
        .map(|(dir, mut videos)| {
            videos.sort_by(|a, b| natural_cmp(&a.name, &b.name));
            LibFolder {
                name: dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| dir.to_string_lossy().into_owned()),
                path: dir.to_string_lossy().into_owned(),
                latest: videos.iter().map(|v| v.mtime).fold(0.0, f64::max),
                videos,
            }
        })
        .collect();
    folders.sort_by(|a, b| b.latest.total_cmp(&a.latest));
    folders
}

/// Copies durations and sizes from the info cache onto videos that were parsed before.
pub fn fill_cached(folders: &mut [LibFolder]) {
    with_cache(|cache| {
        for video in folders.iter_mut().flat_map(|f| f.videos.iter_mut()) {
            if let Some(info) = cache.get(&video.path, video.size, video.mtime) {
                (video.duration, video.width, video.height) = (info.duration, info.width, info.height);
            }
        }
    });
}

fn video_roots(app: &AppHandle) -> Vec<PathBuf> {
    scan::discovery_roots(app.path().home_dir().ok())
}

fn emit_unlocked<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: &S) {
    if !crate::lock::is_locked() {
        let _ = app.emit(event, payload.clone());
    }
}

fn refresh_videos(app: &AppHandle) {
    let mut folders = discover_videos(&video_roots(app));
    fill_cached(&mut folders);
    if let Some(files) = FILES.get() {
        write_json(&files.video_library, &folders);
    }
    emit_unlocked(app, "video-library", &folders);

    let refs: Vec<FileRef> = folders
        .iter()
        .flat_map(|f| &f.videos)
        .filter_map(|v| FileRef::of(Path::new(&v.path), false))
        .collect();
    let unknown = cached_infos(&refs).iter().any(Option::is_none);
    if unknown {
        infos(&refs, |_| {});
        fill_cached(&mut folders);
        if let Some(files) = FILES.get() {
            write_json(&files.video_library, &folders);
        }
        emit_unlocked(app, "video-library", &folders);
    }
}

/// The folders of the last scan (empty before the first one finishes).
#[tauri::command]
pub async fn video_library(app: AppHandle) -> Result<Vec<LibFolder>, String> {
    crate::ensure_unlocked()?;
    init(&app)?;
    Ok(FILES
        .get()
        .and_then(|files| fs::read(&files.video_library).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default())
}

/// Rescans in the background and emits `"video-library"` with the folders when done.
#[tauri::command]
pub async fn video_library_refresh(app: AppHandle) -> Result<(), String> {
    crate::ensure_unlocked()?;
    init(&app)?;
    if REFRESHING_VIDEOS.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    std::thread::Builder::new()
        .name("video-library".into())
        .spawn(move || {
            refresh_videos(&app);
            REFRESHING_VIDEOS.store(false, Ordering::SeqCst);
        })
        .map_err(|e| {
            REFRESHING_VIDEOS.store(false, Ordering::SeqCst);
            e.to_string()
        })?;
    Ok(())
}

/// Durations, resolution, tags and cover art of files, in the order given (blank for anything that
/// can't be read). Tags and art are only read for audio files.
#[tauri::command]
pub async fn video_library_meta(app: AppHandle, paths: Vec<String>) -> Result<Vec<MediaInfo>, String> {
    crate::ensure_unlocked()?;
    init(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<Option<FileRef>> = paths
            .iter()
            .map(|p| FileRef::of(Path::new(p), super::music::is_music(Path::new(p))))
            .collect();
        let known: Vec<FileRef> = refs.iter().flatten().cloned().collect();
        let mut found = infos(&known, |_| {}).into_iter();
        refs.iter().map(|r| if r.is_some() { found.next().unwrap_or_default() } else { MediaInfo::default() }).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zazabor-vlib-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: PathBuf, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![0u8; bytes]).unwrap();
    }

    const BIG: usize = 1024 * 1024 + 10;

    #[test]
    fn discovery_groups_videos_and_skips_small_hidden_and_project_files() {
        let home = temp_dir("discover");
        write(home.join("Videos/Show/ep10.mkv"), BIG);
        write(home.join("Videos/Show/ep2.mkv"), BIG);
        write(home.join("Videos/Show/trailer.mp4"), 1000);
        write(home.join("Downloads/clip.MP4"), BIG);
        write(home.join("Downloads/readme.txt"), BIG);
        write(home.join(".cache/hidden.mp4"), BIG);
        write(home.join("code/app/package.json"), 2);
        write(home.join("code/app/assets/demo.mp4"), BIG);
        write(home.join("stuff/node_modules/pkg/x.mp4"), BIG);

        let folders = discover_videos(&[home.clone()]);
        let mut names: Vec<(&str, Vec<&str>)> = folders
            .iter()
            .map(|f| (f.name.as_str(), f.videos.iter().map(|v| v.name.as_str()).collect()))
            .collect();
        names.sort();
        assert_eq!(names, vec![("Downloads", vec!["clip.MP4"]), ("Show", vec!["ep2.mkv", "ep10.mkv"])]);
        assert!(folders.iter().all(|f| f.latest > 0.0 && f.videos.iter().all(|v| v.duration == 0)));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn info_cache_is_keyed_by_path_size_and_mtime() {
        let mut cache = InfoCache::default();
        let info = MediaInfo { duration: 61_000, width: 1920, height: 1080, ..MediaInfo::default() };
        cache.put("/a.mp4", 100, 5.5, info.clone());
        assert_eq!(cache.get("/a.mp4", 100, 5.5), Some(&info));
        assert_eq!(cache.get("/a.mp4", 101, 5.5), None, "size changed");
        assert_eq!(cache.get("/a.mp4", 100, 6.0), None, "mtime changed");
        assert_eq!(cache.get("/b.mp4", 100, 5.5), None, "other path");
        cache.put("/a.mp4", 101, 6.0, MediaInfo::default());
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get("/a.mp4", 100, 5.5), None);
    }

    #[test]
    fn cache_survives_a_json_round_trip() {
        let mut cache = InfoCache::default();
        cache.put("/a.mp3", 7, 1_700_000_000.123456, MediaInfo { title: "Song".into(), year: 1999, ..MediaInfo::default() });
        let json = serde_json::to_vec(&cache.entries).unwrap();
        let entries: HashMap<String, Entry> = serde_json::from_slice(&json).unwrap();
        let restored = InfoCache { entries, dirty: false };
        assert_eq!(restored.get("/a.mp3", 7, 1_700_000_000.123456).map(|i| i.title.as_str()), Some("Song"));
    }

    #[test]
    fn tags_parse_years_and_track_numbers() {
        assert_eq!(parse_year("2019-05-01"), 2019);
        assert_eq!(parse_year(" 1987 "), 1987);
        assert_eq!(parse_year("n/a"), 0);
        assert_eq!(parse_year("87"), 0);
        assert_eq!(parse_track("3/12"), 3);
        assert_eq!(parse_track("07"), 7);
        assert_eq!(parse_track(""), 0);
    }

    #[test]
    fn folder_cover_prefers_cover_over_folder_and_ignores_other_images() {
        let dir = temp_dir("cover");
        write(dir.join("holiday.jpg"), 10);
        assert_eq!(folder_cover(&dir), None);
        write(dir.join("Folder.PNG"), 10);
        assert!(folder_cover(&dir).unwrap().ends_with("Folder.PNG"));
        write(dir.join("cover.jpg"), 10);
        assert!(folder_cover(&dir).unwrap().ends_with("cover.jpg"));
        let _ = fs::remove_dir_all(dir);
    }

    /// Live check against a real video: `cargo test live_video -- --ignored` (uses
    /// `VIDEO_TEST_FILE`, or the first video found in ~/Videos).
    #[test]
    #[ignore]
    fn live_video_info_has_duration_and_size() {
        let file = std::env::var("VIDEO_TEST_FILE").ok().map(PathBuf::from).or_else(|| {
            let home = std::env::var("HOME").ok()?;
            fs::read_dir(Path::new(&home).join("Videos")).ok()?.flatten().map(|e| e.path()).find(|p| is_video(p))
        });
        let Some(file) = file else { return eprintln!("no video to test with") };
        let info = parse_file(&file, false);
        eprintln!("{} -> {info:?}", file.display());
        assert!(info.duration > 0 && info.has_video && info.width > 0 && info.height > 0);
    }
}
