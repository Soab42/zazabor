//! `phone.db`: the PC's id, the paired phones with their link keys, and the last threads,
//! messages, calls and contacts each phone sent, so the Phone section has something to show while
//! the phone is away.
//!
//! The phone's records are kept as the JSON it sent (docs/plans/phone-link.md §1 types), with the
//! few fields the cache sorts and looks up by pulled out into columns.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

pub type Result<T> = std::result::Result<T, String>;

fn db_err(e: rusqlite::Error) -> String {
    format!("Phone Link's database: {e}")
}

/// A paired phone, as the database knows it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paired {
    pub phone_id: String,
    pub name: String,
    pub model: String,
    /// What the phone calls itself (its Bluetooth name), whatever the user renamed it to here.
    pub device_name: String,
    pub paired_at: i64,
    pub last_seen: i64,
    pub caps: Vec<String>,
    /// Clipboard sharing with this phone.
    pub clip: bool,
}

pub fn open(path: &std::path::Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Phone Link can't make its folder: {e}"))?;
    }
    let conn = Connection::open(path).map_err(db_err)?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS phones (
             phone_id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
             link_key BLOB NOT NULL, paired_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0,
             caps TEXT NOT NULL DEFAULT '[]', clip INTEGER NOT NULL DEFAULT 0, device_name TEXT NOT NULL DEFAULT '');
         CREATE TABLE IF NOT EXISTS threads (
             phone_id TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL,
             PRIMARY KEY (phone_id, thread_id));
         CREATE TABLE IF NOT EXISTS msgs (
             phone_id TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL,
             PRIMARY KEY (phone_id, id));
         CREATE INDEX IF NOT EXISTS msgs_thread ON msgs (phone_id, thread_id, at);
         CREATE TABLE IF NOT EXISTS calls (
             phone_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL,
             PRIMARY KEY (phone_id, id));
         CREATE TABLE IF NOT EXISTS contacts (
             phone_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL,
             PRIMARY KEY (phone_id, id));
         CREATE TABLE IF NOT EXISTS synced (phone_id TEXT NOT NULL, what TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (phone_id, what));
         -- When a thread was last read here. Zazabor Link isn't the phone's SMS app, so it can't
         -- mark texts read there, and the phone keeps reporting them unread.
         CREATE TABLE IF NOT EXISTS thread_seen (phone_id TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (phone_id, thread_id));",
    )
    .map_err(db_err)
}

/// This PC's stable id (32 hex digits), made the first time.
pub fn pc_id(conn: &Connection) -> Result<String> {
    if let Some(id) = conn.query_row("SELECT value FROM meta WHERE key = 'pc_id'", [], |r| r.get::<_, String>(0)).optional().map_err(db_err)? {
        return Ok(id);
    }
    let id = super::link::new_pc_id();
    conn.execute("INSERT INTO meta (key, value) VALUES ('pc_id', ?1)", [&id]).map_err(db_err)?;
    Ok(id)
}

/// The name phones see, when the user set one here.
pub fn pc_name(conn: &Connection) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT value FROM meta WHERE key = 'pc_name'", [], |r| r.get::<_, String>(0)).optional().map_err(db_err)?.filter(|n| !n.trim().is_empty()))
}

pub fn set_pc_name(conn: &Connection, name: &str) -> Result<()> {
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('pc_name', ?1)", [name]).map_err(db_err)?;
    Ok(())
}

// ---- pairings

pub fn link_key(conn: &Connection, phone_id: &str) -> Result<Option<[u8; 32]>> {
    let key: Option<Vec<u8>> = conn.query_row("SELECT link_key FROM phones WHERE phone_id = ?1", [phone_id], |r| r.get(0)).optional().map_err(db_err)?;
    Ok(key.and_then(|k| k.try_into().ok()))
}

pub fn save_pairing(conn: &Connection, phone_id: &str, name: &str, model: &str, key: &[u8; 32], now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO phones (phone_id, name, model, link_key, paired_at, last_seen, device_name) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?2)
         ON CONFLICT (phone_id) DO UPDATE SET link_key = excluded.link_key, model = excluded.model, paired_at = excluded.paired_at, last_seen = excluded.last_seen",
        params![phone_id, name, model, &key[..], now],
    )
    .map_err(db_err)?;
    Ok(())
}

fn paired_row(r: &rusqlite::Row) -> rusqlite::Result<Paired> {
    let caps: String = r.get(5)?;
    Ok(Paired {
        phone_id: r.get(0)?,
        name: r.get(1)?,
        model: r.get(2)?,
        paired_at: r.get(3)?,
        last_seen: r.get(4)?,
        caps: serde_json::from_str(&caps).unwrap_or_default(),
        clip: r.get::<_, i64>(6)? != 0,
        device_name: r.get(7)?,
    })
}

const PAIRED: &str = "SELECT phone_id, name, model, paired_at, last_seen, caps, clip, device_name FROM phones";

pub fn phones(conn: &Connection) -> Result<Vec<Paired>> {
    let mut stmt = conn.prepare(&format!("{PAIRED} ORDER BY last_seen DESC")).map_err(db_err)?;
    let rows = stmt.query_map([], paired_row).map_err(db_err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err);
    rows
}

pub fn phone(conn: &Connection, phone_id: &str) -> Result<Option<Paired>> {
    conn.query_row(&format!("{PAIRED} WHERE phone_id = ?1"), [phone_id], paired_row).optional().map_err(db_err)
}

/// What a phone's `hello` says about it. Its name only replaces the one shown when the user
/// hasn't renamed it here.
pub fn seen(conn: &Connection, phone_id: &str, device_name: &str, model: &str, caps: &[String], now: i64) -> Result<()> {
    conn.execute(
        "UPDATE phones SET name = CASE WHEN ?2 <> '' AND name = device_name THEN ?2 ELSE name END,
             device_name = CASE WHEN ?2 = '' THEN device_name ELSE ?2 END,
             model = CASE WHEN ?3 = '' THEN model ELSE ?3 END, caps = ?4, last_seen = ?5 WHERE phone_id = ?1",
        params![phone_id, device_name, model, serde_json::to_string(caps).unwrap_or_default(), now],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn touch(conn: &Connection, phone_id: &str, now: i64) -> Result<()> {
    conn.execute("UPDATE phones SET last_seen = ?2 WHERE phone_id = ?1", params![phone_id, now]).map_err(db_err)?;
    Ok(())
}

pub fn rename(conn: &Connection, phone_id: &str, name: &str) -> Result<()> {
    let n = conn.execute("UPDATE phones SET name = ?2 WHERE phone_id = ?1", params![phone_id, name]).map_err(db_err)?;
    if n == 0 {
        return Err("That phone isn't paired.".into());
    }
    Ok(())
}

pub fn set_clip(conn: &Connection, phone_id: &str, on: bool) -> Result<()> {
    conn.execute("UPDATE phones SET clip = ?2 WHERE phone_id = ?1", params![phone_id, on as i64]).map_err(db_err)?;
    Ok(())
}

/// Forgets a phone and everything cached from it.
pub fn forget(conn: &Connection, phone_id: &str) -> Result<()> {
    for table in ["phones", "threads", "msgs", "calls", "contacts", "synced", "thread_seen"] {
        conn.execute(&format!("DELETE FROM {table} WHERE phone_id = ?1"), [phone_id]).map_err(db_err)?;
    }
    Ok(())
}

// ---- the cache

/// A JSON field as text, whether the phone sent it as a number or a string.
pub fn key_of(v: &Value, field: &str) -> String {
    match v.get(field) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn int_of(v: &Value, field: &str) -> i64 {
    v.get(field).and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64))).unwrap_or(0)
}

fn mark_synced(conn: &Connection, phone_id: &str, what: &str, now: i64) -> Result<()> {
    conn.execute("INSERT OR REPLACE INTO synced (phone_id, what, at) VALUES (?1, ?2, ?3)", params![phone_id, what, now]).map_err(db_err)?;
    Ok(())
}

/// When a list was last fetched from the phone (0 when never).
pub fn synced(conn: &Connection, phone_id: &str, what: &str) -> Result<i64> {
    Ok(conn.query_row("SELECT at FROM synced WHERE phone_id = ?1 AND what = ?2", params![phone_id, what], |r| r.get(0)).optional().map_err(db_err)?.unwrap_or(0))
}

fn rows(conn: &Connection, sql: &str, args: impl rusqlite::Params) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql).map_err(db_err)?;
    let texts = stmt.query_map(args, |r| r.get::<_, String>(0)).map_err(db_err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    Ok(texts.into_iter().filter_map(|t| serde_json::from_str(&t).ok()).collect())
}

/// Replaces a phone's list of threads.
pub fn save_threads(conn: &mut Connection, phone_id: &str, threads: &[Value], now: i64) -> Result<()> {
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("DELETE FROM threads WHERE phone_id = ?1", [phone_id]).map_err(db_err)?;
    for t in threads {
        let mut t = t.clone();
        // Nothing newer than when it was read here: read, whatever the phone says.
        if seen_at(&tx, phone_id, &key_of(&t, "threadId"))?.is_some_and(|seen| seen >= int_of(&t, "at")) {
            t["unread"] = 0.into();
        }
        tx.execute("INSERT OR REPLACE INTO threads (phone_id, thread_id, at, json) VALUES (?1, ?2, ?3, ?4)", params![phone_id, key_of(&t, "threadId"), int_of(&t, "at"), t.to_string()])
            .map_err(db_err)?;
    }
    mark_synced(&tx, phone_id, "threads", now)?;
    tx.commit().map_err(db_err)
}

/// Threads, newest first.
pub fn threads(conn: &Connection, phone_id: &str) -> Result<Vec<Value>> {
    rows(conn, "SELECT json FROM threads WHERE phone_id = ?1 ORDER BY at DESC", [phone_id])
}

/// Keeps messages of a thread (adds or updates them).
pub fn save_msgs(conn: &mut Connection, phone_id: &str, msgs: &[Value]) -> Result<()> {
    let tx = conn.transaction().map_err(db_err)?;
    for m in msgs {
        tx.execute(
            "INSERT OR REPLACE INTO msgs (phone_id, id, thread_id, at, json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![phone_id, key_of(m, "id"), key_of(m, "threadId"), int_of(m, "at"), m.to_string()],
        )
        .map_err(db_err)?;
    }
    tx.commit().map_err(db_err)
}

/// A thread's messages before `before` (all when None), the newest `limit` of them, oldest first.
pub fn msgs(conn: &Connection, phone_id: &str, thread_id: &str, before: Option<i64>, limit: usize) -> Result<Vec<Value>> {
    let mut out = rows(
        conn,
        "SELECT json FROM msgs WHERE phone_id = ?1 AND thread_id = ?2 AND at < ?3 ORDER BY at DESC LIMIT ?4",
        params![phone_id, thread_id, before.unwrap_or(i64::MAX), limit as i64],
    )?;
    out.reverse();
    Ok(out)
}

/// A message arrived or was sent: keep it, and bring its thread up to date (snippet, time, unread).
pub fn add_msg(conn: &mut Connection, phone_id: &str, msg: &Value) -> Result<()> {
    save_msgs(conn, phone_id, std::slice::from_ref(msg))?;
    let thread_id = key_of(msg, "threadId");
    let at = int_of(msg, "at");
    let old: Option<String> = conn.query_row("SELECT json FROM threads WHERE phone_id = ?1 AND thread_id = ?2", params![phone_id, thread_id], |r| r.get(0)).optional().map_err(db_err)?;
    let mut thread = old.and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or_else(|| {
        serde_json::json!({ "threadId": msg.get("threadId").cloned().unwrap_or(Value::Null), "addresses": [key_of(msg, "address")], "name": null, "snippet": "", "at": 0, "unread": 0, "count": 0 })
    });
    if at >= int_of(&thread, "at") {
        thread["snippet"] = msg.get("body").cloned().unwrap_or(Value::String(String::new()));
        thread["at"] = at.into();
    }
    thread["count"] = (int_of(&thread, "count") + 1).into();
    if msg.get("out").and_then(Value::as_bool) == Some(true) {
        // Answering a thread reads it.
        thread["unread"] = 0.into();
        mark_seen(conn, phone_id, &thread_id, at)?;
    } else {
        thread["unread"] = (int_of(&thread, "unread") + 1).into();
    }
    conn.execute(
        "INSERT OR REPLACE INTO threads (phone_id, thread_id, at, json) VALUES (?1, ?2, ?3, ?4)",
        params![phone_id, thread_id, int_of(&thread, "at"), thread.to_string()],
    )
    .map_err(db_err)?;
    Ok(())
}

fn seen_at(conn: &Connection, phone_id: &str, thread_id: &str) -> Result<Option<i64>> {
    conn.query_row("SELECT at FROM thread_seen WHERE phone_id = ?1 AND thread_id = ?2", params![phone_id, thread_id], |r| r.get(0)).optional().map_err(db_err)
}

fn mark_seen(conn: &Connection, phone_id: &str, thread_id: &str, at: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO thread_seen (phone_id, thread_id, at) VALUES (?1, ?2, ?3) ON CONFLICT (phone_id, thread_id) DO UPDATE SET at = MAX(at, excluded.at)",
        params![phone_id, thread_id, at],
    )
    .map_err(db_err)?;
    Ok(())
}

/// The thread was read on the PC (up to its newest message).
pub fn thread_read(conn: &Connection, phone_id: &str, thread_id: &str) -> Result<()> {
    let newest: Option<i64> = conn.query_row("SELECT MAX(at) FROM msgs WHERE phone_id = ?1 AND thread_id = ?2", params![phone_id, thread_id], |r| r.get(0)).map_err(db_err)?;
    let thread_at: Option<i64> = conn.query_row("SELECT at FROM threads WHERE phone_id = ?1 AND thread_id = ?2", params![phone_id, thread_id], |r| r.get(0)).optional().map_err(db_err)?;
    mark_seen(conn, phone_id, thread_id, newest.unwrap_or(0).max(thread_at.unwrap_or(0)))?;
    let old: Option<String> = conn.query_row("SELECT json FROM threads WHERE phone_id = ?1 AND thread_id = ?2", params![phone_id, thread_id], |r| r.get(0)).optional().map_err(db_err)?;
    if let Some(mut thread) = old.and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        thread["unread"] = 0.into();
        conn.execute("UPDATE threads SET json = ?3 WHERE phone_id = ?1 AND thread_id = ?2", params![phone_id, thread_id, thread.to_string()]).map_err(db_err)?;
    }
    Ok(())
}

/// Unread texts across a phone's threads.
pub fn unread(conn: &Connection, phone_id: &str) -> Result<i64> {
    Ok(threads(conn, phone_id)?.iter().map(|t| int_of(t, "unread")).sum())
}

pub fn save_calls(conn: &mut Connection, phone_id: &str, calls: &[Value], now: i64) -> Result<()> {
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("DELETE FROM calls WHERE phone_id = ?1", [phone_id]).map_err(db_err)?;
    for c in calls {
        tx.execute("INSERT OR REPLACE INTO calls (phone_id, id, at, json) VALUES (?1, ?2, ?3, ?4)", params![phone_id, key_of(c, "id"), int_of(c, "at"), c.to_string()]).map_err(db_err)?;
    }
    mark_synced(&tx, phone_id, "calls", now)?;
    tx.commit().map_err(db_err)
}

/// Calls, newest first.
pub fn calls(conn: &Connection, phone_id: &str) -> Result<Vec<Value>> {
    rows(conn, "SELECT json FROM calls WHERE phone_id = ?1 ORDER BY at DESC", [phone_id])
}

pub fn save_contacts(conn: &mut Connection, phone_id: &str, contacts: &[Value], now: i64) -> Result<()> {
    let tx = conn.transaction().map_err(db_err)?;
    tx.execute("DELETE FROM contacts WHERE phone_id = ?1", [phone_id]).map_err(db_err)?;
    for c in contacts {
        let name = c.get("name").and_then(Value::as_str).unwrap_or("");
        tx.execute("INSERT OR REPLACE INTO contacts (phone_id, id, name, json) VALUES (?1, ?2, ?3, ?4)", params![phone_id, key_of(c, "id"), name, c.to_string()]).map_err(db_err)?;
    }
    mark_synced(&tx, phone_id, "contacts", now)?;
    tx.commit().map_err(db_err)
}

/// Contacts by name.
pub fn contacts(conn: &Connection, phone_id: &str) -> Result<Vec<Value>> {
    rows(conn, "SELECT json FROM contacts WHERE phone_id = ?1 ORDER BY name COLLATE NOCASE", [phone_id])
}

/// The digits that identify a number regardless of how it's written: the last nine digits
/// (so "+880 1712-345678" and "01712345678" match).
pub fn number_key(number: &str) -> String {
    let digits: String = number.chars().filter(char::is_ascii_digit).collect();
    digits[digits.len().saturating_sub(9)..].to_string()
}

/// The name a phone's contacts give a number.
pub fn contact_name(conn: &Connection, phone_id: &str, number: &str) -> Result<Option<String>> {
    let key = number_key(number);
    if key.len() < 3 {
        return Ok(None);
    }
    for c in contacts(conn, phone_id)? {
        let numbers = c.get("numbers").and_then(Value::as_array).cloned().unwrap_or_default();
        if numbers.iter().any(|n| number_key(n.get("number").and_then(Value::as_str).unwrap_or("")) == key) {
            if let Some(name) = c.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()) {
                return Ok(Some(name.to_string()));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c
    }

    #[test]
    fn a_thread_read_here_stays_read_until_a_new_text() {
        let mut c = fresh();
        let thread = |at: i64, unread: i64| json!({"threadId": 9, "addresses": ["555"], "name": null, "snippet": "x", "at": at, "unread": unread, "count": 2});
        save_threads(&mut c, "p1", &[thread(100, 1)], 1).unwrap();
        save_msgs(&mut c, "p1", &[json!({"id": 1, "threadId": 9, "address": "555", "body": "x", "at": 100, "out": false})]).unwrap();
        thread_read(&c, "p1", "9").unwrap();
        // The phone still says unread (it can't mark it): read here wins.
        save_threads(&mut c, "p1", &[thread(100, 1)], 2).unwrap();
        assert_eq!(unread(&c, "p1").unwrap(), 0);
        // A newer text is unread again.
        save_threads(&mut c, "p1", &[thread(200, 2)], 3).unwrap();
        assert_eq!(unread(&c, "p1").unwrap(), 2);
        // Answering reads it.
        add_msg(&mut c, "p1", &json!({"id": 3, "threadId": 9, "address": "555", "body": "ok", "at": 300, "out": true})).unwrap();
        save_threads(&mut c, "p1", &[thread(300, 2)], 4).unwrap();
        assert_eq!(unread(&c, "p1").unwrap(), 0);
    }

    #[test]
    fn pairings_and_the_cache() {
        let mut c = fresh();
        let id = pc_id(&c).unwrap();
        assert_eq!(id.len(), 32);
        assert_eq!(pc_id(&c).unwrap(), id);
        save_pairing(&c, "p1", "Pixel", "Google Pixel 7", &[7; 32], 10).unwrap();
        assert_eq!(link_key(&c, "p1").unwrap(), Some([7; 32]));
        seen(&c, "p1", "Pixel 7", "", &["sms".into()], 11).unwrap();
        assert_eq!(phone(&c, "p1").unwrap().unwrap().name, "Pixel 7");
        rename(&c, "p1", "Work phone").unwrap();
        seen(&c, "p1", "Pixel 7a", "", &[], 12).unwrap();
        let p = phone(&c, "p1").unwrap().unwrap();
        assert_eq!((p.name.as_str(), p.device_name.as_str(), p.model.as_str()), ("Work phone", "Pixel 7a", "Google Pixel 7"));

        save_threads(&mut c, "p1", &[json!({"threadId": 4, "addresses": ["+8801712345678"], "name": null, "snippet": "hi", "at": 100, "unread": 1, "count": 3})], 5).unwrap();
        add_msg(&mut c, "p1", &json!({"id": 9, "threadId": 4, "address": "+8801712345678", "body": "later", "at": 200, "out": false, "status": "received", "mms": false})).unwrap();
        let t = threads(&c, "p1").unwrap();
        assert_eq!((t[0]["snippet"].as_str(), t[0]["unread"].as_i64(), t[0]["count"].as_i64()), (Some("later"), Some(2), Some(4)));
        assert_eq!(unread(&c, "p1").unwrap(), 2);
        thread_read(&c, "p1", "4").unwrap();
        assert_eq!(unread(&c, "p1").unwrap(), 0);
        save_msgs(&mut c, "p1", &[json!({"id": 8, "threadId": 4, "body": "earlier", "at": 150})]).unwrap();
        let m = msgs(&c, "p1", "4", None, 10).unwrap();
        assert_eq!(m.iter().map(|m| m["body"].as_str().unwrap()).collect::<Vec<_>>(), ["earlier", "later"]);
        assert_eq!(msgs(&c, "p1", "4", Some(200), 10).unwrap().len(), 1);

        save_contacts(&mut c, "p1", &[json!({"id": 1, "name": "Ada", "numbers": [{"number": "01712-345678", "label": "mobile"}], "starred": false, "hasPhoto": false})], 5).unwrap();
        assert_eq!(contact_name(&c, "p1", "+880 1712 345678").unwrap().as_deref(), Some("Ada"));
        assert_eq!(contact_name(&c, "p1", "999").unwrap(), None);

        forget(&c, "p1").unwrap();
        assert!(phones(&c).unwrap().is_empty());
        assert!(threads(&c, "p1").unwrap().is_empty());
    }
}
