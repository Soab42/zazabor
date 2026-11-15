//! Credit cards: a card account with its credit limit, the day each statement closes and the day
//! its payment is due. What's owed on a statement is the card's debt on the day it closed; what's
//! still to pay is that, less what went into the card since. A bill can pay it by itself: an
//! automatic transfer whose amount is the statement's (`bills.rs`, `amount_mode = "statement"`).

use rusqlite::{params, Connection};
use serde::Serialize;

use super::dates;
use super::db::{self, db_err, Result};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardStatus {
    pub account_id: String,
    pub limit_minor: Option<i64>,
    /// Owed on the card now.
    pub used_minor: i64,
    /// What can still be spent (with a limit).
    pub available_minor: Option<i64>,
    /// The last statement's closing day.
    pub statement_date: Option<String>,
    /// Owed when it closed.
    pub statement_minor: i64,
    /// Paid into the card since.
    pub paid_since_minor: i64,
    /// Still to pay on it.
    pub due_minor: i64,
    /// The day it's due.
    pub due_date: Option<String>,
    /// The next statement's closing day.
    pub next_statement: Option<String>,
}

/// The last closing day on or before `on`.
pub fn last_close(statement_day: i64, on: &str) -> String {
    let day = statement_day.clamp(0, 31) as u32;
    let this = dates::in_month(on, 0, day);
    if this.as_str() <= on {
        this
    } else {
        dates::in_month(on, -1, day)
    }
}

/// The payment's due day after a statement closed on `close`.
pub fn due_after(close: &str, due_day: i64) -> String {
    let day = due_day.clamp(0, 31) as u32;
    let this = dates::in_month(close, 0, day);
    if this.as_str() > close {
        this
    } else {
        dates::in_month(close, 1, day)
    }
}

/// (owed on the last statement, paid since, still due) as of `on`.
pub fn statement(conn: &Connection, card: &db::Account, on: &str) -> Result<(String, i64, i64, i64)> {
    let close = last_close(card.statement_day, on);
    let at_close: i64 = conn
        .query_row("SELECT COALESCE(SUM(amount_minor), 0) FROM transactions WHERE account_id = ?1 AND date <= ?2", params![card.id, close], |r| r.get(0))
        .map_err(db_err)?;
    let owed = (-(card.opening_minor + at_close)).max(0);
    let paid: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount_minor), 0) FROM transactions WHERE account_id = ?1 AND date > ?2 AND date <= ?3 AND amount_minor > 0",
            params![card.id, close, on],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    Ok((close, owed, paid, (owed - paid).max(0)))
}

pub fn status(conn: &Connection, card: &db::Account, today: &str) -> Result<CardStatus> {
    let used = (-card.balance_minor).max(0);
    let mut s = CardStatus {
        account_id: card.id.clone(),
        limit_minor: card.credit_limit_minor,
        used_minor: used,
        available_minor: card.credit_limit_minor.map(|l| l - used),
        statement_date: None,
        statement_minor: 0,
        paid_since_minor: 0,
        due_minor: 0,
        due_date: None,
        next_statement: None,
    };
    if card.statement_day > 0 {
        let (close, owed, paid, due) = statement(conn, card, today)?;
        s.next_statement = Some(dates::in_month(&close, 1, card.statement_day as u32));
        s.due_date = (card.due_day > 0).then(|| due_after(&close, card.due_day));
        (s.statement_date, s.statement_minor, s.paid_since_minor, s.due_minor) = (Some(close), owed, paid, due);
    }
    Ok(s)
}

/// Every card's status.
pub fn all(conn: &Connection, today: &str) -> Result<Vec<CardStatus>> {
    db::accounts(conn)?.iter().filter(|a| a.kind == "card" && !a.archived).map(|a| status(conn, a, today)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::db::tests::{add_account, fresh};

    #[test]
    fn a_statement_closes_and_comes_due() {
        assert_eq!(last_close(5, "2026-11-14"), "2026-11-05");
        assert_eq!(last_close(20, "2026-11-14"), "2026-10-20");
        assert_eq!(last_close(31, "2026-03-01"), "2026-02-28");
        assert_eq!(due_after("2026-11-05", 25), "2026-11-25");
        assert_eq!(due_after("2026-10-20", 10), "2026-11-10");

        let conn = fresh();
        let bank = add_account(&conn, "Bank", "bank", "BDT", None);
        let card = db::save_account(&conn, db::AccountInput { id: None, name: "Visa".into(), kind: "card".into(), currency: "BDT".into(), opening: "".into(), color: "indigo".into(), rate: None,
            in_total: None, credit_limit: Some("100,000".into()), statement_day: Some(20), due_day: Some(10), details: None }, 1).unwrap();
        let spend = |amount: &str, date: &str| db::save_tx(&conn, db::TxInput { id: None, kind: "expense".into(), account_id: card.id.clone(), amount: amount.into(), date: date.into(), category_id: None, payee: "".into(), note: "".into() }, 2).unwrap();
        spend("12,000", "2026-10-05");
        spend("3,000", "2026-10-25");
        let mut conn = conn;
        db::save_transfer(&mut conn, db::TransferInput { transfer_id: None, from: bank.clone(), to: card.id.clone(), amount: "5,000".into(), received: None, fee: None, date: "2026-11-01".into(), note: "".into() }, 3).unwrap();
        let card = db::accounts(&conn).unwrap().into_iter().find(|a| a.id == card.id).unwrap();
        let s = status(&conn, &card, "2026-11-05").unwrap();
        assert_eq!((s.statement_date.as_deref(), s.statement_minor, s.paid_since_minor, s.due_minor, s.due_date.as_deref()), (Some("2026-10-20"), 1_200_000, 500_000, 700_000, Some("2026-11-10")));
        assert_eq!((s.used_minor, s.available_minor), (1_000_000, Some(9_000_000)));
    }
}
