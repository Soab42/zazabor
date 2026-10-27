//! The ledger out: CSV of any filtered list, an Excel workbook with a sheet per month, and a full
//! JSON copy of every table that other apps (or a later Zazabor) can read.

use rusqlite::{types::ValueRef, Connection};
use std::path::Path;

use super::db::{self, db_err, Filter, Result, Tx};
use super::money;

const HEAD: [&str; 9] = ["Date", "Account", "Kind", "Category", "Payee", "Note", "Amount", "Currency", "Amount (base)"];

/// Every transaction the filter matches, newest first.
fn all(conn: &Connection, filter: &Filter) -> Result<Vec<Tx>> {
    let mut out = Vec::new();
    loop {
        let page = db::list(conn, &Filter { limit: Some(1000), offset: Some(out.len() as i64), ..filter.clone() })?;
        let n = page.items.len();
        out.extend(page.items);
        if n < 1000 || out.len() as i64 >= page.total {
            return Ok(out);
        }
    }
}

/// An amount as a plain number in its currency: "-1250.50".
fn plain(minor: i64, code: &str) -> String {
    let exp = money::exponent(code);
    if exp == 0 {
        return minor.to_string();
    }
    let unit = 10i64.pow(exp);
    let sign = if minor < 0 { "-" } else { "" };
    format!("{sign}{}.{:0width$}", minor.abs() / unit, minor.abs() % unit, width = exp as usize)
}

/// The cells of one transaction, in `HEAD`'s order.
fn cells(t: &Tx, accounts: &[db::Account], categories: &[db::Category]) -> [String; 9] {
    let account = accounts.iter().find(|a| a.id == t.account_id).map(|a| a.name.clone()).unwrap_or_default();
    let category = match categories.iter().find(|c| Some(&c.id) == t.category_id.as_ref()) {
        Some(c) => match categories.iter().find(|p| Some(&p.id) == c.parent_id.as_ref()) {
            Some(p) => format!("{} › {}", p.name, c.name),
            None => c.name.clone(),
        },
        None => String::new(),
    };
    [t.date.clone(), account, t.kind.clone(), category, t.payee.clone(), t.note.clone(), plain(t.amount_minor, &t.currency), t.currency.clone(), plain(t.base_minor, money::BASE)]
}

/// CSV (as Excel reads it: UTF-8 with a byte-order mark, CRLF lines).
pub fn csv(conn: &Connection, filter: &Filter, path: &Path) -> Result<usize> {
    let txs = all(conn, filter)?;
    let (accounts, categories) = (db::accounts(conn)?, db::categories(conn)?);
    let mut out = String::from("\u{feff}");
    out.push_str(&HEAD.join(","));
    out.push_str("\r\n");
    for t in &txs {
        let row: Vec<String> = cells(t, &accounts, &categories).iter().map(|c| crate::office::quote_field(c, ',')).collect();
        out.push_str(&row.join(","));
        out.push_str("\r\n");
    }
    crate::fs::text::write_bytes(path, out.as_bytes())?;
    Ok(txs.len())
}

/// An .xlsx with one sheet per month, newest first.
pub fn xlsx(conn: &Connection, filter: &Filter, path: &Path) -> Result<usize> {
    let txs = all(conn, filter)?;
    let (accounts, categories) = (db::accounts(conn)?, db::categories(conn)?);
    let mut months: Vec<String> = txs.iter().map(|t| t.date[..7].to_string()).collect();
    months.dedup();
    if months.is_empty() {
        months.push("Transactions".into());
    }
    let mut model = ironcalc::base::Model::new_empty("Wallet", "en", "UTC", "en")?;
    for (i, month) in months.iter().enumerate() {
        if i == 0 {
            model.rename_sheet_by_index(0, month)?;
        } else {
            model.add_sheet(month)?;
        }
        let sheet = i as u32;
        for (c, h) in HEAD.iter().enumerate() {
            model.set_user_input(sheet, 1, c as i32 + 1, (*h).to_string())?;
        }
        let mut r = 2;
        for t in txs.iter().filter(|t| t.date.starts_with(month.as_str()) || month == "Transactions") {
            for (c, value) in cells(t, &accounts, &categories).into_iter().enumerate() {
                if value.is_empty() {
                    continue;
                }
                // Text that looks like a number or a formula stays text.
                let numeric = c == 6 || c == 8;
                let input = if !numeric && (value.starts_with('=') || value.parse::<f64>().is_ok()) { format!("'{value}") } else { value };
                model.set_user_input(sheet, r, c as i32 + 1, input)?;
            }
            r += 1;
        }
        for (c, width) in [12.0, 16.0, 9.0, 22.0, 26.0, 26.0, 12.0, 9.0, 14.0].iter().enumerate() {
            model.set_column_width(sheet, c as i32 + 1, width * 7.0)?;
        }
    }
    model.evaluate();
    let bytes = ironcalc::export::save_xlsx_to_writer(&model, std::io::Cursor::new(Vec::new())).map_err(|e| e.to_string())?.into_inner();
    crate::fs::text::write_bytes(path, &bytes)?;
    Ok(txs.len())
}

/// Every row of a table as JSON objects.
fn table(conn: &Connection, name: &str) -> Result<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM {name}")).map_err(db_err)?;
    let columns: Vec<String> = stmt.column_names().into_iter().map(str::to_string).collect();
    let mut rows = stmt.query([]).map_err(db_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(db_err)? {
        let mut object = serde_json::Map::new();
        for (i, column) in columns.iter().enumerate() {
            let value = match row.get_ref(i).map_err(db_err)? {
                ValueRef::Null => serde_json::Value::Null,
                ValueRef::Integer(v) => v.into(),
                ValueRef::Real(v) => v.into(),
                ValueRef::Text(t) => String::from_utf8_lossy(t).into(),
                ValueRef::Blob(_) => serde_json::Value::Null,
            };
            object.insert(column.clone(), value);
        }
        out.push(serde_json::Value::Object(object));
    }
    Ok(out)
}

/// The whole ledger: every table, amounts in minor units as stored.
pub fn json(conn: &Connection, path: &Path, now: i64) -> Result<usize> {
    let mut doc = serde_json::Map::new();
    doc.insert("format".into(), "zazabor-wallet".into());
    doc.insert("version".into(), 1.into());
    doc.insert("exported".into(), now.into());
    doc.insert("baseCurrency".into(), money::BASE.into());
    let mut count = 0;
    for name in ["accounts", "categories", "transactions", "budgets", "rates", "recurring", "rules", "import_profiles", "project_rates", "receipts"] {
        let rows = table(conn, name)?;
        if name == "transactions" {
            count = rows.len();
        }
        doc.insert(name.into(), rows.into());
    }
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(doc)).map_err(|e| e.to_string())?;
    crate::fs::text::write_bytes(path, text.as_bytes())?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::db::tests::{cat, fresh};

    #[test]
    fn exports_read_back() {
        let conn = fresh();
        let cash = db::accounts(&conn).unwrap()[0].id.clone();
        for (amount, date, payee) in [("250", "2026-10-26", "Kacchi Bhai"), ("1,000", "2026-09-02", "=SUM(A1)")] {
            db::save_tx(&conn, db::TxInput { id: None, kind: "expense".into(), account_id: cash.clone(), amount: amount.into(), date: date.into(), category_id: Some(cat(&conn, "Eating out")), payee: payee.into(), note: "".into() }, 1).unwrap();
        }
        let dir = std::env::temp_dir().join(format!("zazabor-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(csv(&conn, &Filter::default(), &dir.join("w.csv")).unwrap(), 2);
        let text = std::fs::read_to_string(dir.join("w.csv")).unwrap();
        assert!(text.contains("2026-10-26,Cash,expense,Food › Eating out,Kacchi Bhai,,-250.00,BDT,-250.00\r\n"));
        assert_eq!(xlsx(&conn, &Filter::default(), &dir.join("w.xlsx")).unwrap(), 2);
        let model = ironcalc::import::load_from_xlsx(&dir.join("w.xlsx").to_string_lossy(), "en", "UTC", "en").unwrap();
        assert_eq!(model.workbook.get_worksheet_names(), ["2026-10", "2026-09"]);
        assert_eq!(model.get_formatted_cell_value(0, 2, 5).unwrap(), "Kacchi Bhai");
        assert_eq!(model.get_formatted_cell_value(1, 2, 5).unwrap(), "=SUM(A1)");
        assert_eq!(json(&conn, &dir.join("w.json"), 3).unwrap(), 2);
        let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("w.json")).unwrap()).unwrap();
        assert_eq!(doc["transactions"].as_array().unwrap().len(), 2);
        let mut amounts: Vec<i64> = doc["transactions"].as_array().unwrap().iter().map(|t| t["amount_minor"].as_i64().unwrap()).collect();
        amounts.sort();
        assert_eq!(amounts, [-100_000, -25_000]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
