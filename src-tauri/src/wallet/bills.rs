//! Bills and other money that repeats (rent, a Netflix plan, a salary): a rule with a schedule,
//! and the transactions it posts. A rule that posts by itself catches up on every due date it
//! missed while CorePro was closed (one transaction each); one that only reminds stays due, once,
//! until it's marked as paid or skipped.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::dates;
use super::db::{self, db_err, valid_date, Result};
use super::money;
use crate::notes::new_id;

pub const FREQS: [&str; 4] = ["daily", "weekly", "monthly", "yearly"];
/// A rule that reminds piles up no further than this many missed dates (they post one by one).
const MAX_CATCH_UP: usize = 400;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bill {
    pub id: String,
    /// "expense" or "income".
    pub kind: String,
    pub account_id: String,
    /// The account's currency.
    pub currency: String,
    /// Unsigned, in the account's currency.
    pub amount_minor: i64,
    pub category_id: Option<String>,
    pub payee: String,
    pub note: String,
    /// One of `FREQS`.
    pub freq: String,
    /// Every 1, 2, 3… days, weeks, months or years.
    pub every: i64,
    /// Monthly: the day of the month (0 for the last day).
    pub day: i64,
    pub start_date: String,
    pub end_date: Option<String>,
    /// The next date it falls due; `None` once it has ended.
    pub next_date: Option<String>,
    /// Posts its transaction on the day by itself; otherwise reminds until marked as paid.
    pub auto_post: bool,
    pub subscription: bool,
    /// Shows as coming up this many days before.
    pub remind_days: i64,
    pub paused: bool,
    /// What it costs (or brings) in a year, base currency at the latest rate.
    pub yearly_base_minor: Option<i64>,
    /// Missed due dates still waiting (reminders only).
    pub overdue: i64,
    /// The last transaction it posted.
    pub last_date: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BillInput {
    pub id: Option<String>,
    pub kind: String,
    pub account_id: String,
    /// As typed.
    pub amount: String,
    pub category_id: Option<String>,
    #[serde(default)]
    pub payee: String,
    #[serde(default)]
    pub note: String,
    pub freq: String,
    #[serde(default = "one")]
    pub every: i64,
    /// Monthly only; 0 = the last day. Without it, the start date's day.
    pub day: Option<i64>,
    pub start_date: String,
    pub end_date: Option<String>,
    #[serde(default)]
    pub auto_post: bool,
    #[serde(default)]
    pub subscription: bool,
    #[serde(default = "three")]
    pub remind_days: i64,
}

fn one() -> i64 {
    1
}
fn three() -> i64 {
    3
}

const SELECT: &str = "SELECT b.id, b.kind, b.account_id, a.currency, b.amount_minor, b.category_id, b.payee, b.note, b.freq, b.every, b.day,
       b.start_date, b.end_date, b.next_date, b.auto_post, b.subscription, b.remind_days, b.paused,
       (SELECT MAX(t.date) FROM transactions t WHERE t.recurring_id = b.id)
  FROM recurring b JOIN accounts a ON a.id = b.account_id";

fn row(r: &Row) -> rusqlite::Result<Bill> {
    Ok(Bill {
        id: r.get(0)?,
        kind: r.get(1)?,
        account_id: r.get(2)?,
        currency: r.get(3)?,
        amount_minor: r.get(4)?,
        category_id: r.get(5)?,
        payee: r.get(6)?,
        note: r.get(7)?,
        freq: r.get(8)?,
        every: r.get(9)?,
        day: r.get(10)?,
        start_date: r.get(11)?,
        end_date: r.get(12)?,
        next_date: r.get(13)?,
        auto_post: r.get(14)?,
        subscription: r.get(15)?,
        remind_days: r.get(16)?,
        paused: r.get(17)?,
        yearly_base_minor: None,
        overdue: 0,
        last_date: r.get(18)?,
    })
}

/// The due date after `date` on the rule's schedule.
pub fn after(b: &Bill, date: &str) -> String {
    let every = b.every.max(1);
    match b.freq.as_str() {
        "daily" => dates::add_days(date, every),
        "weekly" => dates::add_days(date, 7 * every),
        "yearly" => {
            // Same month and day as it started (29 February falls on the 28th in other years).
            let (_, m, d) = dates::parts(&b.start_date);
            let (y, _, _) = dates::parts(date);
            dates::in_month(&dates::format(y + every, m, 1), 0, d)
        }
        _ => dates::in_month(date, every, b.day as u32),
    }
}

/// The first due date on or after the start.
fn first(b: &Bill) -> String {
    if b.freq == "monthly" {
        let candidate = dates::in_month(&b.start_date, 0, b.day as u32);
        if candidate < b.start_date {
            return dates::in_month(&b.start_date, 1, b.day as u32);
        }
        return candidate;
    }
    b.start_date.clone()
}

/// The next date it falls due after `date`, or `None` past its end.
fn next_after(b: &Bill, date: &str) -> Option<String> {
    let next = after(b, date);
    b.end_date.as_ref().is_none_or(|end| &next <= end).then_some(next)
}

/// Payments a year, for the yearly cost.
fn per_year(b: &Bill) -> f64 {
    let every = b.every.max(1) as f64;
    match b.freq.as_str() {
        "daily" => 365.0 / every,
        "weekly" => 52.0 / every,
        "yearly" => 1.0 / every,
        _ => 12.0 / every,
    }
}

/// How many due dates have passed up to `today`, from `next` on.
fn count_due(b: &Bill, today: &str) -> i64 {
    let mut n = 0;
    let mut at = b.next_date.clone();
    while let Some(d) = at {
        if d.as_str() > today || n as usize >= MAX_CATCH_UP {
            break;
        }
        n += 1;
        at = next_after(b, &d);
    }
    n
}

fn finish(conn: &Connection, mut b: Bill, today: &str) -> Result<Bill> {
    let rate = db::rate_of(conn, &b.currency)?;
    b.yearly_base_minor = rate.map(|r| (money::to_base(b.amount_minor, &b.currency, r) as f64 * per_year(&b)).round() as i64);
    b.overdue = if b.auto_post || b.paused { 0 } else { count_due(&b, today) };
    Ok(b)
}

/// Every rule, soonest first (ended and paused ones last).
pub fn list(conn: &Connection, today: &str) -> Result<Vec<Bill>> {
    let mut stmt = conn
        .prepare(&format!("{SELECT} ORDER BY b.paused, b.next_date IS NULL, b.next_date, lower(b.payee)"))
        .map_err(db_err)?;
    let rows: Vec<Bill> = stmt.query_map([], row).map_err(db_err)?.collect::<std::result::Result<_, _>>().map_err(db_err)?;
    rows.into_iter().map(|b| finish(conn, b, today)).collect()
}

pub fn get(conn: &Connection, id: &str, today: &str) -> Result<Bill> {
    let b = conn.query_row(&format!("{SELECT} WHERE b.id = ?1"), [id], row).optional().map_err(db_err)?.ok_or("That bill no longer exists.")?;
    finish(conn, b, today)
}

pub fn save(conn: &Connection, input: BillInput, today: &str, now: i64) -> Result<Bill> {
    if input.kind != "expense" && input.kind != "income" {
        return Err("A bill is spending or income.".into());
    }
    if !FREQS.contains(&input.freq.as_str()) {
        return Err("Pick how often it repeats.".into());
    }
    if !(1..=366).contains(&input.every) {
        return Err("Repeat every 1 to 366 periods.".into());
    }
    if !valid_date(&input.start_date) {
        return Err("Pick the first date.".into());
    }
    if let Some(end) = input.end_date.as_ref().filter(|e| !e.is_empty()) {
        if !valid_date(end) || end < &input.start_date {
            return Err("The end comes after the first date.".into());
        }
    }
    let end_date = input.end_date.filter(|e| !e.is_empty());
    let accounts = db::accounts(conn)?;
    let account = accounts.iter().find(|a| a.id == input.account_id).ok_or("That account no longer exists.")?;
    let amount = money::parse_amount(&input.amount, &account.currency).filter(|a| *a > 0).ok_or("Type the amount as a number, like 1,250.50.")?;
    if let Some(cat) = &input.category_id {
        if !db::categories(conn)?.iter().any(|c| &c.id == cat) {
            return Err("That category no longer exists.".into());
        }
    }
    let day = if input.freq == "monthly" { input.day.unwrap_or_else(|| dates::parts(&input.start_date).2 as i64).clamp(0, 31) } else { 0 };
    let payee: String = input.payee.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect();
    if payee.is_empty() && input.category_id.is_none() {
        return Err("Name the bill, or give it a category.".into());
    }
    let note: String = input.note.trim().chars().take(2000).collect();
    let remind = input.remind_days.clamp(0, 60);
    let mut draft = Bill {
        id: input.id.clone().unwrap_or_else(new_id),
        kind: input.kind,
        account_id: account.id.clone(),
        currency: account.currency.clone(),
        amount_minor: amount,
        category_id: input.category_id,
        payee,
        note,
        freq: input.freq,
        every: input.every,
        day,
        start_date: input.start_date,
        end_date,
        next_date: None,
        auto_post: input.auto_post,
        subscription: input.subscription,
        remind_days: remind,
        paused: false,
        yearly_base_minor: None,
        overdue: 0,
        last_date: None,
    };
    // The next due date: from the start for a new rule; an edited one keeps its place unless its
    // schedule changed, and never goes back before what it already posted.
    let before = match &input.id {
        Some(id) => Some(get(conn, id, today)?),
        None => None,
    };
    let schedule_same = before.as_ref().is_some_and(|b| b.freq == draft.freq && b.every == draft.every && b.day == draft.day && b.start_date == draft.start_date);
    let mut next = if schedule_same { before.as_ref().and_then(|b| b.next_date.clone()) } else { Some(first(&draft)) };
    if let (Some(last), false) = (before.as_ref().and_then(|b| b.last_date.clone()), schedule_same) {
        while let Some(n) = next.clone() {
            if n > last {
                break;
            }
            next = next_after(&draft, &n);
        }
    }
    if let (Some(n), Some(end)) = (&next, &draft.end_date) {
        if n > end {
            next = None;
        }
    }
    draft.next_date = next;
    match before {
        Some(b) => {
            conn.execute(
                "UPDATE recurring SET kind = ?2, account_id = ?3, amount_minor = ?4, category_id = ?5, payee = ?6, note = ?7, freq = ?8, every = ?9, day = ?10,
                   start_date = ?11, end_date = ?12, next_date = ?13, auto_post = ?14, subscription = ?15, remind_days = ?16, updated = ?17 WHERE id = ?1",
                params![b.id, draft.kind, draft.account_id, draft.amount_minor, draft.category_id, draft.payee, draft.note, draft.freq, draft.every, draft.day,
                    draft.start_date, draft.end_date, draft.next_date, draft.auto_post, draft.subscription, draft.remind_days, now],
            )
            .map_err(db_err)?;
        }
        None => {
            conn.execute(
                "INSERT INTO recurring (id, kind, account_id, amount_minor, category_id, payee, note, freq, every, day, start_date, end_date, next_date,
                   auto_post, subscription, remind_days, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)",
                params![draft.id, draft.kind, draft.account_id, draft.amount_minor, draft.category_id, draft.payee, draft.note, draft.freq, draft.every, draft.day,
                    draft.start_date, draft.end_date, draft.next_date, draft.auto_post, draft.subscription, draft.remind_days, now],
            )
            .map_err(db_err)?;
        }
    }
    get(conn, &draft.id, today)
}

pub fn set_paused(conn: &Connection, id: &str, paused: bool, now: i64) -> Result<()> {
    let n = conn.execute("UPDATE recurring SET paused = ?2, updated = ?3 WHERE id = ?1", params![id, paused, now]).map_err(db_err)?;
    if n == 0 {
        return Err("That bill no longer exists.".into());
    }
    Ok(())
}

/// Deletes a rule; what it already posted stays, as ordinary transactions.
pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("UPDATE transactions SET recurring_id = NULL WHERE recurring_id = ?1", [id]).map_err(db_err)?;
    conn.execute("DELETE FROM recurring WHERE id = ?1", [id]).map_err(db_err)?;
    Ok(())
}

/// Writes the rule's transaction for one due date.
fn post_one(conn: &Connection, b: &Bill, date: &str, now: i64) -> Result<String> {
    let rate = db::rate_of(conn, &b.currency)?.ok_or_else(|| format!("Set the rate for {} in Accounts first.", b.currency))?;
    let signed = if b.kind == "income" { b.amount_minor } else { -b.amount_minor };
    let id = new_id();
    conn.execute(
        "INSERT INTO transactions (id, account_id, date, amount_minor, rate_micro, base_minor, category_id, payee, note, recurring_id, created, updated)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![id, b.account_id, date, signed, rate, money::to_base(signed, &b.currency, rate), b.category_id, b.payee, b.note, b.id, now],
    )
    .map_err(db_err)?;
    Ok(id)
}

/// Posts every due date of the rules that post by themselves, up to `today`, each in one SQLite
/// transaction with moving the rule on (so a crash or a second run never posts twice). Returns
/// how many transactions were written.
pub fn post_due(conn: &mut Connection, today: &str, now: i64) -> Result<usize> {
    let due: Vec<Bill> = list(conn, today)?.into_iter().filter(|b| b.auto_post && !b.paused && b.next_date.as_deref().is_some_and(|d| d <= today)).collect();
    let mut posted = 0;
    for b in due {
        let tx = conn.transaction().map_err(db_err)?;
        let mut next = b.next_date.clone();
        let mut n = 0;
        while let Some(d) = next.clone() {
            if d.as_str() > today || n >= MAX_CATCH_UP {
                break;
            }
            post_one(&tx, &b, &d, now)?;
            n += 1;
            next = next_after(&b, &d);
        }
        tx.execute("UPDATE recurring SET next_date = ?2, updated = ?3 WHERE id = ?1", params![b.id, next, now]).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        posted += n;
    }
    Ok(posted)
}

/// Marks the next due date as paid: posts it (on `date`, the day it was really paid, when given)
/// and moves the rule on to the following one.
pub fn pay(conn: &mut Connection, id: &str, date: Option<&str>, today: &str, now: i64) -> Result<String> {
    let b = get(conn, id, today)?;
    let due = b.next_date.clone().ok_or("This bill has ended.")?;
    let on = date.filter(|d| valid_date(d)).unwrap_or(&due).to_string();
    let tx = conn.transaction().map_err(db_err)?;
    let posted = post_one(&tx, &b, &on, now)?;
    tx.execute("UPDATE recurring SET next_date = ?2, updated = ?3 WHERE id = ?1", params![b.id, next_after(&b, &due), now]).map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(posted)
}

/// Moves past the next due date without posting anything.
pub fn skip(conn: &Connection, id: &str, today: &str, now: i64) -> Result<()> {
    let b = get(conn, id, today)?;
    let due = b.next_date.clone().ok_or("This bill has ended.")?;
    conn.execute("UPDATE recurring SET next_date = ?2, updated = ?3 WHERE id = ?1", params![b.id, next_after(&b, &due), now]).map_err(db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::db::tests::{cat, fresh};

    fn input(conn: &Connection, freq: &str, start: &str, auto: bool) -> BillInput {
        let cash = db::accounts(conn).unwrap()[0].id.clone();
        BillInput {
            id: None, kind: "expense".into(), account_id: cash, amount: "1,200".into(), category_id: Some(cat(conn, "Internet")),
            payee: "Link3".into(), note: "".into(), freq: freq.into(), every: 1, day: None, start_date: start.into(), end_date: None,
            auto_post: auto, subscription: false, remind_days: 3,
        }
    }

    #[test]
    fn a_monthly_bill_catches_up_once_per_missed_month() {
        let mut conn = fresh();
        let b = save(&conn, input(&conn, "monthly", "2026-08-05", true), "2026-08-01", 1).unwrap();
        assert_eq!(b.next_date.as_deref(), Some("2026-08-05"));
        // CorePro was closed from 1 August to 26 October: three due dates passed.
        assert_eq!(post_due(&mut conn, "2026-10-26", 2).unwrap(), 3);
        let posted = db::list(&conn, &db::Filter::default()).unwrap();
        assert_eq!(posted.items.iter().map(|t| t.date.as_str()).collect::<Vec<_>>(), ["2026-10-05", "2026-09-05", "2026-08-05"]);
        assert!(posted.items.iter().all(|t| t.amount_minor == -120_000 && t.recurring_id.as_deref() == Some(b.id.as_str())));
        assert_eq!(get(&conn, &b.id, "2026-10-26").unwrap().next_date.as_deref(), Some("2026-11-05"));
        // A second run posts nothing.
        assert_eq!(post_due(&mut conn, "2026-10-26", 3).unwrap(), 0);
        assert_eq!(db::list(&conn, &db::Filter::default()).unwrap().total, 3);
    }

    #[test]
    fn a_reminder_stays_due_once_until_paid() {
        let mut conn = fresh();
        let b = save(&conn, input(&conn, "monthly", "2026-09-10", false), "2026-09-01", 1).unwrap();
        assert_eq!(post_due(&mut conn, "2026-10-26", 2).unwrap(), 0);
        let due = get(&conn, &b.id, "2026-10-26").unwrap();
        assert_eq!((due.next_date.as_deref(), due.overdue), (Some("2026-09-10"), 2));
        pay(&mut conn, &b.id, Some("2026-10-26"), "2026-10-26", 3).unwrap();
        let after_pay = get(&conn, &b.id, "2026-10-26").unwrap();
        assert_eq!((after_pay.next_date.as_deref(), after_pay.overdue, after_pay.last_date.as_deref()), (Some("2026-10-10"), 1, Some("2026-10-26")));
        skip(&conn, &b.id, "2026-10-26", 4).unwrap();
        assert_eq!(get(&conn, &b.id, "2026-10-26").unwrap().overdue, 0);
        assert_eq!(db::list(&conn, &db::Filter::default()).unwrap().total, 1);
    }

    #[test]
    fn schedules_keep_their_day() {
        let conn = fresh();
        let mut i = input(&conn, "monthly", "2026-01-31", true);
        i.day = Some(31);
        let b = save(&conn, i, "2026-01-01", 1).unwrap();
        assert_eq!(after(&b, "2026-01-31"), "2026-02-28");
        assert_eq!(after(&b, "2026-02-28"), "2026-03-31");
        let mut last = input(&conn, "monthly", "2026-10-20", true);
        last.day = Some(0);
        let b = save(&conn, last, "2026-10-01", 1).unwrap();
        assert_eq!(b.next_date.as_deref(), Some("2026-10-31"));
        let y = save(&conn, input(&conn, "yearly", "2028-02-29", true), "2028-01-01", 1).unwrap();
        assert_eq!(after(&y, "2028-02-29"), "2029-02-28");
        let w = save(&conn, BillInput { every: 2, ..input(&conn, "weekly", "2026-10-01", true) }, "2026-10-01", 1).unwrap();
        assert_eq!(after(&w, "2026-10-01"), "2026-10-15");
        assert_eq!(w.yearly_base_minor, Some(120_000 * 26));
        // A rule with an end stops there.
        let mut ending = input(&conn, "monthly", "2026-08-01", true);
        ending.end_date = Some("2026-09-15".into());
        let mut conn2 = conn;
        let e = save(&conn2, ending, "2026-08-01", 1).unwrap();
        post_due(&mut conn2, "2026-12-01", 2).unwrap();
        assert_eq!(get(&conn2, &e.id, "2026-12-01").unwrap().next_date, None);
    }
}
