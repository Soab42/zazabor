//! `.corevideo` projects: JSON written by the page. This side only rewrites where media lives:
//! in memory every media item has an absolute `path`; on disk it's kept relative to the project's
//! folder (so a project and its clips can move together) with the absolute path beside it as a
//! fallback. Opening resolves them back and marks what can't be found as `missing`.

use serde_json::Value;
use std::path::{Component, Path, PathBuf};

/// What a project file says it is.
pub const APP: &str = "corevideo";
/// The newest project format this build reads.
pub const VERSION: u64 = 1;

/// `target` relative to the folder `base` (both absolute), with `..` steps when needed.
pub fn relative(base: &Path, target: &Path) -> Option<PathBuf> {
    if !base.is_absolute() || !target.is_absolute() {
        return None;
    }
    let base_n = normalize(base);
    let base: Vec<Component> = base_n.components().collect();
    let target_n = normalize(target);
    let target: Vec<Component> = target_n.components().collect();
    let common = base.iter().zip(&target).take_while(|(a, b)| a == b).count();
    // Only the root in common: an absolute path says it better.
    if common <= 1 {
        return None;
    }
    let mut out = PathBuf::new();
    for _ in common..base.len() {
        out.push("..");
    }
    for part in &target[common..] {
        out.push(part.as_os_str());
    }
    Some(out)
}

/// Removes `.` and folds `..` without touching the disk.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The media list's items, if the project has one.
fn media_mut(project: &mut Value) -> Vec<&mut serde_json::Map<String, Value>> {
    match project.get_mut("media").and_then(Value::as_array_mut) {
        Some(items) => items.iter_mut().filter_map(Value::as_object_mut).collect(),
        None => Vec::new(),
    }
}

/// Before writing: each media `path` becomes relative to `folder`, the absolute one goes to
/// `absolute`, and in-memory flags (`missing`) are dropped.
pub fn to_disk(project: &mut Value, folder: &Path) {
    if let Some(object) = project.as_object_mut() {
        object.insert("app".into(), Value::from(APP));
        object.insert("version".into(), Value::from(VERSION));
    }
    for item in media_mut(project) {
        item.remove("missing");
        let Some(path) = item.get("path").and_then(Value::as_str).map(PathBuf::from) else { continue };
        if let Some(rel) = relative(folder, &path) {
            item.insert("absolute".into(), Value::from(path.to_string_lossy().into_owned()));
            item.insert("path".into(), Value::from(rel.to_string_lossy().into_owned()));
        } else {
            item.remove("absolute");
        }
    }
}

/// After reading: each media `path` becomes absolute again. A relative path that no longer
/// exists falls back to the stored absolute one; when neither exists the item is `missing`.
pub fn from_disk(project: &mut Value, folder: &Path, exists: impl Fn(&Path) -> bool) -> Result<(), String> {
    if project.get("app").and_then(Value::as_str) != Some(APP) {
        return Err("This isn't a CorePro video project.".into());
    }
    let version = project.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version > VERSION {
        return Err("This project was saved by a newer CorePro. Update CorePro to open it.".into());
    }
    for item in media_mut(project) {
        let Some(stored) = item.get("path").and_then(Value::as_str).map(PathBuf::from) else { continue };
        let absolute = item.remove("absolute").and_then(|v| v.as_str().map(PathBuf::from));
        let joined = if stored.is_absolute() { stored.clone() } else { normalize(&folder.join(&stored)) };
        let found = if exists(&joined) {
            Some(joined.clone())
        } else {
            absolute.filter(|p| exists(p))
        };
        let path = found.clone().unwrap_or(joined);
        item.insert("path".into(), Value::from(path.to_string_lossy().into_owned()));
        if found.is_none() {
            item.insert("missing".into(), Value::Bool(true));
        } else {
            item.remove("missing");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn relative_paths_walk_up_and_down() {
        let base = Path::new("/home/me/Videos/project");
        assert_eq!(relative(base, Path::new("/home/me/Videos/project/a.mp4")).unwrap(), PathBuf::from("a.mp4"));
        assert_eq!(relative(base, Path::new("/home/me/Videos/project/clips/b.mov")).unwrap(), PathBuf::from("clips/b.mov"));
        assert_eq!(relative(base, Path::new("/home/me/Videos/c.mp4")).unwrap(), PathBuf::from("../c.mp4"));
        assert_eq!(relative(base, Path::new("/home/me/Music/song.mp3")).unwrap(), PathBuf::from("../../Music/song.mp3"));
        assert_eq!(relative(base, Path::new("/home/me/Videos/./project/../d.mp4")).unwrap(), PathBuf::from("../d.mp4"));
        assert!(relative(base, Path::new("/media/usb/e.mp4")).is_none());
        assert!(relative(Path::new("rel"), Path::new("/x/y")).is_none());
    }

    #[test]
    fn saving_and_opening_round_trips_and_follows_a_moved_project() {
        let mut project = json!({
            "canvas": { "aspect": "9:16" },
            "media": [
                { "id": "m1", "path": "/home/me/reel/clip.mp4", "missing": false },
                { "id": "m2", "path": "/home/me/Music/song.mp3" },
                { "id": "m3", "path": "/media/usb/far.mp4" }
            ]
        });
        to_disk(&mut project, Path::new("/home/me/reel"));
        assert_eq!(project["app"], APP);
        assert_eq!(project["version"], VERSION);
        assert_eq!(project["media"][0]["path"], "clip.mp4");
        assert_eq!(project["media"][0]["absolute"], "/home/me/reel/clip.mp4");
        assert!(project["media"][0].get("missing").is_none());
        assert_eq!(project["media"][1]["path"], "../Music/song.mp3");
        assert_eq!(project["media"][2]["path"], "/media/usb/far.mp4");
        assert!(project["media"][2].get("absolute").is_none());

        // The project folder moved to /home/me/old/reel with its clip; the song stayed put.
        let present = ["/home/me/old/reel/clip.mp4", "/home/me/Music/song.mp3"];
        let mut opened = project.clone();
        from_disk(&mut opened, Path::new("/home/me/old/reel"), |p| present.contains(&p.to_str().unwrap())).unwrap();
        assert_eq!(opened["media"][0]["path"], "/home/me/old/reel/clip.mp4");
        assert!(opened["media"][0].get("missing").is_none());
        // ../Music/song.mp3 from the new folder doesn't exist; the absolute path does.
        assert_eq!(opened["media"][1]["path"], "/home/me/Music/song.mp3");
        assert_eq!(opened["media"][2]["path"], "/media/usb/far.mp4");
        assert_eq!(opened["media"][2]["missing"], true);
        assert!(opened["media"][0].get("absolute").is_none());
    }

    #[test]
    fn opening_refuses_other_files_and_newer_versions() {
        let folder = Path::new("/x");
        assert!(from_disk(&mut json!({ "media": [] }), folder, |_| true).is_err());
        assert!(from_disk(&mut json!({ "app": APP, "version": VERSION + 1 }), folder, |_| true).is_err());
        assert!(from_disk(&mut json!({ "app": APP, "version": VERSION }), folder, |_| true).is_ok());
    }
}
