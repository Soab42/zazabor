//! Listing the video files in a folder, for the play queue and the sidebar.

use serde::Serialize;
use std::cmp::Ordering;
use std::path::Path;

use crate::scan::{extension, unix_seconds};

const VIDEO_EXTS: &[&str] = &[
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "3gp", "ogv",
];

#[derive(Serialize, Debug, PartialEq)]
pub struct VideoFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// Seconds since the epoch.
    pub mtime: f64,
}

pub fn is_video(path: &Path) -> bool {
    extension(path).is_some_and(|e| VIDEO_EXTS.contains(&e.as_str()))
}

/// Compares names the way people read them: case-insensitive, digit runs by value.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a_chars, mut b_chars) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a_chars.peek().copied(), b_chars.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let run = |chars: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut digits = String::new();
                    while let Some(c) = chars.next_if(|c| c.is_ascii_digit()) {
                        digits.push(c);
                    }
                    digits.trim_start_matches('0').to_string()
                };
                let (na, nb) = (run(&mut a_chars), run(&mut b_chars));
                let order = na.len().cmp(&nb.len()).then_with(|| na.cmp(&nb));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(x), Some(y)) => {
                let order = x.to_lowercase().cmp(y.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                a_chars.next();
                b_chars.next();
            }
        }
    }
}

/// The video files directly inside `folder`, hidden files skipped, sorted naturally by name.
pub fn list_videos(folder: &Path) -> Result<Vec<VideoFile>, String> {
    let entries = std::fs::read_dir(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let mut files: Vec<VideoFile> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            let path = entry.path();
            if name.starts_with('.') || !is_video(&path) {
                return None;
            }
            // `metadata` follows symlinks, so linked videos count and broken links drop out.
            let meta = std::fs::metadata(&path).ok().filter(|m| m.is_file())?;
            Some(VideoFile {
                name,
                path: path.to_string_lossy().into_owned(),
                size: meta.len(),
                mtime: unix_seconds(meta.modified()),
            })
        })
        .collect();
    files.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order_reads_numbers_by_value() {
        let mut names = vec!["ep10.mkv", "Ep2.mkv", "ep1.mkv", "ep02.mkv", "a.mkv"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, ["a.mkv", "ep1.mkv", "Ep2.mkv", "ep02.mkv", "ep10.mkv"]);
        assert_eq!(natural_cmp("x", "x"), Ordering::Equal);
        assert_eq!(natural_cmp("a9", "a10"), Ordering::Less);
        assert_eq!(natural_cmp("a", "a1"), Ordering::Less);
    }

    #[test]
    fn extensions_are_case_insensitive() {
        assert!(is_video(Path::new("/x/Movie.MKV")));
        assert!(is_video(Path::new("clip.m2ts")));
        assert!(!is_video(Path::new("song.mp3")));
        assert!(!is_video(Path::new("mkv")));
    }

    #[test]
    fn lists_only_visible_videos_in_order() {
        let dir = std::env::temp_dir().join(format!("zazabor-vlist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub.mp4")).unwrap();
        for name in ["b10.mp4", "b2.mp4", ".hidden.mp4", "notes.txt", "a.WEBM"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let files = list_videos(&dir).unwrap();
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["a.WEBM", "b2.mp4", "b10.mp4"]);
        assert_eq!(files[0].size, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
