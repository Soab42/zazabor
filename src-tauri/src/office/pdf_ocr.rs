//! The language data OCR reads text with (docs/plans/pdf.md §4.8): Tesseract's fast LSTM models
//! for English and Bangla, downloaded on first use (after the page asks) from a pinned commit of
//! tesseract-ocr/tessdata_fast (Apache-2.0), checked against their SHA-256, and kept in
//! `office/ocr/` in the app's data folder. A download can be cancelled and picks up where it
//! stopped. The page runs tesseract.js itself (bundled with the app) and gets the data from here.

use openssl::sha::Sha256;
use serde::Serialize;
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// The tessdata_fast commit the files come from (2024-08-01).
const COMMIT: &str = "87416418657359cb625c412a48b6e1d6d41c29bd";

pub struct Language {
    pub code: &'static str,
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub const LANGUAGES: [Language; 2] = [
    Language { code: "eng", name: "English", size: 4_113_088, sha256: "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2" },
    Language { code: "ben", name: "Bangla", size: 855_841, sha256: "31163084c279aaebd376216f0c3d5c17ad4b5fee8db49dae79c20000b5de5964" },
];

/// Downloads asked to stop.
static CANCELLED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

fn language(code: &str) -> Result<&'static Language, String> {
    LANGUAGES.iter().find(|l| l.code == code).ok_or_else(|| format!("Zazabor has no OCR data for “{code}”."))
}

fn dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("office").join("ocr"))
}

fn url(code: &str) -> String {
    format!("https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/{COMMIT}/{code}.traineddata")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_of(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finish()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageInfo {
    code: &'static str,
    name: &'static str,
    size: u64,
    installed: bool,
    /// Bytes of an unfinished download (resumed next time).
    partial: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    code: String,
    received: u64,
    total: u64,
}

/// The OCR languages Zazabor offers, and which are installed.
#[tauri::command]
pub fn pdf_ocr_languages(app: tauri::AppHandle) -> Result<Vec<LanguageInfo>, String> {
    let dir = dir(&app)?;
    Ok(LANGUAGES
        .iter()
        .map(|l| LanguageInfo {
            code: l.code,
            name: l.name,
            size: l.size,
            installed: dir.join(format!("{}.traineddata", l.code)).is_file(),
            partial: std::fs::metadata(dir.join(format!("{}.traineddata.part", l.code))).map(|m| m.len()).unwrap_or(0),
        })
        .collect())
}

/// Downloads a language's data (resuming a part already there), with `pdf-ocr-download` progress
/// events, and checks it before keeping it.
#[tauri::command]
pub async fn pdf_ocr_download(app: tauri::AppHandle, code: String) -> Result<(), String> {
    let lang = language(&code)?;
    let dir = dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let done = dir.join(format!("{code}.traineddata"));
    if done.is_file() {
        return Ok(());
    }
    let part = dir.join(format!("{code}.traineddata.part"));
    CANCELLED.lock().unwrap_or_else(|e| e.into_inner()).remove(&code);
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have >= lang.size {
        // A finished but unchecked download, or a broken one: check it below, else start over.
        if sha256_of(&part).map_err(|e| e.to_string())? != lang.sha256 {
            let _ = std::fs::remove_file(&part);
            have = 0;
        }
    }
    if have < lang.size {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| format!("The download couldn't start: {e}"))?;
        let mut request = client.get(url(&code)).header("User-Agent", "Zazabor");
        if have > 0 {
            request = request.header("Range", format!("bytes={have}-"));
        }
        let mut response = request.send().await.map_err(|e| format!("The download couldn't start: {e}"))?;
        let status = response.status();
        let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT;
        if !status.is_success() {
            return Err(format!("The download failed: the server answered {status}."));
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(resumed)
            .write(true)
            .truncate(!resumed)
            .open(&part)
            .map_err(|e| e.to_string())?;
        if !resumed {
            have = 0;
        }
        let mut last_emit = std::time::Instant::now();
        while let Some(chunk) = response.chunk().await.map_err(|e| format!("The download stopped: {e}"))? {
            if CANCELLED.lock().unwrap_or_else(|e| e.into_inner()).remove(&code) {
                return Err("Cancelled".into());
            }
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            have += chunk.len() as u64;
            if have > lang.size {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Err("The download was bigger than expected, so it was thrown away.".into());
            }
            if last_emit.elapsed() > std::time::Duration::from_millis(120) {
                last_emit = std::time::Instant::now();
                let _ = app.emit("pdf-ocr-download", Progress { code: code.clone(), received: have, total: lang.size });
            }
        }
        file.flush().map_err(|e| e.to_string())?;
    }
    let _ = app.emit("pdf-ocr-download", Progress { code: code.clone(), received: have, total: lang.size });
    let part2 = part.clone();
    let sum = tauri::async_runtime::spawn_blocking(move || sha256_of(&part2)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    if sum != lang.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err("The downloaded file didn't match what was expected, so it was thrown away. Try again.".into());
    }
    std::fs::rename(&part, &done).map_err(|e| e.to_string())?;
    Ok(())
}

/// Stops a download (the part already downloaded stays, to resume).
#[tauri::command]
pub fn pdf_ocr_cancel(code: String) {
    CANCELLED.lock().unwrap_or_else(|e| e.into_inner()).insert(code);
}

/// Deletes a language's data (and any unfinished download of it).
#[tauri::command]
pub fn pdf_ocr_remove(app: tauri::AppHandle, code: String) -> Result<(), String> {
    language(&code)?;
    let dir = dir(&app)?;
    for name in [format!("{code}.traineddata"), format!("{code}.traineddata.part")] {
        match std::fs::remove_file(dir.join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    Ok(())
}

/// A language's data, for tesseract.js in the page.
#[tauri::command]
pub async fn pdf_ocr_data(app: tauri::AppHandle, code: String) -> Result<tauri::ipc::Response, String> {
    language(&code)?;
    let path = dir(&app)?.join(format!("{code}.traineddata"));
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(path)).await.map_err(|e| e.to_string())?
        .map_err(|_| "That language isn't downloaded.".to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_languages_are_well_formed() {
        for l in &LANGUAGES {
            assert_eq!(l.sha256.len(), 64);
            assert!(l.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(l.size > 100_000);
            assert!(url(l.code).ends_with(&format!("/{COMMIT}/{}.traineddata", l.code)));
        }
        assert!(language("xyz").is_err());
    }

    #[test]
    fn hashing_matches_openssl_cli_format() {
        let path = std::env::temp_dir().join(format!("zazabor-ocr-test-{}", std::process::id()));
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(sha256_of(&path).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let _ = std::fs::remove_file(path);
    }
}
