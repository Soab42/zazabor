//! The `cs://` scheme serves photos to the webview:
//!
//! - `cs://localhost/thumb?p=<path>&s=<px>`   cached, oriented thumbnail (long edge <= s)
//! - `cs://localhost/preview?p=<path>&s=<px>` cached, oriented render (s = 0: full size)
//! - `cs://localhost/file?p=<path>`           the original bytes of an image or audio file
//!
//! Responses carry `Access-Control-Allow-Origin: *` so canvas and WebGL can read the pixels.

use rayon::ThreadPool;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::http::{Request, Response, StatusCode};
use tauri::UriSchemeResponder;

use crate::imaging;
use crate::scan::{extension, is_audio, is_image};

static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();
static THUMB_POOL: OnceLock<ThreadPool> = OnceLock::new();
static PREVIEW_POOL: OnceLock<ThreadPool> = OnceLock::new();

pub fn init(cache_dir: PathBuf) {
    let _ = fs::create_dir_all(&cache_dir);
    let _ = CACHE_DIR.set(cache_dir);
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    // Thumbnails and large renders get separate pools so a scroll through thousands of
    // thumbnails never delays the photo the user is actually looking at.
    let pool = |threads: usize, name: &'static str| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(move |i| format!("{name}-{i}"))
            .build()
            .expect("failed to build thread pool")
    };
    let _ = THUMB_POOL.set(pool(cores.saturating_sub(2).max(2), "thumb"));
    let _ = PREVIEW_POOL.set(pool(2, "preview"));
}

pub fn cache_dir() -> Option<&'static PathBuf> {
    CACHE_DIR.get()
}

pub fn handle(request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let route = request.uri().path().trim_start_matches('/').to_string();
    let pool = match route.as_str() {
        "thumb" => THUMB_POOL.get(),
        "preview" => PREVIEW_POOL.get(),
        _ => None,
    };
    let work = move || responder.respond(respond(&route, &request));
    match pool {
        Some(pool) => pool.spawn(work),
        None => {
            std::thread::spawn(work);
        }
    }
}

fn respond(route: &str, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if crate::lock::is_locked() {
        return error(StatusCode::FORBIDDEN, "locked");
    }
    let query = request.uri().query().unwrap_or("");
    let mut path: Option<PathBuf> = None;
    let mut size: u32 = 0;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "p" => path = Some(PathBuf::from(value.into_owned())),
            "s" => size = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    let Some(path) = path else {
        return error(StatusCode::BAD_REQUEST, "missing path");
    };

    let result = match route {
        "thumb" | "preview" if is_image(&path) => match cache_dir() {
            Some(dir) => imaging::cached_render(&path, size, dir)
                .and_then(|(file, mime)| read(&file).map(|bytes| (bytes, mime))),
            None => Err("cache unavailable".into()),
        },
        "file" if is_image(&path) || is_audio(&path) => {
            read(&path).map(|bytes| (bytes, mime_for(&path)))
        }
        "thumb" | "preview" | "file" => {
            return error(StatusCode::FORBIDDEN, "unsupported file type")
        }
        _ => return error(StatusCode::NOT_FOUND, "unknown route"),
    };

    match result {
        Ok((bytes, mime)) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", mime)
            .header("Access-Control-Allow-Origin", "*")
            // URLs include the file's mtime, so a given URL's content never changes.
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .body(bytes)
            .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "response")),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn mime_for(path: &Path) -> &'static str {
    match extension(path).as_deref() {
        Some("jpg" | "jpeg" | "jpe" | "jfif") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("tif" | "tiff") => "image/tiff",
        Some("mp3") => "audio/mpeg",
        Some("ogg" | "oga") => "audio/ogg",
        Some("opus") => "audio/opus",
        Some("flac") => "audio/flac",
        Some("wav") => "audio/wav",
        Some("m4a" | "aac") => "audio/mp4",
        _ => "application/octet-stream",
    }
}

fn error(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Content-Type", "text/plain")
        .body(message.as_bytes().to_vec())
        .expect("static error response")
}
