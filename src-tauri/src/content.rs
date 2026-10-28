//! The content library: soundtracks, sound effects, motion templates and the fonts they use, on
//! the content site (GitHub Pages of Soab42/zazabor-content, published by tools/content). The app
//! ships a small starter set; everything else is listed in the site's catalog and downloaded the
//! first time it's used, into the data folder's `content/`, where it stays.
//!
//! The catalog is signed with the release key (`signing`) and an older one never replaces a newer
//! one. A file is fetched only when the catalog lists it, and kept only if its size and SHA-256
//! match the catalog's.

use crate::download::{fetch, sha256_of};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::{Emitter, Manager};

/// The content site. `ZAZABOR_CONTENT_URL` points elsewhere for testing; what's there must
/// still be signed with the release key.
const CONTENT_URL: &str = "https://soab42.github.io/zazabor-content";
const CATALOG: &str = "catalog.json";
const KIND: &str = "zazabor-content";
/// The catalog format this Zazabor reads. A later format waits for an update of the app.
const FORMAT: u64 = 1;
/// A catalog this old is asked for again (at a start; the app asks hourly while it runs).
const FRESH_FOR: Duration = Duration::from_secs(3600);
/// No catalog is bigger than this.
const MAX_CATALOG: u64 = 8 << 20;
/// The library's folders (the first part of every file's path).
const FOLDERS: [&str; 4] = ["music", "sounds", "fonts", "templates"];

fn base_url() -> String {
    std::env::var("ZAZABOR_CONTENT_URL").unwrap_or_else(|_| CONTENT_URL.into()).trim_end_matches('/').to_string()
}

fn content_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("content"))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A checked catalog: the document, and its files with their sizes and checksums.
struct Library {
    catalog: Value,
    files: HashMap<String, (u64, String)>,
}

impl Library {
    fn published(&self) -> u64 {
        self.catalog["published"].as_u64().unwrap_or(0)
    }
}

fn current() -> &'static Mutex<Option<Arc<Library>>> {
    static L: OnceLock<Mutex<Option<Arc<Library>>>> = OnceLock::new();
    L.get_or_init(Default::default)
}

/// Reads a catalog after checking its signature, kind and format; files it lists with an unsafe
/// path or a malformed checksum are left out.
fn parse(bytes: &[u8], signature: &str) -> Result<Library, String> {
    crate::signing::verify(bytes, signature)?;
    let catalog: Value = serde_json::from_slice(bytes).map_err(|e| format!("The library's catalog isn't readable: {e}"))?;
    if catalog["kind"] != KIND {
        return Err("That isn't Zazabor's library catalog.".into());
    }
    if catalog["format"].as_u64() != Some(FORMAT) {
        return Err("The library needs a newer Zazabor. Update Zazabor to get it.".into());
    }
    let mut files = HashMap::new();
    collect(&catalog, &mut files);
    Ok(Library { catalog, files })
}

/// Every `{ file, bytes, sha256 }` in the catalog, wherever it is.
fn collect(v: &Value, out: &mut HashMap<String, (u64, String)>) {
    match v {
        Value::Object(map) => {
            if let (Some(file), Some(bytes), Some(sha)) = (map.get("file").and_then(Value::as_str), map.get("bytes").and_then(Value::as_u64), map.get("sha256").and_then(Value::as_str)) {
                if safe_path(file) && sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                    out.insert(file.to_string(), (bytes, sha.to_ascii_lowercase()));
                }
            }
            map.values().for_each(|x| collect(x, out));
        }
        Value::Array(list) => list.iter().for_each(|x| collect(x, out)),
        _ => {}
    }
}

/// A file's path in the library: inside one of its folders, plain names only.
fn safe_path(file: &str) -> bool {
    let parts: Vec<&str> = file.split('/').collect();
    parts.len() >= 2
        && FOLDERS.contains(&parts[0])
        && parts.iter().all(|p| !p.is_empty() && *p != "." && *p != ".." && p.len() <= 120 && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)))
}

fn read_cached(dir: &Path) -> Option<Library> {
    let bytes = std::fs::read(dir.join(CATALOG)).ok()?;
    let sig = std::fs::read_to_string(dir.join(format!("{CATALOG}.sig"))).ok()?;
    parse(&bytes, &sig).map_err(|e| eprintln!("[content] the saved catalog was set aside: {e}")).ok()
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_global(Some(Duration::from_secs(60)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// GETs a small file (a catalog, a manifest or a signature).
pub fn get_small(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    get_small_if_there(url, limit)?.ok_or_else(|| "The download server answered 404.".into())
}

/// `get_small`, or None when the server has no such file.
pub fn get_small_if_there(url: &str, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let response = agent().get(url).header("User-Agent", "Zazabor").call().map_err(|e| format!("Couldn't reach the download server: {e}"))?;
    match response.status().as_u16() {
        200 => response.into_body().with_config().limit(limit).read_to_vec().map(Some).map_err(|e| format!("The download stopped: {e}")),
        404 => Ok(None),
        status => Err(format!("The download server answered {status}.")),
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The catalog from the site, kept on disk when it checks out and isn't older than the one there.
fn refresh(dir: &Path, have: Option<&Library>) -> Result<Option<Library>, String> {
    let bytes = get_small(&format!("{}/{CATALOG}", base_url()), MAX_CATALOG)?;
    let sig = String::from_utf8(get_small(&format!("{}/{CATALOG}.sig", base_url()), 1024)?).map_err(|e| e.to_string())?;
    let fresh = parse(&bytes, &sig)?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    if have.is_some_and(|old| fresh.published() < old.published()) {
        // A copy from before the one here (a stale mirror): keep ours, and ask again later.
        let _ = std::fs::File::options().write(true).open(dir.join(CATALOG)).and_then(|f| f.set_modified(SystemTime::now()));
        return Ok(None);
    }
    write_atomic(&dir.join(format!("{CATALOG}.sig")), sig.as_bytes())?;
    write_atomic(&dir.join(CATALOG), &bytes)?;
    Ok(Some(fresh))
}

fn is_stale(dir: &Path) -> bool {
    std::fs::metadata(dir.join(CATALOG)).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_none_or(|age| age > FRESH_FOR)
}

/// The library as it is: from memory, else from disk.
fn library(dir: &Path) -> Option<Arc<Library>> {
    let mut slot = lock(current());
    if slot.is_none() {
        *slot = read_cached(dir).map(Arc::new);
    }
    slot.clone()
}

fn installed(dir: &Path, lib: &Library) -> Vec<String> {
    let mut list: Vec<String> = lib.files.iter().filter(|(file, (bytes, _))| std::fs::metadata(dir.join(file)).is_ok_and(|m| m.len() == *bytes)).map(|(f, _)| f.clone()).collect();
    list.sort();
    list
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogState {
    /// The catalog, or null when there's none yet (never online).
    catalog: Value,
    /// Its files that are downloaded.
    installed: Vec<String>,
    /// Where they are (`<dir>/<file>`).
    dir: String,
    /// Why the site couldn't be asked, when it couldn't.
    error: Option<String>,
}

/// The library's catalog: the one kept here, asked for again from the site when it's older than
/// a few hours (or now, with `refresh`). Offline, the kept one is used.
#[tauri::command]
pub async fn content_catalog(app: tauri::AppHandle, refresh_now: bool) -> Result<CatalogState, String> {
    let dir = content_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut lib = library(&dir);
        let mut error = None;
        if refresh_now || lib.is_none() || is_stale(&dir) {
            match refresh(&dir, lib.as_deref()) {
                Ok(Some(fresh)) => {
                    let fresh = Arc::new(fresh);
                    *lock(current()) = Some(fresh.clone());
                    lib = Some(fresh);
                }
                Ok(None) => {}
                Err(why) => {
                    eprintln!("[content] catalog: {why}");
                    error = Some(why);
                }
            }
        }
        Ok(CatalogState {
            catalog: lib.as_ref().map_or(Value::Null, |l| l.catalog.clone()),
            installed: lib.as_ref().map(|l| installed(&dir, l)).unwrap_or_default(),
            dir: dir.to_string_lossy().into_owned(),
            error,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One lock per file, so a file asked for twice at once downloads once.
fn gate(file: &str) -> Arc<Mutex<()>> {
    static G: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    lock(G.get_or_init(Default::default)).entry(file.to_string()).or_default().clone()
}

#[derive(Clone, Serialize)]
struct Progress<'a> {
    file: &'a str,
    done: u64,
    total: u64,
}

/// Downloads a library file if it isn't here yet; its path.
fn ensure(app: &tauri::AppHandle, dir: &Path, file: &str) -> Result<PathBuf, String> {
    let lib = library(dir).ok_or("The library isn't available yet. Connect to the internet and try again.")?;
    let (bytes, sha) = lib.files.get(file).cloned().ok_or_else(|| format!("“{file}” isn't in Zazabor's library."))?;
    let dest = dir.join(file);
    let gate = gate(file);
    let _held = lock(&gate);
    if std::fs::metadata(&dest).is_ok_and(|m| m.len() == bytes) {
        return Ok(dest);
    }
    std::fs::create_dir_all(dest.parent().unwrap_or(dir)).map_err(|e| e.to_string())?;
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let done = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    // Progress for the page while it downloads (big files only: a template is there at once).
    let ticker = (bytes > 256 << 10).then(|| {
        let (app, file, done, stop) = (app.clone(), file.to_string(), done.clone(), stop.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let _ = app.emit("content-progress", Progress { file: &file, done: done.load(Ordering::Relaxed), total: bytes });
                std::thread::sleep(Duration::from_millis(200));
            }
        })
    });
    let result = fetch(&format!("{}/{file}", base_url()), &part, bytes, &done, &AtomicBool::new(false)).and_then(|()| {
        if sha256_of(&part)? != sha {
            let _ = std::fs::remove_file(&part);
            return Err("The download didn't match the library's checksum, so it was deleted. Try again.".into());
        }
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())
    });
    stop.store(true, Ordering::Relaxed);
    if let Some(t) = ticker {
        let _ = t.join();
        let _ = app.emit("content-progress", Progress { file, done: if result.is_ok() { bytes } else { 0 }, total: bytes });
    }
    result.map(|()| dest)
}

/// A library file's path, downloading it first if it isn't here.
#[tauri::command]
pub async fn content_fetch(app: tauri::AppHandle, file: String) -> Result<String, String> {
    let dir = content_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || ensure(&app, &dir, &file).map(|p| p.to_string_lossy().into_owned())).await.map_err(|e| e.to_string())?
}

/// A library file's bytes (a template or a font), downloading it first if it isn't here.
#[tauri::command]
pub async fn content_read(app: tauri::AppHandle, file: String) -> Result<tauri::ipc::Response, String> {
    let dir = content_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = ensure(&app, &dir, &file)?;
        std::fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Usage {
    bytes: u64,
    files: u64,
}

/// How much the downloaded library takes.
#[tauri::command]
pub fn content_usage(app: tauri::AppHandle) -> Result<Usage, String> {
    let dir = content_dir(&app)?;
    let mut usage = Usage { bytes: 0, files: 0 };
    for folder in FOLDERS {
        for entry in walkdir::WalkDir::new(dir.join(folder)).into_iter().flatten().filter(|e| e.file_type().is_file()) {
            usage.bytes += entry.metadata().map_or(0, |m| m.len());
            usage.files += 1;
        }
    }
    Ok(usage)
}

/// Deletes the downloaded music, sound effects and fonts (templates are small and stay, so
/// projects keep opening offline). They download again when they're next used.
#[tauri::command]
pub fn content_clear(app: tauri::AppHandle) -> Result<(), String> {
    let dir = content_dir(&app)?;
    for folder in ["music", "sounds", "fonts"] {
        match std::fs::remove_dir_all(dir.join(folder)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_paths_stay_inside_its_folders() {
        assert!(safe_path("music/cinematic.ogg"));
        assert!(safe_path("fonts/inter/Inter-opsz-wght.ttf"));
        assert!(safe_path("templates/lower-name.json"));
        for bad in ["cinematic.ogg", "music/", "music/../x", "music/./x", "/music/x", "other/x.ogg", "music//x", "music/a b.ogg", "music/x\\y", "music/%2e%2e"] {
            assert!(!safe_path(bad), "{bad}");
        }
    }

    #[test]
    fn only_well_formed_entries_are_files() {
        let sha = "a".repeat(64);
        let catalog = serde_json::json!({
            "music": [{ "id": "a", "file": "music/a.ogg", "bytes": 10, "sha256": sha }],
            "fonts": [{ "files": [{ "file": "fonts/x/X.ttf", "bytes": 5, "sha256": sha.to_uppercase() }] }],
            "bad": [
                { "file": "../etc/passwd", "bytes": 1, "sha256": sha },
                { "file": "music/b.ogg", "bytes": 1, "sha256": "short" },
                { "file": "music/c.ogg", "sha256": sha },
            ],
        });
        let mut files = HashMap::new();
        collect(&catalog, &mut files);
        let mut names: Vec<_> = files.keys().cloned().collect();
        names.sort();
        assert_eq!(names, ["fonts/x/X.ttf", "music/a.ogg"]);
        assert_eq!(files["fonts/x/X.ttf"].1, sha);
    }

    #[test]
    fn unsigned_or_foreign_catalogs_are_refused() {
        assert!(parse(br#"{"kind":"zazabor-content","format":1}"#, "AAAA").is_err());
    }
}
