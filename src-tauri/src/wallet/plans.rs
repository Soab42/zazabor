//! DPS and loan accounts: an account with terms (an amount, a yearly rate, a number of monthly
//! installments) and the payments made on it. A DPS takes a deposit each month and grows to a
//! maturity value; a loan is paid back in installments, each paying the interest due first and
//! the rest off what's owed.
//!
//! The table is worked out from what was really paid, as a bank's statement is: payments in date
//! order, each on its own day and of its own amount. A loan's interest is charged by the day on
//! what's still owed ("daily", actual days over 365, as Bangladeshi banks do), or by the month
//! ("reducing"), or flat on the amount borrowed. A payment that doesn't cover the interest leaves
//! the rest as unpaid interest, paid first next time. A payment can pay one installment, several,
//! or be a part payment of none; the interest the bank charged can be typed to match its
//! statement. After the payments, the installments still to come are projected from what's owed.
//!
//! Each payment is a transfer from the account it's paid from (`plan_payments`, with the parts in
//! `transactions` marked `plan_part`): the principal into the loan account, the interest as
//! spending in "Loan interest". Any change (a payment's date or amount, the rate, the day the loan
//! arrived) works the whole table out again and rewrites those transactions in place.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};

use super::dates;
use super::db::{self, db_err, valid_date, Result};
use super::money;
use crate::notes::new_id;

/// The longest plan: 50 years.
const MAX_MONTHS: i64 = 600;
pub const METHODS: [&str; 3] = ["daily", "reducing", "flat"];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    /// "dps" or "loan".
    pub kind: String,
    pub account_id: String,
    pub name: String,
    pub color: String,
    pub currency: String,
    /// A DPS: the deposit each month. A loan: the amount borrowed.
    pub amount_minor: i64,
    /// The yearly rate in hundredths of a percent (1205 is 12.05%).
    pub rate_bp: i64,
    pub months: i64,
    /// The first installment's date; the rest fall on its day each month.
    pub start_date: String,
    /// A loan: one of `METHODS`.
    pub method: String,
    /// A loan's installment as the bank states it, when typed.
    pub payment_typed: Option<i64>,
    /// A DPS's maturity value as the bank states it, when typed.
    pub maturity_typed: Option<i64>,
    /// Installments paid before the account was added here (they post nothing).
    pub paid_before: i64,
    /// The account installments are paid from.
    pub pay_from: String,
    /// Posts each installment on its date by itself; otherwise it waits to be paid.
    pub auto_post: bool,
    /// A loan: the day the money was lent (interest runs from it).
    pub disburse_date: String,
    /// A loan: the account it arrived in, when that's in Wallet.
    pub disburse_to: Option<String>,
    /// The account counts in the total balance.
    pub in_total: bool,
    /// The usual installment (a DPS: the deposit).
    pub payment_minor: i64,
    /// A loan: interest paid and still to pay. A DPS: the interest at maturity (an estimate).
    pub interest_minor: i64,
    /// A loan: everything paid back. A DPS: the value at maturity.
    pub total_minor: i64,
    /// Installments in the plan.
    pub installments: i64,
    /// Installments paid, counting the ones from before.
    pub paid: i64,
    /// The first installment not paid yet.
    pub next_no: Option<i64>,
    pub next_date: Option<String>,
    /// Unpaid installments whose date has come.
    pub overdue: i64,
    pub end_date: String,
    /// A loan: still owed. A DPS: its value now (deposits and the interest so far).
    pub outstanding_minor: i64,
    /// A loan: interest charged and not paid yet.
    pub unpaid_interest_minor: i64,
    /// Paid so far (a DPS: deposited).
    pub paid_minor: i64,
    /// A loan: interest paid so far.
    pub interest_paid_minor: i64,
    /// The account's balance.
    pub balance_minor: i64,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlanInput {
    pub id: Option<String>,
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    /// As typed.
    pub amount: String,
    /// Percent a year, as typed ("12.05").
    #[serde(default)]
    pub rate: String,
    pub months: i64,
    pub start_date: String,
    #[serde(default)]
    pub method: String,
    pub payment: Option<String>,
    pub maturity: Option<String>,
    #[serde(default)]
    pub paid_before: i64,
    pub pay_from: String,
    #[serde(default)]
    pub auto_post: bool,
    /// A loan: the account the money arrived in ("" or none: not in Wallet).
    pub disburse_to: Option<String>,
    /// A loan: the day it was lent; without it, a month before the first installment.
    pub disburse_date: Option<String>,
    /// Counts in the total balance (a loan: off unless asked).
    pub in_total: Option<bool>,
    /// The account's bank, number and so on; without it they stay as they were.
    #[serde(default)]
    pub details: Option<db::AccountDetails>,
}

/// One payment made on a plan.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PaymentInput {
    pub id: Option<String>,
    pub plan_id: String,
    pub date: String,
    /// As typed.
    pub amount: String,
    /// The first installment it pays; none for a part payment.
    pub no: Option<i64>,
    /// How many installments it pays, from `no`.
    #[serde(default = "one")]
    pub count: i64,
    /// A loan: the interest the bank charged with it (with what was unpaid before), as typed;
    /// empty to work it out.
    pub interest: Option<String>,
    /// Paid from another account than the plan's.
    pub from_account: Option<String>,
    #[serde(default)]
    pub note: String,
    /// The money moves in Wallet (a transfer from the account it's paid from); off for a payment
    /// made before, already out of the bank, kept only for the table.
    #[serde(default = "yes")]
    pub posted: bool,
}

fn one() -> i64 {
    1
}
fn yes() -> bool {
    true
}

/// One line of the table.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanRow {
    /// "before" (paid before it was added here), "payment" (paid), "missed" (an installment
    /// skipped among later payments), "due" (its date has come) or "upcoming" (projected).
    pub kind: String,
    /// The first installment it pays (none for a part payment).
    pub no: Option<i64>,
    pub count: i64,
    pub date: String,
    /// Paid (a projected row: what's due).
    pub payment_minor: i64,
    /// A loan: the part that paid the loan down. A DPS: deposited so far.
    pub principal_minor: i64,
    /// A loan: the interest paid with it. A DPS: interest earned so far.
    pub interest_minor: i64,
    /// A loan: still owed after it. A DPS: its value after it.
    pub balance_minor: i64,
    /// A loan: interest charged and still unpaid after it.
    pub unpaid_interest_minor: i64,
    /// A payment's own.
    pub payment_id: Option<String>,
    pub from_account: Option<String>,
    pub interest_typed: Option<i64>,
    pub note: String,
    pub transfer_id: Option<String>,
    /// A payment whose money moved in Wallet (false: recorded only, paid before).
    pub posted: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlanDetail {
    pub plan: Plan,
    pub rows: Vec<PlanRow>,
}

/// What the terms work out to, before saving.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub payment_minor: i64,
    pub interest_minor: i64,
    pub total_minor: i64,
    pub installments: i64,
    pub end_date: String,
}

/// The terms as stored.
#[derive(Clone, Debug)]
struct Terms {
    kind: String,
    amount: i64,
    rate_bp: i64,
    months: i64,
    start_date: String,
    method: String,
    payment: Option<i64>,
    maturity: Option<i64>,
}

/// One installment of the plan as agreed.
struct Calc {
    date: String,
    payment: i64,
    principal: i64,
    interest: i64,
    balance: i64,
}

fn monthly_rate(rate_bp: i64) -> f64 {
    rate_bp as f64 / 10_000.0 / 12.0
}

/// Interest on `balance` for `days` at `rate_bp` a year, actual days over 365.
fn daily_interest(balance: i64, rate_bp: i64, days: i64) -> i64 {
    (balance as f64 * rate_bp as f64 / 10_000.0 * days.max(0) as f64 / 365.0).round() as i64
}

fn date_of(t: &Terms, no: i64) -> String {
    dates::in_month(&t.start_date, no - 1, dates::parts(&t.start_date).2)
}

fn days(a: &str, b: &str) -> i64 {
    dates::day_number(b) - dates::day_number(a)
}

/// A loan as agreed. Reducing (and daily): the same installment each month (the bank's, or
/// worked out from the rate), interest on what's still owed, the last one settling the rest.
/// Flat: interest on the whole amount for the whole term, spread evenly.
fn loan_rows(t: &Terms) -> Result<Vec<Calc>> {
    let n = t.months;
    let mut rows = Vec::with_capacity(n as usize);
    if t.method == "flat" {
        let interest_total = (t.amount as f64 * t.rate_bp as f64 / 10_000.0 * n as f64 / 12.0).round() as i64;
        let (principal, interest) = (t.amount / n, interest_total / n);
        let mut balance = t.amount;
        for no in 1..=n {
            let last = no == n;
            let p = if last { balance } else { principal };
            let i = if last { interest_total - interest * (n - 1) } else { interest };
            balance -= p;
            rows.push(Calc { date: date_of(t, no), payment: p + i, principal: p, interest: i, balance });
        }
        return Ok(rows);
    }
    let i = monthly_rate(t.rate_bp);
    let payment = match t.payment {
        Some(p) => p,
        None if i == 0.0 => (t.amount as f64 / n as f64).ceil() as i64,
        None => (t.amount as f64 * i / (1.0 - (1.0 + i).powi(-(n as i32)))).round() as i64,
    };
    let mut balance = t.amount;
    for no in 1..=n {
        let interest = (balance as f64 * i).round() as i64;
        let mut principal = payment - interest;
        if principal <= 0 {
            return Err("That installment doesn't cover the interest. Check the installment, the rate and the months.".into());
        }
        if no == n || principal >= balance {
            principal = balance;
        }
        balance -= principal;
        rows.push(Calc { date: date_of(t, no), payment: principal + interest, principal, interest, balance });
        if balance == 0 {
            break;
        }
    }
    Ok(rows)
}

/// A DPS as agreed: the deposit goes in at the start of each month and interest compounds
/// monthly. With the bank's maturity value typed, the interest is scaled to end on it.
fn dps_rows(t: &Terms) -> Result<Vec<Calc>> {
    let n = t.months;
    let i = monthly_rate(t.rate_bp);
    let estimate = |k: i64| -> f64 {
        if i == 0.0 {
            0.0
        } else {
            t.amount as f64 * (1.0 + i) * ((1.0 + i).powi(k as i32) - 1.0) / i - (t.amount * k) as f64
        }
    };
    let deposits = t.amount * n;
    let end = estimate(n);
    if let Some(m) = t.maturity {
        if m < deposits {
            return Err("The maturity value is less than what gets deposited.".into());
        }
    }
    let target = t.maturity.map(|m| (m - deposits) as f64);
    Ok((1..=n)
        .map(|no| {
            let interest = match target {
                Some(target) if end > 0.0 => estimate(no) * target / end,
                Some(target) => target * (no * (no + 1)) as f64 / (n * (n + 1)) as f64,
                None => estimate(no),
            }
            .round() as i64;
            Calc { date: date_of(t, no), payment: t.amount, principal: t.amount * no, interest, balance: t.amount * no + interest }
        })
        .collect())
}

fn rows_of(t: &Terms) -> Result<Vec<Calc>> {
    if t.kind == "loan" {
        loan_rows(t)
    } else {
        dps_rows(t)
    }
}

/// "12.05" percent a year, in hundredths of a percent.
fn parse_percent(text: &str) -> Result<i64> {
    let text = text.trim().trim_end_matches('%').trim();
    if text.is_empty() || text.chars().all(|c| c == '0' || c == '.') {
        return Ok(0);
    }
    let micro = money::parse_rate(text).ok_or("Type the rate as a percent a year, like 12.05.")?;
    if micro % 10_000 != 0 || micro > 100 * money::RATE_ONE {
        return Err("Type the rate as a percent a year, like 12.05 (up to two decimals).".into());
    }
    Ok(micro / 10_000)
}

fn terms_of(conn: &Connection, input: &PlanInput) -> Result<(Terms, db::Account)> {
    if input.kind != "dps" && input.kind != "loan" {
        return Err("A plan is a DPS or a loan.".into());
    }
    let loan = input.kind == "loan";
    let from = db::accounts(conn)?.into_iter().find(|a| a.id == input.pay_from).ok_or("Pick the account it's paid from.")?;
    if from.kind == "dps" || from.kind == "loan" {
        return Err("Pay it from an everyday account, like a bank account or cash.".into());
    }
    let amount = money::parse_amount(&input.amount, &from.currency).filter(|a| *a > 0).ok_or("Type the amount as a number, like 5,000.")?;
    if !(1..=MAX_MONTHS).contains(&input.months) {
        return Err(format!("Type how many months it runs, 1 to {MAX_MONTHS}."));
    }
    if !valid_date(&input.start_date) {
        return Err("Pick the first installment's date.".into());
    }
    let typed = |text: &Option<String>| -> Result<Option<i64>> {
        match text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            Some(text) => Ok(Some(money::parse_amount(text, &from.currency).filter(|a| *a > 0).ok_or("Type the amount as a number, like 5,000.")?)),
            None => Ok(None),
        }
    };
    let method = if loan && METHODS.contains(&input.method.as_str()) { input.method.as_str() } else { "reducing" };
    let terms = Terms {
        kind: input.kind.clone(),
        amount,
        rate_bp: parse_percent(&input.rate)?,
        months: input.months,
        start_date: input.start_date.clone(),
        method: method.into(),
        payment: if loan && method != "flat" { typed(&input.payment)? } else { None },
        maturity: if loan { None } else { typed(&input.maturity)? },
    };
    Ok((terms, from))
}

/// The day a loan was lent when none is set: a month before its first installment.
fn default_disburse(start: &str) -> String {
    dates::in_month(start, -1, dates::parts(start).2)
}

pub fn preview(conn: &Connection, input: &PlanInput) -> Result<Preview> {
    let (terms, _) = terms_of(conn, input)?;
    let disburse = input.disburse_date.clone().filter(|d| valid_date(d)).unwrap_or_else(|| default_disburse(&terms.start_date));
    let s = Stored {
        id: String::new(),
        account_id: String::new(),
        terms,
        paid_before: input.paid_before.max(0),
        pay_from: input.pay_from.clone(),
        auto_post: false,
        next_no: 1,
        disburse_date: disburse,
        disburse_to: None,
        disburse_transfer: None,
    };
    let c = compute(&s, &[], "0000-00-00")?;
    Ok(Preview { payment_minor: c.payment, interest_minor: c.interest_total, total_minor: c.total, installments: c.installments, end_date: c.end_date })
}

// ---- stored plans and payments

#[derive(Clone, Debug)]
struct Stored {
    id: String,
    account_id: String,
    terms: Terms,
    paid_before: i64,
    pay_from: String,
    auto_post: bool,
    /// The installment posting by itself goes on from (so a deleted one isn't posted again).
    next_no: i64,
    disburse_date: String,
    disburse_to: Option<String>,
    disburse_transfer: Option<String>,
}

const SELECT: &str = "SELECT id, kind, account_id, amount_minor, rate_bp, months, start_date, method, payment_minor, maturity_minor,
       paid_before, pay_from, auto_post, next_no, disburse_date, disburse_to, disburse_transfer FROM plans";

fn stored_row(r: &Row) -> rusqlite::Result<Stored> {
    let start: String = r.get(6)?;
    Ok(Stored {
        id: r.get(0)?,
        account_id: r.get(2)?,
        disburse_date: r.get::<_, Option<String>>(14)?.unwrap_or_else(|| default_disburse(&start)),
        terms: Terms { kind: r.get(1)?, amount: r.get(3)?, rate_bp: r.get(4)?, months: r.get(5)?, start_date: start, method: r.get(7)?, payment: r.get(8)?, maturity: r.get(9)? },
        paid_before: r.get(10)?,
        pay_from: r.get(11)?,
        auto_post: r.get(12)?,
        next_no: r.get(13)?,
        disburse_to: r.get(15)?,
        disburse_transfer: r.get(16)?,
    })
}

fn stored(conn: &Connection, id: &str) -> Result<Stored> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], stored_row).optional().map_err(db_err)?.ok_or_else(|| "That DPS or loan no longer exists.".into())
}

fn all_stored(conn: &Connection) -> Result<Vec<Stored>> {
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY created")).map_err(db_err)?;
    let rows = stmt.query_map([], stored_row).map_err(db_err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db_err)
}

#[derive(Clone, Debug)]
struct Payment {
    id: String,
    date: String,
    amount: i64,
    no: Option<i64>,
    count: i64,
    interest: Option<i64>,
    from: Option<String>,
    note: String,
    transfer_id: String,
    posted: bool,
}

/// A plan's payments in the order they count: by date, then as they were added.
fn payments(conn: &Connection, plan: &str) -> Result<Vec<Payment>> {
    let mut stmt = conn
        .prepare("SELECT id, date, amount_minor, no, count, interest_minor, from_account, note, transfer_id, posted FROM plan_payments WHERE plan_id = ?1 ORDER BY date, created, id")
        .map_err(db_err)?;
    let rows = stmt
        .query_map([plan], |r| {
            Ok(Payment {
                id: r.get(0)?,
                date: r.get(1)?,
                amount: r.get(2)?,
                no: r.get(3)?,
                count: r.get(4)?,
                interest: r.get(5)?,
                from: r.get(6)?,
                note: r.get(7)?,
                transfer_id: r.get(8)?,
                posted: r.get(9)?,
            })
        })
        .map_err(db_err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db_err)
}

// ---- working the table out

/// How a payment splits.
#[derive(Clone, Copy, Debug, Default)]
struct Split {
    principal: i64,
    interest: i64,
}

struct Computed {
    rows: Vec<PlanRow>,
    splits: HashMap<String, Split>,
    /// The usual installment.
    payment: i64,
    interest_total: i64,
    total: i64,
    installments: i64,
    paid: i64,
    next: Option<(i64, String)>,
    overdue: i64,
    end_date: String,
    outstanding: i64,
    unpaid_interest: i64,
    paid_amount: i64,
    interest_paid: i64,
    /// The opening balance of the plan's account.
    opening: i64,
}

#[allow(clippy::too_many_arguments)]
fn row(kind: &str, no: Option<i64>, date: &str, payment: i64, principal: i64, interest: i64, balance: i64, unpaid: i64) -> PlanRow {
    PlanRow {
        kind: kind.into(),
        no,
        count: 1,
        date: date.into(),
        payment_minor: payment,
        principal_minor: principal,
        interest_minor: interest,
        balance_minor: balance,
        unpaid_interest_minor: unpaid,
        payment_id: None,
        from_account: None,
        interest_typed: None,
        note: String::new(),
        transfer_id: None,
        posted: false,
    }
}

/// The table: the installments paid before, the payments in date order, the installments
/// skipped among them, then what's still to come, projected from what's owed.
fn compute(s: &Stored, pays: &[Payment], today: &str) -> Result<Computed> {
    let t = &s.terms;
    let loan = t.kind == "loan";
    let sched = rows_of(t)?;
    let n = sched.len() as i64;
    let pb = s.paid_before.clamp(0, n);
    let usual = sched.first().map_or(0, |r| r.payment);
    let mut rows: Vec<PlanRow> = Vec::new();
    for (i, c) in sched.iter().enumerate().take(pb as usize) {
        rows.push(row("before", Some(i as i64 + 1), &c.date, c.payment, c.principal, c.interest, c.balance, 0));
    }
    // Where the payments start from.
    let before = (pb > 0).then(|| &sched[pb as usize - 1]);
    let mut covered: BTreeSet<i64> = (1..=pb).collect();
    for p in pays {
        if let Some(no) = p.no {
            covered.extend(no..no + p.count.max(1));
        }
    }
    let mut splits = HashMap::new();
    let mut paid_rows: Vec<PlanRow> = Vec::new();
    // The installments paid before count as paid, as the schedule had them.
    let before_interest: i64 = if loan { sched.iter().take(pb as usize).map(|c| c.interest).sum() } else { 0 };
    let (mut interest_total, mut interest_paid, mut paid_amount) = (before_interest, before_interest, sched.iter().take(pb as usize).map(|c| c.payment).sum::<i64>());
    let mut carry = 0i64;
    let mut balance: i64;
    let mut last_date: Option<String>;
    if loan {
        balance = before.map_or(t.amount, |c| c.balance);
        last_date = Some(before.map_or(s.disburse_date.clone(), |c| c.date.clone()));
        // Interest charged by the month for the installments a payment pays.
        let monthly = |balance: i64, from: i64, count: i64| -> i64 {
            match t.method.as_str() {
                "flat" => (from..from + count).filter(|k| (1..=n).contains(k)).map(|k| sched[k as usize - 1].interest).sum(),
                _ => (balance as f64 * monthly_rate(t.rate_bp)).round() as i64 * count,
            }
        };
        for p in pays {
            let accrued = match t.method.as_str() {
                "daily" => daily_interest(balance, t.rate_bp, last_date.as_deref().map_or(0, |d| days(d, &p.date))),
                _ => p.no.map_or(0, |no| monthly(balance, no, p.count.max(1))),
            };
            let due = p.interest.unwrap_or(carry + accrued);
            let interest = p.amount.min(due).max(0);
            let principal = p.amount - interest;
            carry = due - interest;
            balance -= principal;
            if last_date.as_deref().is_none_or(|d| d < p.date.as_str()) {
                last_date = Some(p.date.clone());
            }
            interest_total += interest;
            interest_paid += interest;
            paid_amount += p.amount;
            splits.insert(p.id.clone(), Split { principal, interest });
            paid_rows.push(PlanRow {
                count: p.count.max(1),
                payment_id: Some(p.id.clone()),
                from_account: p.from.clone(),
                interest_typed: p.interest,
                note: p.note.clone(),
                transfer_id: p.posted.then(|| p.transfer_id.clone()),
                posted: p.posted,
                ..row("payment", p.no, &p.date, p.amount, principal, interest, balance, carry)
            });
        }
    } else {
        // A DPS: deposits earn interest by the day until maturity.
        let mut deposited = before.map_or(0, |_| t.amount * pb);
        balance = before.map_or(0, |c| c.balance);
        last_date = before.map(|c| c.date.clone());
        for p in pays {
            let accrued = last_date.as_deref().map_or(0, |d| daily_interest(balance, t.rate_bp, days(d, &p.date)));
            balance += accrued + p.amount;
            deposited += p.amount;
            if last_date.as_deref().is_none_or(|d| d < p.date.as_str()) {
                last_date = Some(p.date.clone());
            }
            paid_amount += p.amount;
            splits.insert(p.id.clone(), Split { principal: p.amount, interest: 0 });
            paid_rows.push(PlanRow {
                count: p.count.max(1),
                payment_id: Some(p.id.clone()),
                from_account: p.from.clone(),
                note: p.note.clone(),
                transfer_id: p.posted.then(|| p.transfer_id.clone()),
                posted: p.posted,
                ..row("payment", p.no, &p.date, p.amount, deposited, balance - deposited, balance, 0)
            });
        }
        interest_total = balance - deposited;
    }
    let outstanding = balance;
    let unpaid_interest = carry;
    // Installments skipped among the ones paid.
    let highest = covered.iter().next_back().copied().unwrap_or(0).max(pb);
    for k in pb + 1..=highest.min(n) {
        if !covered.contains(&k) {
            let c = &sched[k as usize - 1];
            let kind = if c.date.as_str() <= today { "missed" } else { "upcoming" };
            paid_rows.push(row(kind, Some(k), &c.date, if loan { usual } else { t.amount }, 0, 0, 0, 0));
        }
    }
    paid_rows.sort_by(|a, b| a.date.cmp(&b.date).then(a.no.cmp(&b.no)));
    rows.extend(paid_rows);
    // What's still to come.
    let mut end_date = last_date.clone().unwrap_or_else(|| t.start_date.clone());
    let mut deposited = if loan { 0 } else { rows.iter().filter(|r| r.kind == "payment" || r.kind == "before").map(|r| r.payment_minor).sum::<i64>() };
    for k in highest + 1..=n {
        if loan && balance <= 0 {
            break;
        }
        let c = &sched[k as usize - 1];
        let status = if c.date.as_str() <= today { "due" } else { "upcoming" };
        if loan {
            let accrued = match t.method.as_str() {
                "daily" => daily_interest(balance, t.rate_bp, last_date.as_deref().map_or(0, |d| days(d, &c.date))),
                "flat" => c.interest,
                _ => (balance as f64 * monthly_rate(t.rate_bp)).round() as i64,
            };
            let due = carry + accrued;
            let mut pay = if k == n { balance + due } else { t.payment.unwrap_or(usual) };
            let interest = pay.min(due);
            let mut principal = (pay - interest).min(balance);
            if principal == balance {
                pay = principal + interest;
            }
            if principal < 0 {
                principal = 0;
            }
            carry = due - interest;
            balance -= principal;
            interest_total += interest;
            rows.push(row(status, Some(k), &c.date, pay, principal, interest, balance, carry));
        } else {
            let accrued = last_date.as_deref().map_or(0, |d| daily_interest(balance, t.rate_bp, days(d, &c.date)));
            balance += accrued + t.amount;
            deposited += t.amount;
            rows.push(row(status, Some(k), &c.date, t.amount, deposited, balance - deposited, balance, 0));
        }
        last_date = Some(c.date.clone());
        end_date = c.date.clone();
    }
    let (payment, total) = if loan {
        (t.payment.unwrap_or(usual), t.amount + interest_total)
    } else {
        // A DPS matures a month after its last deposit, with that month's interest.
        let maturity = dates::in_month(&end_date, 1, dates::parts(&t.start_date).2);
        let value = balance + last_date.as_deref().map_or(0, |d| daily_interest(balance, t.rate_bp, days(d, &maturity)));
        let value = t.maturity.unwrap_or(value);
        interest_total = value - deposited;
        end_date = maturity;
        (t.amount, value)
    };
    let next = rows.iter().find(|r| matches!(r.kind.as_str(), "missed" | "due" | "upcoming")).and_then(|r| r.no.map(|no| (no, r.date.clone())));
    let overdue = rows.iter().filter(|r| r.kind == "missed" || r.kind == "due").count() as i64;
    // Payments recorded but not moved in Wallet were made before: the account opens after them.
    let recorded: i64 = pays.iter().filter(|p| !p.posted).map(|p| splits.get(&p.id).map_or(0, |s| s.principal)).sum();
    let opening = recorded
        + if loan {
            if s.disburse_to.is_some() {
                0
            } else {
                -before.map_or(t.amount, |c| c.balance)
            }
        } else {
            before.map_or(0, |_| t.amount * pb)
        };
    Ok(Computed {
        rows,
        splits,
        payment,
        interest_total,
        total,
        installments: n,
        paid: covered.iter().filter(|k| (1..=n).contains(*k)).count() as i64,
        next,
        overdue,
        end_date,
        outstanding,
        unpaid_interest,
        paid_amount,
        interest_paid,
        opening,
    })
}

fn finish(s: &Stored, account: &db::Account, c: &Computed) -> Plan {
    Plan {
        id: s.id.clone(),
        kind: s.terms.kind.clone(),
        account_id: s.account_id.clone(),
        name: account.name.clone(),
        color: account.color.clone(),
        currency: account.currency.clone(),
        amount_minor: s.terms.amount,
        rate_bp: s.terms.rate_bp,
        months: s.terms.months,
        start_date: s.terms.start_date.clone(),
        method: s.terms.method.clone(),
        payment_typed: s.terms.payment,
        maturity_typed: s.terms.maturity,
        paid_before: s.paid_before,
        pay_from: s.pay_from.clone(),
        auto_post: s.auto_post,
        disburse_date: s.disburse_date.clone(),
        disburse_to: s.disburse_to.clone(),
        in_total: account.in_total,
        payment_minor: c.payment,
        interest_minor: c.interest_total,
        total_minor: c.total,
        installments: c.installments,
        paid: c.paid,
        next_no: c.next.as_ref().map(|n| n.0),
        next_date: c.next.as_ref().map(|n| n.1.clone()),
        overdue: c.overdue,
        end_date: c.end_date.clone(),
        outstanding_minor: c.outstanding,
        unpaid_interest_minor: c.unpaid_interest,
        paid_minor: c.paid_amount,
        interest_paid_minor: c.interest_paid,
        balance_minor: account.balance_minor,
    }
}

pub fn detail(conn: &Connection, id: &str, today: &str) -> Result<PlanDetail> {
    let s = stored(conn, id)?;
    let account = db::accounts(conn)?.into_iter().find(|a| a.id == s.account_id).ok_or("That account no longer exists.")?;
    let c = compute(&s, &payments(conn, &s.id)?, today)?;
    Ok(PlanDetail { plan: finish(&s, &account, &c), rows: c.rows })
}

/// Every DPS and loan, in the order they were added (archived accounts last).
pub fn list(conn: &Connection, today: &str) -> Result<Vec<Plan>> {
    let accounts = db::accounts(conn)?;
    let all = all_stored(conn)?;
    let mut plans = Vec::new();
    for account in &accounts {
        for s in all.iter().filter(|s| s.account_id == account.id) {
            plans.push(finish(s, account, &compute(s, &payments(conn, &s.id)?, today)?));
        }
    }
    Ok(plans)
}

// ---- writing the transactions

fn interest_category(conn: &Connection, now: i64) -> Result<String> {
    let found: Option<String> = conn
        .query_row("SELECT id FROM categories WHERE kind = 'expense' AND parent_id IS NULL AND lower(name) = 'loan interest' LIMIT 1", [], |r| r.get(0))
        .optional()
        .map_err(db_err)?;
    match found {
        Some(id) => Ok(id),
        None => Ok(db::save_category(conn, db::CategoryInput { id: None, parent_id: None, name: "Loan interest".into(), kind: "expense".into(), icon: "bank".into(), color: "red".into() }, now)?.id),
    }
}

/// `minor` units as a plain number ("11135.00").
fn plain(minor: i64, code: &str) -> String {
    let exp = money::exponent(code);
    if exp == 0 {
        return minor.to_string();
    }
    let unit = 10i64.pow(exp);
    format!("{}.{:0width$}", minor / unit, (minor % unit).abs(), width = exp as usize)
}

/// One part of a payment, written over the one before (so its receipts stay), or removed when
/// its amount is nothing.
#[derive(Clone, Copy)]
pub(super) struct Part<'a> {
    pub transfer: &'a str,
    pub part: &'a str,
    pub account: &'a db::Account,
    pub date: &'a str,
    pub amount: i64,
    pub category: Option<&'a str>,
    pub payee: &'a str,
    pub note: &'a str,
    pub payment: Option<&'a str>,
    pub no: Option<i64>,
}

pub(super) fn write_part(conn: &Connection, plan: &str, p: Part, now: i64) -> Result<()> {
    let existing: Option<String> = conn
        .query_row("SELECT id FROM transactions WHERE transfer_id = ?1 AND plan_part = ?2", params![p.transfer, p.part], |r| r.get(0))
        .optional()
        .map_err(db_err)?;
    if p.amount == 0 {
        if let Some(id) = existing {
            conn.execute("DELETE FROM transactions WHERE id = ?1", [id]).map_err(db_err)?;
        }
        return Ok(());
    }
    let rate = db::rate_of(conn, &p.account.currency)?.ok_or_else(|| format!("Set the rate for {} in Accounts first.", p.account.currency))?;
    let base = money::to_base(p.amount, &p.account.currency, rate);
    match existing {
        Some(id) => conn.execute(
            "UPDATE transactions SET account_id = ?2, date = ?3, amount_minor = ?4, rate_micro = ?5, base_minor = ?6, category_id = ?7, payee = ?8, note = ?9,
               plan_id = ?10, plan_no = ?11, plan_payment = ?12, updated = ?13 WHERE id = ?1",
            params![id, p.account.id, p.date, p.amount, rate, base, p.category, p.payee, p.note, plan, p.no, p.payment, now],
        ),
        None => conn.execute(
            "INSERT INTO transactions (id, account_id, date, amount_minor, rate_micro, base_minor, category_id, payee, note, transfer_id, plan_id, plan_no, plan_payment, plan_part, created, updated)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
            params![super::sync::derived_id(&["part", p.transfer, p.part]), p.account.id, p.date, p.amount, rate, base, p.category, p.payee, p.note, p.transfer, plan, p.no, p.payment, p.part, now],
        ),
    }
    .map_err(db_err)?;
    Ok(())
}

fn payment_note(name: &str, p: &Payment) -> String {
    if !p.note.trim().is_empty() {
        return p.note.trim().to_string();
    }
    match (p.no, p.count) {
        (Some(no), c) if c > 1 => format!("{name} installments {no}–{}", no + c - 1),
        (Some(no), _) => format!("{name} installment {no}"),
        (None, _) => format!("{name} part payment"),
    }
}

/// Works the plan out again and writes it: the account's opening balance, the loan's arrival,
/// and each payment's parts.
fn rebuild(conn: &Connection, id: &str, now: i64) -> Result<()> {
    let s = stored(conn, id)?;
    let pays = payments(conn, id)?;
    let c = compute(&s, &pays, "9999-12-31")?;
    let accounts = db::accounts(conn)?;
    let find = |id: &str| accounts.iter().find(|a| a.id == id);
    let account = find(&s.account_id).ok_or("That account no longer exists.")?;
    conn.execute("UPDATE accounts SET opening_minor = ?2 WHERE id = ?1", params![account.id, c.opening]).map_err(db_err)?;
    let loan = s.terms.kind == "loan";
    // The loan's arrival.
    if let Some(transfer) = &s.disburse_transfer {
        let to = s.disburse_to.as_deref().and_then(find);
        let amount = if to.is_some() { s.terms.amount } else { 0 };
        write_part(conn, id, Part { transfer, part: "disb-out", account, date: &s.disburse_date, amount: -amount, category: None, payee: "", note: "Loan received", payment: None, no: None }, now)?;
        if let Some(to) = to {
            write_part(conn, id, Part { transfer, part: "disb-in", account: to, date: &s.disburse_date, amount, category: None, payee: "", note: "Loan received", payment: None, no: None }, now)?;
        } else {
            conn.execute("DELETE FROM transactions WHERE transfer_id = ?1 AND plan_part = 'disb-in'", [transfer]).map_err(db_err)?;
        }
    }
    let category = if loan { Some(interest_category(conn, now)?) } else { None };
    for p in &pays {
        let split = if p.posted { c.splits.get(&p.id).copied().unwrap_or_default() } else { Split::default() };
        let from_id = p.from.as_deref().unwrap_or(&s.pay_from);
        let from = find(from_id).ok_or_else(|| format!("The account {} is paid from no longer exists. Pick another in its settings.", account.name))?;
        if from.currency != account.currency {
            return Err(format!("{} is paid from an account in another currency. Pick another.", account.name));
        }
        let note = payment_note(&account.name, p);
        let base = Part { transfer: &p.transfer_id, part: "out", account: from, date: &p.date, amount: -split.principal, category: None, payee: "", note: &note, payment: Some(&p.id), no: p.no };
        write_part(conn, id, Part { ..base }, now)?;
        write_part(conn, id, Part { part: "in", account, amount: split.principal, ..base }, now)?;
        write_part(conn, id, Part { part: "interest", amount: -split.interest, category: category.as_deref(), payee: &account.name, ..base }, now)?;
    }
    // Parts of payments no longer there.
    conn.execute(
        "DELETE FROM transactions WHERE plan_id = ?1 AND plan_payment IS NOT NULL AND plan_payment NOT IN (SELECT id FROM plan_payments WHERE plan_id = ?1)",
        [id],
    )
    .map_err(db_err)?;
    Ok(())
}

/// Adds a DPS or a loan with its account, or changes one: any change works its table out again.
pub fn save(conn: &mut Connection, input: PlanInput, today: &str, now: i64) -> Result<PlanDetail> {
    let (terms, from) = terms_of(conn, &input)?;
    let rows = rows_of(&terms)?;
    if input.paid_before < 0 || input.paid_before >= rows.len() as i64 {
        return Err("Installments already paid: from 0 to one less than them all.".into());
    }
    let loan = terms.kind == "loan";
    let disburse_date = input.disburse_date.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| default_disburse(&terms.start_date));
    if !valid_date(&disburse_date) || (loan && disburse_date > terms.start_date) {
        return Err("The loan arrives on or before its first installment.".into());
    }
    let disburse_to = match (loan, input.disburse_to.as_deref().filter(|d| !d.is_empty())) {
        (true, Some(to)) => {
            let to = db::accounts(conn)?.into_iter().find(|a| a.id == to).ok_or("The account the loan arrived in no longer exists.")?;
            if to.currency != from.currency {
                return Err("The loan arrives in, and is paid from, accounts in the same currency.".into());
            }
            if input.paid_before > 0 {
                return Err("A loan with installments already paid started before today's ledger: leave out where it arrived.".into());
            }
            Some(to.id)
        }
        _ => None,
    };
    let tx = conn.transaction().map_err(db_err)?;
    let account_input = |id: Option<String>| db::AccountInput {
        id,
        name: input.name.clone(),
        kind: terms.kind.clone(),
        currency: from.currency.clone(),
        opening: String::new(),
        color: input.color.clone(),
        rate: None,
        in_total: input.in_total,
        credit_limit: None,
        statement_day: None,
        due_day: None,
        details: input.details.clone(),
    };
    let id = match &input.id {
        Some(id) => {
            let before = stored(&tx, id)?;
            if before.terms.kind != terms.kind {
                return Err("A DPS stays a DPS, and a loan a loan.".into());
            }
            db::save_account(&tx, account_input(Some(before.account_id.clone())), now).map_err(|e| if e.contains("keeps its currency") { "Pay it from an account in the same currency as before.".to_string() } else { e })?;
            let disburse_transfer = before.disburse_transfer.clone().or_else(|| disburse_to.as_ref().map(|_| new_id()));
            let b = &before.terms;
            let schedule_same = b.months == terms.months && b.start_date == terms.start_date && before.paid_before == input.paid_before;
            tx.execute(
                "UPDATE plans SET amount_minor = ?2, rate_bp = ?3, months = ?4, start_date = ?5, method = ?6, payment_minor = ?7, maturity_minor = ?8, paid_before = ?9,
                   pay_from = ?10, auto_post = ?11, next_no = CASE WHEN ?12 THEN next_no ELSE ?13 END, disburse_date = ?14, disburse_to = ?15, disburse_transfer = ?16, updated = ?17 WHERE id = ?1",
                params![id, terms.amount, terms.rate_bp, terms.months, terms.start_date, terms.method, terms.payment, terms.maturity, input.paid_before,
                    from.id, input.auto_post, schedule_same, input.paid_before + 1, disburse_date, disburse_to, disburse_transfer, now],
            )
            .map_err(db_err)?;
            id.clone()
        }
        None => {
            let account = db::save_account(&tx, account_input(None), now)?;
            let id = new_id();
            tx.execute(
                "INSERT INTO plans (id, kind, account_id, amount_minor, rate_bp, months, start_date, method, payment_minor, maturity_minor, paid_before, pay_from, auto_post, next_no,
                   disburse_date, disburse_to, disburse_transfer, created, updated)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)",
                params![id, terms.kind, account.id, terms.amount, terms.rate_bp, terms.months, terms.start_date, terms.method, terms.payment, terms.maturity, input.paid_before,
                    from.id, input.auto_post, input.paid_before + 1, disburse_date, disburse_to, disburse_to.as_ref().map(|_| new_id()), now],
            )
            .map_err(db_err)?;
            id
        }
    };
    rebuild(&tx, &id, now)?;
    tx.commit().map_err(db_err)?;
    detail(conn, &id, today)
}

/// Adds a payment, or changes one; the table is worked out again from it on.
pub fn save_payment(conn: &mut Connection, input: PaymentInput, today: &str, now: i64) -> Result<PlanDetail> {
    let s = stored(conn, &input.plan_id)?;
    let account = db::accounts(conn)?.into_iter().find(|a| a.id == s.account_id).ok_or("That account no longer exists.")?;
    let amount = money::parse_amount(&input.amount, &account.currency).filter(|a| *a > 0).ok_or("Type the amount paid, like 11,135.")?;
    if !valid_date(&input.date) {
        return Err("Pick the day it was paid.".into());
    }
    let n = s.terms.months;
    let count = input.count.clamp(1, n.max(1));
    if let Some(no) = input.no {
        if !(1..=n).contains(&no) {
            return Err(format!("Pick an installment from 1 to {n}."));
        }
    }
    let interest = match input.interest.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(_) if s.terms.kind != "loan" => None,
        Some(text) => Some(money::parse_amount(text, &account.currency).ok_or("Type the interest as a number, like 2,641.10.")?),
        None => None,
    };
    let from = input.from_account.clone().filter(|f| !f.is_empty() && *f != s.pay_from);
    if let Some(f) = &from {
        let a = db::accounts(conn)?.into_iter().find(|a| &a.id == f).ok_or("That account no longer exists.")?;
        if a.currency != account.currency || a.kind == "loan" || a.kind == "dps" {
            return Err("Pay it from an everyday account in the same currency.".into());
        }
    }
    let note: String = input.note.trim().chars().take(500).collect();
    let tx = conn.transaction().map_err(db_err)?;
    match &input.id {
        Some(id) => {
            let n = tx
                .execute(
                    "UPDATE plan_payments SET date = ?3, amount_minor = ?4, no = ?5, count = ?6, interest_minor = ?7, from_account = ?8, note = ?9, updated = ?10, posted = ?11 WHERE id = ?1 AND plan_id = ?2",
                    params![id, s.id, input.date, amount, input.no, count, interest, from, note, now, input.posted],
                )
                .map_err(db_err)?;
            if n == 0 {
                return Err("That payment no longer exists.".into());
            }
        }
        None => {
            tx.execute(
                "INSERT INTO plan_payments (id, plan_id, date, amount_minor, no, count, interest_minor, from_account, note, transfer_id, created, updated, posted)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12)",
                params![new_id(), s.id, input.date, amount, input.no, count, interest, from, note, new_id(), now, input.posted],
            )
            .map_err(db_err)?;
        }
    }
    rebuild(&tx, &s.id, now)?;
    tx.commit().map_err(db_err)?;
    detail(conn, &s.id, today)
}

pub fn delete_payment(conn: &mut Connection, id: &str, today: &str, now: i64) -> Result<PlanDetail> {
    let plan: String = conn.query_row("SELECT plan_id FROM plan_payments WHERE id = ?1", [id], |r| r.get(0)).optional().map_err(db_err)?.ok_or("That payment no longer exists.")?;
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("DELETE FROM plan_payments WHERE id = ?1", [id]).map_err(db_err)?;
    rebuild(&tx, &plan, now)?;
    tx.commit().map_err(db_err)?;
    detail(conn, &plan, today)
}

/// What a pasted statement held.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatementImport {
    /// Payments read from it.
    pub found: usize,
    /// Added (the rest were already there: same day and amount).
    pub added: usize,
    /// The day the loan was lent, when the statement has it.
    pub disburse_date: Option<String>,
    /// The first and last payment's days.
    pub first: Option<String>,
    pub last: Option<String>,
    /// What's owed after them, as the table works it out.
    pub outstanding_minor: Option<i64>,
    pub detail: Option<PlanDetail>,
}

struct StatementRow {
    date: String,
    no: Option<i64>,
    amount: i64,
    interest: Option<i64>,
}

/// A number as a statement writes it ("11,135", "4705.665896", "(500)"), in minor units.
fn statement_number(text: &str, code: &str) -> Option<i64> {
    let t = text.trim().replace(',', "");
    if t.is_empty() {
        return None;
    }
    let value: f64 = t.trim_matches(|c| c == '(' || c == ')').parse().ok()?;
    Some((value.abs() * 10f64.powi(money::exponent(code) as i32)).round() as i64)
}

/// Reads a loan statement copied from a spreadsheet or the bank's page: a line per entry, with
/// its cells between tabs (or two spaces or more). A header line names the columns ("Debit",
/// "Amount" or "Paid"; "Interest"); without one, they're taken as Date, Description,
/// Installment, Paid, Principal, Interest, Balance. The disbursement line ("Disburs…") gives the
/// day the loan was lent.
fn read_statement(text: &str, code: &str, months: i64) -> (Vec<StatementRow>, Option<String>) {
    let cells = |line: &str| -> Vec<String> {
        if line.contains('\t') {
            line.split('\t').map(|c| c.trim().to_string()).collect()
        } else {
            line.split("  ").filter(|c| !c.trim().is_empty()).map(|c| c.trim().to_string()).collect()
        }
    };
    let (mut amount_col, mut interest_col, mut no_col) = (3usize, Some(5usize), Some(2usize));
    let mut rows = Vec::new();
    let mut disburse = None;
    for line in text.lines() {
        let c = cells(line);
        if c.iter().all(|x| x.is_empty()) {
            continue;
        }
        let lower: Vec<String> = c.iter().map(|x| x.to_lowercase()).collect();
        if lower.first().is_some_and(|f| f.contains("date")) {
            // A header names the columns.
            let find = |names: &[&str]| lower.iter().position(|h| names.iter().any(|n| h.contains(n)));
            if let Some(a) = find(&["debit", "amount", "paid", "payment", "recovery"]) {
                amount_col = a;
            }
            interest_col = find(&["interest"]);
            // The installment number: an unnamed or "no"/"inst" column before the amount.
            no_col = find(&["inst", "no.", "#"]).or_else(|| (2..amount_col).next());
            continue;
        }
        let Some(date) = c.first().and_then(|d| dates::parse_loose(d, "ymd").or_else(|| dates::parse_loose(d, "dmy"))) else { continue };
        let description = c.get(1).map(|d| d.to_lowercase()).unwrap_or_default();
        if description.contains("disburs") {
            disburse = Some(date);
            continue;
        }
        let Some(amount) = c.get(amount_col).and_then(|a| statement_number(a, code)).filter(|a| *a > 0) else { continue };
        let no = no_col.and_then(|i| c.get(i)).and_then(|n| n.trim().parse::<i64>().ok()).filter(|n| (1..=months).contains(n));
        let interest = interest_col.and_then(|i| c.get(i)).and_then(|n| statement_number(n, code));
        rows.push(StatementRow { date, no, amount, interest });
    }
    (rows, disburse)
}

/// Turns a pasted statement into payments already made (recorded, not moved in Wallet), with the
/// interest the bank charged on each, so the table follows the statement to the poisha. The
/// installments the schedule took as paid before give way to them. With `apply` off, only says
/// what it found.
pub fn import_statement(conn: &mut Connection, id: &str, text: &str, by_day: bool, apply: bool, today: &str, now: i64) -> Result<StatementImport> {
    let s = stored(conn, id)?;
    let currency = db::accounts(conn)?.into_iter().find(|a| a.id == s.account_id).map(|a| a.currency).ok_or("That account no longer exists.")?;
    let (rows, disburse) = read_statement(text, &currency, s.terms.months);
    if rows.is_empty() {
        return Err("No payments found. Copy the statement's rows with their dates and amounts, from a spreadsheet or the bank's page.".into());
    }
    let existing = payments(conn, id)?;
    let new: Vec<&StatementRow> = rows.iter().filter(|r| !existing.iter().any(|p| p.date == r.date && p.amount == r.amount)).collect();
    let loan = s.terms.kind == "loan";
    let mut result = StatementImport {
        found: rows.len(),
        added: new.len(),
        disburse_date: disburse.clone(),
        first: rows.iter().map(|r| r.date.clone()).min(),
        last: rows.iter().map(|r| r.date.clone()).max(),
        outstanding_minor: None,
        detail: None,
    };
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("UPDATE plans SET paid_before = 0 WHERE id = ?1", [id]).map_err(db_err)?;
    if let Some(d) = disburse.as_ref().filter(|d| loan && d.as_str() <= s.terms.start_date.as_str()) {
        tx.execute("UPDATE plans SET disburse_date = ?2 WHERE id = ?1", params![id, d]).map_err(db_err)?;
    }
    if loan && by_day {
        tx.execute("UPDATE plans SET method = 'daily' WHERE id = ?1", [id]).map_err(db_err)?;
    }
    for r in &new {
        tx.execute(
            "INSERT INTO plan_payments (id, plan_id, date, amount_minor, no, count, interest_minor, note, transfer_id, created, updated, posted)
               VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 'From the statement', ?7, ?8, ?8, 0)",
            params![new_id(), id, r.date, r.amount, r.no, if loan { r.interest } else { None }, new_id(), now],
        )
        .map_err(db_err)?;
    }
    // Paying by itself goes on after the last installment the statement has.
    if let Some(last) = rows.iter().filter_map(|r| r.no).max() {
        tx.execute("UPDATE plans SET next_no = MAX(next_no, ?2) WHERE id = ?1", params![id, last + 1]).map_err(db_err)?;
    }
    rebuild(&tx, id, now)?;
    let detail = {
        let s = stored(&tx, id)?;
        let account = db::accounts(&tx)?.into_iter().find(|a| a.id == s.account_id).ok_or("That account no longer exists.")?;
        let c = compute(&s, &payments(&tx, id)?, today)?;
        PlanDetail { plan: finish(&s, &account, &c), rows: c.rows }
    };
    result.outstanding_minor = Some(detail.plan.outstanding_minor);
    if apply {
        tx.commit().map_err(db_err)?;
        result.detail = Some(detail);
    }
    // Without `apply`, dropping `tx` rolls it all back.
    Ok(result)
}

/// Pays installment `no` as the table has it: on `date` when given, else its own date (or today
/// when that's still ahead).
pub fn pay(conn: &mut Connection, id: &str, no: i64, date: Option<&str>, today: &str, now: i64) -> Result<()> {
    let d = detail(conn, id, today)?;
    let row = d.rows.iter().find(|r| r.no == Some(no) && matches!(r.kind.as_str(), "missed" | "due" | "upcoming")).ok_or("That installment is already paid.")?;
    let on = date.filter(|d| valid_date(d)).unwrap_or(if row.date.as_str() <= today { &row.date } else { today }).to_string();
    let amount = plain(row.payment_minor, &d.plan.currency);
    save_payment(conn, PaymentInput { id: None, plan_id: id.into(), date: on, amount, no: Some(no), count: 1, interest: None, from_account: None, note: String::new(), posted: true }, today, now)?;
    Ok(())
}

/// Posts the installments that came due on plans that pay by themselves (as the table projects
/// them), each plan in one SQLite transaction with moving it on. Returns how many were posted.
pub fn post_due(conn: &mut Connection, today: &str, now: i64) -> Result<usize> {
    let mut count = 0;
    for s in all_stored(conn)?.into_iter().filter(|s| s.auto_post) {
        let c = compute(&s, &payments(conn, &s.id)?, today)?;
        let due: Vec<&PlanRow> = c.rows.iter().filter(|r| r.kind == "due" && r.no.is_some_and(|no| no >= s.next_no) && r.date.as_str() <= today).collect();
        let last_passed = c.rows.iter().filter(|r| r.no.is_some() && r.date.as_str() <= today).filter_map(|r| r.no).max();
        let tx = conn.transaction().map_err(db_err)?;
        for r in &due {
            // Worked out from the plan and the installment, so the phone and the computer posting
            // the same installment before they sync write the same rows.
            let no = r.no.unwrap_or(0).to_string();
            tx.execute(
                "INSERT INTO plan_payments (id, plan_id, date, amount_minor, no, count, created, updated, transfer_id) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6, ?7)
                 ON CONFLICT (id) DO NOTHING",
                params![super::sync::derived_id(&["plan-payment", &s.id, &no]), s.id, r.date, r.payment_minor, r.no, now, super::sync::derived_id(&["plan-transfer", &s.id, &no])],
            )
            .map_err(db_err)?;
        }
        if !due.is_empty() {
            rebuild(&tx, &s.id, now)?;
        }
        if let Some(next) = last_passed.map(|n| n + 1).filter(|n| *n > s.next_no) {
            tx.execute("UPDATE plans SET next_no = ?2, updated = ?3 WHERE id = ?1", params![s.id, next, now]).map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        count += due.len();
    }
    Ok(count)
}

/// After transactions were deleted in Transactions: a payment whose transfer went is gone, a
/// loan's arrival that went is no longer in Wallet, and those plans are worked out again.
pub fn after_delete(conn: &mut Connection, now: i64) -> Result<()> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut touched: BTreeSet<String> = BTreeSet::new();
    {
        let mut stmt = tx
            .prepare("SELECT p.id, p.plan_id FROM plan_payments p WHERE p.posted = 1 AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.transfer_id = p.transfer_id)")
            .map_err(db_err)?;
        let gone: Vec<(String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(db_err)?.collect::<std::result::Result<_, _>>().map_err(db_err)?;
        for (payment, plan) in gone {
            tx.execute("DELETE FROM plan_payments WHERE id = ?1", [payment]).map_err(db_err)?;
            touched.insert(plan);
        }
        let mut stmt = tx
            .prepare("SELECT id FROM plans WHERE disburse_transfer IS NOT NULL AND disburse_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.transfer_id = plans.disburse_transfer)")
            .map_err(db_err)?;
        let arrived: Vec<String> = stmt.query_map([], |r| r.get(0)).map_err(db_err)?.collect::<std::result::Result<_, _>>().map_err(db_err)?;
        for plan in arrived {
            tx.execute("UPDATE plans SET disburse_to = NULL, disburse_transfer = NULL WHERE id = ?1", [&plan]).map_err(db_err)?;
            touched.insert(plan);
        }
    }
    for plan in &touched {
        rebuild(&tx, plan, now)?;
    }
    tx.commit().map_err(db_err)
}

/// Removes the plan. What it posted stays as ordinary transfers and the account stays with them;
/// an account nothing was posted to goes too.
pub fn delete(conn: &mut Connection, id: &str) -> Result<()> {
    let s = stored(conn, id)?;
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("UPDATE transactions SET plan_id = NULL, plan_no = NULL, plan_payment = NULL, plan_part = NULL WHERE plan_id = ?1", [id]).map_err(db_err)?;
    tx.execute("DELETE FROM plans WHERE id = ?1", [id]).map_err(db_err)?;
    let used: i64 = tx.query_row("SELECT COUNT(*) FROM transactions WHERE account_id = ?1", [&s.account_id], |r| r.get(0)).map_err(db_err)?;
    if used == 0 {
        tx.execute("DELETE FROM accounts WHERE id = ?1", [&s.account_id]).map_err(db_err)?;
    }
    tx.commit().map_err(db_err)
}

/// Plans made before payments had a ledger of their own: each installment's transfer becomes a
/// payment, and a loan's arrival is remembered. Runs at start; does nothing once done.
pub fn adopt(conn: &mut Connection, now: i64) -> Result<()> {
    let tx = conn.transaction().map_err(db_err)?;
    let plans = all_stored(&tx)?;
    let mut touched = Vec::new();
    for s in &plans {
        let mut stmt = tx
            .prepare("SELECT id, account_id, date, amount_minor, category_id IS NOT NULL, transfer_id, plan_no FROM transactions WHERE plan_id = ?1 AND plan_part IS NULL AND transfer_id IS NOT NULL")
            .map_err(db_err)?;
        type Old = (String, String, String, i64, bool, String, Option<i64>);
        let rows: Vec<Old> = stmt
            .query_map([&s.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))
            .map_err(db_err)?
            .collect::<std::result::Result<_, _>>()
            .map_err(db_err)?;
        if rows.is_empty() {
            continue;
        }
        let mut by_transfer: HashMap<String, Vec<Old>> = HashMap::new();
        for r in rows {
            by_transfer.entry(r.5.clone()).or_default().push(r);
        }
        for (transfer, parts) in by_transfer {
            let part_of = |r: &Old| if r.4 { "interest" } else if r.1 == s.account_id { if r.6.is_none() { "disb-out" } else { "in" } } else if r.6.is_none() { "disb-in" } else { "out" };
            if parts.iter().all(|r| r.6.is_none()) {
                // The loan's arrival.
                let to = parts.iter().find(|r| r.1 != s.account_id).map(|r| r.1.clone());
                let date = parts[0].2.clone();
                tx.execute("UPDATE plans SET disburse_to = ?2, disburse_date = ?3, disburse_transfer = ?4 WHERE id = ?1", params![s.id, to, date, transfer]).map_err(db_err)?;
                for r in &parts {
                    tx.execute("UPDATE transactions SET plan_part = ?2 WHERE id = ?1", params![r.0, part_of(r)]).map_err(db_err)?;
                }
                continue;
            }
            let paid: i64 = parts.iter().filter(|r| r.1 != s.account_id).map(|r| -r.3).sum();
            let from = parts.iter().find(|r| r.1 != s.account_id).map(|r| r.1.clone()).filter(|f| *f != s.pay_from);
            let payment = new_id();
            tx.execute(
                "INSERT INTO plan_payments (id, plan_id, date, amount_minor, no, count, from_account, transfer_id, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?8)",
                params![payment, s.id, parts[0].2, paid, parts[0].6, from, transfer, now],
            )
            .map_err(db_err)?;
            for r in &parts {
                tx.execute("UPDATE transactions SET plan_part = ?2, plan_payment = ?3 WHERE id = ?1", params![r.0, part_of(r), payment]).map_err(db_err)?;
            }
        }
        touched.push(s.id.clone());
    }
    for id in &touched {
        rebuild(&tx, id, now)?;
    }
    tx.commit().map_err(db_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::db::tests::{add_account, fresh};

    fn input(kind: &str, bank: &str) -> PlanInput {
        PlanInput {
            id: None, kind: kind.into(), name: if kind == "loan" { "Car loan" } else { "City DPS" }.into(), color: "blue".into(),
            amount: if kind == "loan" { "100,000" } else { "5,000" }.into(), rate: "12".into(), months: 12, start_date: "2026-01-10".into(), method: "reducing".into(),
            payment: None, maturity: None, paid_before: 0, pay_from: bank.into(), auto_post: true, disburse_to: None, disburse_date: None, in_total: None, details: None,
        }
    }

    fn pay_in(plan: &str, date: &str, amount: &str, no: Option<i64>) -> PaymentInput {
        PaymentInput { id: None, plan_id: plan.into(), date: date.into(), amount: amount.into(), no, count: 1, interest: None, from_account: None, note: String::new(), posted: true }
    }

    fn balance(conn: &Connection, id: &str) -> i64 {
        db::accounts(conn).unwrap().into_iter().find(|a| a.id == id).unwrap().balance_minor
    }

    #[test]
    fn a_loan_table_pays_the_loan_off() {
        let mut conn = fresh();
        let bank = add_account(&conn, "Bank", "bank", "BDT", None);
        let mut i = input("loan", &bank);
        i.auto_post = false;
        let d = save(&mut conn, i, "2025-12-20", 1).unwrap();
        // 100,000 at 12% over 12 months: 8,884.88 a month.
        assert_eq!(d.plan.payment_minor, 888_488);
        assert_eq!(d.rows.len(), 12);
        assert_eq!((d.rows[0].interest_minor, d.rows[0].principal_minor), (100_000, 788_488));
        assert_eq!(d.rows.iter().map(|r| r.principal_minor).sum::<i64>(), 10_000_000);
        assert_eq!(d.rows.last().unwrap().balance_minor, 0);
        assert_eq!((d.rows[1].date.as_str(), d.plan.end_date.as_str(), d.plan.disburse_date.as_str()), ("2026-02-10", "2026-12-10", "2025-12-10"));
        // The account starts owing it all, and doesn't count in the total balance.
        assert_eq!(balance(&conn, &d.plan.account_id), -10_000_000);
        assert!(!d.plan.in_total);
    }

    /// The payments on a real statement (a BRAC Bank loan): interest by the day at 12.05%, a
    /// payment too small for the interest leaving the rest unpaid, and installment 2 paid in two.
    #[test]
    fn a_daily_loan_follows_the_banks_statement() {
        let mut conn = fresh();
        let bank = add_account(&conn, "Bank", "bank", "BDT", None);
        let mut i = input("loan", &bank);
        (i.amount, i.rate, i.months, i.start_date, i.method, i.auto_post) = ("500,000".into(), "12.05".into(), 60, "2024-05-08".into(), "daily".into(), false);
        i.disburse_date = Some("2024-04-22".into());
        i.disburse_to = Some(bank.clone());
        let d = save(&mut conn, i, "2024-04-22", 1).unwrap();
        let id = d.plan.id.clone();
        save_payment(&mut conn, pay_in(&id, "2024-05-08", "11,135", Some(1)), "2024-07-10", 2).unwrap();
        save_payment(&mut conn, pay_in(&id, "2024-06-06", "832.83", None), "2024-07-10", 3).unwrap();
        save_payment(&mut conn, pay_in(&id, "2024-06-09", "10,302.17", Some(2)), "2024-07-10", 4).unwrap();
        let d = save_payment(&mut conn, pay_in(&id, "2024-07-08", "11,135", Some(3)), "2024-07-10", 5).unwrap();
        let paid: Vec<(i64, i64, i64, i64)> = d.rows.iter().filter(|r| r.kind == "payment").map(|r| (r.principal_minor, r.interest_minor, r.balance_minor, r.unpaid_interest_minor)).collect();
        // The statement: 8,493.90 + 2,641.10; 0 + 832.83 (3,872.84 unpaid); 5,942.54 + 4,359.63; 6,486.23 + 4,648.77 (to the poisha).
        assert_eq!(paid, [(849_390, 264_110, 49_150_610, 0), (0, 83_283, 49_150_610, 387_284), (594_254, 435_963, 48_556_356, 0), (648_623, 464_877, 47_907_733, 0)]);
        assert_eq!((d.plan.paid, d.plan.next_no, d.plan.outstanding_minor), (3, Some(4), 47_907_733));
        // The loan account owes what the table does; the bank got the loan and paid four times.
        assert_eq!(balance(&conn, &d.plan.account_id), -47_907_733);
        assert_eq!(balance(&conn, &bank), 50_000_000 - 1_113_500 - 83_283 - 1_030_217 - 1_113_500);
        // The part payment with no principal is only interest.
        let june = db::list(&conn, &db::Filter { from: Some("2024-06-06".into()), to: Some("2024-06-06".into()), ..Default::default() }).unwrap();
        assert_eq!((june.total, june.spending_minor), (1, 83_283));
        // Typing the bank's own interest wins.
        let first = d.rows.iter().find(|r| r.no == Some(1)).unwrap().payment_id.clone().unwrap();
        let d = save_payment(&mut conn, PaymentInput { id: Some(first), interest: Some("2,641.09".into()), ..pay_in(&id, "2024-05-08", "11,135", Some(1)) }, "2024-07-10", 6).unwrap();
        assert_eq!(d.rows.iter().find(|r| r.no == Some(1)).map(|r| r.principal_minor), Some(849_391));
        // The day it arrived moves the first month's interest.
        let mut moved = input("loan", &bank);
        (moved.id, moved.amount, moved.rate, moved.months, moved.start_date, moved.method, moved.auto_post) = (Some(id.clone()), "500,000".into(), "12.05".into(), 60, "2024-05-08".into(), "daily".into(), false);
        (moved.disburse_date, moved.disburse_to) = (Some("2024-04-18".into()), Some(bank.clone()));
        let d = save(&mut conn, moved, "2024-07-10", 7).unwrap();
        assert_eq!(d.rows.iter().find(|r| r.no == Some(1)).map(|r| r.interest_minor), Some(264_109));
        let arrived = db::list(&conn, &db::Filter { from: Some("2024-04-18".into()), to: Some("2024-04-18".into()), ..Default::default() }).unwrap();
        assert_eq!(arrived.total, 2);
    }

    /// The start of a real statement, pasted from a spreadsheet: the disbursement, payments with
    /// the bank's interest, a part payment, and installment 2 paid in two.
    const STATEMENT: &str = "Date\tDescription\tColumn 8\tDebit\tPrinciple\tInterest\tBalance\tColumn 2
\t\t\t345264.78\t223400.5564\t121864.2236\t276599.4436\t-11909.96167
2024-04-22\tDisbursement Credit\t\t\t0\t\t420731\t0
\t\t\t\t0\t\t500000\t0
2024-05-08\tLoan Recovery\t1\t11135\t8493.90411\t2641.09589\t491506.0959\t0
2024-06-06\tLoan Recovery\t\t832.83\t0\t4705.665896\t491506.0959\t-3872.835896
2024-06-09\tLoan Recovery\t2\t10302.17\t5942.54108\t4359.62892\t485563.5548\t0
2024-07-08\tLoan Recovery\t3\t11135\t6486.227829\t4648.772171\t479077.327\t0
\t\t\t\t\t\t\t
2024-08-08\tLoan Recovery\t4\t11135\t6232.004507\t4902.995493\t472845.3225\t0";

    #[test]
    fn a_pasted_statement_becomes_the_payments_made() {
        let mut conn = fresh();
        let bank = add_account(&conn, "Bank", "bank", "BDT", None);
        let mut i = input("loan", &bank);
        (i.amount, i.rate, i.months, i.start_date, i.paid_before) = ("500,000".into(), "12.05".into(), 60, "2024-05-08".into(), 4);
        let d = save(&mut conn, i, "2024-08-20", 1).unwrap();
        // A look first changes nothing.
        let look = import_statement(&mut conn, &d.plan.id, STATEMENT, true, false, "2024-08-20", 2).unwrap();
        assert_eq!((look.found, look.added, look.disburse_date.as_deref(), look.outstanding_minor), (5, 5, Some("2024-04-22"), Some(47_284_533)));
        assert_eq!(detail(&conn, &d.plan.id, "2024-08-20").unwrap().plan.paid_before, 4);
        let done = import_statement(&mut conn, &d.plan.id, STATEMENT, true, true, "2024-08-20", 3).unwrap().detail.unwrap();
        let p = &done.plan;
        assert_eq!((p.method.as_str(), p.paid_before, p.disburse_date.as_str(), p.paid, p.next_no), ("daily", 0, "2024-04-22", 4, Some(5)));
        // As the bank has it, 4,72,845.3225 owed (whole poisha each payment: one off), and 3,872.84
        // unpaid after the part payment.
        assert_eq!(p.outstanding_minor, 47_284_533);
        assert_eq!(done.rows.iter().find(|r| r.date == "2024-06-06").map(|r| r.unpaid_interest_minor), Some(387_284));
        // Recorded, not moved: the bank is untouched and the loan account owes what's left.
        assert_eq!(balance(&conn, &bank), 0);
        assert_eq!(balance(&conn, &p.account_id), -47_284_533);
        assert_eq!(db::list(&conn, &db::Filter::default()).unwrap().total, 0);
        // Pasting it again adds nothing; a recorded payment can still be changed.
        assert_eq!(import_statement(&mut conn, &p.id, STATEMENT, true, true, "2024-08-20", 4).unwrap().added, 0);
        let first = done.rows[0].payment_id.clone().unwrap();
        let d = save_payment(&mut conn, PaymentInput { id: Some(first), interest: Some("2,641.10".into()), posted: false, ..pay_in(&p.id, "2024-05-08", "11,135", Some(1)) }, "2024-08-20", 5).unwrap();
        assert_eq!((d.plan.paid, balance(&conn, &bank)), (4, 0));
        // The next one, paid in Wallet, moves the money.
        let d = save_payment(&mut conn, pay_in(&p.id, "2024-09-08", "11,135", Some(5)), "2024-09-10", 6).unwrap();
        assert_eq!(balance(&conn, &bank), -1_113_500);
        assert_eq!(balance(&conn, &p.account_id), -d.plan.outstanding_minor);
    }

    #[test]
    fn several_installments_at_once_and_one_missed() {
        let mut conn = fresh();
        let bank = add_account(&conn, "Bank", "bank", "BDT", None);
        let mut i = input("loan", &bank);
        i.auto_post = false;
        let d = save(&mut conn, i, "2026-01-01", 1).unwrap();
        let id = d.plan.id.clone();
        // Installments 1 and 2 in one payment, then 4 without 3.
        let d = save_payment(&mut conn, PaymentInput { count: 2, ..pay_in(&id, "2026-02-10", "17,769.76", Some(1)) }, "2026-04-20", 2).unwrap();
        assert_eq!(d.rows[0].interest_minor, 200_000);
        let d = save_payment(&mut conn, pay_in(&id, "2026-04-10", "8,884.88", Some(4)), "2026-04-20", 3).unwrap();
        let kinds: Vec<(&str, Option<i64>)> = d.rows.iter().take(4).map(|r| (r.kind.as_str(), r.no)).collect();
        assert_eq!(kinds, [("payment", Some(1)), ("missed", Some(3)), ("payment", Some(4)), ("upcoming", Some(5))]);
        assert_eq!((d.plan.paid, d.plan.overdue, d.plan.next_no), (3, 1, Some(3)));
        // Deleting a payment's transfer in Transactions takes the payment.
        let gone = d.rows[2].transfer_id.clone().unwrap();
        let ids: Vec<String> = db::list(&conn, &db::Filter::default()).unwrap().items.into_iter().filter(|t| t.transfer_id.as_deref() == Some(gone.as_str())).map(|t| t.id).collect();
        db::delete_txs(&mut conn, &ids).unwrap();
        after_delete(&mut conn, 4).unwrap();
        assert_eq!(detail(&conn, &id, "2026-04-20").unwrap().plan.paid, 2);
        // A payment can't be changed in Transactions.
        let left = db::list(&conn, &db::Filter::default()).unwrap().items;
        let t = left.iter().find(|t| t.plan_id.is_some() && t.kind == "expense").unwrap();
        let err = db::save_tx(&conn, db::TxInput { id: Some(t.id.clone()), kind: "expense".into(), account_id: bank.clone(), amount: "1".into(), date: "2026-02-10".into(), category_id: None, payee: "".into(), note: "".into() }, 5).unwrap_err();
        assert_eq!(err, db::PLAN_EDIT);
    }

    #[test]
    fn installments_post_themselves() {
        let mut conn = fresh();
        let bank = add_account(&conn, "Bank", "bank", "BDT", None);
        let d = save(&mut conn, input("loan", &bank), "2025-12-20", 1).unwrap();
        // Closed until 15 March: three installments came due.
        assert_eq!(post_due(&mut conn, "2026-03-15", 2).unwrap(), 3);
        assert_eq!(post_due(&mut conn, "2026-03-15", 3).unwrap(), 0);
        let after = detail(&conn, &d.plan.id, "2026-03-15").unwrap();
        assert_eq!(after.rows.iter().take(4).map(|r| r.kind.as_str()).collect::<Vec<_>>(), ["payment", "payment", "payment", "upcoming"]);
        assert_eq!(balance(&conn, &d.plan.account_id), -after.rows[2].balance_minor);
        assert_eq!(balance(&conn, &bank), -3 * 888_488);
        let interest = db::list(&conn, &db::Filter { kind: Some("expense".into()), ..Default::default() }).unwrap();
        assert_eq!(interest.spending_minor, after.rows.iter().take(3).map(|r| r.interest_minor).sum::<i64>());
        // A deleted one isn't posted again by itself; Pay brings it back.
        let gone = after.rows[1].transfer_id.clone().unwrap();
        let ids: Vec<String> = db::list(&conn, &db::Filter::default()).unwrap().items.into_iter().filter(|t| t.transfer_id.as_deref() == Some(gone.as_str())).map(|t| t.id).collect();
        db::delete_txs(&mut conn, &ids).unwrap();
        after_delete(&mut conn, 4).unwrap();
        assert_eq!(post_due(&mut conn, "2026-03-15", 5).unwrap(), 0);
        assert_eq!(detail(&conn, &d.plan.id, "2026-03-15").unwrap().rows[1].kind, "missed");
        pay(&mut conn, &d.plan.id, 2, None, "2026-03-15", 6).unwrap();
        assert_eq!(detail(&conn, &d.plan.id, "2026-03-15").unwrap().plan.paid, 3);
    }

    #[test]
    fn a_flat_loan_and_one_already_running() {
        let mut conn = fresh();
        let bank = add_account(&conn, "Bank", "bank", "BDT", None);
        let mut flat = input("loan", &bank);
        flat.method = "flat".into();
        flat.paid_before = 4;
        flat.auto_post = false;
        let d = save(&mut conn, flat, "2026-05-01", 1).unwrap();
        // Flat 12% on 100,000 for a year: 12,000 interest, 1,000 a month.
        assert_eq!((d.plan.interest_minor, d.rows[0].interest_minor, d.rows[11].balance_minor), (1_200_000, 100_000, 0));
        assert_eq!(d.rows.iter().take(5).map(|r| r.kind.as_str()).collect::<Vec<_>>(), ["before", "before", "before", "before", "upcoming"]);
        assert_eq!(balance(&conn, &d.plan.account_id), -d.rows[3].balance_minor);
        assert_eq!(post_due(&mut conn, "2026-05-10", 2).unwrap(), 0);
        let due = detail(&conn, &d.plan.id, "2026-05-10").unwrap();
        assert_eq!((due.plan.overdue, due.plan.next_no, due.plan.paid), (1, Some(5), 4));
        pay(&mut conn, &d.plan.id, 5, Some("2026-05-11"), "2026-05-11", 3).unwrap();
        assert_eq!(balance(&conn, &d.plan.account_id), -d.rows[4].balance_minor);
    }

    #[test]
    fn a_dps_grows_and_counts_in_the_total() {
        let mut conn = fresh();
        let bank = add_account(&conn, "Bank", "bank", "BDT", None);
        let d = save(&mut conn, input("dps", &bank), "2025-12-20", 1).unwrap();
        assert!(d.plan.in_total);
        assert_eq!(d.plan.end_date, "2027-01-10");
        assert!((6_390_000..6_420_000).contains(&d.plan.total_minor), "{}", d.plan.total_minor);
        assert_eq!(post_due(&mut conn, "2026-02-20", 2).unwrap(), 2);
        assert_eq!((balance(&conn, &d.plan.account_id), balance(&conn, &bank)), (1_000_000, -1_000_000));
        let mut quoted = input("dps", &bank);
        quoted.id = Some(d.plan.id.clone());
        quoted.maturity = Some("64,500".into());
        quoted.name = "City Bank DPS".into();
        let d = save(&mut conn, quoted, "2026-02-20", 3).unwrap();
        assert_eq!((d.plan.total_minor, d.plan.name.as_str(), d.plan.paid), (6_450_000, "City Bank DPS", 2));
        delete(&mut conn, &d.plan.id).unwrap();
        assert!(list(&conn, "2026-02-20").unwrap().is_empty());
        assert_eq!(balance(&conn, &d.plan.account_id), 1_000_000);
    }

    #[test]
    fn plans_from_before_the_ledger_are_adopted() {
        let mut conn = fresh();
        let bank = add_account(&conn, "Bank", "bank", "BDT", None);
        let mut i = input("loan", &bank);
        i.disburse_to = Some(bank.clone());
        let d = save(&mut conn, i, "2025-12-20", 1).unwrap();
        post_due(&mut conn, "2026-02-15", 2).unwrap();
        // As the first version wrote them: no ledger rows, no parts.
        conn.execute_batch("DELETE FROM plan_payments; UPDATE transactions SET plan_part = NULL, plan_payment = NULL; UPDATE plans SET disburse_to = NULL, disburse_transfer = NULL, disburse_date = NULL;").unwrap();
        adopt(&mut conn, 3).unwrap();
        let after = detail(&conn, &d.plan.id, "2026-02-15").unwrap();
        assert_eq!((after.plan.paid, after.plan.disburse_to.as_deref(), after.plan.disburse_date.as_str()), (2, Some(bank.as_str()), "2025-12-10"));
        assert_eq!(balance(&conn, &d.plan.account_id), -after.rows[1].balance_minor);
        assert_eq!(db::list(&conn, &db::Filter::default()).unwrap().total, 2 + 3 * 2);
        adopt(&mut conn, 4).unwrap();
        assert_eq!(payments(&conn, &d.plan.id).unwrap().len(), 2);
    }
}
