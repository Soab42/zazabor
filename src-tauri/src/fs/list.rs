//! Folder listing for the Files module.

use super::cloud;
use crate::scan::unix_seconds;
use serde::Serialize;
use std::fs::{self, Metadata};
use std::io;
use std::path::Path;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    /// A folder, or a symlink that points at one.
    pub dir: bool,
    pub link: bool,
    pub hidden: bool,
    pub size: f64,
    pub mtime: f64,
    pub ext: String,
    /// The content type, when the listing knows it (cloud drives).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    /// A web address that opens the item (a Google Doc is a link, not a file).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// A readable message for the failures a user can run into.
fn describe(err: &io::Error, path: &Path) -> String {
    let shown = path.display();
    match err.kind() {
        io::ErrorKind::PermissionDenied => format!("Permission denied: {shown}"),
        io::ErrorKind::NotFound => format!("Folder not found: {shown}"),
        _ if path.is_file() => format!("Not a folder: {shown}"),
        _ => format!("Cannot read {shown}: {err}"),
    }
}

pub(super) fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => name[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// Builds an entry from the link-level metadata, following links for the target's details.
fn entry_from(name: String, path: &Path, own: &Metadata) -> FsEntry {
    let link = own.file_type().is_symlink();
    // A broken link has no target metadata: it is a non-folder of size 0.
    let target = if link { fs::metadata(path).ok() } else { None };
    let meta = target.as_ref().unwrap_or(own);
    let dir = meta.is_dir();
    let broken = link && target.is_none();
    FsEntry {
        hidden: name.starts_with('.'),
        ext: if dir { String::new() } else { extension_of(&name) },
        size: if dir || broken { 0.0 } else { meta.len() as f64 },
        mtime: unix_seconds(meta.modified()),
        path: path.to_string_lossy().into_owned(),
        name,
        dir,
        link,
        mime: None,
        url: None,
    }
}

pub fn list(path: &Path, show_hidden: bool) -> Result<Vec<FsEntry>, String> {
    if cloud::is_cloud(path) {
        return cloud::list(path, show_hidden);
    }
    let reader = fs::read_dir(path).map_err(|e| describe(&e, path))?;
    let mut entries = Vec::new();
    for item in reader.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        // `DirEntry::metadata` is an lstat: one syscall, and it does not follow links.
        if let Ok(own) = item.metadata() {
            entries.push(entry_from(name, &item.path(), &own));
        }
    }
    Ok(entries)
}

pub fn stat(path: &Path) -> Result<FsEntry, String> {
    if cloud::is_cloud(path) {
        return cloud::stat(path);
    }
    let own = fs::symlink_metadata(path).map_err(|e| describe(&e, path))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    Ok(entry_from(name, path, &own))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("corepro-fs-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn find<'a>(entries: &'a [FsEntry], name: &str) -> &'a FsEntry {
        entries.iter().find(|e| e.name == name).unwrap()
    }

    #[test]
    fn hides_dotfiles_unless_asked() {
        let dir = temp("hidden");
        fs::write(dir.join(".secret"), "x").unwrap();
        fs::write(dir.join("shown.txt"), "x").unwrap();
        let plain = list(&dir, false).unwrap();
        assert_eq!(plain.len(), 1);
        let all = list(&dir, true).unwrap();
        assert_eq!(all.len(), 2);
        assert!(find(&all, ".secret").hidden);
        assert!(!find(&all, "shown.txt").hidden);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extension_is_lowercase_and_folders_have_none() {
        let dir = temp("ext");
        fs::write(dir.join("Photo.JPG"), "abc").unwrap();
        fs::write(dir.join("README"), "x").unwrap();
        fs::write(dir.join(".bashrc"), "x").unwrap();
        fs::create_dir(dir.join("album.2024")).unwrap();
        let entries = list(&dir, true).unwrap();
        assert_eq!(find(&entries, "Photo.JPG").ext, "jpg");
        assert_eq!(find(&entries, "Photo.JPG").size, 3.0);
        assert_eq!(find(&entries, "README").ext, "");
        assert_eq!(find(&entries, ".bashrc").ext, "");
        let folder = find(&entries, "album.2024");
        assert!(folder.dir && folder.ext.is_empty() && folder.size == 0.0);
        assert!(!find(&entries, "README").dir);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn symlink_to_folder_is_a_folder_and_a_link() {
        let dir = temp("link");
        fs::create_dir(dir.join("real")).unwrap();
        symlink(dir.join("real"), dir.join("shortcut")).unwrap();
        let entries = list(&dir, false).unwrap();
        let link = find(&entries, "shortcut");
        assert!(link.dir && link.link);
        assert!(!find(&entries, "real").link);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_symlink_is_an_empty_non_folder() {
        let dir = temp("broken");
        symlink(dir.join("missing"), dir.join("dangling.txt")).unwrap();
        let entries = list(&dir, false).unwrap();
        let link = find(&entries, "dangling.txt");
        assert!(link.link && !link.dir);
        assert_eq!(link.size, 0.0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn errors_are_readable() {
        let dir = temp("errors");
        let missing = list(&dir.join("nope"), false).unwrap_err();
        assert!(missing.starts_with("Folder not found: "), "{missing}");
        fs::write(dir.join("f.txt"), "x").unwrap();
        let not_folder = list(&dir.join("f.txt"), false).unwrap_err();
        assert!(not_folder.starts_with("Not a folder: "), "{not_folder}");
        assert!(stat(&dir.join("nope")).unwrap_err().starts_with("Folder not found: "));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stat_describes_one_path() {
        let dir = temp("stat");
        fs::write(dir.join("a.PNG"), "12345").unwrap();
        let entry = stat(&dir.join("a.PNG")).unwrap();
        assert_eq!((entry.name.as_str(), entry.ext.as_str(), entry.size), ("a.PNG", "png", 5.0));
        assert!(entry.mtime > 0.0);
        let _ = fs::remove_dir_all(&dir);
    }
}
