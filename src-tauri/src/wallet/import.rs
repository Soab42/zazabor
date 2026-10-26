//! Bank and wallet statements in: a CSV or Excel file read into a table, its columns mapped
//! (date, description, an amount or separate money out and in), every row checked against what
//! the ledger already has, and the new ones added as one batch that can be undone. The column
//! mapping can be kept as a profile, and rules put descriptions in categories.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

use super::dates;
use super::db::{self, db_err, Result};
use super::money;
use super::quick;
use crate::notes::new_id;

/// Statements larger than this are refused.
const MAX_BYTES: u64 = 25 * 1024 * 1024;
/// Rows read from a file at most.
const MAX_ROWS: usize = 20_000;

/// How a statement's columns become transactions (kept in profiles as JSON).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mapping {
    /// The row with the column names (0-based); the rows before it are skipped.
    pub header_row: usize,
    pub date: usize,
    pub description: Option<usize>,
    /// One signed amount…
    pub amount: Option<usize>,
    /// …or money out and money in, in separate columns.
    pub debit: Option<usize>,
    pub credit: Option<usize>,
    /// A column with category names, matched to the wallet's.
    #[serde(default)]
    pub category: Option<usize>,
    /// "dmy", "mdy" or "ymd", for dates written with numbers only.
    pub date_order: String,
    /// One amount column: "negative-out" (spending has a minus) or "positive-out".
    pub sign: String,
    /// "1.250,50" rather than "1,250.50".
    #[serde(default)]
    pub decimal_comma: bool,
}

/// A statement read into text cells.
#[derive(Debug)]
pub struct Table {
    pub rows: Vec<Vec<String>>,
    pub sheets: Vec<String>,
}

/// Decodes text from an old bank export: UTF-8, else Windows-1252.
fn decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => {
            // 0x80–0x9F are Windows-1252's own; the rest is Latin-1.
            const HIGH: [char; 32] = [
                '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š',
                '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
            ];
            bytes.iter().map(|&b| if (0x80..0xa0).contains(&b) { HIGH[(b - 0x80) as usize] } else { b as char }).collect()
        }
    }
}

/// The separator a delimited text uses: the one that splits its first lines most evenly.
fn sniff_separator(text: &str) -> char {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).take(30).collect();
    let mut best = (',', 0usize);
    for sep in [',', ';', '\t', '|'] {
        let counts: Vec<usize> = lines.iter().map(|l| l.matches(sep).count()).collect();
        let mut freq: HashMap<usize, usize> = HashMap::new();
        for c in counts.iter().filter(|c| **c > 0) {
            *freq.entry(*c).or_default() += 1;
        }
        // The most lines agreeing on one count, weighted by that count.
        let score = freq.iter().map(|(count, lines)| lines * 100 + count).max().unwrap_or(0);
        if score > best.1 {
            best = (sep, score);
        }
    }
    best.0
}

/// Reads a statement: .csv, .tsv or .txt, or one sheet of an .xlsx.
pub fn read_table(path: &Path, sheet: Option<u32>) -> Result<Table> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let shown = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    match ext.as_str() {
        "csv" | "tsv" | "txt" | "tab" => {
            let bytes = crate::fs::text::read_bytes(path, MAX_BYTES).map_err(|e| if e.contains("too large") { format!("“{shown}” is larger than 25 MB.") } else { e })?;
            let text = decode(&bytes);
            let sep = if ext == "tsv" || ext == "tab" { '\t' } else { sniff_separator(&text) };
            Ok(Table { rows: trim_rows(crate::office::parse_delimited(&text, sep)), sheets: vec![] })
        }
        "xlsx" | "xlsm" => {
            let meta = std::fs::metadata(path).map_err(|e| format!("{shown}: {e}"))?;
            if meta.len() > MAX_BYTES {
                return Err(format!("“{shown}” is larger than 25 MB."));
            }
            let model = ironcalc::import::load_from_xlsx(&path.to_string_lossy(), "en", "UTC", "en").map_err(|e| format!("Couldn't read “{shown}”: {e}"))?;
            let sheets = model.workbook.get_worksheet_names();
            let index = sheet.unwrap_or(0).min(sheets.len().saturating_sub(1) as u32);
            let dim = model.workbook.worksheet(index)?.dimension();
            let mut rows = Vec::new();
            for row in 1..=dim.max_row.min(MAX_ROWS as i32) {
                let cells = (1..=dim.max_column.min(60)).map(|column| model.get_formatted_cell_value(index, row, column).unwrap_or_default()).collect();
                rows.push(cells);
            }
            Ok(Table { rows: trim_rows(rows), sheets })
        }
        "xls" | "ods" => Err(format!("CorePro reads .xlsx and .csv statements. Open “{shown}” in Sheets and save it as .xlsx first.")),
        _ => Err(format!("“{shown}” isn't a CSV or Excel file.")),
    }
}

/// Trims cells and drops empty rows at the end.
fn trim_rows(mut rows: Vec<Vec<String>>) -> Vec<Vec<String>> {
    rows.truncate(MAX_ROWS);
    for row in &mut rows {
        for cell in row.iter_mut() {
            *cell = cell.trim().to_string();
        }
        while row.last().is_some_and(|c| c.is_empty()) {
            row.pop();
        }
    }
    while rows.last().is_some_and(|r| r.is_empty()) {
        rows.pop();
    }
    rows
}

// ---- reading cells

/// A money cell: "1,250.00", "(1,250.00)", "-1250", "৳ 1,250", "1,250.00 Dr", "1.250,50" (with a
/// decimal comma). Returns the unsigned minor amount and the sign the cell itself carries (−1 for
/// a minus, brackets or "Dr", +1 for "Cr", 0 for none).
pub fn read_money(text: &str, code: &str, decimal_comma: bool) -> Option<(i64, i32)> {
    let mut t = text.trim().to_lowercase();
    if t.is_empty() || t == "-" || t == "—" {
        return None;
    }
    let mut sign = 0;
    for (suffix, s) in [("dr", -1), ("cr", 1), ("dr.", -1), ("cr.", 1)] {
        if let Some(rest) = t.strip_suffix(suffix) {
            if rest.ends_with(|c: char| c.is_ascii_digit() || c == ' ' || c == ')') {
                t = rest.trim().to_string();
                sign = s;
            }
        }
    }
    if t.starts_with('(') && t.ends_with(')') {
        t = t[1..t.len() - 1].to_string();
        sign = -1;
    }
    if t.starts_with('-') || t.starts_with('−') || t.ends_with('-') {
        sign = -1;
    }
    let mut digits: String = t.chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == ',').collect();
    if decimal_comma {
        digits = digits.replace('.', "").replace(',', ".");
    } else {
        digits = digits.replace(',', "");
    }
    if digits.is_empty() || !digits.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    // More decimals than the currency has (a rate column, "12.3456"): rounded to its unit.
    let exp = money::exponent(code) as usize;
    if let Some((w, f)) = digits.split_once('.') {
        if f.len() > exp {
            let value: f64 = format!("{w}.{f}").parse().ok()?;
            let minor = (value * 10f64.powi(exp as i32)).round() as i64;
            return Some((minor, sign));
        }
    }
    money::parse_amount(&digits, code).map(|m| (m, sign))
}

fn lower_words(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

// ---- guessing the mapping

const DATE_NAMES: [&str; 7] = ["date", "txn date", "transaction date", "trans date", "value date", "posting date", "tran date"];
const DESC_NAMES: [&str; 10] = ["description", "details", "narration", "particulars", "remarks", "payee", "merchant", "transaction details", "memo", "name"];
const AMOUNT_NAMES: [&str; 3] = ["amount", "amt", "transaction amount"];
const DEBIT_NAMES: [&str; 7] = ["debit", "withdrawal", "withdrawals", "dr", "paid out", "money out", "out"];
const CREDIT_NAMES: [&str; 7] = ["credit", "deposit", "deposits", "cr", "paid in", "money in", "in"];

fn find_column(header: &[String], names: &[&str]) -> Option<usize> {
    let cells: Vec<String> = header.iter().map(|c| lower_words(c).trim_end_matches(['.', ':']).to_string()).collect();
    names.iter().find_map(|n| cells.iter().position(|c| c == n)).or_else(|| names.iter().find_map(|n| cells.iter().position(|c| c.starts_with(n) && n.len() > 3)))
}

/// A first guess at the mapping: the header row is the first that names a date column (or the
/// row above the first date), columns by their names, and the date order by its numbers.
pub fn guess_mapping(table: &Table) -> Mapping {
    let mut mapping = Mapping { header_row: 0, date: 0, description: None, amount: None, debit: None, credit: None, category: None, date_order: "dmy".into(), sign: "negative-out".into(), decimal_comma: false };
    let header_row = table.rows.iter().take(30).position(|r| find_column(r, &DATE_NAMES).is_some());
    let header_row = header_row.or_else(|| {
        table.rows.iter().take(30).position(|r| r.iter().any(|c| dates::parse_loose(c, "dmy").is_some())).map(|i| i.saturating_sub(1))
    });
    mapping.header_row = header_row.unwrap_or(0);
    let header = table.rows.get(mapping.header_row).cloned().unwrap_or_default();
    let body: Vec<&Vec<String>> = table.rows.iter().skip(mapping.header_row + 1).take(200).collect();
    mapping.date = find_column(&header, &DATE_NAMES).unwrap_or_else(|| {
        (0..header.len().max(1)).find(|&c| body.iter().filter(|r| r.get(c).is_some_and(|v| dates::parse_loose(v, "dmy").is_some())).count() * 2 > body.len()).unwrap_or(0)
    });
    mapping.description = find_column(&header, &DESC_NAMES);
    mapping.debit = find_column(&header, &DEBIT_NAMES);
    mapping.credit = find_column(&header, &CREDIT_NAMES);
    mapping.amount = if mapping.debit.is_some() && mapping.credit.is_some() { None } else { find_column(&header, &AMOUNT_NAMES) };
    mapping.category = find_column(&header, &["category"]);
    if mapping.amount.is_some() {
        mapping.debit = None;
        mapping.credit = None;
    }
    if mapping.description.is_none() {
        // The widest text column.
        let used = [Some(mapping.date), mapping.amount, mapping.debit, mapping.credit];
        mapping.description = (0..header.len())
            .filter(|c| !used.contains(&Some(*c)))
            .max_by_key(|&c| body.iter().map(|r| r.get(c).map_or(0, |v| v.chars().filter(|ch| ch.is_alphabetic()).count())).sum::<usize>());
    }
    // Numbers-only dates: a first part above 12 means day first, a second part above 12 month first.
    let mut dmy = 0;
    let mut mdy = 0;
    for r in &body {
        let Some(v) = r.get(mapping.date) else { continue };
        let nums: Vec<u32> = v.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).filter_map(|p| p.parse().ok()).collect();
        if nums.len() >= 3 && nums[0] <= 31 {
            if nums[0] > 12 {
                dmy += 1;
            } else if nums[1] > 12 {
                mdy += 1;
            }
        }
    }
    mapping.date_order = if mdy > dmy { "mdy" } else { "dmy" }.into();
    // A decimal comma: amounts like "1.250,50".
    let amount_cols = [mapping.amount, mapping.debit, mapping.credit];
    let comma = body.iter().flat_map(|r| amount_cols.iter().flatten().filter_map(|c| r.get(*c))).filter(|v| {
        let t = v.trim();
        t.len() > 3 && t.as_bytes()[t.len() - 3] == b',' && t[t.len() - 2..].chars().all(|c| c.is_ascii_digit())
    });
    mapping.decimal_comma = comma.count() > 0;
    mapping
}

// ---- rules

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: Option<String>,
    /// Words to look for in the description (any case).
    pub pattern: String,
    pub category_id: Option<String>,
    /// A cleaner name for the payee ("FOODPANDA*BD 1234" → "Foodpanda"); "" keeps the description.
    #[serde(default)]
    pub payee: String,
}

pub fn rules(conn: &Connection) -> Result<Vec<Rule>> {
    let mut stmt = conn.prepare("SELECT id, pattern, category_id, payee FROM rules ORDER BY position, created").map_err(db_err)?;
    let rows = stmt.query_map([], |r| Ok(Rule { id: r.get(0)?, pattern: r.get(1)?, category_id: r.get(2)?, payee: r.get(3)? })).map_err(db_err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db_err)
}

pub fn save_rule(conn: &Connection, rule: Rule, now: i64) -> Result<Rule> {
    let pattern = lower_words(&rule.pattern).chars().take(120).collect::<String>();
    if pattern.is_empty() {
        return Err("Type the words to look for.".into());
    }
    if rule.category_id.is_none() && rule.payee.trim().is_empty() {
        return Err("Pick a category, or a name for the payee.".into());
    }
    let payee: String = rule.payee.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect();
    let id = match rule.id {
        Some(id) => {
            conn.execute("UPDATE rules SET pattern = ?2, category_id = ?3, payee = ?4 WHERE id = ?1", params![id, pattern, rule.category_id, payee]).map_err(db_err)?;
            id
        }
        None => {
            let id = new_id();
            let position: f64 = conn.query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM rules", [], |r| r.get(0)).map_err(db_err)?;
            conn.execute("INSERT INTO rules (id, pattern, category_id, payee, position, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![id, pattern, rule.category_id, payee, position, now])
                .map_err(db_err)?;
            id
        }
    };
    Ok(Rule { id: Some(id), pattern, category_id: rule.category_id, payee })
}

pub fn delete_rule(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM rules WHERE id = ?1", [id]).map_err(db_err)?;
    Ok(())
}

fn matching_rule<'a>(rules: &'a [Rule], description: &str) -> Option<&'a Rule> {
    let text = lower_words(description);
    rules.iter().find(|r| text.contains(&r.pattern))
}

// ---- profiles

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub account_id: Option<String>,
    pub mapping: Mapping,
}

pub fn profiles(conn: &Connection) -> Result<Vec<Profile>> {
    let mut stmt = conn.prepare("SELECT id, name, account_id, mapping FROM import_profiles ORDER BY updated DESC").map_err(db_err)?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?))).map_err(db_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, account_id, mapping) = row.map_err(db_err)?;
        if let Ok(mapping) = serde_json::from_str(&mapping) {
            out.push(Profile { id, name, account_id, mapping });
        }
    }
    Ok(out)
}

/// Saves a mapping under a name (replacing a profile of that name).
pub fn save_profile(conn: &Connection, name: &str, account_id: Option<&str>, mapping: &Mapping, now: i64) -> Result<Profile> {
    let name: String = name.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect();
    if name.is_empty() {
        return Err("Give the profile a name, like “City Bank CSV”.".into());
    }
    let json = serde_json::to_string(mapping).map_err(|e| e.to_string())?;
    let existing: Option<String> = conn.query_row("SELECT id FROM import_profiles WHERE lower(name) = lower(?1)", [&name], |r| r.get(0)).optional().map_err(db_err)?;
    let id = existing.unwrap_or_else(new_id);
    conn.execute(
        "INSERT INTO import_profiles (id, name, account_id, mapping, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
           ON CONFLICT(id) DO UPDATE SET name = ?2, account_id = ?3, mapping = ?4, updated = ?5",
        params![id, name, account_id, json, now],
    )
    .map_err(db_err)?;
    Ok(Profile { id, name, account_id: account_id.map(Into::into), mapping: mapping.clone() })
}

pub fn delete_profile(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM import_profiles WHERE id = ?1", [id]).map_err(db_err)?;
    Ok(())
}

// ---- preview and commit

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    /// The row's number in the file (1-based, as a spreadsheet shows it).
    pub line: usize,
    pub date: Option<String>,
    pub payee: String,
    /// Signed, in the account's currency.
    pub amount_minor: Option<i64>,
    pub category_id: Option<String>,
    /// The rule that categorised it.
    pub rule: Option<String>,
    /// Already in the ledger (imported before).
    pub duplicate: bool,
    /// Why it can't be added (a total line, a date that isn't one…).
    pub error: Option<String>,
    #[serde(skip)]
    pub hash: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub mapping: Mapping,
    /// The header row's cells, and a few rows below it, for the mapping step.
    pub columns: Vec<String>,
    pub sample: Vec<Vec<String>>,
    pub sheets: Vec<String>,
    pub rows: Vec<Row>,
    pub new_count: usize,
    pub duplicates: usize,
    pub errors: usize,
}

/// The duplicate key of a row: the account, date, amount and description, plus how many identical
/// rows came before it in the file (two ৳100 rickshaw rides on one day are two rows).
fn row_hash(account: &str, date: &str, amount: i64, description: &str, occurrence: usize) -> String {
    let key = format!("{account}\u{1f}{date}\u{1f}{amount}\u{1f}{}\u{1f}{occurrence}", lower_words(description));
    format!("{:016x}", xxhash_rust::xxh3::xxh3_64(key.as_bytes()))
}

/// Turns the table into rows to add, with categories, duplicates and problems marked.
pub fn rows(conn: &Connection, table: &Table, account_id: &str, mapping: &Mapping) -> Result<Vec<Row>> {
    let account = db::accounts(conn)?.into_iter().find(|a| a.id == account_id).ok_or("That account no longer exists.")?;
    let code = account.currency.clone();
    let rules = rules(conn)?;
    let categories = db::categories(conn)?;
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::new();
    let cell = |r: &Vec<String>, c: Option<usize>| c.and_then(|c| r.get(c)).map(|v| v.trim().to_string()).unwrap_or_default();
    for (i, r) in table.rows.iter().enumerate().skip(mapping.header_row + 1) {
        if r.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        let line = i + 1;
        let description = cell(r, mapping.description);
        let date_text = cell(r, Some(mapping.date));
        let date = dates::parse_loose(&date_text, &mapping.date_order);
        let amount = if let Some(c) = mapping.amount {
            read_money(&cell(r, Some(c)), &code, mapping.decimal_comma).map(|(m, s)| {
                let negative = if s != 0 { s < 0 } else { false };
                let out = if negative { -m } else { m };
                if mapping.sign == "positive-out" && s == 0 { -out } else { out }
            })
        } else {
            let debit = read_money(&cell(r, mapping.debit), &code, mapping.decimal_comma).map(|(m, _)| m).filter(|m| *m != 0);
            let credit = read_money(&cell(r, mapping.credit), &code, mapping.decimal_comma).map(|(m, _)| m).filter(|m| *m != 0);
            match (debit, credit) {
                (Some(d), None) => Some(-d),
                (None, Some(c)) => Some(c),
                (Some(d), Some(c)) => Some(c - d),
                (None, None) => None,
            }
        };
        let error = match (&date, amount) {
            (None, _) if date_text.is_empty() => Some("No date".to_string()),
            (None, _) => Some(format!("“{date_text}” isn't a date")),
            (_, None) => Some("No amount".to_string()),
            (_, Some(0)) => Some("The amount is zero".to_string()),
            _ => None,
        };
        // A rule first, then a category column, then what quick add would guess.
        let rule = matching_rule(&rules, &description);
        let kind = if amount.unwrap_or(0) > 0 { "income" } else { "expense" };
        let mut category_id = rule.and_then(|r| r.category_id.clone());
        if category_id.is_none() {
            let named = cell(r, mapping.category).to_lowercase();
            if !named.is_empty() {
                category_id = categories.iter().find(|c| !c.archived && c.kind == kind && c.name.to_lowercase() == named).map(|c| c.id.clone());
            }
        }
        if category_id.is_none() && !description.is_empty() {
            category_id = quick::guess_category(conn, kind, &description)?;
        }
        let payee = rule.filter(|r| !r.payee.is_empty()).map(|r| r.payee.clone()).unwrap_or_else(|| description.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect());
        let mut hash = String::new();
        let mut duplicate = false;
        if let (Some(d), Some(a), None) = (&date, amount, &error) {
            let key = format!("{d}|{a}|{}", lower_words(&description));
            let n = seen.entry(key).or_default();
            hash = row_hash(account_id, d, a, &description, *n);
            *n += 1;
            duplicate = conn
                .query_row("SELECT 1 FROM transactions WHERE account_id = ?1 AND import_hash = ?2", params![account_id, hash], |r| r.get::<_, i64>(0))
                .optional()
                .map_err(db_err)?
                .is_some();
        }
        out.push(Row { line, date, payee, amount_minor: amount, category_id, rule: rule.map(|r| r.pattern.clone()), duplicate, error, hash });
    }
    Ok(out)
}

pub fn preview(conn: &Connection, path: &Path, sheet: Option<u32>, account_id: &str, mapping: Option<Mapping>) -> Result<Preview> {
    let table = read_table(path, sheet)?;
    if table.rows.is_empty() {
        return Err("The file is empty.".into());
    }
    let mapping = mapping.unwrap_or_else(|| guess_mapping(&table));
    let columns = table.rows.get(mapping.header_row).cloned().unwrap_or_default();
    let sample = table.rows.iter().skip(mapping.header_row + 1).take(6).cloned().collect();
    let rows = rows(conn, &table, account_id, &mapping)?;
    let errors = rows.iter().filter(|r| r.error.is_some()).count();
    let duplicates = rows.iter().filter(|r| r.duplicate).count();
    Ok(Preview { new_count: rows.len() - errors - duplicates, mapping, columns, sample, sheets: table.sheets, rows, duplicates, errors })
}

/// What the page changed on a row before adding it.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RowEdit {
    pub line: usize,
    #[serde(default = "yes")]
    pub include: bool,
    pub category_id: Option<String>,
    pub payee: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub account_id: String,
    /// The file's name.
    pub file: String,
    pub added: i64,
    /// Duplicates and rows left out.
    pub skipped: i64,
    pub created: i64,
    pub undone: bool,
    /// Of what it added, still in the ledger.
    pub remaining: i64,
}

/// Adds the new rows as one batch, in one SQLite transaction. The file is read again with the
/// same mapping, so nothing but the page's choices (left out, category, payee) comes from it.
pub fn commit(conn: &mut Connection, path: &Path, sheet: Option<u32>, account_id: &str, mapping: &Mapping, edits: &[RowEdit], now: i64) -> Result<Batch> {
    let table = read_table(path, sheet)?;
    let rows = rows(conn, &table, account_id, mapping)?;
    let account = db::accounts(conn)?.into_iter().find(|a| a.id == account_id).ok_or("That account no longer exists.")?;
    let rate = db::rate_of(conn, &account.currency)?.ok_or_else(|| format!("Set the rate for {} in Accounts first.", account.currency))?;
    let category_ids: std::collections::HashSet<String> = db::categories(conn)?.into_iter().map(|c| c.id).collect();
    let edits: HashMap<usize, &RowEdit> = edits.iter().map(|e| (e.line, e)).collect();
    let id = new_id();
    let file = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tx = conn.transaction().map_err(db_err)?;
    let mut added = 0i64;
    let mut skipped = 0i64;
    for r in &rows {
        if r.error.is_some() {
            continue;
        }
        let edit = edits.get(&r.line);
        if r.duplicate || edit.is_some_and(|e| !e.include) {
            skipped += 1;
            continue;
        }
        let (Some(date), Some(amount)) = (&r.date, r.amount_minor) else { continue };
        let category = match edit {
            Some(e) => e.category_id.clone().filter(|c| category_ids.contains(c)),
            None => r.category_id.clone(),
        };
        let payee: String = edit.and_then(|e| e.payee.clone()).unwrap_or_else(|| r.payee.clone()).chars().take(120).collect();
        tx.execute(
            "INSERT INTO transactions (id, account_id, date, amount_minor, rate_micro, base_minor, category_id, payee, import_batch, import_hash, created, updated)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
            params![new_id(), account_id, date, amount, rate, money::to_base(amount, &account.currency, rate), category, payee, id, r.hash, now],
        )
        .map_err(db_err)?;
        added += 1;
    }
    if added == 0 {
        return Err(if skipped > 0 { "Everything in this file is already in the wallet.".into() } else { "There's nothing to add.".into() });
    }
    tx.execute(
        "INSERT INTO import_batches (id, account_id, file, added, skipped, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, account_id, file, added, skipped, now],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    batch(conn, &id)
}

fn batch_row(r: &rusqlite::Row) -> rusqlite::Result<Batch> {
    Ok(Batch { id: r.get(0)?, account_id: r.get(1)?, file: r.get(2)?, added: r.get(3)?, skipped: r.get(4)?, created: r.get(5)?, undone: r.get(6)?, remaining: r.get(7)? })
}

const BATCH_SELECT: &str = "SELECT b.id, b.account_id, b.file, b.added, b.skipped, b.created, b.undone,
       (SELECT COUNT(*) FROM transactions t WHERE t.import_batch = b.id) FROM import_batches b";

pub fn batch(conn: &Connection, id: &str) -> Result<Batch> {
    conn.query_row(&format!("{BATCH_SELECT} WHERE b.id = ?1"), [id], batch_row).optional().map_err(db_err)?.ok_or_else(|| "That import no longer exists.".into())
}

pub fn batches(conn: &Connection) -> Result<Vec<Batch>> {
    let mut stmt = conn.prepare(&format!("{BATCH_SELECT} ORDER BY b.created DESC LIMIT 50")).map_err(db_err)?;
    let rows = stmt.query_map([], batch_row).map_err(db_err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db_err)
}

/// Removes everything an import added (and their receipts); returns how many transactions went.
pub fn undo(conn: &mut Connection, id: &str) -> Result<usize> {
    let b = batch(conn, id)?;
    if b.undone {
        return Err("This import was already undone.".into());
    }
    let tx = conn.transaction().map_err(db_err)?;
    let n = tx.execute("DELETE FROM transactions WHERE import_batch = ?1", [id]).map_err(db_err)?;
    tx.execute("UPDATE import_batches SET undone = 1 WHERE id = ?1", [id]).map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::db::tests::{add_account, cat, fresh};

    const STATEMENT: &str = "City Bank\r\nStatement of account\r\n\r\nTxn Date,Description,Debit,Credit,Balance\r\n\
        01/10/2026,Opening balance,,,\"50,000.00\"\r\n\
        05/10/2026,FOODPANDA*BD 1234,450.00,,\"49,550.00\"\r\n\
        05/10/2026,RICKSHAW,100.00,,\"49,450.00\"\r\n\
        05/10/2026,RICKSHAW,100.00,,\"49,350.00\"\r\n\
        25/10/2026,SALARY OCT ACME LTD,,\"85,000.00\",\"134,350.00\"\r\n\
        ,Total,650.00,\"85,000.00\",\r\n";

    fn write(dir: &Path, name: &str, text: &str) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, text).unwrap();
        p
    }

    #[test]
    fn money_cells() {
        assert_eq!(read_money("1,250.00", "BDT", false), Some((125_000, 0)));
        assert_eq!(read_money("(1,250.00)", "BDT", false), Some((125_000, -1)));
        assert_eq!(read_money("1,250.00 Dr", "BDT", false), Some((125_000, -1)));
        assert_eq!(read_money("৳ 85,000 Cr", "BDT", false), Some((8_500_000, 1)));
        assert_eq!(read_money("-99.5", "BDT", false), Some((9_950, -1)));
        assert_eq!(read_money("1.250,50", "EUR", true), Some((125_050, 0)));
        assert_eq!(read_money("", "BDT", false), None);
        assert_eq!(read_money("Total", "BDT", false), None);
    }

    #[test]
    fn a_statement_is_mapped_and_read() {
        let conn = fresh();
        let dir = std::env::temp_dir().join(format!("corepro-import-{}", std::process::id()));
        let path = write(&dir, "city.csv", STATEMENT);
        let bank = add_account(&conn, "City Bank", "bank", "BDT", None);
        let p = preview(&conn, &path, None, &bank, None).unwrap();
        assert_eq!(p.mapping.header_row, 3);
        assert_eq!((p.mapping.date, p.mapping.description, p.mapping.debit, p.mapping.credit, p.mapping.amount), (0, Some(1), Some(2), Some(3), None));
        assert_eq!(p.mapping.date_order, "dmy");
        // The opening balance and the total have no amount or no date.
        assert_eq!((p.new_count, p.errors, p.duplicates), (4, 2, 0));
        let salary = p.rows.iter().find(|r| r.payee.starts_with("SALARY")).unwrap();
        assert_eq!((salary.date.as_deref(), salary.amount_minor), (Some("2026-10-25"), Some(8_500_000)));
        assert_eq!(salary.category_id, Some(cat(&conn, "Salary")));
        let food = p.rows.iter().find(|r| r.payee.starts_with("FOODPANDA")).unwrap();
        assert_eq!((food.amount_minor, food.category_id.clone()), (Some(-45_000), Some(cat(&conn, "Eating out"))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn importing_twice_adds_nothing_and_undo_takes_the_batch() {
        let mut conn = fresh();
        let dir = std::env::temp_dir().join(format!("corepro-import2-{}", std::process::id()));
        let path = write(&dir, "city.csv", STATEMENT);
        let bank = add_account(&conn, "City Bank", "bank", "BDT", None);
        // A rule renames the payee and picks the category.
        save_rule(&conn, Rule { id: None, pattern: "FOODPANDA".into(), category_id: Some(cat(&conn, "Groceries")), payee: "Foodpanda".into() }, 1).unwrap();
        let mapping = preview(&conn, &path, None, &bank, None).unwrap().mapping;
        // One rickshaw ride left out by hand.
        let rickshaw = preview(&conn, &path, None, &bank, Some(mapping.clone())).unwrap().rows.into_iter().find(|r| r.payee == "RICKSHAW").unwrap().line;
        let b = commit(&mut conn, &path, None, &bank, &mapping, &[RowEdit { line: rickshaw, include: false, category_id: None, payee: None }], 2).unwrap();
        assert_eq!((b.added, b.skipped, b.remaining), (3, 1, 3));
        let food = db::list(&conn, &db::Filter { search: Some("foodpanda".into()), ..Default::default() }).unwrap().items.remove(0);
        assert_eq!((food.payee.as_str(), food.category_id.clone()), ("Foodpanda", Some(cat(&conn, "Groceries"))));
        assert_eq!(db::accounts(&conn).unwrap().iter().find(|a| a.id == bank).unwrap().balance_minor, 8_500_000 - 45_000 - 10_000);
        // The same file again: only the ride left out last time is new.
        let again = preview(&conn, &path, None, &bank, Some(mapping.clone())).unwrap();
        assert_eq!((again.new_count, again.duplicates), (1, 3));
        let second = commit(&mut conn, &path, None, &bank, &mapping, &[], 3).unwrap();
        assert_eq!(second.added, 1);
        assert!(commit(&mut conn, &path, None, &bank, &mapping, &[], 4).is_err());
        // Undo removes the first batch only.
        assert_eq!(undo(&mut conn, &b.id).unwrap(), 3);
        assert!(undo(&mut conn, &b.id).is_err());
        assert_eq!(db::list(&conn, &db::Filter { account_id: Some(bank.clone()), ..Default::default() }).unwrap().total, 1);
        let listed = batches(&conn).unwrap();
        assert_eq!(listed.iter().map(|b| (b.undone, b.remaining)).collect::<Vec<_>>(), [(false, 1), (true, 0)]);
        // A profile keeps the mapping.
        save_profile(&conn, "City Bank CSV", Some(&bank), &mapping, 5).unwrap();
        save_profile(&conn, "city bank csv", Some(&bank), &mapping, 6).unwrap();
        assert_eq!(profiles(&conn).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_signed_column_and_old_encodings() {
        let conn = fresh();
        let dir = std::env::temp_dir().join(format!("corepro-import3-{}", std::process::id()));
        let mut bytes = b"Date;Payee;Amount\n2026-10-03;Caf\xe9 Mocha;-4,50\n2026-10-04;Refund;12,00\n".to_vec();
        bytes.extend_from_slice(b"");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("eur.csv");
        std::fs::write(&path, &bytes).unwrap();
        let eur = add_account(&conn, "Wise EUR", "bank", "EUR", Some("130"));
        let p = preview(&conn, &path, None, &eur, None).unwrap();
        assert!(p.mapping.decimal_comma);
        assert_eq!(p.rows[0].payee, "Café Mocha");
        assert_eq!(p.rows.iter().map(|r| r.amount_minor).collect::<Vec<_>>(), [Some(-450), Some(1_200)]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
