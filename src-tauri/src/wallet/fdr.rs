//! FDRs (fixed deposits): an account holding one deposit for a term at a yearly rate, paying its
//! interest each month, quarter, half-year, year or at maturity, with the source tax the bank
//! keeps. The interest goes to an account you pick (each payment as income in "Interest", the tax
//! as spending in "Tax"), or stays in the FDR, where it earns interest too. Paying by itself, each
//! payment posts on its day and catches up on the days Zazabor was closed.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::dates;
use super::db::{self, db_err, valid_date, Result};
use super::money;
use super::plans::{write_part, Part};
use crate::notes::new_id;

pub const PAYOUTS: [&str; 5] = ["monthly", "quarterly", "halfyearly", "yearly", "maturity"];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fdr {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub color: String,
    pub currency: String,
    pub principal_minor: i64,
    pub rate_bp: i64,
    pub months: i64,
    pub start_date: String,
    /// One of `PAYOUTS`.
    pub payout: String,
    /// The source tax on its interest, in hundredths of a percent (1000 is 10%).
    pub tax_bp: i64,
    /// Where the interest goes; none: it stays in the FDR.
    pub interest_to: Option<String>,
    /// The account the deposit came from, when that's in Wallet.
    pub funded_from: Option<String>,
    pub auto_post: bool,
    pub in_total: bool,
    pub maturity_date: String,
    /// At maturity: the deposit and, when it stays in, the interest after tax.
    pub maturity_value_minor: i64,
    pub interest_minor: i64,
    pub tax_minor: i64,
    /// Interest after tax, over the whole term.
    pub net_minor: i64,
    /// Interest after tax received so far.
    pub received_minor: i64,
    pub payments: i64,
    pub posted: i64,
    pub next_date: Option<String>,
    /// The next interest payment after tax.
    pub next_net_minor: Option<i64>,
    pub overdue: i64,
    pub matured: bool,
    pub balance_minor: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FdrRow {
    pub no: i64,
    pub date: String,
    pub interest_minor: i64,
    pub tax_minor: i64,
    pub net_minor: i64,
    /// The FDR's value after it.
    pub value_minor: i64,
    /// "posted", "due" or "upcoming".
    pub kind: String,
    pub posted_on: Option<String>,
    pub transfer_id: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FdrDetail {
    pub fdr: Fdr,
    pub rows: Vec<FdrRow>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FdrInput {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub color: String,
    pub currency: Option<String>,
    /// As typed.
    pub amount: String,
    /// Percent a year, as typed.
    pub rate: String,
    pub months: i64,
    pub start_date: String,
    pub payout: String,
    /// Percent, as typed ("10").
    #[serde(default)]
    pub tax: String,
    pub interest_to: Option<String>,
    pub funded_from: Option<String>,
    #[serde(default = "yes")]
    pub auto_post: bool,
    pub in_total: Option<bool>,
    #[serde(default)]
    pub details: Option<db::AccountDetails>,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug)]
struct Stored {
    id: String,
    account_id: String,
    principal: i64,
    rate_bp: i64,
    months: i64,
    start_date: String,
    payout: String,
    tax_bp: i64,
    interest_to: Option<String>,
    funded_from: Option<String>,
    funded_transfer: Option<String>,
    auto_post: bool,
    next_no: i64,
}

const SELECT: &str = "SELECT id, account_id, principal_minor, rate_bp, months, start_date, payout, tax_bp, interest_to, funded_from, funded_transfer, auto_post, next_no FROM fdrs";

fn stored_row(r: &Row) -> rusqlite::Result<Stored> {
    Ok(Stored {
        id: r.get(0)?,
        account_id: r.get(1)?,
        principal: r.get(2)?,
        rate_bp: r.get(3)?,
        months: r.get(4)?,
        start_date: r.get(5)?,
        payout: r.get(6)?,
        tax_bp: r.get(7)?,
        interest_to: r.get(8)?,
        funded_from: r.get(9)?,
        funded_transfer: r.get(10)?,
        auto_post: r.get(11)?,
        next_no: r.get(12)?,
    })
}

fn stored(conn: &Connection, id: &str) -> Result<Stored> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], stored_row).optional().map_err(db_err)?.ok_or_else(|| "That FDR no longer exists.".into())
}

fn all_stored(conn: &Connection) -> Result<Vec<Stored>> {
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY created")).map_err(db_err)?;
    let rows = stmt.query_map([], stored_row).map_err(db_err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db_err)
}

fn period(payout: &str, months: i64) -> i64 {
    match payout {
        "monthly" => 1,
        "quarterly" => 3,
        "halfyearly" => 6,
        "yearly" => 12,
        _ => months,
    }
}

/// The interest payments as agreed: (number, date, gross, tax, net, value after).
fn schedule(s: &Stored) -> Vec<(i64, String, i64, i64, i64, i64)> {
    let step = period(&s.payout, s.months).clamp(1, s.months.max(1));
    let day = dates::parts(&s.start_date).2;
    let mut ends: Vec<i64> = (1..).map(|k| k * step).take_while(|m| *m <= s.months).collect();
    if ends.last() != Some(&s.months) {
        ends.push(s.months);
    }
    let stays = s.interest_to.is_none();
    let mut value = s.principal;
    let mut last = 0;
    ends.iter()
        .enumerate()
        .map(|(i, end)| {
            let length = end - last;
            last = *end;
            let base = if stays { value } else { s.principal };
            let gross = (base as f64 * s.rate_bp as f64 / 10_000.0 * length as f64 / 12.0).round() as i64;
            let tax = (gross as f64 * s.tax_bp as f64 / 10_000.0).round() as i64;
            let net = gross - tax;
            if stays {
                value += net;
            }
            (i as i64 + 1, dates::in_month(&s.start_date, *end, day), gross, tax, net, value)
        })
        .collect()
}

/// Posted interest payments: number → (day, transfer).
fn posted(conn: &Connection, id: &str) -> Result<HashMap<i64, (String, String)>> {
    let mut stmt = conn
        .prepare("SELECT plan_no, date, transfer_id FROM transactions WHERE plan_id = ?1 AND plan_part = 'interest' AND plan_no IS NOT NULL")
        .map_err(db_err)?;
    let rows = stmt.query_map([id], |r| Ok((r.get::<_, i64>(0)?, (r.get(1)?, r.get(2)?)))).map_err(db_err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db_err)
}

fn build(conn: &Connection, s: &Stored, account: &db::Account, today: &str) -> Result<FdrDetail> {
    let done = posted(conn, &s.id)?;
    let rows: Vec<FdrRow> = schedule(s)
        .into_iter()
        .map(|(no, date, gross, tax, net, value)| {
            let p = done.get(&no);
            FdrRow {
                kind: if p.is_some() { "posted" } else if date.as_str() <= today { "due" } else { "upcoming" }.into(),
                no,
                date,
                interest_minor: gross,
                tax_minor: tax,
                net_minor: net,
                value_minor: value,
                posted_on: p.map(|p| p.0.clone()),
                transfer_id: p.map(|p| p.1.clone()),
            }
        })
        .collect();
    let maturity_date = dates::in_month(&s.start_date, s.months, dates::parts(&s.start_date).2);
    let next = rows.iter().find(|r| r.kind != "posted");
    let fdr = Fdr {
        id: s.id.clone(),
        account_id: s.account_id.clone(),
        name: account.name.clone(),
        color: account.color.clone(),
        currency: account.currency.clone(),
        principal_minor: s.principal,
        rate_bp: s.rate_bp,
        months: s.months,
        start_date: s.start_date.clone(),
        payout: s.payout.clone(),
        tax_bp: s.tax_bp,
        interest_to: s.interest_to.clone(),
        funded_from: s.funded_from.clone(),
        auto_post: s.auto_post,
        in_total: account.in_total,
        maturity_value_minor: rows.last().map_or(s.principal, |r| r.value_minor),
        maturity_date: maturity_date.clone(),
        interest_minor: rows.iter().map(|r| r.interest_minor).sum(),
        tax_minor: rows.iter().map(|r| r.tax_minor).sum(),
        net_minor: rows.iter().map(|r| r.net_minor).sum(),
        received_minor: rows.iter().filter(|r| r.kind == "posted").map(|r| r.net_minor).sum(),
        payments: rows.len() as i64,
        posted: rows.iter().filter(|r| r.kind == "posted").count() as i64,
        next_date: next.map(|r| r.date.clone()),
        next_net_minor: next.map(|r| r.net_minor),
        overdue: rows.iter().filter(|r| r.kind == "due").count() as i64,
        matured: maturity_date.as_str() <= today,
        balance_minor: account.balance_minor,
    };
    Ok(FdrDetail { fdr, rows })
}

/// Every FDR with its payments, in the order they were added.
pub fn list(conn: &Connection, today: &str) -> Result<Vec<FdrDetail>> {
    let accounts = db::accounts(conn)?;
    all_stored(conn)?
        .iter()
        .filter_map(|s| accounts.iter().find(|a| a.id == s.account_id).map(|a| (s, a)))
        .map(|(s, a)| build(conn, s, a, today))
        .collect()
}

pub fn detail(conn: &Connection, id: &str, today: &str) -> Result<FdrDetail> {
    let s = stored(conn, id)?;
    let account = db::accounts(conn)?.into_iter().find(|a| a.id == s.account_id).ok_or("That account no longer exists.")?;
    build(conn, &s, &account, today)
}

fn category(conn: &Connection, name: &str, kind: &str, icon: &str, color: &str, now: i64) -> Result<String> {
    let found: Option<String> = conn
        .query_row("SELECT id FROM categories WHERE kind = ?1 AND parent_id IS NULL AND lower(name) = lower(?2) LIMIT 1", params![kind, name], |r| r.get(0))
        .optional()
        .map_err(db_err)?;
    match found {
        Some(id) => Ok(id),
        None => Ok(db::save_category(conn, db::CategoryInput { id: None, parent_id: None, name: name.into(), kind: kind.into(), icon: icon.into(), color: color.into() }, now)?.id),
    }
}

/// Writes the deposit's arrival and the account's opening balance.
fn write_funding(conn: &Connection, s: &Stored, now: i64) -> Result<()> {
    let accounts = db::accounts(conn)?;
    let account = accounts.iter().find(|a| a.id == s.account_id).ok_or("That account no longer exists.")?;
    let from = s.funded_from.as_deref().and_then(|f| accounts.iter().find(|a| a.id == f));
    conn.execute("UPDATE accounts SET opening_minor = ?2 WHERE id = ?1", params![account.id, if from.is_some() { 0 } else { s.principal }]).map_err(db_err)?;
    if let Some(transfer) = &s.funded_transfer {
        let amount = if from.is_some() { s.principal } else { 0 };
        let note = format!("{} opened", account.name);
        write_part(conn, &s.id, Part { transfer, part: "fund-in", account, date: &s.start_date, amount, category: None, payee: "", note: &note, payment: None, no: None }, now)?;
        match from {
            Some(from) => write_part(conn, &s.id, Part { transfer, part: "fund-out", account: from, date: &s.start_date, amount: -amount, category: None, payee: "", note: &note, payment: None, no: None }, now)?,
            None => {
                conn.execute("DELETE FROM transactions WHERE transfer_id = ?1 AND plan_part = 'fund-out'", [transfer]).map_err(db_err)?;
            }
        }
    }
    Ok(())
}

fn percent(text: &str, what: &str) -> Result<i64> {
    let t = text.trim().trim_end_matches('%').trim();
    if t.is_empty() {
        return Ok(0);
    }
    let micro = money::parse_rate(t).ok_or_else(|| format!("Type the {what} as a percent, like 9.5."))?;
    if micro % 10_000 != 0 || micro > 100 * money::RATE_ONE {
        return Err(format!("Type the {what} as a percent, like 9.5 (up to two decimals)."));
    }
    Ok(micro / 10_000)
}

/// Adds an FDR with its account, or changes one. Interest already posted stays as it was.
pub fn save(conn: &mut Connection, input: FdrInput, today: &str, now: i64) -> Result<FdrDetail> {
    let accounts = db::accounts(conn)?;
    let pick = |id: &Option<String>| -> Result<Option<db::Account>> {
        match id.as_deref().filter(|i| !i.is_empty()) {
            Some(i) => accounts.iter().find(|a| a.id == i).cloned().map(Some).ok_or_else(|| "That account no longer exists.".into()),
            None => Ok(None),
        }
    };
    let from = pick(&input.funded_from)?;
    let to = pick(&input.interest_to)?;
    let before = input.id.as_deref().map(|id| stored(conn, id)).transpose()?;
    let currency = from
        .as_ref()
        .map(|a| a.currency.clone())
        .or_else(|| before.as_ref().and_then(|b| accounts.iter().find(|a| a.id == b.account_id)).map(|a| a.currency.clone()))
        .or(input.currency.clone())
        .unwrap_or_else(|| money::BASE.into());
    for a in [&from, &to].into_iter().flatten() {
        if a.currency != currency || matches!(a.kind.as_str(), "dps" | "loan" | "fdr") {
            return Err("The deposit and its interest go between everyday accounts in the FDR's currency.".into());
        }
    }
    let principal = money::parse_amount(&input.amount, &currency).filter(|a| *a > 0).ok_or("Type the amount deposited, like 1,00,000.")?;
    let rate_bp = percent(&input.rate, "rate")?;
    let tax_bp = percent(&input.tax, "tax")?;
    if !(1..=600).contains(&input.months) {
        return Err("Type its term in months, 1 to 600.".into());
    }
    if !valid_date(&input.start_date) {
        return Err("Pick the day it was opened.".into());
    }
    let payout = if PAYOUTS.contains(&input.payout.as_str()) { input.payout.clone() } else { "maturity".into() };
    let tx = conn.transaction().map_err(db_err)?;
    let account_input = |id: Option<String>| db::AccountInput {
        id,
        name: input.name.clone(),
        kind: "fdr".into(),
        currency: currency.clone(),
        opening: String::new(),
        color: input.color.clone(),
        rate: None,
        in_total: input.in_total,
        credit_limit: None,
        statement_day: None,
        due_day: None,
        details: input.details.clone(),
    };
    let from_id = from.as_ref().map(|a| a.id.clone());
    let id = match &before {
        Some(b) => {
            db::save_account(&tx, account_input(Some(b.account_id.clone())), now)?;
            let transfer = b.funded_transfer.clone().or_else(|| from_id.as_ref().map(|_| new_id()));
            let schedule_same = b.months == input.months && b.start_date == input.start_date && b.payout == payout;
            tx.execute(
                "UPDATE fdrs SET principal_minor = ?2, rate_bp = ?3, months = ?4, start_date = ?5, payout = ?6, tax_bp = ?7, interest_to = ?8, funded_from = ?9,
                   funded_transfer = ?10, auto_post = ?11, next_no = CASE WHEN ?12 THEN next_no ELSE 1 END, updated = ?13 WHERE id = ?1",
                params![b.id, principal, rate_bp, input.months, input.start_date, payout, tax_bp, to.as_ref().map(|a| &a.id), from_id, transfer, input.auto_post, schedule_same, now],
            )
            .map_err(db_err)?;
            b.id.clone()
        }
        None => {
            let account = db::save_account(&tx, account_input(None), now)?;
            let id = new_id();
            tx.execute(
                "INSERT INTO fdrs (id, account_id, principal_minor, rate_bp, months, start_date, payout, tax_bp, interest_to, funded_from, funded_transfer, auto_post, next_no, created, updated)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?13)",
                params![id, account.id, principal, rate_bp, input.months, input.start_date, payout, tax_bp, to.as_ref().map(|a| &a.id), from_id, from_id.as_ref().map(|_| new_id()), input.auto_post, now],
            )
            .map_err(db_err)?;
            id
        }
    };
    write_funding(&tx, &stored(&tx, &id)?, now)?;
    tx.commit().map_err(db_err)?;
    detail(conn, &id, today)
}

/// Writes one interest payment: the interest as income where it goes, the tax as spending there.
fn post_row(conn: &Connection, s: &Stored, row: &FdrRow, date: &str, now: i64) -> Result<()> {
    let accounts = db::accounts(conn)?;
    let account = accounts.iter().find(|a| a.id == s.account_id).ok_or("That account no longer exists.")?;
    let to = match &s.interest_to {
        Some(t) => accounts.iter().find(|a| &a.id == t).ok_or_else(|| format!("The account {}'s interest goes to no longer exists. Pick another.", account.name))?,
        None => account,
    };
    let transfer = super::sync::derived_id(&["fdr-interest", &s.id, &row.no.to_string()]);
    let note = format!("{} interest {}", account.name, row.no);
    let interest = category(conn, "Interest", "income", "piggy", "green", now)?;
    write_part(conn, &s.id, Part { transfer: &transfer, part: "interest", account: to, date, amount: row.interest_minor, category: Some(&interest), payee: &account.name, note: &note, payment: None, no: Some(row.no) }, now)?;
    if row.tax_minor > 0 {
        let tax = category(conn, "Tax", "expense", "receipt", "gray", now)?;
        write_part(conn, &s.id, Part { transfer: &transfer, part: "tax", account: to, date, amount: -row.tax_minor, category: Some(&tax), payee: &account.name, note: &format!("{note}: source tax"), payment: None, no: Some(row.no) }, now)?;
    }
    Ok(())
}

/// Posts the interest payments that came due on FDRs that post by themselves.
pub fn post_due(conn: &mut Connection, today: &str, now: i64) -> Result<usize> {
    let mut count = 0;
    for s in all_stored(conn)?.into_iter().filter(|s| s.auto_post) {
        let d = detail(conn, &s.id, today)?;
        let due: Vec<&FdrRow> = d.rows.iter().filter(|r| r.kind == "due" && r.no >= s.next_no).collect();
        let passed = d.rows.iter().filter(|r| r.date.as_str() <= today).map(|r| r.no).max();
        let tx = conn.transaction().map_err(db_err)?;
        for r in &due {
            post_row(&tx, &s, r, &r.date, now)?;
        }
        if let Some(next) = passed.map(|n| n + 1).filter(|n| *n > s.next_no) {
            tx.execute("UPDATE fdrs SET next_no = ?2 WHERE id = ?1", params![s.id, next]).map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        count += due.len();
    }
    Ok(count)
}

/// Marks interest payment `no` as received (on `date`, else its own date).
pub fn receive(conn: &mut Connection, id: &str, no: i64, date: Option<&str>, today: &str, now: i64) -> Result<FdrDetail> {
    let s = stored(conn, id)?;
    let d = detail(conn, id, today)?;
    let row = d.rows.iter().find(|r| r.no == no && r.kind != "posted").ok_or("That interest is already received.")?;
    let on = date.filter(|d| valid_date(d)).unwrap_or(&row.date).to_string();
    let tx = conn.transaction().map_err(db_err)?;
    post_row(&tx, &s, row, &on, now)?;
    tx.commit().map_err(db_err)?;
    detail(conn, id, today)
}

/// After transactions were deleted in Transactions: a deposit whose arrival went is no longer
/// from an account in Wallet.
pub fn after_delete(conn: &mut Connection, now: i64) -> Result<()> {
    let gone: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM fdrs WHERE funded_transfer IS NOT NULL AND funded_from IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.transfer_id = fdrs.funded_transfer)")
            .map_err(db_err)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(db_err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(db_err)?
    };
    for id in gone {
        conn.execute("UPDATE fdrs SET funded_from = NULL, funded_transfer = NULL WHERE id = ?1", [&id]).map_err(db_err)?;
        write_funding(conn, &stored(conn, &id)?, now)?;
    }
    Ok(())
}

/// Removes the FDR; what it posted stays as ordinary transactions, and its account with them.
pub fn delete(conn: &mut Connection, id: &str) -> Result<()> {
    let s = stored(conn, id)?;
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("UPDATE transactions SET plan_id = NULL, plan_no = NULL, plan_part = NULL WHERE plan_id = ?1", [id]).map_err(db_err)?;
    tx.execute("DELETE FROM fdrs WHERE id = ?1", [id]).map_err(db_err)?;
    let used: i64 = tx.query_row("SELECT COUNT(*) FROM transactions WHERE account_id = ?1", [&s.account_id], |r| r.get(0)).map_err(db_err)?;
    if used == 0 {
        tx.execute("DELETE FROM accounts WHERE id = ?1", [&s.account_id]).map_err(db_err)?;
    }
    tx.commit().map_err(db_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::db::tests::{add_account, fresh};

    fn input(bank: &str, payout: &str, to: Option<&str>) -> FdrInput {
        FdrInput {
            id: None, name: "City FDR".into(), color: "teal".into(), currency: None, amount: "1,00,000".into(), rate: "9".into(), months: 12,
            start_date: "2026-01-15".into(), payout: payout.into(), tax: "10".into(), interest_to: to.map(Into::into), funded_from: Some(bank.into()), auto_post: true, in_total: None, details: None,
        }
    }

    fn balance(conn: &Connection, id: &str) -> i64 {
        db::accounts(conn).unwrap().into_iter().find(|a| a.id == id).unwrap().balance_minor
    }

    #[test]
    fn quarterly_interest_posts_itself_after_tax() {
        let mut conn = fresh();
        let bank = add_account(&conn, "Bank", "bank", "BDT", None);
        let d = save(&mut conn, input(&bank, "quarterly", Some(&bank)), "2026-01-15", 1).unwrap();
        // 1,00,000 moved into the FDR; 9% a quarter is 2,250, less 10% tax: 2,025.
        assert_eq!((balance(&conn, &bank), balance(&conn, &d.fdr.account_id)), (-10_000_000, 10_000_000));
        assert_eq!(d.rows.iter().map(|r| (r.date.as_str(), r.interest_minor, r.net_minor)).collect::<Vec<_>>(),
            [("2026-04-15", 225_000, 202_500), ("2026-07-15", 225_000, 202_500), ("2026-10-15", 225_000, 202_500), ("2027-01-15", 225_000, 202_500)]);
        assert_eq!((d.fdr.maturity_value_minor, d.fdr.net_minor, d.fdr.tax_minor), (10_000_000, 810_000, 90_000));
        // Closed until 1 November: three payments came due.
        assert_eq!(post_due(&mut conn, "2026-11-01", 2).unwrap(), 3);
        assert_eq!(post_due(&mut conn, "2026-11-01", 3).unwrap(), 0);
        assert_eq!(balance(&conn, &bank), -10_000_000 + 3 * 202_500);
        let income = db::list(&conn, &db::Filter { kind: Some("income".into()), ..Default::default() }).unwrap();
        assert_eq!((income.income_minor, income.spending_minor), (3 * 225_000, 0));
        let after = detail(&conn, &d.fdr.id, "2026-11-01").unwrap();
        assert_eq!((after.fdr.posted, after.fdr.received_minor, after.fdr.next_date.as_deref()), (3, 3 * 202_500, Some("2027-01-15")));
    }

    #[test]
    fn interest_that_stays_earns_interest() {
        let mut conn = fresh();
        let bank = add_account(&conn, "Bank", "bank", "BDT", None);
        let mut i = input(&bank, "quarterly", None);
        i.funded_from = None;
        let d = save(&mut conn, i, "2026-01-15", 1).unwrap();
        // Opened before Wallet: the account starts with the deposit, and the bank is untouched.
        assert_eq!((balance(&conn, &bank), balance(&conn, &d.fdr.account_id)), (0, 10_000_000));
        assert_eq!(d.rows[1].interest_minor, 229_556);
        assert!(d.fdr.maturity_value_minor > 10_810_000);
        post_due(&mut conn, "2027-02-01", 2).unwrap();
        assert_eq!(balance(&conn, &d.fdr.account_id), d.fdr.maturity_value_minor);
    }

    #[test]
    fn at_maturity_and_by_hand() {
        let mut conn = fresh();
        let bank = add_account(&conn, "Bank", "bank", "BDT", None);
        let mut i = input(&bank, "maturity", Some(&bank));
        i.auto_post = false;
        let d = save(&mut conn, i, "2026-01-15", 1).unwrap();
        assert_eq!((d.rows.len(), d.rows[0].interest_minor, d.fdr.maturity_date.as_str()), (1, 900_000, "2027-01-15"));
        assert_eq!(post_due(&mut conn, "2027-02-01", 2).unwrap(), 0);
        let d = receive(&mut conn, &d.fdr.id, 1, Some("2027-01-17"), "2027-02-01", 3).unwrap();
        assert_eq!((d.rows[0].kind.as_str(), d.rows[0].posted_on.as_deref(), d.fdr.matured), ("posted", Some("2027-01-17"), true));
        // Its entries are changed here, not in Transactions.
        let t = db::list(&conn, &db::Filter { kind: Some("income".into()), ..Default::default() }).unwrap().items.remove(0);
        let err = db::save_tx(&conn, db::TxInput { id: Some(t.id), kind: "income".into(), account_id: bank, amount: "1".into(), date: "2027-01-17".into(), category_id: None, payee: "".into(), note: "".into() }, 4).unwrap_err();
        assert_eq!(err, db::PLAN_EDIT);
    }
}
