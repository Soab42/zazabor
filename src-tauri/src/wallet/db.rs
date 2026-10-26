//! The ledger in SQLite: schema, migrations and every read and write. Everything takes a
//! `Connection`, so the tests run on an in-memory database.
//!
//! Each transaction keeps its amount in its account's currency (signed: negative is money out of
//! that account) and, fixed when it's written, the same amount in the base currency, so totals are
//! sums of integers and never move when a rate changes later. A transfer is two rows sharing a
//! `transfer_id` (out of one account, into another) plus, for a fee, a third row in Fees.

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::money::{self, BASE, RATE_ONE};
use crate::notes::new_id;

pub type Result<T> = std::result::Result<T, String>;

pub fn db_err(e: rusqlite::Error) -> String {
    format!("The wallet database: {e}")
}

pub const ACCOUNT_KINDS: [&str; 5] = ["cash", "bank", "mobile_wallet", "card", "savings"];
/// Category colours, named like the page's palette (`wallet.css`).
pub const COLORS: [&str; 11] = ["red", "orange", "amber", "green", "teal", "sky", "blue", "indigo", "purple", "pink", "gray"];

const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, currency TEXT NOT NULL,
  opening_minor INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL DEFAULT 'gray',
  archived INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE categories (
  id TEXT PRIMARY KEY, parent_id TEXT REFERENCES categories(id), name TEXT NOT NULL,
  kind TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'more', color TEXT NOT NULL DEFAULT 'gray',
  archived INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE transactions (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL, amount_minor INTEGER NOT NULL,
  rate_micro INTEGER NOT NULL DEFAULT 1000000, base_minor INTEGER NOT NULL,
  category_id TEXT REFERENCES categories(id), payee TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', transfer_id TEXT,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX tx_date ON transactions(date);
CREATE INDEX tx_account_date ON transactions(account_id, date);
CREATE INDEX tx_category ON transactions(category_id);
CREATE INDEX tx_transfer ON transactions(transfer_id);
CREATE TABLE budgets (
  month TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id),
  amount_minor INTEGER NOT NULL, PRIMARY KEY (month, category_id));
CREATE TABLE rates (currency TEXT PRIMARY KEY, rate_micro INTEGER NOT NULL, updated INTEGER NOT NULL);
"#, r#"
ALTER TABLE budgets ADD COLUMN rollover INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN recurring_id TEXT;
ALTER TABLE transactions ADD COLUMN import_batch TEXT;
ALTER TABLE transactions ADD COLUMN import_hash TEXT;
ALTER TABLE transactions ADD COLUMN time_project TEXT;
ALTER TABLE transactions ADD COLUMN time_month TEXT;
CREATE INDEX tx_import_hash ON transactions(account_id, import_hash);
CREATE INDEX tx_import_batch ON transactions(import_batch);
CREATE INDEX tx_recurring ON transactions(recurring_id);
CREATE UNIQUE INDEX tx_earning ON transactions(time_project, time_month) WHERE time_project IS NOT NULL;
CREATE TABLE recurring (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_minor INTEGER NOT NULL, category_id TEXT REFERENCES categories(id),
  payee TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  freq TEXT NOT NULL, every INTEGER NOT NULL DEFAULT 1, day INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL, end_date TEXT, next_date TEXT,
  auto_post INTEGER NOT NULL DEFAULT 0, subscription INTEGER NOT NULL DEFAULT 0,
  remind_days INTEGER NOT NULL DEFAULT 3, paused INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE receipts (
  id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  file TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE INDEX receipt_tx ON receipts(transaction_id);
CREATE TABLE rules (
  id TEXT PRIMARY KEY, pattern TEXT NOT NULL, category_id TEXT REFERENCES categories(id),
  payee TEXT NOT NULL DEFAULT '', position REAL NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE import_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, account_id TEXT, mapping TEXT NOT NULL,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, file TEXT NOT NULL, added INTEGER NOT NULL,
  skipped INTEGER NOT NULL, created INTEGER NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
CREATE TABLE project_rates (
  project TEXT PRIMARY KEY, rate_minor INTEGER NOT NULL, currency TEXT NOT NULL, updated INTEGER NOT NULL);
"#];

/// The categories a new wallet starts with: (name, icon, colour, children).
const EXPENSE_DEFAULTS: &[(&str, &str, &str, &[&str])] = &[
    ("Food", "utensils", "orange", &["Groceries", "Eating out"]),
    ("Transport", "bus", "sky", &["Rickshaw and CNG", "Ride share", "Fuel"]),
    ("Bills", "bolt", "amber", &["Electricity", "Gas", "Water", "Internet", "Mobile recharge"]),
    ("Rent", "home", "indigo", &[]),
    ("Family", "users", "pink", &[]),
    ("Health", "heart", "red", &[]),
    ("Education", "book", "blue", &[]),
    ("Shopping", "bag", "purple", &[]),
    ("Entertainment", "film", "teal", &[]),
    ("Subscriptions", "repeat", "indigo", &[]),
    ("Charity", "handHeart", "green", &["Zakat", "Sadaqah"]),
    ("Fees", "receipt", "gray", &[]),
    ("Other", "more", "gray", &[]),
];
const INCOME_DEFAULTS: &[(&str, &str, &str)] = &[
    ("Salary", "briefcase", "green"),
    ("Freelance", "laptop", "teal"),
    ("Business", "store", "blue"),
    ("Gifts", "gift", "pink"),
    ("Refunds", "undo", "sky"),
    ("Other income", "more", "gray"),
];

/// Brings the schema up to date (`PRAGMA user_version` counts the migrations run); a new
/// database also gets the default categories and a Cash account.
pub fn migrate(conn: &mut Connection, now: i64) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(db_err)?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(db_err)?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        let tx = conn.transaction().map_err(db_err)?;
        tx.execute_batch(sql).map_err(db_err)?;
        if i == 0 {
            seed(&tx, now)?;
        }
        tx.pragma_update(None, "user_version", (i + 1) as i64).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
    }
    Ok(())
}

fn seed(conn: &Connection, now: i64) -> Result<()> {
    let mut position = 0.0;
    let mut insert = |parent: Option<&str>, name: &str, kind: &str, icon: &str, color: &str| -> Result<String> {
        let id = new_id();
        position += 1.0;
        conn.execute(
            "INSERT INTO categories (id, parent_id, name, kind, icon, color, position, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![id, parent, name, kind, icon, color, position, now],
        )
        .map_err(db_err)?;
        Ok(id)
    };
    for (name, icon, color, children) in EXPENSE_DEFAULTS {
        let parent = insert(None, name, "expense", icon, color)?;
        for child in *children {
            insert(Some(&parent), child, "expense", icon, color)?;
        }
    }
    for (name, icon, color) in INCOME_DEFAULTS {
        insert(None, name, "income", icon, color)?;
    }
    conn.execute(
        "INSERT INTO accounts (id, name, kind, currency, color, position, created, updated) VALUES (?1, 'Cash', 'cash', ?2, 'green', 1, ?3, ?3)",
        params![new_id(), BASE, now],
    )
    .map_err(db_err)?;
    Ok(())
}

fn clean(text: &str, max: usize) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

/// "YYYY-MM-DD" with a real month and day.
pub fn valid_date(date: &str) -> bool {
    let b = date.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let (Ok(y), Ok(m), Ok(d)) = (date[..4].parse::<i32>(), date[5..7].parse::<u32>(), date[8..].parse::<u32>()) else {
        return false;
    };
    (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m)
}

pub fn valid_month(month: &str) -> bool {
    month.len() == 7 && valid_date(&format!("{month}-01"))
}

pub fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

/// The month `delta` months from "YYYY-MM".
pub fn add_months(month: &str, delta: i32) -> String {
    let y: i32 = month[..4].parse().unwrap_or(2000);
    let m: i32 = month[5..7].parse().unwrap_or(1);
    let total = y * 12 + (m - 1) + delta;
    format!("{:04}-{:02}", total.div_euclid(12), total.rem_euclid(12) + 1)
}

// ---- accounts

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
    /// One of `ACCOUNT_KINDS`.
    pub kind: String,
    pub currency: String,
    pub opening_minor: i64,
    pub color: String,
    pub archived: bool,
    pub position: f64,
    /// Opening balance plus every transaction, in the account's currency.
    pub balance_minor: i64,
    /// The balance in the base currency, at the latest rate (`None` without one).
    pub balance_base_minor: Option<i64>,
    pub tx_count: i64,
    /// The newest transaction's date.
    pub last_date: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    pub currency: String,
    /// As typed; may start with "-" (a card or a loan that starts in debt).
    pub opening: String,
    pub color: String,
    /// For an account not in the base currency: base units per unit, as typed.
    pub rate: Option<String>,
}

/// The latest rate typed for a currency (1 for the base currency).
pub fn rate_of(conn: &Connection, currency: &str) -> Result<Option<i64>> {
    if currency == BASE {
        return Ok(Some(RATE_ONE));
    }
    conn.query_row("SELECT rate_micro FROM rates WHERE currency = ?1", [currency], |r| r.get(0)).optional().map_err(db_err)
}

pub fn set_rate(conn: &Connection, currency: &str, rate: &str, now: i64) -> Result<()> {
    if currency == BASE || money::currency(currency).is_none() {
        return Err("Unknown currency.".into());
    }
    let rate = money::parse_rate(rate).ok_or("Type the rate as a number, like 122.50.")?;
    conn.execute(
        "INSERT INTO rates (currency, rate_micro, updated) VALUES (?1, ?2, ?3) ON CONFLICT(currency) DO UPDATE SET rate_micro = ?2, updated = ?3",
        params![currency, rate, now],
    )
    .map_err(db_err)?;
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Rate {
    pub currency: String,
    pub rate_micro: i64,
    pub updated: i64,
}

pub fn rates(conn: &Connection) -> Result<Vec<Rate>> {
    let mut stmt = conn.prepare("SELECT currency, rate_micro, updated FROM rates ORDER BY currency").map_err(db_err)?;
    let rows = stmt.query_map([], |r| Ok(Rate { currency: r.get(0)?, rate_micro: r.get(1)?, updated: r.get(2)? })).map_err(db_err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db_err)
}

pub fn accounts(conn: &Connection) -> Result<Vec<Account>> {
    let mut stmt = conn
        .prepare(
            "SELECT a.id, a.name, a.kind, a.currency, a.opening_minor, a.color, a.archived, a.position,
                    a.opening_minor + COALESCE(SUM(t.amount_minor), 0), COUNT(t.id), MAX(t.date)
             FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
             GROUP BY a.id ORDER BY a.archived, a.position, a.created",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Account {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                currency: r.get(3)?,
                opening_minor: r.get(4)?,
                color: r.get(5)?,
                archived: r.get(6)?,
                position: r.get(7)?,
                balance_minor: r.get(8)?,
                balance_base_minor: None,
                tx_count: r.get(9)?,
                last_date: r.get(10)?,
            })
        })
        .map_err(db_err)?;
    let mut list: Vec<Account> = rows.collect::<std::result::Result<_, _>>().map_err(db_err)?;
    for account in &mut list {
        account.balance_base_minor = rate_of(conn, &account.currency)?.map(|rate| money::to_base(account.balance_minor, &account.currency, rate));
    }
    Ok(list)
}

fn account(conn: &Connection, id: &str) -> Result<Account> {
    accounts(conn)?.into_iter().find(|a| a.id == id).ok_or_else(|| "That account no longer exists.".into())
}

/// The opening balance as typed, signed.
fn parse_signed(text: &str, currency: &str) -> Result<i64> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(0);
    }
    let negative = text.starts_with('-') || text.starts_with('−');
    let amount = money::parse_amount(text, currency).ok_or("Type the amount as a number, like 1,250.50.")?;
    Ok(if negative { -amount } else { amount })
}

pub fn save_account(conn: &Connection, input: AccountInput, now: i64) -> Result<Account> {
    let name = clean(&input.name, 80);
    if name.is_empty() {
        return Err("Give the account a name.".into());
    }
    if !ACCOUNT_KINDS.contains(&input.kind.as_str()) {
        return Err("Unknown kind of account.".into());
    }
    if money::currency(&input.currency).is_none() {
        return Err("Unknown currency.".into());
    }
    let color = if COLORS.contains(&input.color.as_str()) { input.color.clone() } else { "gray".into() };
    let opening = parse_signed(&input.opening, &input.currency)?;
    if let Some(rate) = input.rate.as_deref().filter(|r| !r.trim().is_empty()) {
        set_rate(conn, &input.currency, rate, now)?;
    } else if rate_of(conn, &input.currency)?.is_none() {
        return Err(format!("Type how many {BASE} one {} is.", input.currency));
    }
    let id = match input.id {
        Some(id) => {
            let before = account(conn, &id)?;
            if before.currency != input.currency && before.tx_count > 0 {
                return Err("An account with transactions keeps its currency.".into());
            }
            conn.execute(
                "UPDATE accounts SET name = ?2, kind = ?3, currency = ?4, opening_minor = ?5, color = ?6, updated = ?7 WHERE id = ?1",
                params![id, name, input.kind, input.currency, opening, color, now],
            )
            .map_err(db_err)?;
            id
        }
        None => {
            let id = new_id();
            let position: f64 = conn.query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM accounts", [], |r| r.get(0)).map_err(db_err)?;
            conn.execute(
                "INSERT INTO accounts (id, name, kind, currency, opening_minor, color, position, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![id, name, input.kind, input.currency, opening, color, position, now],
            )
            .map_err(db_err)?;
            id
        }
    };
    account(conn, &id)
}

pub fn archive_account(conn: &Connection, id: &str, archived: bool, now: i64) -> Result<()> {
    let n = conn.execute("UPDATE accounts SET archived = ?2, updated = ?3 WHERE id = ?1", params![id, archived, now]).map_err(db_err)?;
    if n == 0 {
        return Err("That account no longer exists.".into());
    }
    Ok(())
}

/// Only an account with no transactions goes; one with history is archived instead.
pub fn delete_account(conn: &Connection, id: &str) -> Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM transactions WHERE account_id = ?1", [id], |r| r.get(0)).map_err(db_err)?;
    if count > 0 {
        return Err("This account has transactions. Archive it instead, to keep its history.".into());
    }
    conn.execute("DELETE FROM accounts WHERE id = ?1", [id]).map_err(db_err)?;
    Ok(())
}

// ---- categories

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    /// "expense" or "income".
    pub kind: String,
    /// An icon name from the page's set.
    pub icon: String,
    pub color: String,
    pub archived: bool,
    pub position: f64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInput {
    pub id: Option<String>,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: String,
    pub icon: String,
    pub color: String,
}

pub fn categories(conn: &Connection) -> Result<Vec<Category>> {
    let mut stmt = conn
        .prepare("SELECT id, parent_id, name, kind, icon, color, archived, position FROM categories ORDER BY kind DESC, position, created")
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Category {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                name: r.get(2)?,
                kind: r.get(3)?,
                icon: r.get(4)?,
                color: r.get(5)?,
                archived: r.get(6)?,
                position: r.get(7)?,
            })
        })
        .map_err(db_err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db_err)
}

pub fn save_category(conn: &Connection, input: CategoryInput, now: i64) -> Result<Category> {
    let name = clean(&input.name, 60);
    if name.is_empty() {
        return Err("Give the category a name.".into());
    }
    if input.kind != "expense" && input.kind != "income" {
        return Err("A category is for spending or for income.".into());
    }
    let all = categories(conn)?;
    if let Some(parent) = &input.parent_id {
        let Some(p) = all.iter().find(|c| &c.id == parent) else {
            return Err("That parent category no longer exists.".into());
        };
        if p.parent_id.is_some() {
            return Err("Categories go two levels deep.".into());
        }
        if p.kind != input.kind || Some(parent) == input.id.as_ref() {
            return Err("A sub-category is of the same kind as its parent.".into());
        }
        if input.id.as_ref().is_some_and(|id| all.iter().any(|c| c.parent_id.as_ref() == Some(id))) {
            return Err("A category with sub-categories stays at the top.".into());
        }
    }
    let color = if COLORS.contains(&input.color.as_str()) { input.color } else { "gray".into() };
    let icon = clean(&input.icon, 40);
    let id = match input.id {
        Some(id) => {
            let n = conn
                .execute(
                    "UPDATE categories SET parent_id = ?2, name = ?3, kind = ?4, icon = ?5, color = ?6, updated = ?7 WHERE id = ?1",
                    params![id, input.parent_id, name, input.kind, icon, color, now],
                )
                .map_err(db_err)?;
            if n == 0 {
                return Err("That category no longer exists.".into());
            }
            id
        }
        None => {
            let id = new_id();
            let position: f64 = conn.query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM categories", [], |r| r.get(0)).map_err(db_err)?;
            conn.execute(
                "INSERT INTO categories (id, parent_id, name, kind, icon, color, position, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![id, input.parent_id, name, input.kind, icon, color, position, now],
            )
            .map_err(db_err)?;
            id
        }
    };
    categories(conn)?.into_iter().find(|c| c.id == id).ok_or_else(|| "The category vanished.".into())
}

/// Archives a category (and, for a top category, its sub-categories), or brings it back (with
/// its parent). Archived ones stay in reports and on their transactions but leave the pickers.
pub fn archive_category(conn: &Connection, id: &str, archived: bool, now: i64) -> Result<()> {
    let n = conn
        .execute("UPDATE categories SET archived = ?2, updated = ?3 WHERE id = ?1 OR parent_id = ?1", params![id, archived, now])
        .map_err(db_err)?;
    if n == 0 {
        return Err("That category no longer exists.".into());
    }
    if !archived {
        conn.execute("UPDATE categories SET archived = 0, updated = ?2 WHERE id = (SELECT parent_id FROM categories WHERE id = ?1)", params![id, now])
            .map_err(db_err)?;
    }
    Ok(())
}

/// Deletes a category and its sub-categories; their transactions move to `move_to` (or to no
/// category), and their budgets go.
pub fn delete_category(conn: &mut Connection, id: &str, move_to: Option<&str>) -> Result<()> {
    let tx = conn.transaction().map_err(db_err)?;
    let ids: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM categories WHERE id = ?1 OR parent_id = ?1").map_err(db_err)?;
        let rows = stmt.query_map([id], |r| r.get(0)).map_err(db_err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(db_err)?
    };
    if ids.is_empty() {
        return Err("That category no longer exists.".into());
    }
    if move_to.is_some_and(|m| ids.iter().any(|i| i == m)) {
        return Err("Move its transactions to another category.".into());
    }
    for cat in &ids {
        tx.execute("UPDATE transactions SET category_id = ?2 WHERE category_id = ?1", params![cat, move_to]).map_err(db_err)?;
        tx.execute("UPDATE recurring SET category_id = ?2 WHERE category_id = ?1", params![cat, move_to]).map_err(db_err)?;
        tx.execute("UPDATE rules SET category_id = ?2 WHERE category_id = ?1", params![cat, move_to]).map_err(db_err)?;
        tx.execute("DELETE FROM budgets WHERE category_id = ?1", [cat]).map_err(db_err)?;
    }
    for cat in ids.iter().rev() {
        tx.execute("DELETE FROM categories WHERE id = ?1", [cat]).map_err(db_err)?;
    }
    tx.commit().map_err(db_err)
}

// ---- transactions

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tx {
    pub id: String,
    pub account_id: String,
    /// The account's currency.
    pub currency: String,
    pub date: String,
    /// Signed, in the account's currency.
    pub amount_minor: i64,
    pub base_minor: i64,
    pub rate_micro: i64,
    pub category_id: Option<String>,
    pub payee: String,
    pub note: String,
    pub transfer_id: Option<String>,
    /// "expense", "income" or "transfer" (a transfer's fee is an expense).
    pub kind: String,
    /// The other side of a transfer.
    pub counter_account_id: Option<String>,
    pub created: i64,
    /// Receipts attached.
    pub receipts: i64,
    /// The bill that posted it.
    pub recurring_id: Option<String>,
    /// The import that added it (Undo Import removes the batch).
    pub import_batch: Option<String>,
}

const TX_SELECT: &str = "SELECT t.id, t.account_id, a.currency, t.date, t.amount_minor, t.base_minor, t.rate_micro, t.category_id,
       t.payee, t.note, t.transfer_id,
       CASE WHEN t.transfer_id IS NOT NULL AND t.category_id IS NULL THEN 'transfer' WHEN t.amount_minor < 0 THEN 'expense' ELSE 'income' END,
       (SELECT o.account_id FROM transactions o WHERE t.transfer_id IS NOT NULL AND o.transfer_id = t.transfer_id AND o.id <> t.id AND o.category_id IS NULL LIMIT 1),
       t.created, (SELECT COUNT(*) FROM receipts r WHERE r.transaction_id = t.id), t.recurring_id, t.import_batch
  FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id";

/// The derived kind, for WHERE clauses.
const TX_KIND: &str = "(CASE WHEN t.transfer_id IS NOT NULL AND t.category_id IS NULL THEN 'transfer' WHEN t.amount_minor < 0 THEN 'expense' ELSE 'income' END)";

fn tx_row(r: &Row) -> rusqlite::Result<Tx> {
    Ok(Tx {
        id: r.get(0)?,
        account_id: r.get(1)?,
        currency: r.get(2)?,
        date: r.get(3)?,
        amount_minor: r.get(4)?,
        base_minor: r.get(5)?,
        rate_micro: r.get(6)?,
        category_id: r.get(7)?,
        payee: r.get(8)?,
        note: r.get(9)?,
        transfer_id: r.get(10)?,
        kind: r.get(11)?,
        counter_account_id: r.get(12)?,
        created: r.get(13)?,
        receipts: r.get(14)?,
        recurring_id: r.get(15)?,
        import_batch: r.get(16)?,
    })
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    /// Dates, inclusive.
    pub from: Option<String>,
    pub to: Option<String>,
    pub account_id: Option<String>,
    /// Includes its sub-categories.
    pub category_id: Option<String>,
    /// "expense", "income" or "transfer".
    pub kind: Option<String>,
    pub search: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TxPage {
    pub items: Vec<Tx>,
    /// How many match, beyond this page.
    pub total: i64,
    /// Over everything that matches, in the base currency: money in and money out (transfers
    /// between your own accounts count as neither).
    pub income_minor: i64,
    pub spending_minor: i64,
}

fn filter_sql(f: &Filter) -> (String, Vec<Value>) {
    let mut clauses = vec!["1 = 1".to_string()];
    let mut values: Vec<Value> = Vec::new();
    // `?` in a clause stands for the value added with it.
    let mut add = |clause: &str, value: String| {
        values.push(Value::Text(value));
        clauses.push(clause.replace('?', &format!("?{}", values.len())));
    };
    if let Some(from) = f.from.as_ref().filter(|d| valid_date(d)) {
        add("t.date >= ?", from.clone());
    }
    if let Some(to) = f.to.as_ref().filter(|d| valid_date(d)) {
        add("t.date <= ?", to.clone());
    }
    if let Some(account) = &f.account_id {
        add("t.account_id = ?", account.clone());
    }
    if let Some(category) = &f.category_id {
        add("(t.category_id = ? OR t.category_id IN (SELECT id FROM categories WHERE parent_id = ?))", category.clone());
    }
    if let Some(kind) = f.kind.as_ref().filter(|k| ["expense", "income", "transfer"].contains(&k.as_str())) {
        add(&format!("{TX_KIND} = ?"), kind.clone());
    }
    for word in f.search.as_deref().unwrap_or("").split_whitespace().take(8) {
        let like = format!("%{}%", word.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        add("(t.payee LIKE ? ESCAPE '\\' OR t.note LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR a.name LIKE ? ESCAPE '\\')", like);
    }
    (clauses.join(" AND "), values)
}

pub fn list(conn: &Connection, f: &Filter) -> Result<TxPage> {
    let (clause, values) = filter_sql(f);
    let limit = f.limit.unwrap_or(100).clamp(1, 1000);
    let offset = f.offset.unwrap_or(0).max(0);
    let sql = format!("{TX_SELECT} WHERE {clause} ORDER BY t.date DESC, t.created DESC LIMIT {limit} OFFSET {offset}");
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let items = stmt.query_map(params_from_iter(values.iter()), tx_row).map_err(db_err)?.collect::<std::result::Result<Vec<_>, _>>().map_err(db_err)?;
    let sums = format!(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN {TX_KIND} = 'income' THEN t.base_minor END), 0), COALESCE(-SUM(CASE WHEN {TX_KIND} = 'expense' THEN t.base_minor END), 0)
           FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id WHERE {clause}"
    );
    let (total, income_minor, spending_minor) =
        conn.query_row(&sums, params_from_iter(values.iter()), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(db_err)?;
    Ok(TxPage { items, total, income_minor, spending_minor })
}

pub fn tx(conn: &Connection, id: &str) -> Result<Tx> {
    conn.query_row(&format!("{TX_SELECT} WHERE t.id = ?1"), [id], tx_row).optional().map_err(db_err)?.ok_or_else(|| "That transaction no longer exists.".into())
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TxInput {
    pub id: Option<String>,
    /// "expense" or "income".
    pub kind: String,
    pub account_id: String,
    /// As typed, without a sign.
    pub amount: String,
    pub date: String,
    pub category_id: Option<String>,
    #[serde(default)]
    pub payee: String,
    #[serde(default)]
    pub note: String,
}

pub fn save_tx(conn: &Connection, input: TxInput, now: i64) -> Result<Tx> {
    if input.kind != "expense" && input.kind != "income" {
        return Err("A transaction is spending or income.".into());
    }
    let account = account(conn, &input.account_id)?;
    let amount = money::parse_amount(&input.amount, &account.currency).ok_or("Type the amount as a number, like 1,250.50.")?;
    if amount == 0 {
        return Err("The amount can't be zero.".into());
    }
    if !valid_date(&input.date) {
        return Err("Pick a date.".into());
    }
    if let Some(cat) = &input.category_id {
        let found: Option<i64> = conn.query_row("SELECT 1 FROM categories WHERE id = ?1", [cat], |r| r.get(0)).optional().map_err(db_err)?;
        if found.is_none() {
            return Err("That category no longer exists.".into());
        }
    }
    let rate = rate_of(conn, &account.currency)?.ok_or_else(|| format!("Set the rate for {} in Accounts first.", account.currency))?;
    let signed = if input.kind == "income" { amount } else { -amount };
    let base = money::to_base(signed, &account.currency, rate);
    let payee = clean(&input.payee, 120);
    let note = input.note.trim().chars().take(2000).collect::<String>();
    let id = match input.id {
        Some(id) => {
            let before = tx(conn, &id)?;
            if before.transfer_id.is_some() && before.kind == "transfer" {
                return Err("Edit the transfer instead.".into());
            }
            conn.execute(
                "UPDATE transactions SET account_id = ?2, date = ?3, amount_minor = ?4, rate_micro = ?5, base_minor = ?6, category_id = ?7, payee = ?8, note = ?9, updated = ?10 WHERE id = ?1",
                params![id, account.id, input.date, signed, rate, base, input.category_id, payee, note, now],
            )
            .map_err(db_err)?;
            id
        }
        None => {
            let id = new_id();
            conn.execute(
                "INSERT INTO transactions (id, account_id, date, amount_minor, rate_micro, base_minor, category_id, payee, note, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![id, account.id, input.date, signed, rate, base, input.category_id, payee, note, now],
            )
            .map_err(db_err)?;
            id
        }
    };
    tx(conn, &id)
}

/// Deletes transactions; a transfer goes as a whole (both sides and its fee).
pub fn delete_txs(conn: &mut Connection, ids: &[String]) -> Result<usize> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut n = 0;
    for id in ids {
        let transfer: Option<Option<String>> = tx.query_row("SELECT transfer_id FROM transactions WHERE id = ?1", [id], |r| r.get(0)).optional().map_err(db_err)?;
        n += match transfer {
            Some(Some(t)) => tx.execute("DELETE FROM transactions WHERE transfer_id = ?1", [t]).map_err(db_err)?,
            Some(None) => tx.execute("DELETE FROM transactions WHERE id = ?1", [id]).map_err(db_err)?,
            None => 0,
        };
    }
    tx.commit().map_err(db_err)?;
    Ok(n)
}

/// Puts transactions in a category (transfers keep none).
pub fn set_category(conn: &Connection, ids: &[String], category_id: Option<&str>, now: i64) -> Result<usize> {
    let mut n = 0;
    for id in ids {
        n += conn
            .execute(
                "UPDATE transactions SET category_id = ?2, updated = ?3 WHERE id = ?1 AND NOT (transfer_id IS NOT NULL AND category_id IS NULL)",
                params![id, category_id, now],
            )
            .map_err(db_err)?;
    }
    Ok(n)
}

// ---- transfers

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransferInput {
    /// Set when editing a transfer.
    pub transfer_id: Option<String>,
    pub from: String,
    pub to: String,
    /// Out of `from`, in its currency.
    pub amount: String,
    /// Into `to`, in its currency; needed only when the currencies differ.
    pub received: Option<String>,
    /// Charged on top by `from` (a bKash cash-out fee); booked in Fees.
    pub fee: Option<String>,
    pub date: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub transfer_id: String,
    pub from: String,
    pub to: String,
    pub amount_minor: i64,
    pub received_minor: i64,
    pub fee_minor: i64,
    pub date: String,
    pub note: String,
}

fn fees_category(conn: &Connection, now: i64) -> Result<String> {
    let found: Option<String> = conn
        .query_row("SELECT id FROM categories WHERE kind = 'expense' AND parent_id IS NULL AND lower(name) = 'fees' LIMIT 1", [], |r| r.get(0))
        .optional()
        .map_err(db_err)?;
    match found {
        Some(id) => Ok(id),
        None => Ok(save_category(conn, CategoryInput { id: None, parent_id: None, name: "Fees".into(), kind: "expense".into(), icon: "receipt".into(), color: "gray".into() }, now)?.id),
    }
}

pub fn save_transfer(conn: &mut Connection, input: TransferInput, now: i64) -> Result<Transfer> {
    if input.from == input.to {
        return Err("Pick two different accounts.".into());
    }
    let from = account(conn, &input.from)?;
    let to = account(conn, &input.to)?;
    let amount = money::parse_amount(&input.amount, &from.currency).filter(|a| *a > 0).ok_or("Type the amount as a number, like 1,250.50.")?;
    let received = if from.currency == to.currency {
        amount
    } else {
        let text = input.received.as_deref().unwrap_or("").trim();
        money::parse_amount(text, &to.currency).filter(|a| *a > 0).ok_or_else(|| format!("Type how much arrives in {}.", to.currency))?
    };
    let fee = match input.fee.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        Some(text) => money::parse_amount(text, &from.currency).ok_or("Type the fee as a number.")?,
        None => 0,
    };
    if !valid_date(&input.date) {
        return Err("Pick a date.".into());
    }
    let rate_from = rate_of(conn, &from.currency)?.ok_or_else(|| format!("Set the rate for {} in Accounts first.", from.currency))?;
    let rate_to = rate_of(conn, &to.currency)?.ok_or_else(|| format!("Set the rate for {} in Accounts first.", to.currency))?;
    let fees = if fee > 0 { Some(fees_category(conn, now)?) } else { None };
    let note = input.note.trim().chars().take(2000).collect::<String>();
    let id = input.transfer_id.unwrap_or_else(new_id);
    let tx = conn.transaction().map_err(db_err)?;
    let created: i64 = tx
        .query_row("SELECT MIN(created) FROM transactions WHERE transfer_id = ?1", [&id], |r| r.get::<_, Option<i64>>(0))
        .map_err(db_err)?
        .unwrap_or(now);
    tx.execute("DELETE FROM transactions WHERE transfer_id = ?1", [&id]).map_err(db_err)?;
    let insert = |account: &str, amount: i64, currency: &str, rate: i64, category: Option<&str>| {
        tx.execute(
            "INSERT INTO transactions (id, account_id, date, amount_minor, rate_micro, base_minor, category_id, payee, note, transfer_id, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![new_id(), account, input.date, amount, rate, money::to_base(amount, currency, rate), category, if category.is_some() { "Transfer fee" } else { "" }, note, id, created, now],
        )
        .map_err(db_err)
    };
    insert(&from.id, -amount, &from.currency, rate_from, None)?;
    insert(&to.id, received, &to.currency, rate_to, None)?;
    if let Some(cat) = &fees {
        insert(&from.id, -fee, &from.currency, rate_from, Some(cat))?;
    }
    tx.commit().map_err(db_err)?;
    transfer(conn, &id)
}

pub fn transfer(conn: &Connection, id: &str) -> Result<Transfer> {
    let mut stmt = conn
        .prepare("SELECT account_id, amount_minor, category_id IS NOT NULL, date, note FROM transactions WHERE transfer_id = ?1")
        .map_err(db_err)?;
    let rows: Vec<(String, i64, bool, String, String)> = stmt
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .map_err(db_err)?
        .collect::<std::result::Result<_, _>>()
        .map_err(db_err)?;
    let out = rows.iter().find(|r| !r.2 && r.1 < 0).ok_or("That transfer no longer exists.")?;
    let into = rows.iter().find(|r| !r.2 && r.1 > 0).ok_or("That transfer no longer exists.")?;
    let fee = rows.iter().filter(|r| r.2).map(|r| -r.1).sum();
    Ok(Transfer {
        transfer_id: id.into(),
        from: out.0.clone(),
        to: into.0.clone(),
        amount_minor: -out.1,
        received_minor: into.1,
        fee_minor: fee,
        date: out.3.clone(),
        note: out.4.clone(),
    })
}

// ---- budgets and reports

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BudgetRow {
    pub category_id: String,
    /// As set for the month, without what rolled over.
    pub budget_minor: Option<i64>,
    /// In the month, base currency; a parent's includes its sub-categories'.
    pub spent_minor: i64,
    /// What's left of last month's budget is added to this one.
    pub rollover: bool,
    /// What rolled over from last month (0 without roll-over).
    pub carry_minor: i64,
}

/// Spending per category in `from..=to` (dates), base currency; refunds into a spending category
/// lower it.
fn spent_by_category(conn: &Connection, from: &str, to: &str) -> Result<HashMap<String, i64>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT t.category_id, -SUM(t.base_minor) FROM transactions t JOIN categories c ON c.id = t.category_id
              WHERE c.kind = 'expense' AND t.date >= ?1 AND t.date <= ?2 AND {TX_KIND} <> 'transfer' GROUP BY t.category_id"
        ))
        .map_err(db_err)?;
    let rows = stmt.query_map([from, to], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(db_err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db_err)
}

pub fn month_span(month: &str) -> (String, String) {
    let y: i32 = month[..4].parse().unwrap_or(2000);
    let m: u32 = month[5..7].parse().unwrap_or(1);
    (format!("{month}-01"), format!("{month}-{:02}", days_in_month(y, m)))
}

/// How far back a roll-over looks for what was left.
const ROLLOVER_MONTHS: i32 = 24;

/// Spending per category in a month, a parent's including its sub-categories'.
fn spent_in_month(conn: &Connection, month: &str, cats: &[Category]) -> Result<HashMap<String, i64>> {
    let (from, to) = month_span(month);
    let own = spent_by_category(conn, &from, &to)?;
    let mut out = own.clone();
    for c in cats {
        if let (Some(parent), Some(v)) = (&c.parent_id, own.get(&c.id)) {
            *out.entry(parent.clone()).or_insert(0) += v;
        }
    }
    Ok(out)
}

/// A month's budgets: category → (amount, rollover).
fn budget_rows(conn: &Connection, month: &str) -> Result<HashMap<String, (i64, bool)>> {
    let mut stmt = conn.prepare("SELECT category_id, amount_minor, rollover FROM budgets WHERE month = ?1").map_err(db_err)?;
    let rows = stmt.query_map([month], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, bool>(2)?)))).map_err(db_err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db_err)
}

/// What rolls into `month` for a category whose budget there rolls over: what was left of the
/// month before (its own budget plus what rolled into it), never below zero. A month without a
/// budget for the category leaves nothing.
fn carry_into(conn: &Connection, month: &str, category: &str, cats: &[Category], cache: &mut HashMap<String, (HashMap<String, (i64, bool)>, HashMap<String, i64>)>) -> Result<i64> {
    // Walk back to the first month of the chain, then forward.
    let mut chain: Vec<(String, i64, i64)> = Vec::new();
    let mut m = add_months(month, -1);
    for _ in 0..ROLLOVER_MONTHS {
        if !cache.contains_key(&m) {
            let rows = budget_rows(conn, &m)?;
            let spent = spent_in_month(conn, &m, cats)?;
            cache.insert(m.clone(), (rows, spent));
        }
        let (rows, spent) = &cache[&m];
        let Some(&(amount, rollover)) = rows.get(category) else { break };
        chain.push((m.clone(), amount, spent.get(category).copied().unwrap_or(0)));
        if !rollover {
            break;
        }
        m = add_months(&m, -1);
    }
    // The oldest month first: its own carry is zero (it doesn't roll over, or the chain ended).
    let mut carry = 0i64;
    for (i, (_, amount, spent)) in chain.iter().rev().enumerate() {
        let carried_in = if i == 0 { 0 } else { carry };
        carry = (amount + carried_in - spent).max(0);
    }
    Ok(carry)
}

/// A row for every spending category: its budget for `month` (if any), what rolled over into
/// it, and what was spent.
pub fn budgets(conn: &Connection, month: &str) -> Result<Vec<BudgetRow>> {
    if !valid_month(month) {
        return Err("Pick a month.".into());
    }
    let cats: Vec<Category> = categories(conn)?.into_iter().filter(|c| c.kind == "expense").collect();
    let spent = spent_in_month(conn, month, &cats)?;
    let budget = budget_rows(conn, month)?;
    let mut cache = HashMap::new();
    let mut out = Vec::new();
    for c in cats.iter().filter(|c| !c.archived || budget.contains_key(&c.id) || spent.get(&c.id).is_some_and(|v| *v != 0)) {
        let (budget_minor, rollover) = match budget.get(&c.id) {
            Some(&(amount, rollover)) => (Some(amount), rollover),
            None => (None, false),
        };
        let carry_minor = if rollover { carry_into(conn, month, &c.id, &cats, &mut cache)? } else { 0 };
        out.push(BudgetRow { category_id: c.id.clone(), budget_minor, spent_minor: spent.get(&c.id).copied().unwrap_or(0), rollover, carry_minor });
    }
    Ok(out)
}

/// Turns roll-over on or off for a category's budget in a month (it needs a budget there).
pub fn set_rollover(conn: &Connection, month: &str, category_id: &str, on: bool) -> Result<()> {
    if !valid_month(month) {
        return Err("Pick a month.".into());
    }
    let n = conn
        .execute("UPDATE budgets SET rollover = ?3 WHERE month = ?1 AND category_id = ?2", params![month, category_id, on])
        .map_err(db_err)?;
    if n == 0 {
        return Err("Set a budget for this month first.".into());
    }
    Ok(())
}

/// Sets (or, with an empty amount, removes) a category's budget for a month, in the base currency.
pub fn set_budget(conn: &Connection, month: &str, category_id: &str, amount: &str) -> Result<()> {
    if !valid_month(month) {
        return Err("Pick a month.".into());
    }
    if amount.trim().is_empty() {
        conn.execute("DELETE FROM budgets WHERE month = ?1 AND category_id = ?2", params![month, category_id]).map_err(db_err)?;
        return Ok(());
    }
    let minor = money::parse_amount(amount, BASE).ok_or("Type the budget as a number.")?;
    conn.execute(
        "INSERT INTO budgets (month, category_id, amount_minor) VALUES (?1, ?2, ?3) ON CONFLICT(month, category_id) DO UPDATE SET amount_minor = ?3",
        params![month, category_id, minor],
    )
    .map_err(db_err)?;
    Ok(())
}

/// Copies one month's budgets to another (replacing the ones already set there).
pub fn copy_budgets(conn: &Connection, from: &str, to: &str) -> Result<usize> {
    if !valid_month(from) || !valid_month(to) {
        return Err("Pick a month.".into());
    }
    conn.execute(
        "INSERT INTO budgets (month, category_id, amount_minor, rollover) SELECT ?2, category_id, amount_minor, rollover FROM budgets WHERE month = ?1
           ON CONFLICT(month, category_id) DO UPDATE SET amount_minor = excluded.amount_minor, rollover = excluded.rollover",
        params![from, to],
    )
    .map_err(db_err)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CategorySpend {
    pub category_id: String,
    /// Including its sub-categories.
    pub spent_minor: i64,
    pub children: Vec<CategorySpend>,
}

/// Spending per top-level category in `from..=to`, largest first, with their sub-categories.
pub fn by_category(conn: &Connection, from: &str, to: &str) -> Result<Vec<CategorySpend>> {
    let spent = spent_by_category(conn, from, to)?;
    let cats: Vec<Category> = categories(conn)?.into_iter().filter(|c| c.kind == "expense").collect();
    let mut out: Vec<CategorySpend> = cats
        .iter()
        .filter(|c| c.parent_id.is_none())
        .map(|c| {
            let mut children: Vec<CategorySpend> = cats
                .iter()
                .filter(|k| k.parent_id.as_ref() == Some(&c.id))
                .filter_map(|k| spent.get(&k.id).map(|s| CategorySpend { category_id: k.id.clone(), spent_minor: *s, children: vec![] }))
                .filter(|k| k.spent_minor != 0)
                .collect();
            children.sort_by_key(|k| std::cmp::Reverse(k.spent_minor));
            let own = spent.get(&c.id).copied().unwrap_or(0);
            CategorySpend { category_id: c.id.clone(), spent_minor: own + children.iter().map(|k| k.spent_minor).sum::<i64>(), children }
        })
        .filter(|c| c.spent_minor != 0)
        .collect();
    out.sort_by_key(|c| std::cmp::Reverse(c.spent_minor));
    Ok(out)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonthTotals {
    /// "YYYY-MM".
    pub month: String,
    pub income_minor: i64,
    pub spending_minor: i64,
    /// Net worth at the end of the month, base currency.
    pub net_worth_minor: i64,
}

/// The `count` months up to `last` (oldest first): income, spending and net worth at each end.
/// Opening balances count at the latest rate; transactions at the rate they were written with.
pub fn months(conn: &Connection, last: &str, count: i32) -> Result<Vec<MonthTotals>> {
    if !valid_month(last) {
        return Err("Pick a month.".into());
    }
    let count = count.clamp(1, 120);
    let first = add_months(last, -(count - 1));
    let mut opening = 0i64;
    for a in accounts(conn)? {
        if let Some(rate) = rate_of(conn, &a.currency)? {
            opening += money::to_base(a.opening_minor, &a.currency, rate);
        }
    }
    let before: i64 = conn
        .query_row("SELECT COALESCE(SUM(base_minor), 0) FROM transactions WHERE date < ?1", [format!("{first}-01")], |r| r.get(0))
        .map_err(db_err)?;
    let mut per_month: std::collections::HashMap<String, (i64, i64, i64)> = std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT substr(t.date, 1, 7), COALESCE(SUM(CASE WHEN {TX_KIND} = 'income' THEN t.base_minor END), 0),
                        COALESCE(-SUM(CASE WHEN {TX_KIND} = 'expense' THEN t.base_minor END), 0), COALESCE(SUM(t.base_minor), 0)
                   FROM transactions t WHERE t.date >= ?1 GROUP BY substr(t.date, 1, 7)"
            ))
            .map_err(db_err)?;
        let rows = stmt.query_map([format!("{first}-01")], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)))).map_err(db_err)?;
        for row in rows {
            let (k, v) = row.map_err(db_err)?;
            per_month.insert(k, v);
        }
    }
    let mut running = opening + before;
    Ok((0..count)
        .map(|i| {
            let month = add_months(&first, i);
            let (income_minor, spending_minor, net) = per_month.get(&month).copied().unwrap_or((0, 0, 0));
            running += net;
            MonthTotals { month, income_minor, spending_minor, net_worth_minor: running }
        })
        .collect())
}

/// Past payees, most used first, for the add sheet's suggestions.
pub fn payees(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT payee FROM transactions WHERE payee <> '' AND transfer_id IS NULL GROUP BY lower(payee) ORDER BY COUNT(*) DESC, MAX(created) DESC LIMIT 200")
        .map_err(db_err)?;
    let rows = stmt.query_map([], |r| r.get(0)).map_err(db_err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db_err)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn fresh() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, 1).unwrap();
        conn
    }

    pub fn cat(conn: &Connection, name: &str) -> String {
        categories(conn).unwrap().into_iter().find(|c| c.name == name).unwrap().id
    }

    pub fn add_account(conn: &Connection, name: &str, kind: &str, currency: &str, rate: Option<&str>) -> String {
        save_account(conn, AccountInput { id: None, name: name.into(), kind: kind.into(), currency: currency.into(), opening: "".into(), color: "blue".into(), rate: rate.map(Into::into) }, 2)
            .unwrap()
            .id
    }

    fn spend(conn: &Connection, account: &str, amount: &str, date: &str, category: &str) -> Tx {
        save_tx(conn, TxInput { id: None, kind: "expense".into(), account_id: account.into(), amount: amount.into(), date: date.into(), category_id: Some(cat(conn, category)), payee: "".into(), note: "".into() }, 3).unwrap()
    }

    #[test]
    fn a_new_wallet_has_categories_and_cash() {
        let mut conn = fresh();
        let cats = categories(&conn).unwrap();
        assert!(cats.iter().any(|c| c.name == "Eating out" && c.parent_id.is_some()));
        assert!(cats.iter().any(|c| c.name == "Salary" && c.kind == "income"));
        assert_eq!(accounts(&conn).unwrap()[0].name, "Cash");
        // Running the migrations again changes nothing.
        migrate(&mut conn, 5).unwrap();
        assert_eq!(categories(&conn).unwrap().len(), cats.len());
    }

    #[test]
    fn balances_follow_signed_amounts() {
        let conn = fresh();
        let cash = accounts(&conn).unwrap()[0].id.clone();
        spend(&conn, &cash, "250", "2026-10-26", "Eating out");
        save_tx(&conn, TxInput { id: None, kind: "income".into(), account_id: cash.clone(), amount: "1,000".into(), date: "2026-10-25".into(), category_id: Some(cat(&conn, "Gifts")), payee: "".into(), note: "".into() }, 4).unwrap();
        let a = account(&conn, &cash).unwrap();
        assert_eq!(a.balance_minor, 75_000);
        assert_eq!(a.balance_base_minor, Some(75_000));
        let page = list(&conn, &Filter::default()).unwrap();
        assert_eq!((page.total, page.income_minor, page.spending_minor), (2, 100_000, 25_000));
    }

    #[test]
    fn a_transfer_moves_money_without_spending_it() {
        let mut conn = fresh();
        let cash = accounts(&conn).unwrap()[0].id.clone();
        let bkash = add_account(&conn, "bKash", "mobile_wallet", "BDT", None);
        save_tx(&conn, TxInput { id: None, kind: "income".into(), account_id: bkash.clone(), amount: "5000".into(), date: "2026-10-01".into(), category_id: Some(cat(&conn, "Salary")), payee: "".into(), note: "".into() }, 4).unwrap();
        let t = save_transfer(&mut conn, TransferInput { transfer_id: None, from: bkash.clone(), to: cash.clone(), amount: "1000".into(), received: None, fee: Some("18.50".into()), date: "2026-10-02".into(), note: "Cash-out".into() }, 5).unwrap();
        assert_eq!((t.amount_minor, t.received_minor, t.fee_minor), (100_000, 100_000, 1_850));
        assert_eq!(account(&conn, &bkash).unwrap().balance_minor, 500_000 - 100_000 - 1_850);
        assert_eq!(account(&conn, &cash).unwrap().balance_minor, 100_000);
        let page = list(&conn, &Filter { from: Some("2026-10-02".into()), ..Default::default() }).unwrap();
        assert_eq!((page.total, page.income_minor, page.spending_minor), (3, 0, 1_850));
        let legs: Vec<&Tx> = page.items.iter().filter(|t| t.kind == "transfer").collect();
        assert_eq!(legs.len(), 2);
        assert!(legs.iter().all(|l| l.counter_account_id.is_some()));
        // Editing replaces all three rows; deleting one side takes the whole transfer.
        save_transfer(&mut conn, TransferInput { transfer_id: Some(t.transfer_id.clone()), from: bkash.clone(), to: cash.clone(), amount: "2000".into(), received: None, fee: None, date: "2026-10-02".into(), note: "".into() }, 6).unwrap();
        assert_eq!(account(&conn, &bkash).unwrap().balance_minor, 300_000);
        let one = list(&conn, &Filter { kind: Some("transfer".into()), ..Default::default() }).unwrap().items[0].id.clone();
        assert_eq!(delete_txs(&mut conn, &[one]).unwrap(), 2);
        assert_eq!(account(&conn, &cash).unwrap().balance_minor, 0);
        assert!(save_tx(&conn, TxInput { id: None, kind: "expense".into(), account_id: cash.clone(), amount: "0".into(), date: "2026-10-02".into(), category_id: None, payee: "".into(), note: "".into() }, 7).is_err());
    }

    #[test]
    fn foreign_accounts_need_a_rate_and_keep_theirs() {
        let conn = fresh();
        let input = |rate: Option<&str>| AccountInput { id: None, name: "Payoneer".into(), kind: "bank".into(), currency: "USD".into(), opening: "100".into(), color: "blue".into(), rate: rate.map(Into::into) };
        assert!(save_account(&conn, input(None), 2).is_err());
        let usd = save_account(&conn, input(Some("120")), 2).unwrap();
        assert_eq!(usd.balance_base_minor, Some(1_200_000));
        let t = save_tx(&conn, TxInput { id: None, kind: "expense".into(), account_id: usd.id.clone(), amount: "12.99".into(), date: "2026-10-03".into(), category_id: Some(cat(&conn, "Subscriptions")), payee: "Netflix".into(), note: "".into() }, 3).unwrap();
        assert_eq!(t.base_minor, -155_880);
        set_rate(&conn, "USD", "125", 4).unwrap();
        // The total stays as written; the balance's value follows the new rate.
        assert_eq!(list(&conn, &Filter::default()).unwrap().spending_minor, 155_880);
        assert_eq!(account(&conn, &usd.id).unwrap().balance_base_minor, Some(1_087_625));
    }

    #[test]
    fn budgets_count_sub_categories_and_refunds() {
        let conn = fresh();
        let cash = accounts(&conn).unwrap()[0].id.clone();
        spend(&conn, &cash, "300", "2026-10-05", "Groceries");
        spend(&conn, &cash, "200", "2026-10-06", "Eating out");
        spend(&conn, &cash, "999", "2026-09-30", "Eating out");
        save_tx(&conn, TxInput { id: None, kind: "income".into(), account_id: cash.clone(), amount: "50".into(), date: "2026-10-07".into(), category_id: Some(cat(&conn, "Groceries")), payee: "Refund".into(), note: "".into() }, 4).unwrap();
        set_budget(&conn, "2026-10", &cat(&conn, "Food"), "4,000").unwrap();
        let rows = budgets(&conn, "2026-10").unwrap();
        let food = rows.iter().find(|r| r.category_id == cat(&conn, "Food")).unwrap();
        assert_eq!((food.budget_minor, food.spent_minor), (Some(400_000), 45_000));
        assert_eq!(copy_budgets(&conn, "2026-10", "2026-11").unwrap(), 1);
        set_budget(&conn, "2026-11", &cat(&conn, "Food"), "").unwrap();
        assert!(budgets(&conn, "2026-11").unwrap().iter().all(|r| r.budget_minor.is_none()));
        let spend = by_category(&conn, "2026-10-01", "2026-10-31").unwrap();
        assert_eq!(spend[0].spent_minor, 45_000);
        assert_eq!(spend[0].children.len(), 2);
    }

    #[test]
    fn months_add_up_to_net_worth() {
        let conn = fresh();
        let cash = accounts(&conn).unwrap()[0].id.clone();
        save_account(&conn, AccountInput { id: Some(cash.clone()), name: "Cash".into(), kind: "cash".into(), currency: "BDT".into(), opening: "1000".into(), color: "green".into(), rate: None }, 2).unwrap();
        spend(&conn, &cash, "100", "2026-08-10", "Rent");
        spend(&conn, &cash, "200", "2026-10-10", "Rent");
        let m = months(&conn, "2026-10", 3).unwrap();
        assert_eq!(m.iter().map(|x| x.month.as_str()).collect::<Vec<_>>(), ["2026-08", "2026-09", "2026-10"]);
        assert_eq!(m.iter().map(|x| x.net_worth_minor).collect::<Vec<_>>(), [90_000, 90_000, 70_000]);
        assert_eq!(m[2].spending_minor, 20_000);
        assert_eq!(add_months("2026-01", -1), "2025-12");
        assert!(valid_date("2028-02-29") && !valid_date("2026-02-29") && !valid_date("2026-13-01"));
    }

    #[test]
    fn deleting_a_category_moves_its_transactions() {
        let mut conn = fresh();
        let cash = accounts(&conn).unwrap()[0].id.clone();
        let t = spend(&conn, &cash, "80", "2026-10-05", "Ride share");
        let other = cat(&conn, "Other");
        let transport = cat(&conn, "Transport");
        delete_category(&mut conn, &transport, Some(&other)).unwrap();
        assert!(categories(&conn).unwrap().iter().all(|c| c.name != "Ride share"));
        assert_eq!(tx(&conn, &t.id).unwrap().category_id, Some(other));
        assert!(delete_account(&conn, &cash).is_err());
        let search = list(&conn, &Filter { search: Some("oth".into()), ..Default::default() }).unwrap();
        assert_eq!(search.total, 1);
    }
}
