//! Motion templates' files: a `.zaztemplate` is a zip with `template.json` and the pictures it
//! uses under `assets/`. My Templates keep their pictures in the app data folder
//! (`motion/assets/<id>/`). Bytes travel as raw request bodies (no JSON arrays of numbers).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;

const DOC: &str = "template.json";
/// A template document bigger than this isn't one.
const DOC_MAX: u64 = 4 * 1024 * 1024;
/// Every picture in a package together.
const ASSETS_MAX: u64 = 256 * 1024 * 1024;
const MAGIC: &[u8; 4] = b"ZTPK";
/// Pictures in one package, entries in one zip, one kept picture, one `.zazkit`.
const ASSETS_COUNT: usize = 64;
const ENTRIES_MAX: usize = 512;
const ASSET_MAX: usize = 64 * 1024 * 1024;
const KIT_MAX: u64 = 1024 * 1024;
const PICTURE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "avif", "gif", "bmp", "tif", "tiff", "svg"];

/// A file the page names for one of these commands: an absolute path with the expected
/// extension that isn't a link or a folder (the page only gets such paths from the file dialogs).
pub fn checked_path(path: &str, extension: &str, must_exist: bool) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let wrong = || format!("Only .{extension} files can be used here.");
    if !path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(wrong());
    }
    if !path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(extension)) {
        return Err(wrong());
    }
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if !meta.file_type().is_file() => Err(wrong()),
        Err(_) if must_exist => Err(format!("{} can't be found.", path.display())),
        _ => {
            if !must_exist && !path.parent().is_some_and(|d| d.is_dir()) {
                return Err(format!("The folder for {} isn't there.", path.display()));
            }
            Ok(path)
        }
    }
}

/// The owner of kept pictures: a My Templates id ("mine-…").
fn owner_name(owner: &str) -> Option<String> {
    let clean = safe_name(owner)?;
    (clean.starts_with("mine-") && clean.len() > 5 && clean.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).then_some(clean)
}

fn percent_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let value = request.headers().get(name).and_then(|v| v.to_str().ok()).ok_or_else(|| format!("Missing {name}."))?;
    percent_decode(value)
}

fn body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err("Nothing to save.".into()),
    }
}

/// A picture's name inside a package or the assets folder: its last path part, letters, digits,
/// dot, dash and underscore only (so a name can never leave its folder).
pub fn safe_name(name: &str) -> Option<String> {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = last.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).take(96).collect();
    let clean = clean.trim_start_matches('.').to_string();
    (!clean.is_empty()).then_some(clean)
}

#[derive(serde::Deserialize)]
struct PackMeta {
    doc_len: usize,
    assets: Vec<(String, usize)>,
}

/// Writes a package: the document and its pictures.
pub fn pack(path: &Path, doc: &[u8], assets: &[(String, Vec<u8>)]) -> Result<(), String> {
    let tmp = path.with_extension("zaztemplate.part");
    let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file(DOC, options).map_err(|e| e.to_string())?;
    zip.write_all(doc).map_err(|e| e.to_string())?;
    for (name, data) in assets {
        let name = safe_name(name).ok_or("A picture has no usable name.")?;
        // Pictures are compressed already.
        zip.start_file(format!("assets/{name}"), zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored))
            .map_err(|e| e.to_string())?;
        zip.write_all(data).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Reads a package: its document and pictures.
pub fn unpack(path: &Path) -> Result<(Vec<u8>, Vec<(String, Vec<u8>)>), String> {
    unpack_within(path, ASSETS_MAX)
}

/// `unpack`, reading at most `budget` bytes of pictures (counted as they're read, not as the zip claims).
fn unpack_within(path: &Path, budget: u64) -> Result<(Vec<u8>, Vec<(String, Vec<u8>)>), String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "This isn't a motion template (.zaztemplate).".to_string())?;
    if zip.len() > ENTRIES_MAX {
        return Err("This template has too many files in it.".into());
    }
    let mut doc = Vec::new();
    let mut assets = Vec::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name == DOC {
            if entry.size() > DOC_MAX || !doc.is_empty() {
                return Err("The template's document is too big.".into());
            }
            entry.by_ref().take(DOC_MAX + 1).read_to_end(&mut doc).map_err(|e| e.to_string())?;
            if doc.len() as u64 > DOC_MAX {
                return Err("The template's document is too big.".into());
            }
        } else if let Some(rest) = name.strip_prefix("assets/") {
            let Some(clean) = safe_name(rest) else { continue };
            if assets.len() >= ASSETS_COUNT {
                return Err("This template has too many pictures.".into());
            }
            let left = budget.saturating_sub(total);
            let mut data = Vec::with_capacity(entry.size().min(left) as usize);
            entry.by_ref().take(left + 1).read_to_end(&mut data).map_err(|e| e.to_string())?;
            total += data.len() as u64;
            if total > budget {
                return Err("The template's pictures are too big.".into());
            }
            assets.push((clean, data));
        }
    }
    if doc.is_empty() {
        return Err("This isn't a motion template (.zaztemplate).".into());
    }
    Ok((doc, assets))
}

/// The unpacked package for the page: "ZTPK", the document's length and bytes, the number of
/// pictures, then each picture's name length, name, length and bytes (lengths little-endian u32).
pub fn encode_package(doc: &[u8], assets: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(doc.len() + assets.iter().map(|(n, d)| n.len() + d.len() + 8).sum::<usize>() + 12);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(doc.len() as u32).to_le_bytes());
    out.extend_from_slice(doc);
    out.extend_from_slice(&(assets.len() as u32).to_le_bytes());
    for (name, data) in assets {
        out.extend_from_slice(&(name.len() as u32).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
    }
    out
}

fn assets_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("motion").join("assets"))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Saves a package to `x-path`: the body is the document then each picture, as `x-meta` lists them.
#[tauri::command]
pub async fn motion_pack(request: Request<'_>) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let path = checked_path(&header(&request, "x-path")?, "zaztemplate", false)?;
    let meta: PackMeta = serde_json::from_str(&header(&request, "x-meta")?).map_err(|e| e.to_string())?;
    let bytes = body(&request)?;
    let pictures: usize = meta.assets.iter().map(|(_, len)| *len).sum();
    if meta.doc_len as u64 > DOC_MAX || meta.assets.len() > ASSETS_COUNT || pictures as u64 > ASSETS_MAX || meta.doc_len + pictures != bytes.len() {
        return Err("The template is too big, or cut short.".into());
    }
    let mut at = meta.doc_len;
    let doc = bytes.get(..at).ok_or("The template is cut short.")?.to_vec();
    let mut assets = Vec::new();
    for (name, len) in meta.assets {
        let data = bytes.get(at..at + len).ok_or("The template is cut short.")?.to_vec();
        at += len;
        assets.push((name, data));
    }
    blocking(move || pack(&path, &doc, &assets)).await
}

/// Reads a package (see `encode_package` for what comes back).
#[tauri::command]
pub async fn motion_unpack(path: String) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let path = checked_path(&path, "zaztemplate", true)?;
    blocking(move || {
        let (doc, assets) = unpack(&path)?;
        Ok(Response::new(encode_package(&doc, &assets)))
    })
    .await
}

/// Keeps a picture of a saved template in the app data folder; returns where it went.
#[tauri::command]
pub async fn motion_asset_store(app: tauri::AppHandle, request: Request<'_>) -> Result<String, String> {
    crate::ensure_unlocked()?;
    let owner = owner_name(&header(&request, "x-owner")?).ok_or("No template to keep it for.")?;
    let name = safe_name(&header(&request, "x-name")?).ok_or("The picture has no usable name.")?;
    let ext = Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !PICTURE_EXTENSIONS.contains(&ext.as_str()) {
        return Err("Only pictures can be kept for a template.".into());
    }
    let data = body(&request)?;
    if data.len() > ASSET_MAX {
        return Err("That picture is too big to keep.".into());
    }
    let data = data.to_vec();
    let dir = assets_dir(&app)?.join(owner);
    blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(name);
        crate::fs::text::write_bytes(&path, &data)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}

/// Deletes the pictures kept for a saved template.
#[tauri::command]
pub async fn motion_assets_delete(app: tauri::AppHandle, owner: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let owner = owner_name(&owner).ok_or("No template to delete.")?;
    let dir = assets_dir(&app)?.join(owner);
    blocking(move || match std::fs::remove_dir_all(&dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    })
    .await
}

/// Reads a `.zazkit` Brand Kit (JSON, at most 1 MB).
#[tauri::command]
pub async fn motion_kit_read(path: String) -> Result<String, String> {
    crate::ensure_unlocked()?;
    let path = checked_path(&path, "zazkit", true)?;
    blocking(move || {
        let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut text = String::new();
        file.take(KIT_MAX + 1).read_to_string(&mut text).map_err(|_| "This isn't a Brand Kit (.zazkit).".to_string())?;
        if text.len() as u64 > KIT_MAX || serde_json::from_str::<serde_json::Value>(&text).is_err() {
            return Err("This isn't a Brand Kit (.zazkit).".into());
        }
        Ok(text)
    })
    .await
}

/// Writes a `.zazkit` Brand Kit (JSON, at most 1 MB).
#[tauri::command]
pub async fn motion_kit_write(path: String, text: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let path = checked_path(&path, "zazkit", false)?;
    if text.len() as u64 > KIT_MAX || serde_json::from_str::<serde_json::Value>(&text).is_err() {
        return Err("That isn't a Brand Kit.".into());
    }
    blocking(move || crate::fs::text::write_bytes(&path, text.as_bytes()).map(|_| ())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("motion-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_package_round_trips() {
        let dir = temp("round");
        let path = dir.join("Launch.zaztemplate");
        let doc = br#"{"app":"zaztemplate","version":1}"#.to_vec();
        let assets = vec![("product.png".to_string(), vec![1, 2, 3, 4]), ("logo.svg".to_string(), b"<svg/>".to_vec())];
        pack(&path, &doc, &assets).unwrap();
        let (d, a) = unpack(&path).unwrap();
        assert_eq!(d, doc);
        assert_eq!(a, assets);
        let encoded = encode_package(&d, &a);
        assert_eq!(&encoded[..4], MAGIC);
        assert_eq!(u32::from_le_bytes(encoded[4..8].try_into().unwrap()) as usize, doc.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_never_leave_their_folder() {
        assert_eq!(safe_name("../../etc/passwd").as_deref(), Some("passwd"));
        assert_eq!(safe_name("..\\..\\win.ini").as_deref(), Some("win.ini"));
        assert_eq!(safe_name("a b/../c d.png").as_deref(), Some("cd.png"));
        assert_eq!(safe_name(".hidden").as_deref(), Some("hidden"));
        assert_eq!(safe_name("../"), None);
        assert_eq!(safe_name(""), None);
    }

    #[test]
    fn a_zip_without_a_document_is_refused() {
        let dir = temp("nodoc");
        let path = dir.join("x.zaztemplate");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("other.txt", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(b"hi").unwrap();
        zip.finish().unwrap();
        assert!(unpack(&path).is_err());
        assert!(unpack(&dir.join("missing.zaztemplate")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_picked_files_of_the_right_kind() {
        let dir = temp("paths");
        let ok = dir.join("Sale.zaztemplate");
        assert!(checked_path(ok.to_str().unwrap(), "zaztemplate", false).is_ok());
        assert!(checked_path(dir.join("x.ZazTemplate").to_str().unwrap(), "zaztemplate", false).is_ok());
        assert!(checked_path("relative.zaztemplate", "zaztemplate", false).is_err());
        assert!(checked_path(dir.join("../x.zaztemplate").to_str().unwrap(), "zaztemplate", false).is_err());
        assert!(checked_path(dir.join(".bashrc").to_str().unwrap(), "zaztemplate", false).is_err());
        assert!(checked_path(dir.join("kit.zazkit.sh").to_str().unwrap(), "zazkit", false).is_err());
        assert!(checked_path(dir.join("nofolder/x.zaztemplate").to_str().unwrap(), "zaztemplate", false).is_err());
        assert!(checked_path(ok.to_str().unwrap(), "zaztemplate", true).is_err(), "must exist to be read");
        // A link named like a template isn't followed.
        let target = dir.join("target.txt");
        std::fs::write(&target, b"x").unwrap();
        let link = dir.join("link.zaztemplate");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(checked_path(link.to_str().unwrap(), "zaztemplate", true).is_err());
            assert!(checked_path(link.to_str().unwrap(), "zaztemplate", false).is_err());
        }
        std::fs::create_dir(dir.join("folder.zaztemplate")).unwrap();
        assert!(checked_path(dir.join("folder.zaztemplate").to_str().unwrap(), "zaztemplate", true).is_err());
        assert_eq!(owner_name("mine-abc123").as_deref(), Some("mine-abc123"));
        assert_eq!(owner_name("../mine-x").as_deref(), Some("mine-x"), "only the last part counts");
        assert!(owner_name("assets").is_none());
        assert!(owner_name("mine-").is_none());
        assert!(owner_name("mine-a.b").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pictures_are_counted_as_read() {
        let dir = temp("budget");
        let path = dir.join("big.zaztemplate");
        pack(&path, b"{}", &[("a.png".into(), vec![7; 4000]), ("b.png".into(), vec![8; 4000])]).unwrap();
        assert!(unpack_within(&path, 10_000).is_ok());
        assert!(unpack_within(&path, 6_000).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hostile_entry_names_are_cleaned() {
        let dir = temp("slip");
        let path = dir.join("y.zaztemplate");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(DOC, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.start_file("assets/../../evil.sh", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(b"x").unwrap();
        zip.finish().unwrap();
        let (_, a) = unpack(&path).unwrap();
        assert_eq!(a, vec![("evil.sh".to_string(), b"x".to_vec())]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
