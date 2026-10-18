//! The `cs://` scheme serves photos to the webview:
//!
//! - `cs://localhost/thumb?p=<path>&s=<px>`   cached, oriented thumbnail (long edge <= s)
//! - `cs://localhost/preview?p=<path>&s=<px>` cached, oriented render (s = 0: full size)
//! - `cs://localhost/file?p=<path>`           the original bytes of an image or audio file
//! - `cs://localhost/frame?after=<n>`         the newest decoded video frame (see `video`)
//! - `cs://localhost/vthumb?p=<path>&s=<px>`  cached JPEG frame from a video (see `video`)
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
static TILE_POOL: OnceLock<ThreadPool> = OnceLock::new();

/// Background decoding must not starve the interface of CPU time.
fn lower_thread_priority(nice: i32) {
    #[cfg(unix)]
    // SAFETY: setpriority only adjusts the scheduling priority of the calling thread.
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, 0, nice);
    }
    #[cfg(not(unix))]
    let _ = nice;
}

pub fn init(cache_dir: PathBuf) {
    let _ = fs::create_dir_all(&cache_dir);
    let _ = CACHE_DIR.set(cache_dir);
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    // Thumbnails and large renders get separate pools so a scroll through thousands of
    // thumbnails never delays the photo the user is actually looking at.
    let pool = |threads: usize, name: &'static str, nice: i32| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(move |i| format!("{name}-{i}"))
            .start_handler(move |_| lower_thread_priority(nice))
            .build()
            .expect("failed to build thread pool")
    };
    // Few, low-priority thumbnail workers: big photos need lots of memory to decode.
    let _ = THUMB_POOL.set(pool((cores / 2).clamp(2, 6), "thumb", 10));
    let _ = PREVIEW_POOL.set(pool(2, "preview", 5));
    // Tiles are what the user is looking at right now.
    let _ = TILE_POOL.set(pool(3, "tile", 0));
}

pub fn cache_dir() -> Option<&'static PathBuf> {
    CACHE_DIR.get()
}

pub fn handle(request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let route = request.uri().path().trim_start_matches('/').to_string();
    // Video routes block on libVLC, so they bring their own threads.
    match route.as_str() {
        "frame" => return crate::video::serve_frame(request, responder),
        "vthumb" => return crate::video::serve_thumb(request, responder),
        _ => {}
    }
    let pool = match route.as_str() {
        "thumb" => THUMB_POOL.get(),
        "preview" => PREVIEW_POOL.get(),
        "tile" | "full" => TILE_POOL.get(),
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
    let (mut size, mut tx, mut ty) = (0u32, 0u32, 0u32);
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "p" => path = Some(PathBuf::from(value.into_owned())),
            "s" => size = value.parse().unwrap_or(0),
            "x" => tx = value.parse().unwrap_or(0),
            "y" => ty = value.parse().unwrap_or(0),
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
        "full" if is_image(&path) => imaging::full_image(&path).map(|image| {
            (format!(r#"{{"width":{},"height":{}}}"#, image.width(), image.height()).into_bytes(), "application/json")
        }),
        "tile" if is_image(&path) => imaging::tile(&path, tx, ty, size).map(|bytes| (bytes, "application/octet-stream")),
        "file" if is_image(&path) || is_audio(&path) => {
            read(&path).map(|bytes| (bytes, mime_for(&path)))
        }
        "thumb" | "preview" | "file" | "full" | "tile" => {
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

pub(crate) fn error(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Content-Type", "text/plain")
        .body(message.as_bytes().to_vec())
        .expect("static error response")
}
