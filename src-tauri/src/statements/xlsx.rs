//! Statements and tables as Excel workbooks: typed dates and amounts (with the taka sign), a
//! summary sheet with the balance check, and rows that need a look shaded.

use std::path::Path;

use ironcalc::base::types::Color;
use ironcalc::base::Model;

use super::build::Statement;
use super::parse;
use crate::wallet::dates;

type Result<T> = std::result::Result<T, String>;

const FLAG_FILL: &str = "#FDE2E1";
const HEAD_FILL: &str = "#E8ECF2";

/// Days since 1899-12-30: how a spreadsheet counts dates.
fn serial(date: &str) -> Option<f64> {
    if !crate::wallet::dates::parse_loose(date, "ymd").is_some_and(|d| d == date) {
        return None;
    }
    let (y, m, d) = dates::parts(date);
    Some((dates::days_from_civil(y, m, d) - dates::days_from_civil(1899, 12, 30)) as f64)
}

fn money_format(currency: &str) -> String {
    match currency {
        "BDT" => "\"৳\"#,##0.00".into(),
        "USD" => "\"$\"#,##0.00".into(),
        "EUR" => "\"€\"#,##0.00".into(),
        "GBP" => "\"£\"#,##0.00".into(),
        "INR" => "\"₹\"#,##0.00".into(),
        _ => "#,##0.00".into(),
    }
}

/// Changes a cell's look.
fn style(model: &mut Model, sheet: u32, row: i32, column: i32, f: impl FnOnce(&mut ironcalc::base::types::Style)) -> Result<()> {
    let mut s = model.get_style_for_cell(sheet, row, column)?;
    f(&mut s);
    model.set_cell_style(sheet, row, column, &s)
}

/// Text that stays text (a leading "=" or digits would turn into a formula or a number).
fn text(model: &mut Model, sheet: u32, row: i32, column: i32, value: &str) -> Result<()> {
    if value.is_empty() {
        return Ok(());
    }
    let looks_like_value = value.starts_with('=') || value.starts_with('+') || value.starts_with('-') || value.parse::<f64>().is_ok();
    model.set_user_input(sheet, row, column, if looks_like_value { format!("'{value}") } else { value.to_string() })
}

fn number(model: &mut Model, sheet: u32, row: i32, column: i32, value: f64, format: &str) -> Result<()> {
    model.update_cell_with_number(sheet, row, column, value)?;
    style(model, sheet, row, column, |s| s.num_fmt = format.to_string())
}

fn minor(model: &mut Model, sheet: u32, row: i32, column: i32, value: Option<i64>, currency: &str) -> Result<()> {
    let Some(v) = value else { return Ok(()) };
    let unit = 10f64.powi(crate::wallet::money::exponent(currency) as i32);
    number(model, sheet, row, column, v as f64 / unit, &money_format(currency))
}

fn heading(model: &mut Model, sheet: u32, row: i32, names: &[&str]) -> Result<()> {
    for (i, name) in names.iter().enumerate() {
        let c = i as i32 + 1;
        model.set_user_input(sheet, row, c, (*name).to_string())?;
        style(model, sheet, row, c, |s| {
            s.font.b = true;
            s.fill.color = Color::Rgb(HEAD_FILL.into());
        })?;
    }
    Ok(())
}

fn save(model: &mut Model, path: &Path) -> Result<()> {
    model.evaluate();
    let bytes = ironcalc::export::save_xlsx_to_writer(model, std::io::Cursor::new(Vec::new())).map_err(|e| e.to_string())?.into_inner();
    crate::fs::text::write_bytes(path, &bytes).map(|_| ())
}

/// A statement: "Transactions" (one row each, flagged ones shaded, a note saying why) and
/// "Summary" (bank, account, period, balances and what the check found).
pub fn statement(st: &Statement, path: &Path) -> Result<()> {
    let mut model = Model::new_empty("Statement", "en", "UTC", "en")?;
    model.rename_sheet_by_index(0, "Transactions")?;
    let cur = st.currency.as_str();
    heading(&mut model, 0, 1, &["Date", "Description", "Reference", "Money out", "Money in", "Balance", "Note"])?;
    for (i, r) in st.rows.iter().enumerate() {
        let row = i as i32 + 2;
        match serial(&r.date) {
            Some(s) => number(&mut model, 0, row, 1, s, "dd/mm/yyyy")?,
            None => text(&mut model, 0, row, 1, &r.date)?,
        }
        text(&mut model, 0, row, 2, &r.description)?;
        text(&mut model, 0, row, 3, r.reference.as_deref().unwrap_or(""))?;
        minor(&mut model, 0, row, 4, r.debit, cur)?;
        minor(&mut model, 0, row, 5, r.credit, cur)?;
        minor(&mut model, 0, row, 6, r.balance, cur)?;
        if let Some(flag) = &r.flag {
            text(&mut model, 0, row, 7, flag)?;
            for c in 1..=7 {
                style(&mut model, 0, row, c, |s| s.fill.color = Color::Rgb(FLAG_FILL.into()))?;
            }
        }
    }
    // Totals under the money columns.
    let total_row = st.rows.len() as i32 + 3;
    if !st.rows.is_empty() {
        model.set_user_input(0, total_row, 3, "Total".into())?;
        style(&mut model, 0, total_row, 3, |s| s.font.b = true)?;
        for c in [4, 5] {
            let letter = if c == 4 { "D" } else { "E" };
            model.set_user_input(0, total_row, c, format!("=SUM({letter}2:{letter}{})", total_row - 2))?;
            style(&mut model, 0, total_row, c, |s| {
                s.num_fmt = money_format(cur);
                s.font.b = true;
            })?;
        }
    }
    for (c, width) in [12.0, 44.0, 16.0, 14.0, 14.0, 15.0, 40.0].iter().enumerate() {
        model.set_column_width(0, c as i32 + 1, width * 7.0)?;
    }
    model.set_frozen_rows(0, 1)?;

    model.add_sheet("Summary")?;
    let c = &st.check;
    let period = match (&st.period_from, &st.period_to) {
        (Some(a), Some(b)) => format!("{a} to {b}"),
        _ => String::new(),
    };
    let source = match st.source.as_str() {
        "ai" => "Read by Claude (AI) from the statement",
        "pdf" => "Read from the PDF's text",
        "xlsx" => "Read from the Excel file",
        _ => "Read from the CSV file",
    };
    let rows: Vec<(&str, Option<i64>, String)> = vec![
        ("File", None, st.file.clone()),
        ("Bank", None, st.bank.clone().unwrap_or_default()),
        ("Account", None, st.account_last4.as_ref().map(|l| format!("••••{l}")).unwrap_or_default()),
        ("Period", None, period),
        ("Currency", None, st.currency.clone()),
        ("Opening balance", st.opening, if c.derived_opening { "Worked out from the first row".into() } else { String::new() }),
        ("Money in", Some(c.credits), String::new()),
        ("Money out", Some(c.debits), String::new()),
        ("Expected closing balance", c.expected_closing, String::new()),
        ("Closing balance (statement)", st.closing, String::new()),
        ("Difference", c.difference, String::new()),
        ("Transactions", None, st.rows.len().to_string()),
        ("Check", None, c.message.clone()),
        ("Source", None, source.into()),
    ];
    for (i, (label, amount, note)) in rows.iter().enumerate() {
        let row = i as i32 + 1;
        model.set_user_input(1, row, 1, (*label).to_string())?;
        style(&mut model, 1, row, 1, |s| s.font.b = true)?;
        match amount {
            Some(v) => minor(&mut model, 1, row, 2, Some(*v), cur)?,
            None => text(&mut model, 1, row, 2, note)?,
        }
        if amount.is_some() && !note.is_empty() {
            text(&mut model, 1, row, 3, note)?;
        }
        if *label == "Check" && c.status == "mismatch" {
            style(&mut model, 1, row, 2, |s| s.fill.color = Color::Rgb(FLAG_FILL.into()))?;
        }
    }
    for (col, width) in [28.0, 70.0, 30.0].iter().enumerate() {
        model.set_column_width(1, col as i32 + 1, width * 7.0)?;
    }
    save(&mut model, path)
}

/// Tables found in a PDF: one sheet each ("Page 2", "Page 2 (2)"…), amounts as numbers.
pub fn tables(found: &[(u32, Vec<Vec<String>>)], path: &Path) -> Result<usize> {
    if found.is_empty() {
        return Err("No tables were found in this PDF.".into());
    }
    let mut model = Model::new_empty("Tables", "en", "UTC", "en")?;
    let mut names: Vec<String> = Vec::new();
    for (i, (page, grid)) in found.iter().enumerate().take(200) {
        let base = format!("Page {page}");
        let mut name = base.clone();
        let mut n = 2;
        while names.contains(&name) {
            name = format!("{base} ({n})");
            n += 1;
        }
        if i == 0 {
            model.rename_sheet_by_index(0, &name)?;
        } else {
            model.add_sheet(&name)?;
        }
        names.push(name);
        let sheet = i as u32;
        let mut widths: Vec<usize> = Vec::new();
        for (r, cells) in grid.iter().enumerate() {
            for (c, value) in cells.iter().enumerate() {
                let (row, col) = (r as i32 + 1, c as i32 + 1);
                match parse::money(value, "BDT").filter(|_| r > 0) {
                    Some((m, s)) => number(&mut model, sheet, row, col, (if s < 0 { -m } else { m }) as f64 / 100.0, "#,##0.00")?,
                    None => text(&mut model, sheet, row, col, value)?,
                }
                if r == 0 {
                    style(&mut model, sheet, row, col, |s| s.font.b = true)?;
                }
                if widths.len() <= c {
                    widths.resize(c + 1, 6);
                }
                widths[c] = widths[c].max(value.chars().count().min(60));
            }
        }
        for (c, w) in widths.iter().enumerate() {
            model.set_column_width(sheet, c as i32 + 1, (*w as f64 + 2.0) * 7.5)?;
        }
    }
    save(&mut model, path)?;
    Ok(found.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::statements::build::{check, Row};

    #[test]
    fn a_statement_reads_back_from_its_workbook() {
        let mut st = Statement { file: "city.pdf".into(), currency: "BDT".into(), opening: Some(5_000_000), bank: Some("The City Bank".into()), account_last4: Some("9012".into()), ..Default::default() };
        st.rows = vec![
            Row { date: "2026-10-05".into(), description: "FOODPANDA".into(), debit: Some(45_000), balance: Some(4_955_000), ..Default::default() },
            Row { date: "2026-10-25".into(), description: "=SALARY".into(), credit: Some(8_500_000), balance: Some(13_000_000), ..Default::default() },
        ];
        check(&mut st);
        assert_eq!(st.check.status, "mismatch");
        let dir = std::env::temp_dir().join(format!("zazabor-stmt-xlsx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.xlsx");
        statement(&st, &path).unwrap();
        let model = ironcalc::import::load_from_xlsx(&path.to_string_lossy(), "en", "UTC", "en").unwrap();
        assert_eq!(model.workbook.get_worksheet_names(), ["Transactions", "Summary"]);
        assert_eq!(model.get_formatted_cell_value(0, 2, 1).unwrap(), "05/10/2026");
        assert_eq!(model.get_formatted_cell_value(0, 3, 2).unwrap(), "=SALARY");
        assert!(model.get_formatted_cell_value(0, 2, 4).unwrap().contains("450.00"));
        assert!(model.get_formatted_cell_value(0, 3, 7).unwrap().contains("should be"));
        assert_eq!(model.get_style_for_cell(0, 3, 2).unwrap().fill.color, Color::Rgb(FLAG_FILL.into()));
        assert!(model.get_formatted_cell_value(1, 3, 2).unwrap().contains("9012"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
