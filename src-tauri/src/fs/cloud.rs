//! Cloud drives mounted by GVfs (Google Drive, OneDrive accounts from GNOME Online Accounts),
//! reached through its FUSE bridge at /run/user/<uid>/gvfs/…, are listed through GIO rather than
//! the file system: on disk their files are named by id, and Google's Docs, Sheets and Slides are
//! links to the web rather than files. GIO knows their titles, kinds, dates and web addresses.
//!
//! Paths stay the on-disk ones, so opening, copying and watching keep working; only what is shown
//! (and the name a copy gets) comes from GIO.

use super::list::{extension_of, FsEntry};
use gio::prelude::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const ATTRIBUTES: &str = "standard::name,standard::display-name,standard::type,standard::size,standard::is-hidden,\
standard::content-type,standard::target-uri,time::modified";

/// GVfs backends whose on-disk names are ids rather than titles.
const CLOUD_BACKENDS: [&str; 2] = ["/gvfs/google-drive:", "/gvfs/onedrive:"];

/// Google's own document types: links to the web app, not downloadable files.
const WEB_DOCUMENT: &str = "application/vnd.google-apps.";

/// Whether a path is on a cloud drive that must be listed through GIO.
pub fn is_cloud(path: &Path) -> bool {
    path.to_str().is_some_and(|p| CLOUD_BACKENDS.iter().any(|b| p.contains(b)))
}

fn readable(err: &gio::glib::Error, path: &Path) -> String {
    if err.matches(gio::IOErrorEnum::NotFound) {
        format!("Folder not found: {}", path.display())
    } else if err.matches(gio::IOErrorEnum::PermissionDenied) {
        format!("Permission denied: {}", path.display())
    } else {
        format!("Couldn’t read {}: {}", path.display(), err.message())
    }
}

fn entry_from(info: &gio::FileInfo, path: PathBuf) -> FsEntry {
    let name = info.display_name().to_string();
    remember(&path, &name);
    let dir = matches!(info.file_type(), gio::FileType::Directory | gio::FileType::Mountable);
    let mime = info.content_type().map(|t| t.to_string());
    let url = info.attribute_string("standard::target-uri").map(|u| u.to_string()).filter(|u| u.starts_with("http"));
    let web = url.is_some() || mime.as_deref().is_some_and(|m| m.starts_with(WEB_DOCUMENT));
    FsEntry {
        hidden: info.is_hidden(),
        // A Google Doc called "notes.md" is not a Markdown file.
        ext: if dir || web { String::new() } else { extension_of(&name) },
        size: if dir || web { 0.0 } else { info.size().max(0) as f64 },
        mtime: info.modification_date_time().map(|t| t.to_unix() as f64).unwrap_or(0.0),
        path: path.to_string_lossy().into_owned(),
        name,
        dir,
        link: false,
        mime,
        url,
    }
}

pub fn list(path: &Path, show_hidden: bool) -> Result<Vec<FsEntry>, String> {
    let folder = gio::File::for_path(path);
    let children = folder
        .enumerate_children(ATTRIBUTES, gio::FileQueryInfoFlags::NOFOLLOW_SYMLINKS, gio::Cancellable::NONE)
        .map_err(|e| readable(&e, path))?;
    let mut entries = Vec::new();
    while let Some(info) = children.next_file(gio::Cancellable::NONE).map_err(|e| readable(&e, path))? {
        if !show_hidden && info.is_hidden() {
            continue;
        }
        entries.push(entry_from(&info, path.join(info.name())));
    }
    Ok(entries)
}

pub fn stat(path: &Path) -> Result<FsEntry, String> {
    let info = gio::File::for_path(path)
        .query_info(ATTRIBUTES, gio::FileQueryInfoFlags::NOFOLLOW_SYMLINKS, gio::Cancellable::NONE)
        .map_err(|e| readable(&e, path))?;
    Ok(entry_from(&info, path.to_path_buf()))
}

// ---- titles ------------------------------------------------------------------------------------

/// Titles seen in listings, by on-disk path: the path bar and copies ask for them often.
static TITLES: Mutex<Option<HashMap<PathBuf, String>>> = Mutex::new(None);
const MAX_TITLES: usize = 20_000;

fn titles() -> MutexGuard<'static, Option<HashMap<PathBuf, String>>> {
    TITLES.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn remember(path: &Path, title: &str) {
    let mut guard = titles();
    let map = guard.get_or_insert_with(HashMap::new);
    if map.len() >= MAX_TITLES {
        map.clear();
    }
    map.insert(path.to_path_buf(), title.to_string());
}

/// What people call a cloud path's last part ("My Drive", a document's title); `None` for other
/// paths or when the drive can't be reached.
pub fn title(path: &Path) -> Option<String> {
    if !is_cloud(path) {
        return None;
    }
    if let Some(title) = titles().as_ref().and_then(|m| m.get(path).cloned()) {
        return Some(title);
    }
    let info = gio::File::for_path(path)
        .query_info("standard::display-name", gio::FileQueryInfoFlags::NOFOLLOW_SYMLINKS, gio::Cancellable::NONE)
        .ok()?;
    let title = info.display_name().to_string();
    remember(path, &title);
    Some(title)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_cloud_backends_go_through_gio() {
        assert!(is_cloud(Path::new("/run/user/1000/gvfs/google-drive:host=gmail.com,user=me/0AF5w1fy")));
        assert!(is_cloud(Path::new("/run/user/1000/gvfs/onedrive:host=x,user=me")));
        assert!(!is_cloud(Path::new("/run/user/1000/gvfs/smb-share:server=nas,share=media")));
        assert!(!is_cloud(Path::new("/home/me/google-drive:notes")));
        assert_eq!(title(Path::new("/home/me/file.txt")), None);
    }

    /// `CS_CLOUD=/run/user/1000/gvfs/google-drive:… cargo test cloud -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn lists_a_real_drive() {
        let Ok(path) = std::env::var("CS_CLOUD") else { return };
        let started = std::time::Instant::now();
        let entries = list(Path::new(&path), false).unwrap();
        println!("{} entries in {:?}", entries.len(), started.elapsed());
        for e in entries.iter().take(8) {
            println!("{:40} dir={} size={} mtime={} ext={:?} mime={:?} url={}", e.name, e.dir, e.size, e.mtime, e.ext, e.mime, e.url.is_some());
        }
    }

    /// A picture named by id on disk is known by its title, so previews and the viewer take it.
    /// `CS_CLOUD_PICTURE=/run/user/1000/gvfs/google-drive:…/<id> cargo test cloud -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn a_real_picture_is_known_by_its_title() {
        let Ok(path) = std::env::var("CS_CLOUD_PICTURE") else { return };
        let path = Path::new(&path);
        assert!(crate::scan::is_image(path));
        let info = crate::imaging::photo_info(path).unwrap();
        let render = crate::imaging::render(path, 256).unwrap();
        println!("{:?}: {} {}×{}, rendered {}×{}", title(path), info.format, info.width, info.height, render.width(), render.height());
        assert!(info.width > 0 && render.width() > 0);
    }
}
