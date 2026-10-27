//! The music library: songs in `~/Music`, Downloads and mounted drives, with their tags and cover
//! art (read by libVLC through the shared info cache in `library`). `music_library` returns the
//! last scan; `music_library_refresh` rescans in the background and emits `"music-library"`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

use super::library::{self, cached_infos, infos, FileRef, MediaInfo};
use crate::scan::{self, unix_seconds};

const MUSIC_EXTS: &[&str] = &["mp3", "ogg", "oga", "opus", "flac", "wav", "m4a", "aac", "wma", "aiff", "aif", "mka"];
/// Shorter files are notification sounds and jingles rather than songs.
const MIN_SONG_BYTES: u64 = 300 * 1024;
const MAX_SONGS: usize = 20_000;
/// The list is re-sent to the UI after this many more songs were read.
const EMIT_EVERY: usize = 120;

static REFRESHING: AtomicBool = AtomicBool::new(false);

pub fn is_music(path: &Path) -> bool {
    scan::extension(path).is_some_and(|e| MUSIC_EXTS.contains(&e.as_str()))
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub path: String,
    /// The file name without its extension.
    pub name: String,
    pub size: u64,
    pub mtime: f64,
    /// The tag, or the file name when the file has none.
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub year: u32,
    pub track: u32,
    /// Milliseconds; 0 until read.
    pub duration: i64,
    pub cover: Option<String>,
}

/// A song from a file's identity and what the parser found (nothing yet is fine).
pub fn song_of(file: &FileRef, info: Option<&MediaInfo>) -> Song {
    let path = Path::new(&file.path);
    let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let blank = MediaInfo::default();
    let info = info.unwrap_or(&blank);
    Song {
        path: file.path.clone(),
        title: if info.title.is_empty() { name.clone() } else { info.title.clone() },
        name,
        size: file.size,
        mtime: file.mtime,
        artist: info.artist.clone(),
        album: info.album.clone(),
        album_artist: info.album_artist.clone(),
        genre: info.genre.clone(),
        year: info.year,
        track: info.track,
        duration: info.duration,
        cover: info.cover.clone().or_else(|| path.parent().and_then(library::folder_cover)),
    }
}

/// Song files under the roots (each with its search depth), without reading any tags.
pub fn discover_songs(roots: &[(PathBuf, usize)]) -> Vec<FileRef> {
    let mut files: Vec<FileRef> = scan::walk_files(roots, |path, meta| is_music(path) && meta.len() >= MIN_SONG_BYTES)
        .into_iter()
        .map(|(path, meta)| FileRef {
            path: path.to_string_lossy().into_owned(),
            size: meta.len(),
            mtime: unix_seconds(meta.modified()),
            art: true,
        })
        .collect();
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    files.truncate(MAX_SONGS);
    files
}

fn music_roots(app: &AppHandle) -> Vec<(PathBuf, usize)> {
    let mut roots: Vec<(PathBuf, usize)> = Vec::new();
    let home = app.path().home_dir().ok();
    match app.path().audio_dir() {
        Ok(music) => roots.push((music, 8)),
        Err(_) => roots.extend(home.iter().map(|h| (h.join("Music"), 8))),
    }
    if let Some(home) = &home {
        roots.push((home.join("Downloads"), 3));
    }
    // Mounted drives: everything `discovery_roots` finds except the home folder itself.
    for drive in scan::discovery_roots(None) {
        roots.push((drive, 6));
    }
    roots
}

fn emit_songs(app: &AppHandle, songs: &[Song]) {
    if !crate::lock::is_locked() {
        let _ = app.emit("music-library", songs);
    }
}

fn refresh(app: &AppHandle) {
    let files = discover_songs(&music_roots(app));
    let known = cached_infos(&files);
    let mut songs: Vec<Song> = files.iter().zip(&known).map(|(f, i)| song_of(f, i.as_ref())).collect();
    if let Some(file) = library::music_library_file() {
        library::write_json(file, &songs);
    }
    emit_songs(app, &songs);
    if known.iter().all(Option::is_some) {
        return;
    }

    let mut announced = 0;
    let parsed = infos(&files, |done| {
        if done - announced >= EMIT_EVERY {
            announced = done;
            // Partial results come from the cache, which `infos` fills batch by batch.
            let now = cached_infos(&files);
            let partial: Vec<Song> = files.iter().zip(&now).map(|(f, i)| song_of(f, i.as_ref())).collect();
            emit_songs(app, &partial);
        }
    });
    songs = files.iter().zip(&parsed).map(|(f, i)| song_of(f, Some(i))).collect();
    if let Some(file) = library::music_library_file() {
        library::write_json(file, &songs);
    }
    emit_songs(app, &songs);
}

/// The songs of the last scan (empty before the first one finishes).
#[tauri::command]
pub async fn music_library(app: AppHandle) -> Result<Vec<Song>, String> {
    crate::ensure_unlocked()?;
    library::init(&app)?;
    Ok(library::music_library_file()
        .and_then(|file| std::fs::read(file).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default())
}

/// Rescans in the background and emits `"music-library"` with the songs as tags are read.
#[tauri::command]
pub async fn music_library_refresh(app: AppHandle) -> Result<(), String> {
    crate::ensure_unlocked()?;
    library::init(&app)?;
    if REFRESHING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    std::thread::Builder::new()
        .name("music-library".into())
        .spawn(move || {
            refresh(&app);
            REFRESHING.store(false, Ordering::SeqCst);
        })
        .map_err(|e| {
            REFRESHING.store(false, Ordering::SeqCst);
            e.to_string()
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zazabor-music-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: PathBuf, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn discovery_finds_songs_but_not_jingles_hidden_or_other_files() {
        let home = temp_dir("discover");
        write(home.join("Music/Artist/Album/01 Intro.MP3"), 400_000);
        write(home.join("Music/Artist/Album/cover.jpg"), 5_000);
        write(home.join("Music/ping.wav"), 20_000);
        write(home.join("Music/.trash/old.mp3"), 400_000);
        write(home.join("Downloads/song.flac"), 500_000);
        write(home.join("Downloads/deep/a/b/c/too-deep.mp3"), 500_000);
        write(home.join("Downloads/video.mp4"), 500_000);

        let roots = [(home.join("Music"), 8), (home.join("Downloads"), 3)];
        let names: Vec<String> = discover_songs(&roots)
            .iter()
            .map(|f| Path::new(&f.path).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["song.flac", "01 Intro.MP3"]);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn songs_fall_back_to_the_file_name_and_folder_art() {
        let dir = temp_dir("song");
        write(dir.join("track one.mp3"), 10);
        write(dir.join("cover.png"), 10);
        let file = FileRef::of(&dir.join("track one.mp3"), true).unwrap();
        let bare = song_of(&file, None);
        assert_eq!((bare.title.as_str(), bare.artist.as_str()), ("track one", ""));
        assert!(bare.cover.as_deref().is_some_and(|c| c.ends_with("cover.png")));
        let info = MediaInfo { title: "One".into(), artist: "Them".into(), year: 2001, duration: 3_000, ..MediaInfo::default() };
        let tagged = song_of(&file, Some(&info));
        assert_eq!((tagged.title.as_str(), tagged.artist.as_str(), tagged.year, tagged.duration), ("One", "Them", 2001, 3_000));
        let _ = fs::remove_dir_all(dir);
    }

    /// Live check against a real song: `cargo test live_music -- --ignored` (uses
    /// `MUSIC_TEST_FILE`, or the first song found in ~/Music or ~/Downloads).
    #[test]
    #[ignore]
    fn live_music_tags_and_duration_are_read() {
        let home = std::env::var("HOME").unwrap_or_default();
        let file = std::env::var("MUSIC_TEST_FILE").ok().map(PathBuf::from).or_else(|| {
            ["Music", "Downloads"].iter().find_map(|dir| {
                fs::read_dir(Path::new(&home).join(dir)).ok()?.flatten().map(|e| e.path()).find(|p| is_music(p))
            })
        });
        let Some(file) = file else { return eprintln!("no song to test with") };
        let info = library::parse_file(&file, true);
        eprintln!("{} -> {info:?}", file.display());
        assert!(info.duration > 0, "no duration");
        assert!(!info.has_video || info.width > 0);
    }
}
