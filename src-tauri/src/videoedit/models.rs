//! The captions models: whisper.cpp's official ggml files (MIT), downloaded on first use into the
//! app's data folder after the user agrees, resumable (a `.part` file and an HTTP range request),
//! cancellable, and checked against the size and SHA-256 pinned here before they're used.

pub use crate::download::{fetch, sha256_of};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// The model repository at a fixed commit, so the files match the checksums below.
const BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1";

pub struct Spec {
    pub id: &'static str,
    pub label: &'static str,
    pub file: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
    pub note: &'static str,
}

pub const MODELS: [Spec; 2] = [
    Spec {
        id: "base",
        label: "Base",
        file: "ggml-base.bin",
        bytes: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        note: "Fast; good for English and other widely spoken languages.",
    },
    Spec {
        id: "small",
        label: "Small",
        file: "ggml-small.bin",
        bytes: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        note: "About three times slower; better with accents and less common languages. Bangla doesn't come out right yet.",
    },
];

pub fn spec(id: &str) -> Result<&'static Spec, String> {
    MODELS.iter().find(|m| m.id == id).ok_or_else(|| format!("There's no captions model “{id}”."))
}

#[derive(Serialize)]
pub struct Status {
    pub id: String,
    pub label: String,
    pub note: String,
    pub bytes: u64,
    pub installed: bool,
    /// Bytes downloaded so far (a paused or running download).
    pub partial: u64,
    pub downloading: bool,
    pub error: Option<String>,
}

#[derive(Default)]
struct Download {
    done: AtomicU64,
    cancel: AtomicBool,
    running: AtomicBool,
    error: Mutex<Option<String>>,
}

fn downloads() -> &'static Mutex<HashMap<String, Arc<Download>>> {
    static D: OnceLock<Mutex<HashMap<String, Arc<Download>>>> = OnceLock::new();
    D.get_or_init(Default::default)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn path_in(dir: &Path, spec: &Spec) -> PathBuf {
    dir.join(spec.file)
}

fn part_in(dir: &Path, spec: &Spec) -> PathBuf {
    dir.join(format!("{}.part", spec.file))
}

fn url_for(spec: &Spec) -> String {
    let base = std::env::var("ZAZABOR_WHISPER_BASE_URL").unwrap_or_else(|_| BASE_URL.into());
    format!("{}/{}", base.trim_end_matches('/'), spec.file)
}

/// The installed model file, if it's there and whole.
pub fn installed(dir: &Path, spec: &Spec) -> Option<PathBuf> {
    let path = path_in(dir, spec);
    (std::fs::metadata(&path).ok()?.len() == spec.bytes).then_some(path)
}

pub fn statuses(dir: &Path) -> Vec<Status> {
    let running = lock(downloads()).clone();
    MODELS
        .iter()
        .map(|m| {
            let d = running.get(m.id);
            let partial = d.filter(|d| d.running.load(Ordering::Relaxed)).map(|d| d.done.load(Ordering::Relaxed)).unwrap_or_else(|| std::fs::metadata(part_in(dir, m)).map_or(0, |md| md.len()));
            Status {
                id: m.id.into(),
                label: m.label.into(),
                note: m.note.into(),
                bytes: m.bytes,
                installed: installed(dir, m).is_some(),
                partial,
                downloading: d.is_some_and(|d| d.running.load(Ordering::Relaxed)),
                error: d.and_then(|d| lock(&d.error).clone()),
            }
        })
        .collect()
}

/// Checks a finished download against the pinned size and checksum, then puts it in place.
pub fn finish(part: &Path, dest: &Path, bytes: u64, sha256: &str) -> Result<(), String> {
    let size = std::fs::metadata(part).map_err(|e| e.to_string())?.len();
    if size != bytes {
        return Err(format!("The download is {size} bytes, not {bytes}; it will start again."));
    }
    let got = sha256_of(part)?;
    if got != sha256 {
        let _ = std::fs::remove_file(part);
        return Err("The downloaded model didn't match its checksum, so it was deleted. Try again.".into());
    }
    std::fs::rename(part, dest).map_err(|e| e.to_string())
}

/// Starts (or continues) downloading a model in the background.
pub fn start(dir: PathBuf, id: &str) -> Result<(), String> {
    let spec = spec(id)?;
    if installed(&dir, spec).is_some() {
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let job = {
        let mut map = lock(downloads());
        if map.get(id).is_some_and(|d| d.running.load(Ordering::Relaxed)) {
            return Ok(());
        }
        let job = Arc::new(Download::default());
        job.running.store(true, Ordering::Relaxed);
        map.insert(id.to_string(), job.clone());
        job
    };
    std::thread::Builder::new()
        .name(format!("model-{id}"))
        .spawn(move || {
            let part = part_in(&dir, spec);
            let dest = path_in(&dir, spec);
            let mut result = fetch(&url_for(spec), &part, spec.bytes, &job.done, &job.cancel);
            if result.is_ok() {
                result = finish(&part, &dest, spec.bytes, spec.sha256);
            }
            if let Err(why) = result {
                if why != "Cancelled" {
                    *lock(&job.error) = Some(why);
                }
            }
            job.running.store(false, Ordering::Relaxed);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Pauses a download (what's there is kept for later).
pub fn cancel(id: &str) {
    if let Some(d) = lock(downloads()).get(id) {
        d.cancel.store(true, Ordering::Relaxed);
    }
}

/// Deletes a model (and any half-downloaded copy).
pub fn remove(dir: &Path, id: &str) -> Result<(), String> {
    let spec = spec(id)?;
    cancel(id);
    for p in [path_in(dir, spec), part_in(dir, spec)] {
        match std::fs::remove_file(&p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    lock(downloads()).remove(id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    /// A one-file HTTP server that honours `Range: bytes=N-` (and counts what it was asked).
    fn serve(body: Vec<u8>, ranges: bool) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut range = None;
                let mut line = String::new();
                while reader.read_line(&mut line).is_ok_and(|n| n > 0) {
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        range = v.trim().trim_end_matches('-').parse::<usize>().ok();
                    }
                    line.clear();
                }
                lock(&log).push(range.map_or("full".into(), |r| format!("from {r}")));
                let mut s = stream;
                let (status, part) = match range.filter(|_| ranges) {
                    Some(r) => ("206 Partial Content", &body[r.min(body.len())..]),
                    None => ("200 OK", &body[..]),
                };
                let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", part.len());
                let _ = s.write_all(part);
            }
        });
        (url, seen)
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zazabor-models-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn a_download_resumes_where_it_stopped_and_is_checked() {
        let body: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let (url, seen) = serve(body.clone(), true);
        let dir = temp("resume");
        let part = dir.join("m.bin.part");
        // The first 100,000 bytes are already there (a download that was paused).
        std::fs::write(&part, &body[..100_000]).unwrap();
        let (done, cancel) = (AtomicU64::new(0), AtomicBool::new(false));
        fetch(&format!("{url}/m.bin"), &part, body.len() as u64, &done, &cancel).unwrap();
        assert_eq!(lock(&seen).as_slice(), &["from 100000".to_string()]);
        assert_eq!(done.load(Ordering::Relaxed), body.len() as u64);
        let dest = dir.join("m.bin");
        finish(&part, &dest, body.len() as u64, &hex(&body)).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert!(!part.exists());
    }

    #[test]
    fn a_server_without_ranges_starts_over() {
        let body: Vec<u8> = (0..50_000u32).map(|i| (i % 13) as u8).collect();
        let (url, _) = serve(body.clone(), false);
        let dir = temp("norange");
        let part = dir.join("m.bin.part");
        std::fs::write(&part, vec![9u8; 20_000]).unwrap();
        let (done, cancel) = (AtomicU64::new(0), AtomicBool::new(false));
        fetch(&format!("{url}/m.bin"), &part, body.len() as u64, &done, &cancel).unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), body, "the stale start was replaced, not appended to");
    }

    #[test]
    fn a_wrong_checksum_deletes_the_file() {
        let dir = temp("checksum");
        let part = dir.join("m.bin.part");
        std::fs::write(&part, b"not the model").unwrap();
        let err = finish(&part, &dir.join("m.bin"), 13, &hex(b"the real model")).unwrap_err();
        assert!(err.contains("checksum"));
        assert!(!part.exists());
        // A short file is kept to resume.
        std::fs::write(&part, b"short").unwrap();
        assert!(finish(&part, &dir.join("m.bin"), 13, &hex(b"short")).is_err());
        assert!(part.exists());
    }

    #[test]
    fn cancelling_keeps_what_was_downloaded() {
        let body = vec![1u8; 2_000_000];
        let (url, _) = serve(body.clone(), true);
        let dir = temp("cancel");
        let part = dir.join("m.bin.part");
        let (done, cancel) = (AtomicU64::new(0), AtomicBool::new(true));
        assert_eq!(fetch(&format!("{url}/m.bin"), &part, body.len() as u64, &done, &cancel).unwrap_err(), "Cancelled");
        assert!(part.exists());
    }

    #[test]
    fn the_pinned_models_are_the_official_files() {
        for m in &MODELS {
            assert_eq!(m.sha256.len(), 64);
            assert!(m.file.starts_with("ggml-") && !m.file.contains(".en."), "multilingual models only");
        }
        assert!(url_for(&MODELS[0]).ends_with("/ggml-base.bin"));
    }
}
