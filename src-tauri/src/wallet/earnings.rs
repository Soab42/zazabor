//! What tracked hours earn: an hourly rate per Time project, and the month's hours × rate recorded
//! as income, one transaction per project, never twice for the same month.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::db::{self, db_err, valid_month, Result};
use super::money;
use crate::notes::new_id;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRate {
    pub project: String,
    /// Per hour, in `currency`'s minor unit.
    pub rate_minor: i64,
    pub currency: String,
}

pub fn rates(conn: &Connection) -> Result<Vec<ProjectRate>> {
    let mut stmt = conn.prepare("SELECT project, rate_minor, currency FROM project_rates ORDER BY lower(project)").map_err(db_err)?;
    let rows = stmt.query_map([], |r| Ok(ProjectRate { project: r.get(0)?, rate_minor: r.get(1)?, currency: r.get(2)? })).map_err(db_err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db_err)
}

/// Sets a project's hourly rate; an empty rate removes it.
pub fn set_rate(conn: &Connection, project: &str, rate: &str, currency: &str, now: i64) -> Result<()> {
    let project = project.trim();
    if project.is_empty() {
        return Err("Pick a project.".into());
    }
    if rate.trim().is_empty() {
        conn.execute("DELETE FROM project_rates WHERE project = ?1", [project]).map_err(db_err)?;
        return Ok(());
    }
    if money::currency(currency).is_none() {
        return Err("Unknown currency.".into());
    }
    let minor = money::parse_amount(rate, currency).filter(|v| *v > 0).ok_or("Type the hourly rate as a number, like 1,500.")?;
    conn.execute(
        "INSERT INTO project_rates (project, rate_minor, currency, updated) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(project) DO UPDATE SET rate_minor = ?2, currency = ?3, updated = ?4",
        params![project, minor, currency, now],
    )
    .map_err(db_err)?;
    Ok(())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Earning {
    pub project: String,
    pub minutes: i64,
    pub rate: Option<ProjectRate>,
    /// Hours × rate, in the rate's currency.
    pub amount_minor: Option<i64>,
    /// The same in the base currency, at the latest rate.
    pub base_minor: Option<i64>,
    /// The income transaction already recorded for this month.
    pub posted: Option<String>,
}

fn earned(minutes: i64, rate_minor: i64) -> i64 {
    // Rounded to the nearest minor unit.
    (minutes * rate_minor + 30).div_euclid(60)
}

/// The month's earnings per project, from Time's minutes per project.
pub fn earnings(conn: &Connection, month: &str, minutes: &[(String, i64)]) -> Result<Vec<Earning>> {
    if !valid_month(month) {
        return Err("Pick a month.".into());
    }
    let rates = rates(conn)?;
    let mut out = Vec::new();
    for (project, minutes) in minutes.iter().filter(|(p, m)| !p.is_empty() && *m > 0) {
        let rate = rates.iter().find(|r| &r.project == project).cloned();
        let amount_minor = rate.as_ref().map(|r| earned(*minutes, r.rate_minor));
        let base_minor = match (&rate, amount_minor) {
            (Some(r), Some(a)) => db::rate_of(conn, &r.currency)?.map(|fx| money::to_base(a, &r.currency, fx)),
            _ => None,
        };
        let posted: Option<String> = conn
            .query_row("SELECT id FROM transactions WHERE time_project = ?1 AND time_month = ?2", params![project, month], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        out.push(Earning { project: project.clone(), minutes: *minutes, rate, amount_minor, base_minor, posted });
    }
    out.sort_by(|a, b| b.base_minor.unwrap_or(0).cmp(&a.base_minor.unwrap_or(0)).then(b.minutes.cmp(&a.minutes)));
    Ok(out)
}

/// Records the month's earnings as income into an account (one transaction per project with a
/// rate in the account's currency), dated the month's last day (or `today` within it). Refuses
/// when everything was already recorded; returns how many were added.
pub fn post(conn: &mut Connection, month: &str, minutes: &[(String, i64)], account_id: &str, category_id: Option<&str>, today: &str, now: i64) -> Result<usize> {
    let rows = earnings(conn, month, minutes)?;
    let account = db::accounts(conn)?.into_iter().find(|a| a.id == account_id).ok_or("That account no longer exists.")?;
    let rate = db::rate_of(conn, &account.currency)?.ok_or_else(|| format!("Set the rate for {} in Accounts first.", account.currency))?;
    let (_, end) = db::month_span(month);
    let date = if today.starts_with(month) { today.to_string() } else { end };
    let ready: Vec<&Earning> = rows.iter().filter(|e| e.posted.is_none() && e.rate.as_ref().is_some_and(|r| r.currency == account.currency)).collect();
    if ready.is_empty() {
        let label = month;
        return Err(if rows.iter().any(|e| e.posted.is_some()) && rows.iter().all(|e| e.posted.is_some() || e.rate.is_none()) {
            format!("The earnings for {label} are already recorded.")
        } else if rows.iter().any(|e| e.rate.is_some()) {
            format!("No rates in {}: pick an account in the rates' currency.", account.currency)
        } else {
            "Set an hourly rate for a project first.".into()
        });
    }
    let tx = conn.transaction().map_err(db_err)?;
    for e in &ready {
        let amount = e.amount_minor.unwrap_or(0);
        let hours = format!("{}:{:02} h", e.minutes / 60, e.minutes % 60);
        tx.execute(
            "INSERT INTO transactions (id, account_id, date, amount_minor, rate_micro, base_minor, category_id, payee, note, time_project, time_month, created, updated)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
            params![new_id(), account.id, date, amount, rate, money::to_base(amount, &account.currency, rate), category_id, e.project, format!("{hours} tracked in Time"), e.project, month, now],
        )
        .map_err(|err| if err.to_string().contains("UNIQUE") { format!("The earnings for {month} are already recorded.") } else { db_err(err) })?;
    }
    tx.commit().map_err(db_err)?;
    Ok(ready.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::db::tests::{add_account, cat, fresh};

    #[test]
    fn hours_become_income_once() {
        let mut conn = fresh();
        let bank = add_account(&conn, "City Bank", "bank", "BDT", None);
        set_rate(&conn, "Acme site", "1,500", "BDT", 1).unwrap();
        assert!(set_rate(&conn, "Acme site", "abc", "BDT", 1).is_err());
        set_rate(&conn, "Upwork", "20", "USD", 1).unwrap();
        db::set_rate(&conn, "USD", "120", 1).unwrap();
        let minutes = vec![("Acme site".to_string(), 615), ("Upwork".to_string(), 90), ("".to_string(), 30), ("Unrated".to_string(), 60)];
        let rows = earnings(&conn, "2026-10", &minutes).unwrap();
        assert_eq!(rows.len(), 3);
        let acme = rows.iter().find(|e| e.project == "Acme site").unwrap();
        // 10 h 15 m × ৳1,500 = ৳15,375.
        assert_eq!((acme.amount_minor, acme.base_minor), (Some(1_537_500), Some(1_537_500)));
        let upwork = rows.iter().find(|e| e.project == "Upwork").unwrap();
        assert_eq!((upwork.amount_minor, upwork.base_minor), (Some(3_000), Some(360_000)));
        // Into the taka account: only the taka project.
        let freelance = cat(&conn, "Freelance");
        assert_eq!(post(&mut conn, "2026-10", &minutes, &bank, Some(&freelance), "2026-11-02", 2).unwrap(), 1);
        let t = db::list(&conn, &db::Filter::default()).unwrap().items.remove(0);
        assert_eq!((t.date.as_str(), t.amount_minor, t.payee.as_str()), ("2026-10-31", 1_537_500, "Acme site"));
        // Posting the month again is refused.
        let again = post(&mut conn, "2026-10", &minutes, &bank, None, "2026-11-02", 3).unwrap_err();
        assert!(again.contains("pick an account") || again.contains("already"), "{again}");
        let usd = add_account(&conn, "Payoneer", "bank", "USD", None);
        assert_eq!(post(&mut conn, "2026-10", &minutes, &usd, None, "2026-11-02", 4).unwrap(), 1);
        assert!(post(&mut conn, "2026-10", &minutes, &usd, None, "2026-11-02", 5).unwrap_err().contains("already recorded"));
        assert!(earnings(&conn, "2026-10", &minutes).unwrap().iter().filter(|e| e.rate.is_some()).all(|e| e.posted.is_some()));
    }
}
