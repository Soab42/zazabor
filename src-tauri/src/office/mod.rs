//! Office: Docs (a word processor) and Sheets (a spreadsheet), for Word and Excel files. The page
//! edits them: documents in Tiptap, spreadsheets in IronCalc's engine compiled to wasm. This side
//! reads and writes the files. A spreadsheet travels as IronCalc's own bytes (`Model::to_bytes`):
//! .xlsx is read and written here with the `ironcalc` crate, the same version as the page's engine.
//!
//! File contents cross the bridge raw (no JSON arrays of numbers): reads return
//! `tauri::ipc::Response`, writes take the request body, with the path in an `x-path` header
//! (percent-encoded, as headers are ASCII).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::ipc::{InvokeBody, Request, Response};

pub mod pdf_signatures;

/// Bigger files than this aren't opened (a document or a workbook this size is no longer one).
const MAX_BYTES: u64 = 256 * 1024 * 1024;
/// The language formulas are written in (function names, separators).
const LANGUAGE: &str = "en";

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

/// The body and the `x-path` header of a write.
fn body_and_path<'a>(request: &'a Request<'_>) -> Result<(&'a [u8], String), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Nothing to save.".into());
    };
    let header = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("Save where?")?;
    Ok((bytes, percent_decode(header)?))
}

fn percent_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| format!("Bad path: {text}"))?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| format!("Bad path: {text}"))
}

// ---- AutoRecover: snapshots of unsaved files, kept until they're saved or closed

static RECOVERY: OnceLock<PathBuf> = OnceLock::new();

/// Where snapshots go: `office/recovery/` in the app's data folder.
pub fn init(dir: PathBuf) {
    let _ = RECOVERY.set(dir.join("office").join("recovery"));
}

fn recovery_dir() -> Result<&'static PathBuf, String> {
    RECOVERY.get().ok_or_else(|| "AutoRecover isn't ready.".to_string())
}

/// A snapshot's id is the editor's own: letters, digits and dashes only (it names files).
fn recovery_file(id: &str, ext: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Bad AutoRecover id.".into());
    }
    Ok(recovery_dir()?.join(format!("{id}.{ext}")))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Recovered {
    pub id: String,
    /// "doc" or "sheet".
    pub kind: String,
    /// The file it was opened from; None for a new file.
    pub path: Option<String>,
    pub name: String,
    /// When the snapshot was taken (ms).
    #[serde(default)]
    pub saved: i64,
    /// The CorePro that took it. Its own (all its windows share one process) are files still open.
    #[serde(default)]
    pub pid: u32,
}

/// Saves a snapshot (the body) with what it is (`x-meta`, percent-encoded JSON of `Recovered`).
#[tauri::command]
pub async fn office_recovery_save(request: Request<'_>) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Nothing to keep.".into());
    };
    let meta = request.headers().get("x-meta").and_then(|v| v.to_str().ok()).ok_or("No AutoRecover details.")?;
    let mut meta: Recovered = serde_json::from_str(&percent_decode(meta)?).map_err(|e| e.to_string())?;
    meta.saved = crate::notes::now();
    meta.pid = std::process::id();
    let data = recovery_file(&meta.id, "bin")?;
    let info = recovery_file(&meta.id, "json")?;
    let bytes = bytes.to_vec();
    blocking(move || {
        std::fs::create_dir_all(recovery_dir()?).map_err(|e| e.to_string())?;
        crate::fs::text::write_bytes(&data, &bytes)?;
        crate::fs::text::write_bytes(&info, &serde_json::to_vec(&meta).map_err(|e| e.to_string())?)?;
        Ok(())
    })
    .await
}

/// Snapshots left by a CorePro that didn't close its files (a crash, a power cut), newest first.
#[tauri::command]
pub async fn office_recovery_list() -> Result<Vec<Recovered>, String> {
    crate::ensure_unlocked()?;
    let dir = recovery_dir()?.clone();
    blocking(move || {
        let mut list: Vec<Recovered> = std::fs::read_dir(&dir)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
                    .filter_map(|e| std::fs::read(e.path()).ok())
                    .filter_map(|b| serde_json::from_slice::<Recovered>(&b).ok())
                    .filter(|r| r.pid != std::process::id() && recovery_file(&r.id, "bin").is_ok_and(|p| p.exists()))
                    .collect()
            })
            .unwrap_or_default();
        list.sort_by_key(|r| std::cmp::Reverse(r.saved));
        Ok(list)
    })
    .await
}

#[tauri::command]
pub async fn office_recovery_read(id: String) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let file = recovery_file(&id, "bin")?;
    let bytes = blocking(move || crate::fs::text::read_bytes(&file, MAX_BYTES)).await?;
    Ok(Response::new(bytes))
}

/// Forgets a snapshot (its file was saved, closed without saving, or recovered).
#[tauri::command]
pub async fn office_recovery_delete(id: String) -> Result<(), String> {
    let data = recovery_file(&id, "bin")?;
    let info = recovery_file(&id, "json")?;
    blocking(move || {
        let _ = std::fs::remove_file(data);
        let _ = std::fs::remove_file(info);
        Ok(())
    })
    .await
}

/// A file's bytes (a .docx, an image to insert…).
#[tauri::command]
pub async fn office_read(path: String) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let bytes = blocking(move || crate::fs::text::read_bytes(Path::new(&path), MAX_BYTES)).await?;
    Ok(Response::new(bytes))
}

/// Saves the request body over `x-path`, safely (see `fs::text::write_bytes`); returns the new
/// modification time.
#[tauri::command]
pub async fn office_write(request: Request<'_>) -> Result<f64, String> {
    crate::ensure_unlocked()?;
    let (bytes, path) = body_and_path(&request)?;
    let bytes = bytes.to_vec();
    blocking(move || crate::fs::text::write_bytes(Path::new(&path), &bytes)).await
}

/// The separator of a delimited text file, by its extension; `None` for a workbook.
fn separator(path: &str) -> Option<char> {
    match Path::new(path).extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("csv") => Some(','),
        Some("tsv") | Some("tab") => Some('\t'),
        _ => None,
    }
}

/// Splits delimited text into rows of fields, as RFC 4180 has it: quotes around a field allow the
/// separator, line breaks and doubled quotes inside it. A byte-order mark is dropped.
fn parse_delimited(text: &str, sep: char) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                '"' => quoted = false,
                _ => field.push(c),
            }
        } else if c == '"' && field.is_empty() {
            quoted = true;
        } else if c == sep {
            row.push(std::mem::take(&mut field));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(c);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// A field as delimited text writes it: quoted when it holds the separator, a quote or a line break.
fn quote_field(value: &str, sep: char) -> String {
    if value.contains(sep) || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// A workbook of one sheet from delimited text; each field is read as if typed into its cell.
fn workbook_from_delimited(text: &str, sep: char, name: &str, locale: &str, timezone: &str) -> Result<Vec<u8>, String> {
    let mut model = ironcalc::base::Model::new_empty(name, locale, timezone, LANGUAGE)?;
    for (r, fields) in parse_delimited(text, sep).iter().enumerate() {
        for (c, value) in fields.iter().enumerate() {
            if !value.is_empty() {
                model.set_user_input(0, r as i32 + 1, c as i32 + 1, value.clone())?;
            }
        }
    }
    model.evaluate();
    Ok(model.to_bytes())
}

/// One sheet's values as shown (what Excel writes to CSV), as delimited text.
fn delimited_from_workbook(bytes: &[u8], sheet: u32, sep: char) -> Result<String, String> {
    let model = ironcalc::base::Model::from_bytes(bytes, LANGUAGE)?;
    let dim = model.workbook.worksheet(sheet)?.dimension();
    let mut out = String::new();
    for row in 1..=dim.max_row {
        let fields: Vec<String> = (1..=dim.max_column)
            .map(|column| model.get_formatted_cell_value(sheet, row, column).map(|v| quote_field(&v, sep)))
            .collect::<Result<_, _>>()?;
        out.push_str(&fields.join(&sep.to_string()));
        out.push_str("\r\n");
    }
    Ok(out)
}

/// Reads a workbook (.xlsx, or .csv/.tsv as one sheet) into IronCalc's bytes, for the page's
/// engine. `locale` is one IronCalc knows ("en", "en-GB", "de"…), `timezone` an IANA name.
#[tauri::command]
pub async fn sheet_open(path: String, locale: String, timezone: String) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let bytes = blocking(move || {
        let shown = Path::new(&path).display().to_string();
        if let Some(sep) = separator(&path) {
            let raw = crate::fs::text::read_bytes(Path::new(&path), MAX_BYTES)?;
            let name = Path::new(&path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Sheet".into());
            return workbook_from_delimited(&String::from_utf8_lossy(&raw), sep, &name, &locale, &timezone).map_err(|e| format!("Couldn’t open {shown}: {e}"));
        }
        let model = ironcalc::import::load_from_xlsx(&path, &locale, &timezone, LANGUAGE).map_err(|e| format!("Couldn’t open {shown}: {e}"))?;
        Ok(model.to_bytes())
    })
    .await?;
    Ok(Response::new(bytes))
}

/// Writes IronCalc's bytes (the body) to `x-path`: an .xlsx, or for .csv/.tsv the sheet whose
/// index is in `x-sheet`.
#[tauri::command]
pub async fn sheet_save(request: Request<'_>) -> Result<f64, String> {
    crate::ensure_unlocked()?;
    let (bytes, path) = body_and_path(&request)?;
    let sheet: u32 = request.headers().get("x-sheet").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0);
    let bytes = bytes.to_vec();
    blocking(move || {
        let out = match separator(&path) {
            Some(sep) => delimited_from_workbook(&bytes, sheet, sep)?.into_bytes(),
            None => {
                let model = ironcalc::base::Model::from_bytes(&bytes, LANGUAGE)?;
                ironcalc::export::save_xlsx_to_writer(&model, std::io::Cursor::new(Vec::new()))
                    .map_err(|e| format!("Couldn’t write the workbook: {e}"))?
                    .into_inner()
            }
        };
        crate::fs::text::write_bytes(Path::new(&path), &out)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_ids_cannot_leave_the_folder() {
        let _ = RECOVERY.set(PathBuf::from("/tmp/corepro-recovery-test"));
        assert!(recovery_file("sheet-1a2b", "bin").is_ok());
        assert!(recovery_file("../../etc/passwd", "bin").is_err());
        assert!(recovery_file("a/b", "json").is_err());
        assert!(recovery_file("", "bin").is_err());
    }

    #[test]
    fn paths_come_back_from_headers() {
        assert_eq!(percent_decode("/home/a%20b/%E0%A6%95.xlsx").unwrap(), "/home/a b/ক.xlsx");
        assert_eq!(percent_decode("/plain/path.docx").unwrap(), "/plain/path.docx");
        assert!(percent_decode("/bad/%zz").is_err());
    }

    #[test]
    fn delimited_text_round_trips() {
        let rows = parse_delimited("\u{feff}name,note\r\n\"Rahim, A\",\"said \"\"hi\"\"\nthen left\"\r\n3,", ',');
        assert_eq!(rows, vec![vec!["name", "note"], vec!["Rahim, A", "said \"hi\"\nthen left"], vec!["3", ""]]);
        let bytes = workbook_from_delimited("a,b\n1,=A2*2\n", ',', "t", "en", "UTC").unwrap();
        assert_eq!(delimited_from_workbook(&bytes, 0, ',').unwrap(), "a,b\r\n1,2\r\n");
        assert_eq!(quote_field("x\ty", '\t'), "\"x\ty\"");
    }

    #[test]
    fn a_workbook_survives_xlsx() {
        let mut model = ironcalc::base::Model::new_empty("Book", "en", "UTC", LANGUAGE).unwrap();
        model.set_user_input(0, 1, 1, "21".into()).unwrap();
        model.set_user_input(0, 2, 1, "=A1*2".into()).unwrap();
        model.evaluate();
        let bytes = ironcalc::export::save_xlsx_to_writer(&model, std::io::Cursor::new(Vec::new())).unwrap().into_inner();
        let back = ironcalc::import::load_from_xlsx_bytes(&bytes, "Book", "en", "UTC").unwrap();
        let back = ironcalc::base::Model::from_workbook(back, LANGUAGE).unwrap();
        assert_eq!(back.get_formatted_cell_value(0, 2, 1).unwrap(), "42");
        // And through the bytes the page's engine reads.
        let again = ironcalc::base::Model::from_bytes(&back.to_bytes(), LANGUAGE).unwrap();
        assert_eq!(again.get_localized_cell_content(0, 2, 1).unwrap(), "=A1*2");
    }
}
