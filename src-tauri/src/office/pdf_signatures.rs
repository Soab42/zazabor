//! PDF's signatures and initials: the pictures Fill & Sign puts on pages, kept so they can be used
//! again. One JSON file, `office/pdf-signatures.json` in the app's data folder; each picture is a
//! PNG data URL the page drew (typed, drawn or from a picture file). Refused while CorePro is locked.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// More than this many aren't kept (Acrobat keeps one signature and one set of initials).
const MAX_KEPT: usize = 20;
/// A signature picture is small; anything bigger than this isn't one.
const MAX_IMAGE: usize = 2 * 1024 * 1024;
const PNG_PREFIX: &str = "data:image/png;base64,";

/// One read-modify-write at a time (every window of CorePro shares this process).
static STORE: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub id: String,
    /// "signature" or "initials".
    pub kind: String,
    /// What it says, or "Drawn" / the picture's name: shown in the list.
    pub name: String,
    /// A PNG data URL.
    pub image: String,
    /// When it was added (ms).
    pub created: i64,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("office").join("pdf-signatures.json"))
}

fn read_all(path: &PathBuf) -> Vec<Signature> {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn write_all(path: &PathBuf, list: &[Signature]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    crate::fs::text::write_bytes(path, &serde_json::to_vec(list).map_err(|e| e.to_string())?)?;
    Ok(())
}

/// Checks what the page sends: a known kind, a short name, a PNG data URL of a sensible size.
fn validate(kind: &str, name: &str, image: &str) -> Result<(), String> {
    if kind != "signature" && kind != "initials" {
        return Err("That isn't a signature or initials.".into());
    }
    if name.chars().count() > 120 {
        return Err("The name is too long.".into());
    }
    let Some(data) = image.strip_prefix(PNG_PREFIX) else {
        return Err("The signature isn't a picture.".into());
    };
    if image.len() > MAX_IMAGE {
        return Err("The signature picture is too big.".into());
    }
    if data.is_empty() || !data.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=') {
        return Err("The signature picture is damaged.".into());
    }
    Ok(())
}

/// The saved signatures and initials, oldest first.
#[tauri::command]
pub async fn pdf_signatures(app: tauri::AppHandle) -> Result<Vec<Signature>, String> {
    crate::ensure_unlocked()?;
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORE.lock().map_err(|e| e.to_string())?;
        Ok(read_all(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Keeps a new signature or set of initials; returns it with its id.
#[tauri::command]
pub async fn pdf_signature_add(app: tauri::AppHandle, kind: String, name: String, image: String) -> Result<Signature, String> {
    crate::ensure_unlocked()?;
    validate(&kind, &name, &image)?;
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORE.lock().map_err(|e| e.to_string())?;
        let mut list = read_all(&path);
        if list.len() >= MAX_KEPT {
            return Err(format!("CorePro keeps up to {MAX_KEPT} signatures and initials. Delete one to keep another."));
        }
        let created = crate::notes::now();
        let signature = Signature { id: format!("sig-{created}-{}", list.len()), kind, name: name.trim().to_string(), image, created };
        list.push(signature.clone());
        write_all(&path, &list)?;
        Ok(signature)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Forgets one.
#[tauri::command]
pub async fn pdf_signature_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let path = store_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORE.lock().map_err(|e| e.to_string())?;
        let mut list = read_all(&path);
        let before = list.len();
        list.retain(|s| s.id != id);
        if list.len() != before {
            write_all(&path, &list)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_png_data_urls_only() {
        assert!(validate("signature", "Jo Citizen", "data:image/png;base64,iVBORw0KGgo=").is_ok());
        assert!(validate("initials", "JC", "data:image/png;base64,iVBORw0KGgo=").is_ok());
        assert!(validate("stamp", "x", "data:image/png;base64,iVBORw0KGgo=").is_err());
        assert!(validate("signature", "x", "data:image/svg+xml;base64,PHN2Zz4=").is_err());
        assert!(validate("signature", "x", "data:image/png;base64,<script>").is_err());
        assert!(validate("signature", "x", "data:image/png;base64,").is_err());
        assert!(validate("signature", &"n".repeat(121), "data:image/png;base64,iVBORw0KGgo=").is_err());
    }

    #[test]
    fn round_trips_the_file() {
        let dir = std::env::temp_dir().join(format!("corepro-sig-test-{}", std::process::id()));
        let path = dir.join("office").join("pdf-signatures.json");
        assert!(read_all(&path).is_empty());
        let one = Signature { id: "sig-1".into(), kind: "signature".into(), name: "Jo".into(), image: "data:image/png;base64,AA==".into(), created: 1 };
        write_all(&path, std::slice::from_ref(&one)).unwrap();
        assert_eq!(read_all(&path), vec![one]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
