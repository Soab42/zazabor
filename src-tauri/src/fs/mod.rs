//! The Files module's backend: folder listing, standard places, mounted volumes, change
//! watching and "open with the default app". The command shapes mirror
//! `src/modules/files/api.ts`.

mod info;
mod list;
mod tags;
mod text;
mod volumes;
mod watch;

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub use list::FsEntry;
pub use volumes::Volume;

/// Everything here refuses to run while the app is locked, like the photo library does.
fn ensure_unlocked() -> Result<(), String> {
    if crate::lock::is_locked() {
        Err("locked".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn fs_list(path: String, show_hidden: bool) -> Result<Vec<FsEntry>, String> {
    ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || list::list(Path::new(&path), show_hidden))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_stat(path: String) -> Result<FsEntry, String> {
    ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || list::stat(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

/// A standard folder for the sidebar's Favourites.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub kind: &'static str,
    pub name: &'static str,
    pub path: String,
}

/// Keeps only the candidates that exist, in order.
fn existing_places(candidates: Vec<(&'static str, &'static str, Option<PathBuf>)>) -> Vec<Place> {
    candidates
        .into_iter()
        .filter_map(|(kind, name, path)| {
            let path = path?;
            path.is_dir().then(|| Place { kind, name, path: path.to_string_lossy().into_owned() })
        })
        .collect()
}

#[tauri::command]
pub fn fs_places(app: tauri::AppHandle) -> Result<Vec<Place>, String> {
    ensure_unlocked()?;
    let p = app.path();
    let home = p.home_dir().ok();
    let trash = home.as_ref().map(|h| h.join(".local/share/Trash/files"));
    Ok(existing_places(vec![
        ("home", "Home", home),
        ("desktop", "Desktop", p.desktop_dir().ok()),
        ("documents", "Documents", p.document_dir().ok()),
        ("downloads", "Downloads", p.download_dir().ok()),
        ("pictures", "Pictures", p.picture_dir().ok()),
        ("videos", "Videos", p.video_dir().ok()),
        ("music", "Music", p.audio_dir().ok()),
        ("trash", "Trash", trash),
    ]))
}

#[tauri::command]
pub async fn fs_volumes() -> Result<Vec<Volume>, String> {
    ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(volumes::volumes)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_watch(app: tauri::AppHandle, path: String) -> Result<(), String> {
    ensure_unlocked()?;
    watch::watch(app, PathBuf::from(path))
}

#[tauri::command]
pub fn fs_unwatch(path: String) -> Result<(), String> {
    ensure_unlocked()?;
    watch::unwatch(Path::new(&path));
    Ok(())
}

/// Opens a file or folder with the system's default application.
#[tauri::command]
pub fn fs_open_default(path: String) -> Result<(), String> {
    crate::open_with_system(std::ffi::OsStr::new(&path))
}

// ---- quick look and info ----------------------------------------------------------------------

/// The start of a file as text, for Quick Look.
#[tauri::command]
pub async fn fs_read_text(path: String, max_bytes: usize) -> Result<text::TextPreview, String> {
    ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || text::read_text(Path::new(&path), max_bytes))
        .await
        .map_err(|e| e.to_string())?
}

/// A file's raw bytes (up to `max_bytes`), answered as a binary IPC response.
#[tauri::command]
pub async fn fs_read_binary(path: String, max_bytes: u64) -> Result<tauri::ipc::Response, String> {
    ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || text::read_bytes(Path::new(&path), max_bytes))
        .await
        .map_err(|e| e.to_string())?
        .map(tauri::ipc::Response::new)
}

/// Metadata for Get Info.
#[tauri::command]
pub async fn fs_info(path: String) -> Result<info::FsInfo, String> {
    ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || info::info(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

/// Starts measuring a folder; answers with a job id and streams `fs-size` events.
#[tauri::command]
pub fn fs_folder_size(app: tauri::AppHandle, path: String) -> Result<u64, String> {
    ensure_unlocked()?;
    Ok(info::start_folder_size(app, PathBuf::from(path)))
}

#[tauri::command]
pub fn fs_folder_size_cancel(id: u64) {
    info::cancel_folder_size(id);
}

/// The colour tags of each path (paths without tags are left out).
#[tauri::command]
pub async fn fs_tags_get(paths: Vec<String>) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || tags::get_many(&paths))
        .await
        .map_err(|e| e.to_string())
}

/// Replaces a path's tags; rejects when the filesystem has no user extended attributes.
#[tauri::command]
pub async fn fs_tags_set(path: String, tags: Vec<String>) -> Result<(), String> {
    ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || tags::set(Path::new(&path), &tags))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn places_keep_only_existing_folders() {
        let dir = std::env::temp_dir().join(format!("corepro-places-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let places = existing_places(vec![
            ("home", "Home", Some(dir.clone())),
            ("music", "Music", Some(dir.join("nope"))),
            ("trash", "Trash", None),
        ]);
        assert_eq!(places.len(), 1);
        assert_eq!(places[0].kind, "home");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
