//! Sync: two ledgers (the desktop and the phone) kept the same, both ways.
//!
//! Triggers on every ledger table note each changed row in `sync_log`, keyed by table and
//! primary key, with a stamp: milliseconds since the epoch and the device that made the change
//! (`0001731500000000-<device>`). A device sends the rows logged since the last batch the other
//! acknowledged, as they are now (or as gone, when deleted); the receiver keeps whichever side's
//! stamp is later, row by row. Nothing in the ledger code knows about any of this: the triggers
//! see every insert, update and delete, so new code and new columns sync without changes here.
//!
//! Two cases need care:
//! - a row whose parent isn't there yet (a transaction on an account the other side deleted)
//!   waits in `sync_pending` and is tried again with every later batch;
//! - a delete of a row that still has children here (that account, when this side has just added
//!   a transaction to it) is refused, and the row is stamped anew so it comes back on the other side.

use rusqlite::{params, types::Value, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};

use super::db::{db_err, Result};
use crate::notes::new_id;

/// The ledger's tables, parents before children (upserts run in this order, deletes in reverse).
pub const TABLES: &[&str] = &[
    "accounts", "categories", "rates", "project_rates", "import_profiles", "import_batches", "rules", "recurring", "plans", "fdrs",
    "plan_payments", "transactions", "budgets", "receipts",
];

/// Joins the parts of a composite primary key (budgets: month and category).
const KEY_SEP: char = '\u{1f}';

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, pk TEXT NOT NULL, stamp TEXT NOT NULL, UNIQUE (tbl, pk));
CREATE TABLE IF NOT EXISTS sync_pending (
  tbl TEXT NOT NULL, pk TEXT NOT NULL, stamp TEXT NOT NULL, row TEXT, PRIMARY KEY (tbl, pk));
CREATE TABLE IF NOT EXISTS sync_peers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, secret TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '', sent INTEGER NOT NULL DEFAULT 0, last_sync INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL);
";

/// One row as it is on the sending side, or `row: None` when it was deleted there.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Change {
    pub table: String,
    pub key: String,
    pub stamp: String,
    pub row: Option<Map<String, Json>>,
}

/// What one batch did here.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Applied {
    /// Rows written or deleted.
    pub applied: usize,
    /// Rows this side already had as new or newer.
    pub skipped: usize,
    /// Rows waiting for a parent.
    pub pending: usize,
}

/// A table's primary key columns and every column, as the schema has them now.
struct Shape {
    keys: Vec<String>,
    columns: Vec<String>,
}

fn shape(conn: &Connection, table: &str) -> Result<Shape> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).map_err(db_err)?;
    let mut cols: Vec<(String, i64)> = stmt.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(5)?))).map_err(db_err)?.collect::<std::result::Result<_, _>>().map_err(db_err)?;
    let columns = cols.iter().map(|c| c.0.clone()).collect();
    cols.retain(|c| c.1 > 0);
    cols.sort_by_key(|c| c.1);
    Ok(Shape { keys: cols.into_iter().map(|c| c.0).collect(), columns })
}

fn key_expr(keys: &[String], row: &str) -> String {
    keys.iter().map(|k| format!("{row}.\"{k}\"")).collect::<Vec<_>>().join(" || char(31) || ")
}

/// The stamp a local change gets: now, or just after the row's last stamp when that is later
/// (the other device's clock may run ahead), and this device.
fn stamp_sql(table: &str, key: &str) -> String {
    format!(
        "printf('%016d-%s', max(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), \
         coalesce((SELECT CAST(substr(stamp, 1, 16) AS INTEGER) + 1 FROM sync_log WHERE tbl = '{table}' AND pk = {key}), 0)), \
         (SELECT value FROM sync_meta WHERE key = 'device'))"
    )
}

/// Makes the sync tables and (re)makes the triggers from the schema as it is now; then logs the
/// rows that were there before sync was. Run after every migration.
pub fn install(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA).map_err(db_err)?;
    conn.execute("INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('device', ?1)", [new_id()]).map_err(db_err)?;
    let quiet = "WHEN NOT EXISTS (SELECT 1 FROM sync_meta WHERE key = 'applying')";
    for table in TABLES {
        let s = shape(conn, table)?;
        let (new, old) = (key_expr(&s.keys, "NEW"), key_expr(&s.keys, "OLD"));
        let log = |key: &str| format!("INSERT OR REPLACE INTO sync_log (tbl, pk, stamp) VALUES ('{table}', {key}, {});", stamp_sql(table, key));
        conn.execute_batch(&format!(
            "DROP TRIGGER IF EXISTS sync_{table}_insert;
             DROP TRIGGER IF EXISTS sync_{table}_update;
             DROP TRIGGER IF EXISTS sync_{table}_delete;
             CREATE TRIGGER sync_{table}_insert AFTER INSERT ON {table} {quiet} BEGIN {ins} END;
             CREATE TRIGGER sync_{table}_update AFTER UPDATE ON {table} {quiet} BEGIN
               {upd}
               INSERT OR REPLACE INTO sync_log (tbl, pk, stamp) SELECT '{table}', {old}, {old_stamp} WHERE ({old}) IS NOT ({new});
             END;
             CREATE TRIGGER sync_{table}_delete AFTER DELETE ON {table} {quiet} BEGIN {del} END;",
            ins = log(&new),
            upd = log(&new),
            del = log(&old),
            old_stamp = stamp_sql(table, &old),
        ))
        .map_err(db_err)?;
        // Rows from before sync (or before this table synced) get a stamp now.
        conn.execute(
            &format!(
                "INSERT INTO sync_log (tbl, pk, stamp) SELECT '{table}', {k}, printf('%016d-%s', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), (SELECT value FROM sync_meta WHERE key = 'device'))
                 FROM {table} t WHERE NOT EXISTS (SELECT 1 FROM sync_log WHERE tbl = '{table}' AND pk = {k})",
                k = key_expr(&s.keys, "t")
            ),
            [],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

/// This device's id in stamps.
pub fn device(conn: &Connection) -> Result<String> {
    conn.query_row("SELECT value FROM sync_meta WHERE key = 'device'", [], |r| r.get(0)).map_err(db_err)
}

/// The newest change logged here.
pub fn head(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT coalesce(max(seq), 0) FROM sync_log", [], |r| r.get(0)).map_err(db_err)
}

fn json_of(v: Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Integer(i) => Json::from(i),
        Value::Real(f) => Json::from(f),
        Value::Text(t) => Json::from(t),
        Value::Blob(b) => Json::from(b),
    }
}

fn value_of(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(*b as i64),
        Json::Number(n) => n.as_i64().map(Value::Integer).unwrap_or_else(|| Value::Real(n.as_f64().unwrap_or(0.0))),
        Json::String(s) => Value::Text(s.clone()),
        Json::Array(a) => Value::Blob(a.iter().filter_map(|b| b.as_u64().map(|b| b as u8)).collect()),
        Json::Object(_) => Value::Text(v.to_string()),
    }
}

fn key_where(s: &Shape) -> String {
    s.keys.iter().enumerate().map(|(i, k)| format!("\"{k}\" = ?{}", i + 1)).collect::<Vec<_>>().join(" AND ")
}

fn key_parts(key: &str) -> Vec<String> {
    key.split(KEY_SEP).map(str::to_string).collect()
}

fn read_row(conn: &Connection, table: &str, s: &Shape, key: &str) -> Result<Option<Map<String, Json>>> {
    let sql = format!("SELECT * FROM {table} WHERE {}", key_where(s));
    conn.query_row(&sql, rusqlite::params_from_iter(key_parts(key)), |r| {
        let mut row = Map::new();
        for (i, c) in s.columns.iter().enumerate() {
            row.insert(c.clone(), json_of(r.get::<_, Value>(i)?));
        }
        Ok(row)
    })
    .optional()
    .map_err(db_err)
}

/// The rows changed here after `since` (a `sync_log` seq), up to `limit` of them, leaving out the
/// changes `peer` made itself; and the seq the batch reaches.
pub fn changes_since(conn: &Connection, since: i64, limit: usize, peer: Option<&str>) -> Result<(Vec<Change>, i64)> {
    let mut stmt = conn.prepare("SELECT seq, tbl, pk, stamp FROM sync_log WHERE seq > ?1 ORDER BY seq LIMIT ?2").map_err(db_err)?;
    let logged: Vec<(i64, String, String, String)> =
        stmt.query_map(params![since, limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).map_err(db_err)?.collect::<std::result::Result<_, _>>().map_err(db_err)?;
    let upto = logged.last().map_or(since, |l| l.0);
    let mut shapes = std::collections::HashMap::new();
    let mut out = Vec::new();
    for (_, table, key, stamp) in logged {
        if peer.is_some_and(|p| stamp.ends_with(p)) || !TABLES.contains(&table.as_str()) {
            continue;
        }
        if !shapes.contains_key(&table) {
            shapes.insert(table.clone(), shape(conn, &table)?);
        }
        let row = read_row(conn, &table, &shapes[&table], &key)?;
        out.push(Change { table, key, stamp, row });
    }
    Ok((out, upto))
}

/// The stamp this side has for a row, if it has one.
fn local_stamp(conn: &Connection, table: &str, key: &str) -> Result<Option<String>> {
    conn.query_row("SELECT stamp FROM sync_log WHERE tbl = ?1 AND pk = ?2", params![table, key], |r| r.get(0)).optional().map_err(db_err)
}

/// Whether a row has children here that would stop its delete (cascading ones don't).
fn has_children(conn: &Connection, table: &str, key: &str) -> Result<bool> {
    for child in TABLES {
        let mut stmt = conn.prepare(&format!("PRAGMA foreign_key_list({child})")).map_err(db_err)?;
        let refs: Vec<(String, String, String)> =
            stmt.query_map([], |r| Ok((r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(6)?))).map_err(db_err)?.collect::<std::result::Result<_, _>>().map_err(db_err)?;
        for (parent, from, on_delete) in refs {
            if parent != *table || on_delete.eq_ignore_ascii_case("CASCADE") {
                continue;
            }
            let found: Option<i64> = conn.query_row(&format!("SELECT 1 FROM {child} WHERE \"{from}\" = ?1 LIMIT 1"), [key], |r| r.get(0)).optional().map_err(db_err)?;
            if found.is_some() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn upsert(conn: &Connection, table: &str, s: &Shape, row: &Map<String, Json>) -> Result<()> {
    let cols: Vec<&String> = s.columns.iter().filter(|c| row.contains_key(*c)).collect();
    let names = cols.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
    let marks = (1..=cols.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    let keys = s.keys.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", ");
    let sets = cols.iter().filter(|c| !s.keys.contains(c)).map(|c| format!("\"{c}\" = excluded.\"{c}\"")).collect::<Vec<_>>().join(", ");
    let action = if sets.is_empty() { "NOTHING".to_string() } else { format!("UPDATE SET {sets}") };
    let sql = format!("INSERT INTO {table} ({names}) VALUES ({marks}) ON CONFLICT ({keys}) DO {action}");
    conn.execute(&sql, rusqlite::params_from_iter(cols.iter().map(|c| value_of(&row[c.as_str()])))).map_err(db_err)?;
    Ok(())
}

/// Whether a written row points at a parent that isn't here.
fn orphaned(conn: &Connection, table: &str, s: &Shape, key: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA foreign_key_list({table})")).map_err(db_err)?;
    let refs: Vec<(String, String, Option<String>)> =
        stmt.query_map([], |r| Ok((r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?))).map_err(db_err)?.collect::<std::result::Result<_, _>>().map_err(db_err)?;
    for (parent, from, to) in refs {
        let to = to.unwrap_or_else(|| "id".into());
        let sql = format!(
            "SELECT 1 FROM {table} c WHERE {} AND c.\"{from}\" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM {parent} p WHERE p.\"{to}\" = c.\"{from}\")",
            s.keys.iter().enumerate().map(|(i, k)| format!("c.\"{k}\" = ?{}", i + 1)).collect::<Vec<_>>().join(" AND ")
        );
        if conn.query_row(&sql, rusqlite::params_from_iter(key_parts(key)), |r| r.get::<_, i64>(0)).optional().map_err(db_err)?.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Writes a batch from another device, keeping the later stamp row by row, and retries the rows
/// that were waiting for a parent. All of it or none of it lands.
pub fn apply(conn: &mut Connection, changes: Vec<Change>) -> Result<Applied> {
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON; INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1');").map_err(db_err)?;
    // What waited from before goes first, so a newer change in this batch overrides it.
    let mut waiting: Vec<Change> = {
        let mut stmt = tx.prepare("SELECT tbl, pk, stamp, row FROM sync_pending").map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?)))
            .map_err(db_err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_err)?;
        rows.into_iter().map(|(table, key, stamp, row)| Change { table, key, stamp, row: row.and_then(|r| serde_json::from_str(&r).ok()) }).collect()
    };
    tx.execute("DELETE FROM sync_pending", []).map_err(db_err)?;
    waiting.extend(changes);
    let rank = |t: &str| TABLES.iter().position(|x| *x == t).unwrap_or(usize::MAX);
    let (mut writes, mut deletes): (Vec<Change>, Vec<Change>) = waiting.into_iter().filter(|c| TABLES.contains(&c.table.as_str())).partition(|c| c.row.is_some());
    writes.sort_by_key(|c| rank(&c.table));
    deletes.sort_by_key(|c| std::cmp::Reverse(rank(&c.table)));

    let mut out = Applied::default();
    let mut shapes = std::collections::HashMap::new();
    let mut refused = Vec::new();
    for change in writes.iter().chain(deletes.iter()) {
        if local_stamp(&tx, &change.table, &change.key)?.is_some_and(|l| l >= change.stamp) {
            out.skipped += 1;
            continue;
        }
        if !shapes.contains_key(&change.table) {
            shapes.insert(change.table.clone(), shape(&tx, &change.table)?);
        }
        let s = &shapes[&change.table];
        match &change.row {
            Some(row) => upsert(&tx, &change.table, s, row)?,
            None if has_children(&tx, &change.table, &change.key)? => {
                refused.push(change.clone());
                continue;
            }
            None => {
                tx.execute(&format!("DELETE FROM {} WHERE {}", change.table, key_where(s)), rusqlite::params_from_iter(key_parts(&change.key))).map_err(db_err)?;
            }
        }
        tx.execute("INSERT OR REPLACE INTO sync_log (tbl, pk, stamp) VALUES (?1, ?2, ?3)", params![change.table, change.key, change.stamp]).map_err(db_err)?;
        out.applied += 1;
    }
    // Rows whose parent didn't come: undo them and keep them for a later batch.
    for change in writes.iter().rev() {
        let Some(s) = shapes.get(&change.table) else { continue };
        if local_stamp(&tx, &change.table, &change.key)?.as_deref() != Some(change.stamp.as_str()) || !orphaned(&tx, &change.table, s, &change.key)? {
            continue;
        }
        tx.execute(&format!("DELETE FROM {} WHERE {}", change.table, key_where(s)), rusqlite::params_from_iter(key_parts(&change.key))).map_err(db_err)?;
        tx.execute("DELETE FROM sync_log WHERE tbl = ?1 AND pk = ?2", params![change.table, change.key]).map_err(db_err)?;
        tx.execute(
            "INSERT OR REPLACE INTO sync_pending (tbl, pk, stamp, row) VALUES (?1, ?2, ?3, ?4)",
            params![change.table, change.key, change.stamp, change.row.as_ref().map(|r| Json::Object(r.clone()).to_string())],
        )
        .map_err(db_err)?;
        out.applied -= 1;
        out.pending += 1;
    }
    tx.execute("DELETE FROM sync_meta WHERE key = 'applying'", []).map_err(db_err)?;
    // A refused delete: stamp the row anew here so it goes back to the other side alive.
    for change in refused {
        tx.execute(
            "INSERT OR REPLACE INTO sync_log (tbl, pk, stamp) VALUES (?1, ?2, printf('%016d-%s', \
             max(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), CAST(substr(?3, 1, 16) AS INTEGER) + 1), \
             (SELECT value FROM sync_meta WHERE key = 'device')))",
            params![change.table, change.key, change.stamp],
        )
        .map_err(db_err)?;
        out.skipped += 1;
    }
    tx.commit().map_err(db_err)?;
    Ok(out)
}

/// An id two devices work out alike for the same thing, so an installment or a bill that both
/// post by themselves before they sync lands once, not twice.
pub fn derived_id(parts: &[&str]) -> String {
    format!("{:032x}", xxhash_rust::xxh3::xxh3_128(parts.join("\u{1f}").as_bytes()))
}

/// A ledger nobody has used yet (only the starter categories and the empty Cash account) drops
/// them quietly before its first sync, so it takes the other device's as they are instead of
/// adding a second "Food", "Rent", "Cash"… Returns whether it did.
pub fn forget_starter(conn: &mut Connection) -> Result<bool> {
    let used: i64 = conn
        .query_row(
            "SELECT (SELECT count(*) FROM transactions) + (SELECT count(*) FROM recurring) + (SELECT count(*) FROM plans)
                  + (SELECT count(*) FROM fdrs) + (SELECT count(*) FROM budgets) + (SELECT count(*) FROM rules)
                  + (SELECT count(*) FROM accounts WHERE NOT (kind = 'cash' AND opening_minor = 0))
                  + (SELECT count(*) FROM accounts) / 2
                  + (SELECT count(*) FROM categories WHERE updated <> created)",
            [],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if used > 0 {
        return Ok(false);
    }
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute_batch(
        "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1');
         DELETE FROM accounts; DELETE FROM categories WHERE parent_id IS NOT NULL; DELETE FROM categories;
         DELETE FROM sync_log WHERE tbl IN ('accounts', 'categories');
         DELETE FROM sync_meta WHERE key = 'applying';",
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::db::tests::fresh;

    fn ledger() -> Connection {
        let conn = fresh();
        install(&conn).unwrap();
        conn
    }

    /// Every ledger row, table by table, for comparing two sides.
    fn dump(conn: &Connection) -> Vec<(String, Vec<String>)> {
        TABLES
            .iter()
            .map(|t| {
                let s = shape(conn, t).unwrap();
                let order = s.keys.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", ");
                let mut stmt = conn.prepare(&format!("SELECT * FROM {t} ORDER BY {order}")).unwrap();
                let n = s.columns.len();
                let rows = stmt.query_map([], |r| Ok((0..n).map(|i| format!("{:?}", r.get::<_, Value>(i).unwrap())).collect::<Vec<_>>().join("|"))).unwrap().map(|r| r.unwrap()).collect();
                (t.to_string(), rows)
            })
            .collect()
    }

    /// One round both ways, as the network sync does it.
    fn exchange(a: &mut Connection, a_sent: &mut i64, b: &mut Connection, b_sent: &mut i64) {
        let (to_b, upto_a) = changes_since(a, *a_sent, 10_000, Some(&device(b).unwrap())).unwrap();
        let (to_a, upto_b) = changes_since(b, *b_sent, 10_000, Some(&device(a).unwrap())).unwrap();
        apply(b, to_b).unwrap();
        apply(a, to_a).unwrap();
        *a_sent = upto_a;
        *b_sent = upto_b;
    }

    fn account(conn: &Connection, id: &str, name: &str) {
        conn.execute("INSERT INTO accounts (id, name, kind, currency, created, updated) VALUES (?1, ?2, 'bank', 'BDT', 1, 1)", params![id, name]).unwrap();
    }

    fn spend(conn: &Connection, id: &str, account: &str, amount: i64) {
        conn.execute(
            "INSERT INTO transactions (id, account_id, date, amount_minor, base_minor, created, updated) VALUES (?1, ?2, '2026-11-14', ?3, ?3, 1, 1)",
            params![id, account, amount],
        )
        .unwrap();
    }

    #[test]
    fn a_fresh_device_takes_the_whole_ledger() {
        let mut desk = ledger();
        let mut phone = ledger();
        assert!(forget_starter(&mut phone).unwrap());
        account(&desk, "acc", "City Bank");
        spend(&desk, "t1", "acc", -50_000);
        assert!(!forget_starter(&mut desk).unwrap(), "a ledger in use keeps its categories");
        let (mut ds, mut ps) = (0, 0);
        exchange(&mut desk, &mut ds, &mut phone, &mut ps);
        assert_eq!(dump(&desk), dump(&phone));
    }

    #[test]
    fn edits_on_both_sides_meet_and_the_later_one_wins() {
        let mut desk = ledger();
        let mut phone = ledger();
        let (mut ds, mut ps) = (0, 0);
        exchange(&mut desk, &mut ds, &mut phone, &mut ps);
        account(&desk, "acc", "City Bank");
        exchange(&mut desk, &mut ds, &mut phone, &mut ps);
        spend(&phone, "t1", "acc", -100);
        spend(&desk, "t2", "acc", -200);
        desk.execute("UPDATE accounts SET name = 'Old name' WHERE id = 'acc'", []).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        phone.execute("UPDATE accounts SET name = 'City Bank PLC' WHERE id = 'acc'", []).unwrap();
        exchange(&mut desk, &mut ds, &mut phone, &mut ps);
        assert_eq!(dump(&desk), dump(&phone));
        let name: String = desk.query_row("SELECT name FROM accounts WHERE id = 'acc'", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "City Bank PLC");
        let n: i64 = desk.query_row("SELECT count(*) FROM transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn deletes_travel_and_cascade() {
        let mut desk = ledger();
        let mut phone = ledger();
        let (mut ds, mut ps) = (0, 0);
        account(&desk, "acc", "City Bank");
        spend(&desk, "t1", "acc", -100);
        desk.execute("INSERT INTO receipts (id, transaction_id, file, name, mime, size, created) VALUES ('r1', 't1', 'f', 'n', 'image/png', 1, 1)", []).unwrap();
        exchange(&mut desk, &mut ds, &mut phone, &mut ps);
        phone.execute("DELETE FROM transactions WHERE id = 't1'", []).unwrap();
        exchange(&mut desk, &mut ds, &mut phone, &mut ps);
        assert_eq!(dump(&desk), dump(&phone));
        let n: i64 = desk.query_row("SELECT count(*) FROM receipts", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn a_deleted_account_with_a_new_transaction_elsewhere_comes_back() {
        let mut desk = ledger();
        let mut phone = ledger();
        let (mut ds, mut ps) = (0, 0);
        account(&desk, "acc", "City Bank");
        exchange(&mut desk, &mut ds, &mut phone, &mut ps);
        // The desktop deletes the account while the phone, offline, spends from it.
        desk.execute("DELETE FROM accounts WHERE id = 'acc'", []).unwrap();
        spend(&phone, "t1", "acc", -100);
        exchange(&mut desk, &mut ds, &mut phone, &mut ps);
        exchange(&mut desk, &mut ds, &mut phone, &mut ps);
        assert_eq!(dump(&desk), dump(&phone));
        let n: i64 = desk.query_row("SELECT count(*) FROM transactions WHERE account_id = 'acc'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let pending: i64 = desk.query_row("SELECT count(*) FROM sync_pending", [], |r| r.get(0)).unwrap();
        assert_eq!(pending, 0);
    }

    #[test]
    fn composite_keys_and_unchanged_rows() {
        let mut desk = ledger();
        let mut phone = ledger();
        let (mut ds, mut ps) = (0, 0);
        exchange(&mut desk, &mut ds, &mut phone, &mut ps);
        let cat: String = desk.query_row("SELECT id FROM categories LIMIT 1", [], |r| r.get(0)).unwrap();
        desk.execute("INSERT INTO budgets (month, category_id, amount_minor) VALUES ('2026-11', ?1, 500)", [&cat]).unwrap();
        exchange(&mut desk, &mut ds, &mut phone, &mut ps);
        phone.execute("UPDATE budgets SET amount_minor = 900", []).unwrap();
        exchange(&mut desk, &mut ds, &mut phone, &mut ps);
        assert_eq!(dump(&desk), dump(&phone));
        let amount: i64 = desk.query_row("SELECT amount_minor FROM budgets", [], |r| r.get(0)).unwrap();
        assert_eq!(amount, 900);
        // Nothing new: nothing goes either way.
        let (left, _) = changes_since(&desk, ds, 100, Some(&device(&phone).unwrap())).unwrap();
        assert!(left.is_empty(), "{left:?}");
    }
}
