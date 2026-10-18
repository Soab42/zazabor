mod dims;
mod fs;
mod imaging;
mod lock;
mod migrate;
mod music;
mod protocol;
mod scan;
mod video;

use std::path::{Path, PathBuf};
use tauri::Manager;

/// Library commands refuse to run while the app is locked.
fn ensure_unlocked() -> Result<(), String> {
    if lock::is_locked() {
        Err("locked".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
async fn scan_folder(path: String, recursive: Option<bool>) -> Result<Vec<scan::Folder>, String> {
    ensure_unlocked()?;
    let recursive = recursive.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        let folders = scan::scan(Path::new(&path), recursive);
        dims::save();
        folders
    })
    .await
    .map_err(|e| e.to_string())
}

fn library_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|d| d.join("library.json"))
        .map_err(|e| e.to_string())
}

/// Scans this computer for photo folders and caches the result for the next launch.
#[tauri::command]
async fn discover_photos(app: tauri::AppHandle) -> Result<Vec<scan::Folder>, String> {
    ensure_unlocked()?;
    let roots = scan::discovery_roots(app.path().home_dir().ok());
    let cache = library_cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let folders = scan::discover(&roots);
        dims::save();
        if let Ok(json) = serde_json::to_string(&folders) {
            if let Some(dir) = cache.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&cache, json);
        }
        folders
    })
    .await
    .map_err(|e| e.to_string())
}

/// Songs on this computer (the Music folder, plus Downloads and Desktop near the top).
#[tauri::command]
async fn discover_music(app: tauri::AppHandle) -> Result<Vec<scan::MusicFile>, String> {
    ensure_unlocked()?;
    let mut roots: Vec<(PathBuf, usize)> = Vec::new();
    if let Ok(music) = app.path().audio_dir() {
        roots.push((music, 8));
    }
    if let Ok(home) = app.path().home_dir() {
        roots.push((home.join("Music"), 8));
        roots.push((home.join("Downloads"), 3));
        roots.push((home.join("Desktop"), 2));
    }
    tauri::async_runtime::spawn_blocking(move || scan::discover_music(&roots))
        .await
        .map_err(|e| e.to_string())
}

/// YouTube's Audio Library: free music the user may download and use.
const AUDIO_LIBRARY_URL: &str = "https://www.youtube.com/audiolibrary";

pub(crate) fn open_with_system(target: &std::ffi::OsStr) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") { "open" } else if cfg!(windows) { "explorer" } else { "xdg-open" };
    std::process::Command::new(opener)
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Opens the user's Music folder (creating it if needed), where downloaded songs belong.
#[tauri::command]
fn open_music_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .audio_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Music")))
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open_with_system(dir.as_os_str())
}

/// Opens YouTube's Audio Library (royalty-free music) in the default browser.
#[tauri::command]
fn open_audio_library() -> Result<(), String> {
    open_with_system(std::ffi::OsStr::new(AUDIO_LIBRARY_URL))
}

/// The result of the previous discovery, so the gallery can appear instantly.
#[tauri::command]
fn cached_photos(app: tauri::AppHandle) -> Option<String> {
    ensure_unlocked().ok()?;
    std::fs::read_to_string(library_cache_path(&app).ok()?).ok()
}

/// The soundtracks bundled with the app, with absolute paths.
#[tauri::command]
fn builtin_tracks(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("resources")
        .join("music");
    let manifest = std::fs::read_to_string(dir.join("tracks.json")).map_err(|e| e.to_string())?;
    let mut tracks: serde_json::Value = serde_json::from_str(&manifest).map_err(|e| e.to_string())?;
    for track in tracks.as_array_mut().into_iter().flatten() {
        if let Some(file) = track.get("file").and_then(|f| f.as_str()).map(str::to_owned) {
            track["path"] = dir.join(file).to_string_lossy().into_owned().into();
        }
    }
    Ok(tracks)
}

#[tauri::command]
async fn photo_info(path: String) -> Result<imaging::PhotoInfo, String> {
    ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || imaging::photo_info(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

/// "dir", "image", "audio", "file" or "missing" — used to route drag-and-drop and launch paths.
#[tauri::command]
fn path_kind(path: String) -> &'static str {
    let path = Path::new(&path);
    if path.is_dir() {
        "dir"
    } else if !path.is_file() {
        "missing"
    } else if scan::is_image(path) {
        "image"
    } else if scan::is_audio(path) {
        "audio"
    } else {
        "file"
    }
}

/// The first command-line argument that names an existing file or folder, for "Open with".
#[tauri::command]
fn launch_path() -> Option<String> {
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(PathBuf::from)
        .find(|p| p.exists())
        .and_then(|p| std::fs::canonicalize(&p).ok().or(Some(p)))
        .map(|p| p.to_string_lossy().into_owned())
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("config.json"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> Option<String> {
    std::fs::read_to_string(config_path(&app).ok()?).ok()
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = config_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Lets the frontend print to the terminal, which is where `tauri dev` users look.
#[tauri::command]
fn log(level: String, message: String) {
    eprintln!("[web:{level}] {message}");
}

/// WebKitGTK only honours CORS headers on custom schemes registered as CORS-enabled. Without
/// this, `cs://` images taint canvases and WebGL refuses to upload them as textures.
#[cfg(target_os = "linux")]
fn enable_cors_for_cs_scheme(webview: tauri::webview::PlatformWebview) {
    use webkit2gtk::{SecurityManagerExt, WebContextExt, WebViewExt};
    if let Some(security) = webview.inner().context().and_then(|c| c.security_manager()) {
        security.register_uri_scheme_as_cors_enabled("cs");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("cs", |_ctx, request, responder| {
            protocol::handle(request, responder)
        })
        .setup(|app| {
            let cache = app.path().app_cache_dir()?;
            migrate::run(&app.path().app_config_dir()?, &cache);
            protocol::init(cache.join("renders"));
            dims::init(cache.join("dimensions.json"));
            lock::init(app.path().app_config_dir()?);
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(enable_cors_for_cs_scheme)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            discover_photos,
            discover_music,
            open_music_folder,
            open_audio_library,
            cached_photos,
            builtin_tracks,
            music::music_play,
            music::music_pause,
            music::music_resume,
            music::music_volume,
            music::music_stop,
            music::music_position,
            lock::lock_status,
            lock::lock_now,
            lock::unlock,
            lock::confirm_identity,
            lock::set_lock,
            photo_info,
            path_kind,
            launch_path,
            load_config,
            save_config,
            log,
            fs::fs_list,
            fs::fs_stat,
            fs::fs_places,
            fs::fs_volumes,
            fs::fs_watch,
            fs::fs_unwatch,
            fs::fs_open_default,
            // video
            video::video_open,
            video::video_set_paused,
            video::video_stop,
            video::video_seek,
            video::video_set_volume,
            video::video_set_muted,
            video::video_set_rate,
            video::video_set_audio_track,
            video::video_set_subtitle_track,
            video::video_add_subtitle,
            video::video_state,
            video::video_list,
            // file operations
            fs::fs_copy,
            fs::fs_move,
            fs::fs_trash,
            fs::fs_trash_restore,
            fs::fs_delete,
            fs::fs_empty_trash,
            fs::fs_job_resolve,
            fs::fs_job_cancel,
            fs::fs_rename,
            fs::fs_new_folder,
            fs::fs_duplicate,
            fs::fs_undo,
            // quick look and info
            fs::fs_read_text,
            fs::fs_read_binary,
            fs::fs_info,
            fs::fs_folder_size,
            fs::fs_folder_size_cancel,
            fs::fs_tags_get,
            fs::fs_tags_set,
            // video: chrome and quick access
            video::audio_out::video_audio_devices,
            video::audio_out::video_set_audio_device,
            video::chapters::video_chapters,
            video::chapters::video_set_chapter,
            video::sprite::video_sprite_start,
            video::sprite::video_sprite_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running CorePro");
}
