//! Bank and mobile-wallet statements in, from any shape: CSV or Excel (read here), a PDF with
//! text (the page sends pdf.js's positioned text, `layout` rebuilds the table), or a scan, photo
//! or odd layout (Claude reads it, when the user turned that on in Settings → AI). Every way ends
//! in the same `Statement`, checked against its own running balance (`build::check`), which can
//! be saved as Excel (`xlsx`) or handed to Wallet's importer (`statement_stage`).

pub mod ai;
pub mod build;
pub mod keys;
pub mod layout;
pub mod parse;
pub mod xlsx;

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::Emitter;

use build::{Grid, Statement};

type Result<T> = std::result::Result<T, String>;

/// Files larger than this aren't read.
const MAX_BYTES: u64 = 40 * 1024 * 1024;
/// Staged statements (for Wallet's importer) are removed after this long.
const STAGED_DAYS: u64 = 7;

struct Dirs {
    config: PathBuf,
    data: PathBuf,
}

static DIRS: OnceLock<Dirs> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
/// Set by Stop while Claude reads.
static CANCEL: AtomicBool = AtomicBool::new(false);

pub fn init(app: tauri::AppHandle, config: PathBuf, data: PathBuf) {
    let staged = data.join("statements").join("staged");
    let _ = DIRS.set(Dirs { config, data });
    let _ = APP.set(app);
    // Old staged copies go.
    if let Ok(entries) = std::fs::read_dir(&staged) {
        let limit = std::time::Duration::from_secs(STAGED_DAYS * 86_400);
        for e in entries.flatten() {
            let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > limit);
            if old {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
}

fn dirs() -> Result<&'static Dirs> {
    DIRS.get().ok_or_else(|| "Statements aren't ready yet.".to_string())
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

fn extension(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---- reading

/// A CSV or Excel statement: its heading row (a date column and two more a statement has, one of
/// them money) and everything around it.
pub fn from_table(rows: &[Vec<String>], source: &str, file: &str) -> Result<Statement> {
    let heading = rows.iter().take(60).position(|r| {
        let roles: Vec<parse::Role> = r.iter().filter_map(|c| parse::role_of(c)).collect();
        let money = roles.iter().any(|x| matches!(x, parse::Role::Debit | parse::Role::Credit | parse::Role::Amount | parse::Role::Balance));
        roles.contains(&parse::Role::Date) && roles.len() >= 3 && money
    });
    let Some(h) = heading else {
        return Err("No table of transactions was found (a row naming Date and the amount columns). Try Choose File… to map the columns by hand.".into());
    };
    let grid = Grid {
        roles: rows[h].iter().map(|c| parse::role_of(c)).collect(),
        lines: rows[h + 1..].iter().map(|r| (None, r.clone())).collect(),
        around: rows[..h].iter().chain(rows.iter().skip(h + 1).filter(|r| r.iter().any(|c| parse::balance_line(c).is_some()))).map(|r| r.join(" | ")).collect(),
    };
    Ok(build::build(&grid, "BDT", source, file))
}

/// A PDF's text (from the page) as a statement.
pub fn from_items(items: &[layout::Item], file: &str) -> Statement {
    let lines = layout::lines(items);
    match layout::statement_table(&lines, "BDT") {
        Some(found) => {
            let grid = Grid { roles: found.columns.iter().map(|c| c.role).collect(), lines: found.rows.into_iter().map(|(p, y, h, cells)| (Some((p, y, h)), cells)).collect(), around: found.around };
            build::build(&grid, "BDT", "pdf", file)
        }
        None => {
            let around: Vec<String> = lines.iter().map(layout::line_text).collect();
            let mut st = Statement { source: "pdf".into(), file: file.into(), currency: "BDT".into(), confidence: "none".into(), ..Default::default() };
            st.bank = parse::bank(&around);
            st.account_last4 = parse::account_last4(&around);
            st.warnings.push(if items.len() < 20 { "This PDF has little or no text: it's probably a scan. Reading it needs Claude (Settings → AI).".into() } else { "No table of transactions was found in this PDF's text.".into() });
            build::check(&mut st);
            st
        }
    }
}

/// The text of a PDF, line by line, for Claude (cheaper than the whole file).
fn items_text(items: &[layout::Item]) -> String {
    let lines = layout::lines(items);
    let mut out = String::new();
    let mut page = 0;
    for l in &lines {
        if l.page != page {
            page = l.page;
            out.push_str(&format!("--- page {page} ---\n"));
        }
        out.push_str(&layout::line_text(l));
        out.push('\n');
    }
    out
}

#[tauri::command]
pub async fn statement_read(path: String) -> Result<Statement> {
    crate::ensure_unlocked()?;
    blocking(move || {
        let path = PathBuf::from(path);
        let table = crate::wallet::import::read_table(&path, None)?;
        let source = if matches!(extension(&path).as_str(), "xlsx" | "xlsm") { "xlsx" } else { "csv" };
        from_table(&table.rows, source, &file_name(&path))
    })
    .await
}

#[tauri::command]
pub async fn statement_from_items(items: Vec<layout::Item>, file: String) -> Result<Statement> {
    crate::ensure_unlocked()?;
    blocking(move || Ok(from_items(&items, &file))).await
}

#[tauri::command]
pub async fn statement_save_xlsx(statement: Statement, path: String) -> Result<()> {
    crate::ensure_unlocked()?;
    blocking(move || xlsx::statement(&statement, Path::new(&path))).await
}

/// "Tables to Excel": every table in a PDF's text, a sheet each; returns how many.
#[tauri::command]
pub async fn statement_tables_xlsx(items: Vec<layout::Item>, path: String) -> Result<usize> {
    crate::ensure_unlocked()?;
    blocking(move || {
        let lines = layout::lines(&items);
        xlsx::tables(&layout::tables(&lines), Path::new(&path))
    })
    .await
}

// ---- Claude

/// The API's address: Anthropic's, or (only in a development build) a local stand-in.
fn api_base() -> String {
    if cfg!(debug_assertions) {
        if let Ok(base) = std::env::var("ZAZABOR_ANTHROPIC_BASE_URL") {
            if base.starts_with("http://127.0.0.1:") || base.starts_with("http://localhost:") {
                return base;
            }
        }
    }
    ai::API.to_string()
}

/// What Claude is given for this file.
fn ai_input(path: &Path, items: Option<Vec<layout::Item>>) -> Result<ai::Input> {
    let ext = extension(path);
    let shown = file_name(path);
    let meta = std::fs::metadata(path).map_err(|e| format!("{shown}: {e}"))?;
    if meta.len() > MAX_BYTES {
        return Err(format!("“{shown}” is larger than 40 MB."));
    }
    match ext.as_str() {
        "pdf" => {
            // A PDF with real text goes as text; a scan goes as the file.
            if let Some(items) = items.filter(|i| i.len() >= 20) {
                return Ok(ai::Input::Text(items_text(&items)));
            }
            Ok(ai::Input::Pdf(std::fs::read(path).map_err(|e| e.to_string())?))
        }
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "tif" | "tiff" => {
            let media = match ext.as_str() {
                "jpg" | "jpeg" => "image/jpeg",
                "png" => "image/png",
                "webp" => "image/webp",
                "gif" => "image/gif",
                _ => "image/other",
            };
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            Ok(ai::Input::Images(vec![ai::prepare_image(media, bytes)?]))
        }
        "csv" | "tsv" | "txt" | "xlsx" | "xlsm" => {
            let table = crate::wallet::import::read_table(path, None)?;
            Ok(ai::Input::Text(table.rows.iter().map(|r| r.join(" | ")).collect::<Vec<_>>().join("\n")))
        }
        _ => Err(format!("Claude reads PDFs, pictures, CSV and Excel files, not “{shown}”.")),
    }
}

/// Claude reads the statement. Needs the user's consent and key (Settings → AI). The page
/// hears `statement-ai-progress` (characters received) while it reads.
#[tauri::command]
pub async fn statement_ai(path: String, items: Option<Vec<layout::Item>>) -> Result<Statement> {
    crate::ensure_unlocked()?;
    let d = dirs()?;
    let settings = keys::settings(&d.config);
    if !settings.consent {
        return Err("Reading statements with Claude is off. Turn it on in Settings → AI.".into());
    }
    let (key, input, file) = {
        let path = PathBuf::from(&path);
        let config = d.config.clone();
        blocking(move || {
            let key = keys::get_key(&config).ok_or("Add your Claude API key in Settings → AI first.")?;
            let input = ai_input(&path, items)?;
            Ok((key, input, file_name(&path)))
        })
        .await?
    };
    CANCEL.store(false, Ordering::SeqCst);
    let progress = |chars: usize| {
        if let Some(app) = APP.get() {
            let _ = app.emit("statement-ai-progress", chars);
        }
    };
    let out = ai::extract(&api_base(), &key, &settings.model, input, &file, &progress, &CANCEL).await.map_err(|e| e.text());
    crate::ensure_unlocked()?;
    out
}

#[tauri::command]
pub fn statement_ai_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiState {
    has_key: bool,
    /// "keyring", "file" or "".
    key_store: String,
    model: String,
    consent: bool,
}

fn ai_state(dir: &Path) -> AiState {
    let s = keys::settings(dir);
    let store = keys::store_of(dir);
    AiState { has_key: !store.is_empty(), key_store: store.into(), model: s.model, consent: s.consent }
}

#[tauri::command]
pub async fn ai_state_get() -> Result<AiState> {
    crate::ensure_unlocked()?;
    let dir = dirs()?.config.clone();
    blocking(move || Ok(ai_state(&dir))).await
}

#[tauri::command]
pub async fn ai_settings_set(model: String, consent: bool) -> Result<AiState> {
    crate::ensure_unlocked()?;
    let dir = dirs()?.config.clone();
    blocking(move || {
        keys::save_settings(&dir, keys::Settings { model, consent })?;
        Ok(ai_state(&dir))
    })
    .await
}

#[tauri::command]
pub async fn ai_key_set(key: String) -> Result<AiState> {
    crate::ensure_unlocked()?;
    let dir = dirs()?.config.clone();
    blocking(move || {
        keys::set_key(&dir, &key)?;
        Ok(ai_state(&dir))
    })
    .await
}

#[tauri::command]
pub async fn ai_key_clear() -> Result<AiState> {
    crate::ensure_unlocked()?;
    let dir = dirs()?.config.clone();
    blocking(move || {
        keys::clear_key(&dir);
        Ok(ai_state(&dir))
    })
    .await
}

/// Sends a one-word request with the saved key and model.
#[tauri::command]
pub async fn ai_test() -> Result<String> {
    crate::ensure_unlocked()?;
    let dir = dirs()?.config.clone();
    let (key, settings) = blocking(move || Ok((keys::get_key(&dir).ok_or("Add your Claude API key first.")?, keys::settings(&dir)))).await?;
    ai::ping(&api_base(), &key, &settings.model).await.map_err(|e| e.text())?;
    Ok(format!("The key works with {}.", settings.model))
}

// ---- into Wallet

/// A statement written as the CSV Wallet's importer reads, with the mapping for it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    path: String,
    mapping: crate::wallet::import::Mapping,
}

/// The CSV Wallet reads: Date, Description, Reference, Money out, Money in, Balance (row 2 is
/// the statement's first row).
pub fn staged_csv(st: &Statement) -> String {
    let plain = |v: Option<i64>| -> String {
        v.map(|m| {
            let exp = crate::wallet::money::exponent(&st.currency);
            if exp == 0 {
                return m.to_string();
            }
            let unit = 10i64.pow(exp);
            format!("{}{}.{:0w$}", if m < 0 { "-" } else { "" }, m.abs() / unit, m.abs() % unit, w = exp as usize)
        })
        .unwrap_or_default()
    };
    let q = |s: &str| crate::office::quote_field(s, ',');
    let mut out = String::from("Date,Description,Reference,Money out,Money in,Balance\r\n");
    for r in &st.rows {
        out.push_str(&[q(&r.date), q(&r.description), q(r.reference.as_deref().unwrap_or("")), plain(r.debit), plain(r.credit), plain(r.balance)].join(","));
        out.push_str("\r\n");
    }
    out
}

#[tauri::command]
pub async fn statement_stage(statement: Statement) -> Result<Staged> {
    crate::ensure_unlocked()?;
    let data = dirs()?.data.clone();
    blocking(move || {
        let folder = data.join("statements").join("staged").join(crate::notes::new_id());
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let mut name: String = statement.file.chars().filter(|c| !matches!(c, '/' | '\\' | '\0')).collect();
        if name.is_empty() {
            name = "statement".into();
        }
        let path = folder.join(format!("{name}.csv"));
        crate::fs::text::write_bytes(&path, staged_csv(&statement).as_bytes())?;
        let mapping = crate::wallet::import::Mapping {
            header_row: 0,
            date: 0,
            description: Some(1),
            amount: None,
            debit: Some(3),
            credit: Some(4),
            category: None,
            account: None,
            date_order: "ymd".into(),
            sign: "negative-out".into(),
            decimal_comma: false,
        };
        Ok(Staged { path: path.to_string_lossy().to_string(), mapping })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cells(rows: &[&[&str]]) -> Vec<Vec<String>> {
        rows.iter().map(|r| r.iter().map(|s| s.to_string()).collect()).collect()
    }

    #[test]
    fn a_csv_statement_is_read_and_checked() {
        let rows = cells(&[
            &["BRAC Bank Limited"],
            &["Account Number: 1501-2034-5678-001"],
            &["Period: 01/10/2026 to 31/10/2026"],
            &["Value Date", "Narration", "Chq No", "Debit", "Credit", "Balance"],
            &["01/10/2026", "Balance B/F", "", "", "", "20,000.00"],
            &["03/10/2026", "POS PURCHASE SHWAPNO", "", "1,250.00", "", "18,750.00"],
            &["", "GULSHAN 2", "", "", "", ""],
            &["10/10/2026", "INWARD REMITTANCE", "", "", "50,000.00", "68,750.00"],
            &["", "Total", "", "1,250.00", "50,000.00", ""],
        ]);
        let st = from_table(&rows, "csv", "brac.csv").unwrap();
        assert_eq!(st.bank.as_deref(), Some("BRAC Bank"));
        assert_eq!(st.account_last4.as_deref(), Some("8001"));
        assert_eq!((st.period_from.as_deref(), st.period_to.as_deref()), (Some("2026-10-01"), Some("2026-10-31")));
        assert_eq!(st.opening, Some(2_000_000));
        assert_eq!(st.rows.len(), 2);
        assert_eq!(st.rows[0].description, "POS PURCHASE SHWAPNO GULSHAN 2");
        assert_eq!(st.check.status, "ok", "{}", st.check.message);
        assert_eq!(st.closing, Some(6_875_000));
        assert!(from_table(&cells(&[&["just", "words"]]), "csv", "x.csv").is_err());
    }

    #[test]
    fn a_pdf_page_becomes_a_checked_statement() {
        let st = from_items(&layout::tests::city_page(), "city.pdf");
        assert_eq!(st.bank.as_deref(), Some("The City Bank"));
        assert_eq!(st.account_last4.as_deref(), Some("9012"));
        assert_eq!(st.opening, Some(5_000_000));
        assert_eq!(st.rows.len(), 3);
        assert_eq!(st.rows[0].description, "FOODPANDA*BD ORDER DHAKA 1212");
        assert_eq!(st.rows[1].reference.as_deref(), Some("123456"));
        assert_eq!(st.closing, Some(13_355_000));
        assert_eq!(st.check.status, "ok", "{}", st.check.message);
        assert_eq!(st.confidence, "good");
        // A scan: almost no text.
        let scan = from_items(&[layout::tests::it(10.0, 10.0, "Scanned")], "scan.pdf");
        assert_eq!(scan.confidence, "none");
        assert!(scan.warnings[0].contains("scan"));
    }

    #[test]
    fn staged_rows_import_once_and_undo_together() {
        use crate::wallet::import::{commit, preview, undo};
        let st = from_items(&layout::tests::city_page(), "city.pdf");
        let dir = std::env::temp_dir().join(format!("zazabor-stage-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("city.pdf.csv");
        std::fs::write(&path, staged_csv(&st)).unwrap();
        let mapping = crate::wallet::import::Mapping { header_row: 0, date: 0, description: Some(1), amount: None, debit: Some(3), credit: Some(4), category: None, account: None, date_order: "ymd".into(), sign: "negative-out".into(), decimal_comma: false };
        let mut conn = crate::wallet::db_for_tests();
        let bank = crate::wallet::account_for_tests(&conn, "City Bank");
        let p = preview(&conn, &path, None, &bank, Some(mapping.clone())).unwrap();
        assert_eq!((p.new_count, p.errors, p.duplicates), (3, 0, 0));
        let salary = p.rows.iter().find(|r| r.payee.starts_with("SALARY")).unwrap();
        assert_eq!(salary.amount_minor, Some(8_500_000));
        let b = commit(&mut conn, &path, None, &bank, &mapping, &[], 1).unwrap();
        assert_eq!(b.added, 3);
        // The same statement again (say, re-read by Claude): nothing new.
        let again = preview(&conn, &path, None, &bank, Some(mapping.clone())).unwrap();
        assert_eq!((again.new_count, again.duplicates), (0, 3));
        assert_eq!(undo(&mut conn, &b.id).unwrap(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
