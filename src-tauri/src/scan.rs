//! Folder scanning: finds images under a root and groups them by directory.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::{DirEntry, WalkDir};

pub const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "png", "gif", "webp", "bmp", "tif", "tiff",
];
pub const AUDIO_EXTS: &[&str] = &["mp3", "ogg", "oga", "opus", "flac", "wav", "m4a", "aac"];

/// Folder names that hold application data rather than a person's photos.
const SKIP_DIRS: &[&str] = &[
    "node_modules", "site-packages", "__pycache__", "venv", "snap", "anaconda3", "miniconda3",
    "AppData", "Library", "lost+found", "$RECYCLE.BIN", "System Volume Information",
];
/// A folder containing any of these is a software project; its images are assets, not photos.
const PROJECT_MARKERS: &[&str] = &[
    ".git", ".hg", ".svn", "package.json", "Cargo.toml", "pyproject.toml", "setup.py", "go.mod",
    "pom.xml", "build.gradle", "CMakeLists.txt", "composer.json", "Gemfile",
];
/// Smaller images found by discovery are almost always icons or UI assets.
const MIN_DISCOVERED_BYTES: u64 = 12 * 1024;
const MAX_DISCOVERY_DEPTH: usize = 12;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub path: String,
    pub name: String,
    pub photos: Vec<Photo>,
}

pub fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

pub fn is_image(path: &Path) -> bool {
    extension(path).is_some_and(|e| IMAGE_EXTS.contains(&e.as_str()))
}

pub fn is_audio(path: &Path) -> bool {
    extension(path).is_some_and(|e| AUDIO_EXTS.contains(&e.as_str()))
}

pub fn unix_seconds(t: std::io::Result<SystemTime>) -> f64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn is_hidden(entry: &DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .is_some_and(|name| name.starts_with('.'))
}

fn is_skipped_dir(entry: &DirEntry) -> bool {
    if !entry.file_type().is_dir() {
        return false;
    }
    let name = entry.file_name().to_string_lossy();
    SKIP_DIRS.iter().any(|skip| skip.eq_ignore_ascii_case(&name))
        || PROJECT_MARKERS.iter().any(|marker| entry.path().join(marker).exists())
}

/// Scans `root` for images. When `recursive` is false only the root itself is read.
/// Folders without images are omitted; order of photos is left to the frontend.
pub fn scan(root: &Path, recursive: bool) -> Vec<Folder> {
    walk(
        WalkDir::new(root)
            .follow_links(true)
            .max_depth(if recursive { usize::MAX } else { 1 }),
        root,
        false,
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicFile {
    pub path: String,
    pub name: String,
    pub folder: String,
    pub size: u64,
}

/// Shorter files are notification sounds and jingles rather than songs.
const MIN_SONG_BYTES: u64 = 300 * 1024;
const MAX_SONGS: usize = 1000;

/// Finds songs in the given folders (each with its own search depth), sorted by name.
pub fn discover_music(roots: &[(PathBuf, usize)]) -> Vec<MusicFile> {
    let mut seen = std::collections::HashSet::new();
    let mut songs = Vec::new();
    for (root, depth) in roots {
        let walker = WalkDir::new(root)
            .follow_links(false)
            .max_depth(*depth)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !(is_hidden(e) || is_skipped_dir(e)));
        for entry in walker.filter_map(Result::ok) {
            let path = entry.path();
            if !entry.file_type().is_file() || !is_audio(path) || !seen.insert(path.to_path_buf()) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() < MIN_SONG_BYTES {
                continue;
            }
            songs.push(MusicFile {
                path: path.to_string_lossy().into_owned(),
                name: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                folder: path
                    .parent()
                    .and_then(|p| p.file_name())
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                size: meta.len(),
            });
            if songs.len() >= MAX_SONGS {
                break;
            }
        }
    }
    songs.sort_by_key(|s| s.name.to_lowercase());
    songs
}

/// Where automatic discovery looks: the home folder and mounted drives.
pub fn discovery_roots(home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = home.into_iter().collect();
    if let Ok(user) = std::env::var("USER") {
        for base in ["/media", "/run/media"] {
            let Ok(entries) = std::fs::read_dir(Path::new(base).join(&user)) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && !roots.iter().any(|r| path.starts_with(r)) {
                    roots.push(path);
                }
            }
        }
    }
    roots
}

/// Finds photo folders the way a phone gallery does, skipping hidden folders, app data,
/// software projects and icon-sized images.
pub fn discover(roots: &[PathBuf]) -> Vec<Folder> {
    roots
        .iter()
        .flat_map(|root| {
            walk(
                WalkDir::new(root).follow_links(false).max_depth(MAX_DISCOVERY_DEPTH),
                root,
                true,
            )
        })
        .collect()
}

fn walk(walker: WalkDir, root: &Path, discovering: bool) -> Vec<Folder> {
    let mut groups: BTreeMap<PathBuf, Vec<Photo>> = BTreeMap::new();
    let entries = walker.into_iter().filter_entry(|e| {
        e.depth() == 0 || !(is_hidden(e) || (discovering && is_skipped_dir(e)))
    });

    for entry in entries.filter_map(Result::ok) {
        if !entry.file_type().is_file() || !is_image(entry.path()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if discovering && meta.len() < MIN_DISCOVERED_BYTES {
            continue;
        }
        let parent = entry.path().parent().unwrap_or(root).to_path_buf();
        groups.entry(parent).or_default().push(Photo {
            path: entry.path().to_string_lossy().into_owned(),
            name: entry.file_name().to_string_lossy().into_owned(),
            size: meta.len(),
            mtime: unix_seconds(meta.modified()),
        });
    }

    groups
        .into_iter()
        .map(|(dir, photos)| Folder {
            name: dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| dir.to_string_lossy().into_owned()),
            path: dir.to_string_lossy().into_owned(),
            photos,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sliderpro-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: PathBuf, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![0u8; bytes]).unwrap();
    }

    fn found(folders: &[Folder]) -> Vec<String> {
        let mut names: Vec<String> = folders
            .iter()
            .flat_map(|f| f.photos.iter().map(|p| p.name.clone()))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn discovery_finds_photos_but_skips_app_data_projects_and_icons() {
        let home = temp_home("discover");
        write(home.join("Pictures/Trip/beach.jpg"), 50_000);
        write(home.join("Downloads/IMG_1.png"), 40_000);
        write(home.join("Downloads/favicon.png"), 900);
        write(home.join(".cache/thumb.jpg"), 50_000);
        write(home.join("stuff/node_modules/pkg/logo.jpg"), 50_000);
        write(home.join("code/app/package.json"), 2);
        write(home.join("code/app/assets/hero.jpg"), 50_000);
        write(home.join("Pictures/notes.txt"), 50_000);

        let folders = discover(&[home.clone()]);
        assert_eq!(found(&folders), vec!["IMG_1.png", "beach.jpg"]);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn manual_scan_keeps_small_images_and_projects() {
        let home = temp_home("manual");
        write(home.join("icons/tiny.png"), 500);
        write(home.join("package.json"), 2);
        write(home.join(".hidden/secret.jpg"), 50_000);

        let folders = scan(&home, true);
        assert_eq!(found(&folders), vec!["tiny.png"]);
        let _ = fs::remove_dir_all(home);
    }
}
