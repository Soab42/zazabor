//! A table of text cells with known columns → a statement: transactions with dates and amounts,
//! wrapped descriptions joined, opening and closing balances, then the balance check.

use serde::{Deserialize, Serialize};

use super::parse::{self, BalanceLine, Role};

/// A statement as read: from a file the page or Rust read, or from Claude. Amounts are in minor
/// units (poisha). The account number is never kept, only its last four digits.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Statement {
    /// "csv", "xlsx", "pdf" (its text), or "ai" (Claude read it).
    pub source: String,
    /// The file's name.
    pub file: String,
    pub bank: Option<String>,
    pub account_last4: Option<String>,
    pub currency: String,
    pub period_from: Option<String>,
    pub period_to: Option<String>,
    pub opening: Option<i64>,
    pub closing: Option<i64>,
    pub rows: Vec<Row>,
    /// Things worth knowing about the reading ("3 lines weren't transactions").
    pub warnings: Vec<String>,
    pub check: Check,
    /// "good", "partial" (some lines unread) or "none" (no table found).
    pub confidence: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    /// "YYYY-MM-DD".
    pub date: String,
    pub description: String,
    pub reference: Option<String>,
    /// Money out and money in (one of them), unsigned.
    pub debit: Option<i64>,
    pub credit: Option<i64>,
    /// The running balance the statement prints on this row.
    pub balance: Option<i64>,
    /// Why this row needs a look (its balance doesn't follow, its direction was guessed…).
    pub flag: Option<String>,
}

impl Row {
    /// Money in minus money out.
    pub fn net(&self) -> i64 {
        self.credit.unwrap_or(0) - self.debit.unwrap_or(0)
    }
}

/// How the statement's own numbers agree with each other.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// "ok" (everything agrees), "mismatch", or "unchecked" (no balances to check with).
    pub status: String,
    /// Rows whose running balance doesn't follow from the row before.
    pub breaks: usize,
    pub credits: i64,
    pub debits: i64,
    /// Opening + credits − debits.
    pub expected_closing: Option<i64>,
    /// Closing balance − expected closing.
    pub difference: Option<i64>,
    /// The opening balance wasn't printed; it was worked out from the first row's balance.
    pub derived_opening: bool,
    pub message: String,
}

/// Lines of a table split into columns, with what each column holds.
pub struct Grid {
    pub roles: Vec<Option<Role>>,
    /// Each line's cells, with its page and baseline and height when it came from a PDF (wrapped
    /// text sits close under its row; a footer doesn't).
    pub lines: Vec<(Option<(u32, f64, f64)>, Vec<String>)>,
    /// Every line outside the table, as text (bank, account, period, balances).
    pub around: Vec<String>,
}

fn first(cells: &[String], roles: &[Option<Role>], role: Role) -> String {
    roles.iter().zip(cells).find(|(r, c)| **r == Some(role) && !c.trim().is_empty()).map(|(_, c)| c.trim().to_string()).unwrap_or_default()
}

fn all(cells: &[String], roles: &[Option<Role>], role: Role) -> String {
    roles.iter().zip(cells).filter(|(r, c)| **r == Some(role) && !c.trim().is_empty()).map(|(_, c)| c.trim()).collect::<Vec<_>>().join(" ")
}

/// Signed minor units of a cell, or None.
fn signed(text: &str, currency: &str) -> Option<(i64, i32)> {
    parse::money(text, currency)
}

pub fn build(grid: &Grid, currency: &str, source: &str, file: &str) -> Statement {
    let roles = &grid.roles;
    let has = |r: Role| roles.contains(&Some(r));
    let order = parse::date_order(grid.lines.iter().map(|(_, c)| first(c, roles, Role::Date)).collect::<Vec<_>>().iter().map(|s| s.as_str()));
    let mut st = Statement { source: source.into(), file: file.into(), currency: currency.into(), ..Default::default() };
    st.bank = parse::bank(&grid.around);
    st.account_last4 = parse::account_last4(&grid.around);
    if let Some((a, b)) = parse::period(&grid.around, order) {
        st.period_from = Some(a);
        st.period_to = Some(b);
    }
    // Balances named outside the table ("Opening Balance: 50,000.00").
    for line in &grid.around {
        match parse::balance_line(line) {
            Some(BalanceLine::Opening) if st.opening.is_none() => st.opening = parse::last_money(&line.split(" | ").map(str::to_string).collect::<Vec<_>>(), currency),
            Some(BalanceLine::Closing) if st.closing.is_none() => st.closing = parse::last_money(&line.split(" | ").map(str::to_string).collect::<Vec<_>>(), currency),
            _ => {}
        }
    }
    let mut unread = 0usize;
    let mut guessed: Vec<usize> = Vec::new();
    let mut last_place: Option<(u32, f64, f64)> = None;
    for (place, cells) in &grid.lines {
        let joined = cells.iter().filter(|c| !c.trim().is_empty()).cloned().collect::<Vec<_>>().join(" ");
        if joined.trim().is_empty() {
            continue;
        }
        let date_text = first(cells, roles, Role::Date);
        let description = all(cells, roles, Role::Description);
        let reference = all(cells, roles, Role::Reference);
        let kind = all(cells, roles, Role::Kind);
        let debit = signed(&first(cells, roles, Role::Debit), currency);
        let credit = signed(&first(cells, roles, Role::Credit), currency);
        let amount = signed(&first(cells, roles, Role::Amount), currency);
        let balance = signed(&first(cells, roles, Role::Balance), currency).map(|(m, s)| if s < 0 { -m } else { m });
        let date = parse::date(&date_text, order);
        // Opening, closing and total lines aren't transactions.
        if date.is_none() || has(Role::Description) {
            if let Some(kind) = parse::balance_line(if description.is_empty() { &joined } else { &description }).or_else(|| if date.is_none() { parse::balance_line(&joined) } else { None }) {
                let value = balance.or_else(|| amount.or(credit).or(debit).map(|(m, s)| if s < 0 { -m } else { m }));
                match kind {
                    BalanceLine::Opening => {
                        if value.is_some() {
                            st.opening = value;
                        }
                    }
                    BalanceLine::Closing => {
                        if value.is_some() {
                            st.closing = value;
                        }
                    }
                    BalanceLine::Total => {}
                }
                last_place = None;
                continue;
            }
        }
        let has_money = debit.is_some() || credit.is_some() || amount.is_some();
        let near_last = match (place, last_place) {
            (Some((page, y, h)), Some((lp, ly, lh))) => *page == lp && (y - ly) <= 2.6 * h.max(lh) && y >= &ly,
            (None, _) => true,
            _ => false,
        };
        if date.is_none() && !has_money {
            // Wrapped text under the row above.
            if let Some(row) = st.rows.last_mut() {
                if near_last {
                    let extra = [description.as_str(), reference.as_str()].iter().filter(|t| !t.is_empty()).cloned().collect::<Vec<_>>().join(" ");
                    let extra = if extra.is_empty() { joined.clone() } else { extra };
                    if !extra.is_empty() {
                        row.description = format!("{} {}", row.description, extra).trim().to_string();
                    }
                    if let Some(p) = place {
                        last_place = Some(*p);
                    }
                    continue;
                }
            }
            if !st.rows.is_empty() {
                unread += 1;
            }
            continue;
        }
        let date = match date {
            Some(d) => d,
            // Some statements print the date once for the day's rows.
            None => match st.rows.last() {
                Some(prev) => prev.date.clone(),
                None => {
                    unread += 1;
                    continue;
                }
            },
        };
        let mut row = Row { date, description: description.clone(), reference: (!reference.is_empty()).then_some(reference), balance, ..Default::default() };
        if debit.is_some() || credit.is_some() {
            let d = debit.map(|(m, _)| m).filter(|m| *m != 0);
            let c = credit.map(|(m, _)| m).filter(|m| *m != 0);
            row.debit = d;
            row.credit = c;
        } else if let Some((m, sign)) = amount {
            let way = if sign != 0 { sign } else { parse::direction(&kind) };
            match way {
                w if w < 0 => row.debit = Some(m),
                w if w > 0 => row.credit = Some(m),
                _ => {
                    row.debit = Some(m);
                    guessed.push(st.rows.len());
                }
            }
        }
        if row.debit.is_none() && row.credit.is_none() {
            if row.balance.is_some() && row.description.is_empty() {
                continue;
            }
            row.flag = Some("No amount on this row".into());
        }
        if row.description.is_empty() && !kind.is_empty() {
            row.description = kind.clone();
        } else if !kind.is_empty() && !row.description.to_lowercase().contains(&kind.to_lowercase()) && has(Role::Description) && kind.len() < 30 {
            row.description = format!("{kind}: {}", row.description);
        }
        st.rows.push(row);
        if let Some(p) = place {
            last_place = Some(*p);
        }
    }
    // Newest first: turned around so the balance runs forward.
    if st.rows.len() >= 2 && st.rows.first().map(|r| &r.date) > st.rows.last().map(|r| &r.date) {
        st.rows.reverse();
        let n = st.rows.len();
        guessed = guessed.into_iter().map(|i| n - 1 - i).collect();
    }
    resolve_directions(&mut st, &guessed);
    if unread > 0 {
        st.warnings.push(format!("{unread} line{} in the table weren't transactions and were left out.", if unread == 1 { "" } else { "s" }));
    }
    st.confidence = if st.rows.is_empty() {
        "none".into()
    } else if unread * 5 > st.rows.len() {
        "partial".into()
    } else {
        "good".into()
    };
    check(&mut st);
    st
}

/// Rows whose direction wasn't printed: the running balance tells which way the money went.
fn resolve_directions(st: &mut Statement, guessed: &[usize]) {
    for &i in guessed {
        let prev = if i == 0 { st.opening } else { st.rows[i - 1].balance };
        let row = &mut st.rows[i];
        let (Some(p), Some(b), Some(m)) = (prev, row.balance, row.debit.or(row.credit)) else {
            row.flag = Some("The statement doesn't say which way this went; taken as money out".into());
            continue;
        };
        if b - p == m {
            row.debit = None;
            row.credit = Some(m);
        } else if p - b == m {
            row.credit = None;
            row.debit = Some(m);
        } else {
            row.flag = Some("The statement doesn't say which way this went; taken as money out".into());
        }
    }
}

/// Lakh-grouped taka for messages: "1,25,000.50".
pub fn show(minor: i64, currency: &str) -> String {
    let exp = crate::wallet::money::exponent(currency);
    let unit = 10i64.pow(exp);
    let sign = if minor < 0 { "−" } else { "" };
    let whole = (minor.abs() / unit).to_string();
    let frac = if exp > 0 { format!(".{:0width$}", minor.abs() % unit, width = exp as usize) } else { String::new() };
    let grouped = if currency == "BDT" && whole.len() > 3 {
        let (head, tail) = whole.split_at(whole.len() - 3);
        let mut parts: Vec<String> = Vec::new();
        let mut h = head.to_string();
        while h.len() > 2 {
            parts.insert(0, h[h.len() - 2..].to_string());
            h.truncate(h.len() - 2);
        }
        if !h.is_empty() {
            parts.insert(0, h);
        }
        format!("{},{tail}", parts.join(","))
    } else {
        let mut out = String::new();
        for (i, c) in whole.chars().enumerate() {
            if i > 0 && (whole.len() - i) % 3 == 0 {
                out.push(',');
            }
            out.push(c);
        }
        out
    };
    let symbol = if currency == "BDT" { "৳" } else { "" };
    format!("{sign}{symbol}{grouped}{frac}")
}

/// Checks the statement against itself: every running balance follows from the row before, and
/// opening + money in − money out = closing. Rows that break it are flagged; no number is changed.
pub fn check(st: &mut Statement) {
    let mut c = Check { status: "unchecked".into(), ..Default::default() };
    c.credits = st.rows.iter().filter_map(|r| r.credit).sum();
    c.debits = st.rows.iter().filter_map(|r| r.debit).sum();
    // An opening balance worked out from the first row's.
    if st.opening.is_none() {
        if let Some(first) = st.rows.first() {
            if let Some(b) = first.balance {
                st.opening = Some(b - first.net());
                c.derived_opening = true;
            }
        }
    }
    let mut prev = st.opening;
    let mut checked = 0;
    for row in &mut st.rows {
        if let Some(b) = row.balance {
            if let Some(p) = prev {
                checked += 1;
                let expected = p + row.net();
                if expected != b {
                    c.breaks += 1;
                    row.flag = Some(format!("The balance should be {} after this row; the statement says {}", show(expected, &st.currency), show(b, &st.currency)));
                }
            }
            prev = Some(b);
        } else if let Some(p) = prev {
            prev = Some(p + row.net());
        }
    }
    if st.closing.is_none() {
        st.closing = st.rows.iter().rev().find_map(|r| r.balance);
    }
    if let (Some(o), Some(cl)) = (st.opening, st.closing) {
        let expected = o + c.credits - c.debits;
        c.expected_closing = Some(expected);
        c.difference = Some(cl - expected);
    }
    let totals_ok = c.difference.map(|d| d == 0);
    c.status = match (totals_ok, checked) {
        (Some(true), _) if c.breaks == 0 => "ok",
        (None, n) if n > 0 && c.breaks == 0 => "ok",
        (None, 0) => "unchecked",
        _ => "mismatch",
    }
    .into();
    let cur = st.currency.clone();
    let n = st.rows.len();
    c.message = match c.status.as_str() {
        "ok" => match (st.opening, c.expected_closing) {
            (Some(o), Some(e)) => format!(
                "Checked: {} + {} in − {} out = {}, as the statement says.{}",
                show(o, &cur),
                show(c.credits, &cur),
                show(c.debits, &cur),
                show(e, &cur),
                if c.derived_opening { " (The opening balance was worked out from the first row.)" } else { "" }
            ),
            _ => format!("Checked: every running balance follows from the row before ({n} rows)."),
        },
        "mismatch" => {
            let mut parts = Vec::new();
            if c.breaks > 0 {
                parts.push(format!("{} row{} don't follow the running balance", c.breaks, if c.breaks == 1 { "" } else { "s" }));
            }
            if let Some(d) = c.difference.filter(|d| *d != 0) {
                parts.push(format!("the totals are off by {}", show(d, &cur)));
            }
            format!("Doesn't add up: {}. Look at the flagged rows before importing; nothing was changed.", parts.join(", and "))
        }
        _ => "There are no balances in this statement to check the rows against.".into(),
    };
    st.check = c;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(date: &str, debit: Option<i64>, credit: Option<i64>, balance: Option<i64>) -> Row {
        Row { date: date.into(), description: "x".into(), debit, credit, balance, ..Default::default() }
    }

    #[test]
    fn the_balance_check_flags_what_doesnt_follow() {
        let mut st = Statement { currency: "BDT".into(), opening: Some(5_000_000), ..Default::default() };
        st.rows = vec![row("2026-10-05", Some(45_000), None, Some(4_955_000)), row("2026-10-06", Some(100_000), None, Some(4_855_000)), row("2026-10-25", None, Some(8_500_000), Some(13_355_000))];
        check(&mut st);
        assert_eq!(st.check.status, "ok");
        assert_eq!(st.closing, Some(13_355_000));
        assert_eq!((st.check.credits, st.check.debits, st.check.difference), (8_500_000, 145_000, Some(0)));
        assert!(st.check.message.starts_with("Checked: ৳50,000.00 + ৳85,000.00 in"), "{}", st.check.message);
        // A misread amount: the row and the totals both say so, and nothing is "fixed".
        st.rows[1].debit = Some(10_000);
        st.closing = Some(13_355_000);
        check(&mut st);
        assert_eq!(st.check.status, "mismatch");
        assert_eq!(st.check.breaks, 1);
        assert!(st.rows[1].flag.as_deref().unwrap().contains("৳48,550.00"));
        assert_eq!(st.rows[1].debit, Some(10_000));
        assert_eq!(st.check.difference, Some(-90_000));
        // No opening balance printed: worked out from the first row.
        let mut st = Statement { currency: "BDT".into(), ..Default::default() };
        st.rows = vec![row("2026-10-05", Some(45_000), None, Some(4_955_000))];
        check(&mut st);
        assert!(st.check.derived_opening);
        assert_eq!(st.opening, Some(5_000_000));
        // No balances anywhere.
        let mut st = Statement { currency: "BDT".into(), ..Default::default() };
        st.rows = vec![row("2026-10-05", Some(45_000), None, None)];
        check(&mut st);
        assert_eq!(st.check.status, "unchecked");
    }

    #[test]
    fn lakh_grouping() {
        assert_eq!(show(12_500_050, "BDT"), "৳1,25,000.50");
        assert_eq!(show(-45_000, "BDT"), "−৳450.00");
        assert_eq!(show(123_456_789, "USD"), "1,234,567.89");
    }

    #[test]
    fn a_wallet_statement_with_one_amount_column() {
        // bKash: one amount, the type in words, newest first.
        let roles = vec![Some(Role::Date), Some(Role::Reference), Some(Role::Kind), Some(Role::Description), Some(Role::Amount), Some(Role::Balance)];
        let line = |cells: [&str; 6]| (None, cells.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        let grid = Grid {
            roles,
            lines: vec![
                line(["26/10/2026 09:12", "BJQ81X", "Payment", "Shwapno", "1,250.00", "8,750.00"]),
                line(["20/10/2026 18:40", "BJK22A", "Cash In", "Agent 017xx", "5,000.00", "10,000.00"]),
                line(["15/10/2026 11:03", "BJF10C", "Transfer", "To 018xx", "500.00", "5,000.00"]),
            ],
            around: vec!["bKash Statement".into(), "Account: 01712-345678".into(), "Opening Balance: 5,500.00".into()],
        };
        let st = build(&grid, "BDT", "pdf", "bkash.pdf");
        assert_eq!(st.bank.as_deref(), Some("bKash"));
        assert_eq!(st.account_last4.as_deref(), Some("5678"));
        assert_eq!(st.rows.iter().map(|r| r.date.as_str()).collect::<Vec<_>>(), ["2026-10-15", "2026-10-20", "2026-10-26"]);
        // "Transfer" says nothing; the balance going down says money out.
        assert_eq!((st.rows[0].debit, st.rows[0].credit, st.rows[0].flag.clone()), (Some(50_000), None, None));
        assert_eq!(st.rows[1].credit, Some(500_000));
        assert_eq!(st.rows[2].debit, Some(125_000));
        assert_eq!(st.rows[2].description, "Payment: Shwapno");
        assert_eq!(st.check.status, "ok", "{}", st.check.message);
    }
}
