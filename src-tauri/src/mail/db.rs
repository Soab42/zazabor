//! Mail's local store in SQLite: accounts, their folders, the messages' headers, a full-text
//! index and the drafts. Everything takes a `Connection`, so the tests run on an in-memory
//! database. The messages themselves (the `.eml` as the server holds it) are files beside the
//! database (`mod.rs`); a row's `body` says whether its file is there.

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub type Result<T> = std::result::Result<T, String>;

pub fn db_err(e: rusqlite::Error) -> String {
    format!("The mail database: {e}")
}

pub const SEEN: u32 = 1;
pub const FLAGGED: u32 = 2;
pub const ANSWERED: u32 = 4;
pub const DRAFT: u32 = 8;

/// Account colours, named like the page's palette (`mail.css`).
pub const COLORS: [&str; 8] = ["blue", "green", "orange", "purple", "pink", "teal", "red", "amber"];

/// Folders that only mirror other folders (Gmail's All Mail, Starred and Important): not synced.
pub const VIRTUAL_ROLES: [&str; 3] = ["all", "flagged", "important"];

const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE accounts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'blue',
  username TEXT NOT NULL,
  imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_security TEXT NOT NULL,
  smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_security TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '', position REAL NOT NULL DEFAULT 0,
  created INTEGER NOT NULL, synced INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE folders (
  id INTEGER PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  path TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', delim TEXT NOT NULL DEFAULT '/',
  selectable INTEGER NOT NULL DEFAULT 1, uidvalidity INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0, synced INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id, path));
CREATE TABLE messages (
  id INTEGER PRIMARY KEY, account_id TEXT NOT NULL,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE, uid INTEGER NOT NULL,
  message_id TEXT NOT NULL DEFAULT '', in_reply_to TEXT NOT NULL DEFAULT '', refs TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '', from_addr TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', reply_to TEXT NOT NULL DEFAULT '',
  date INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, flags INTEGER NOT NULL DEFAULT 0,
  seen INTEGER GENERATED ALWAYS AS (flags & 1) VIRTUAL,
  flagged INTEGER GENERATED ALWAYS AS ((flags >> 1) & 1) VIRTUAL,
  attachments INTEGER NOT NULL DEFAULT 0, snippet TEXT NOT NULL DEFAULT '', body INTEGER NOT NULL DEFAULT 0,
  UNIQUE(folder_id, uid));
CREATE INDEX msg_thread ON messages(account_id, thread_id);
CREATE INDEX msg_folder_date ON messages(folder_id, date);
CREATE INDEX msg_message_id ON messages(account_id, message_id);
CREATE VIRTUAL TABLE messages_fts USING fts5(subject, sender, recipients, body, tokenize = 'unicode61 remove_diacritics 2');
CREATE TRIGGER msg_fts_delete AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE rowid = old.id; END;
CREATE TABLE drafts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL DEFAULT '', json TEXT NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE contacts (addr TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', uses INTEGER NOT NULL DEFAULT 0, last INTEGER NOT NULL DEFAULT 0);
"#];

pub fn migrate(conn: &mut Connection) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(db_err)?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(db_err)?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        let tx = conn.transaction().map_err(db_err)?;
        tx.execute_batch(sql).map_err(db_err)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
    }
    Ok(())
}

// ---- accounts

/// How to reach one of an account's servers.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Server {
    pub host: String,
    pub port: u16,
    /// "ssl" (TLS from the start), "starttls" or "none".
    pub security: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub email: String,
    /// The name mail goes out under.
    pub name: String,
    pub color: String,
    pub username: String,
    pub imap: Server,
    pub smtp: Server,
    pub signature: String,
    #[serde(default)]
    pub synced: i64,
    #[serde(default)]
    pub error: Option<String>,
}

fn account_row(r: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        email: r.get(1)?,
        name: r.get(2)?,
        color: r.get(3)?,
        username: r.get(4)?,
        imap: Server { host: r.get(5)?, port: r.get(6)?, security: r.get(7)? },
        smtp: Server { host: r.get(8)?, port: r.get(9)?, security: r.get(10)? },
        signature: r.get(11)?,
        synced: r.get(12)?,
        error: r.get(13)?,
    })
}

const ACCOUNT_COLUMNS: &str = "id, email, name, color, username, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, signature, synced, error";

pub fn accounts(conn: &Connection) -> Result<Vec<Account>> {
    let mut stmt = conn.prepare(&format!("SELECT {ACCOUNT_COLUMNS} FROM accounts ORDER BY position, created")).map_err(db_err)?;
    let rows = stmt.query_map([], account_row).map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

pub fn account(conn: &Connection, id: &str) -> Result<Account> {
    conn.query_row(&format!("SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE id = ?1"), [id], account_row)
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| "That account isn't here any more.".to_string())
}

pub fn save_account(conn: &Connection, a: &Account, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO accounts (id, email, name, color, username, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, signature, position, created)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, (SELECT COALESCE(MAX(position), 0) + 1 FROM accounts), ?13)
         ON CONFLICT(id) DO UPDATE SET email = ?2, name = ?3, color = ?4, username = ?5, imap_host = ?6, imap_port = ?7, imap_security = ?8,
           smtp_host = ?9, smtp_port = ?10, smtp_security = ?11, signature = ?12",
        params![a.id, a.email, a.name, a.color, a.username, a.imap.host, a.imap.port, a.imap.security, a.smtp.host, a.smtp.port, a.smtp.security, a.signature, now],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn remove_account(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM accounts WHERE id = ?1", [id]).map_err(db_err)?;
    conn.execute("DELETE FROM drafts WHERE account_id = ?1", [id]).map_err(db_err)?;
    Ok(())
}

pub fn set_account_state(conn: &Connection, id: &str, synced: Option<i64>, error: Option<&str>) -> Result<()> {
    match synced {
        Some(at) => conn.execute("UPDATE accounts SET synced = ?2, error = ?3 WHERE id = ?1", params![id, at, error]),
        None => conn.execute("UPDATE accounts SET error = ?2 WHERE id = ?1", params![id, error]),
    }
    .map_err(db_err)?;
    Ok(())
}

// ---- folders

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i64,
    pub account_id: String,
    /// Its name on the server, as commands take it.
    pub path: String,
    pub name: String,
    /// "inbox", "sent", "drafts", "trash", "junk", "archive", a virtual role, or "".
    pub role: String,
    pub delim: String,
    pub selectable: bool,
    pub uidvalidity: u32,
    pub total: u32,
    pub unread: u32,
    pub synced: i64,
}

fn folder_row(r: &Row) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: r.get(0)?,
        account_id: r.get(1)?,
        path: r.get(2)?,
        name: r.get(3)?,
        role: r.get(4)?,
        delim: r.get(5)?,
        selectable: r.get(6)?,
        uidvalidity: r.get(7)?,
        total: r.get(8)?,
        unread: r.get(9)?,
        synced: r.get(10)?,
    })
}

const FOLDER_COLUMNS: &str = "id, account_id, path, name, role, delim, selectable, uidvalidity, total, unread, synced";

pub fn folders(conn: &Connection, account: Option<&str>) -> Result<Vec<Folder>> {
    let mut stmt = conn
        .prepare(&format!("SELECT {FOLDER_COLUMNS} FROM folders WHERE (?1 IS NULL OR account_id = ?1) ORDER BY account_id, path COLLATE NOCASE"))
        .map_err(db_err)?;
    let rows = stmt.query_map([account], folder_row).map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

pub fn folder(conn: &Connection, id: i64) -> Result<Folder> {
    conn.query_row(&format!("SELECT {FOLDER_COLUMNS} FROM folders WHERE id = ?1"), [id], folder_row)
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| "That folder isn't here any more.".to_string())
}

pub fn folder_by_role(conn: &Connection, account: &str, role: &str) -> Result<Option<Folder>> {
    conn.query_row(&format!("SELECT {FOLDER_COLUMNS} FROM folders WHERE account_id = ?1 AND role = ?2 ORDER BY length(path) LIMIT 1"), [account, role], folder_row)
        .optional()
        .map_err(db_err)
}

/// What the server lists for one folder.
pub struct Listed {
    pub path: String,
    pub name: String,
    pub role: String,
    pub delim: String,
    pub selectable: bool,
}

/// Makes the account's folders match the server's list; returns the ids of the folders that went
/// (their message files are the caller's to delete).
pub fn set_folders(conn: &mut Connection, account: &str, listed: &[Listed]) -> Result<Vec<i64>> {
    let tx = conn.transaction().map_err(db_err)?;
    let before: HashMap<String, i64> = {
        let mut stmt = tx.prepare("SELECT path, id FROM folders WHERE account_id = ?1").map_err(db_err)?;
        let rows = stmt.query_map([account], |r| Ok((r.get(0)?, r.get(1)?))).map_err(db_err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
    };
    for f in listed {
        tx.execute(
            "INSERT INTO folders (account_id, path, name, role, delim, selectable) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(account_id, path) DO UPDATE SET name = ?3, role = ?4, delim = ?5, selectable = ?6",
            params![account, f.path, f.name, f.role, f.delim, f.selectable],
        )
        .map_err(db_err)?;
    }
    let gone: Vec<i64> = before.iter().filter(|(path, _)| !listed.iter().any(|f| &f.path == *path)).map(|(_, id)| *id).collect();
    for id in &gone {
        tx.execute("DELETE FROM folders WHERE id = ?1", [id]).map_err(db_err)?;
    }
    tx.commit().map_err(db_err)?;
    Ok(gone)
}

pub fn set_folder_state(conn: &Connection, id: i64, uidvalidity: u32, total: u32, unread: u32, now: i64) -> Result<()> {
    conn.execute("UPDATE folders SET uidvalidity = ?2, total = ?3, unread = ?4, synced = ?5 WHERE id = ?1", params![id, uidvalidity, total, unread, now]).map_err(db_err)?;
    Ok(())
}

/// Forgets a folder's messages (its UIDs changed on the server).
pub fn clear_folder(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM messages WHERE folder_id = ?1", [id]).map_err(db_err)?;
    Ok(())
}

/// The folder's unread count again, from the messages held here (after reading or moving some).
pub fn recount_unread(conn: &Connection, folder: i64, delta: i64) -> Result<()> {
    conn.execute("UPDATE folders SET unread = MAX(0, unread + ?2) WHERE id = ?1", params![folder, delta]).map_err(db_err)?;
    Ok(())
}

// ---- messages

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Address {
    pub name: String,
    pub addr: String,
}

/// A message's headers, as the sync reads them from the server.
#[derive(Default, Clone, Debug)]
pub struct Header {
    pub uid: u32,
    pub message_id: String,
    pub in_reply_to: String,
    pub refs: Vec<String>,
    pub subject: String,
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub reply_to: String,
    pub date: i64,
    pub size: u32,
    pub flags: u32,
    /// The headers say it's a multipart/mixed message: it probably carries files.
    pub attachments: bool,
}

/// The conversation a new message belongs to: the one a message it answers is in, else named
/// after the first message it refers to, else its own.
fn thread_for(conn: &Connection, account: &str, folder: i64, h: &Header) -> Result<String> {
    let mut find = conn.prepare_cached("SELECT thread_id FROM messages WHERE account_id = ?1 AND message_id = ?2 LIMIT 1").map_err(db_err)?;
    for id in std::iter::once(&h.in_reply_to).chain(h.refs.iter().rev()).filter(|id| !id.is_empty()) {
        if let Some(thread) = find.query_row(params![account, id], |r| r.get::<_, String>(0)).optional().map_err(db_err)? {
            return Ok(thread);
        }
    }
    if !h.message_id.is_empty() {
        if let Some(thread) = find.query_row(params![account, h.message_id], |r| r.get::<_, String>(0)).optional().map_err(db_err)? {
            return Ok(thread);
        }
    }
    Ok(h.refs.first().filter(|id| !id.is_empty()).cloned().unwrap_or_else(|| {
        if !h.in_reply_to.is_empty() {
            h.in_reply_to.clone()
        } else if !h.message_id.is_empty() {
            h.message_id.clone()
        } else {
            format!("uid:{folder}:{}", h.uid)
        }
    }))
}

/// Files new messages' headers; returns their row ids. A header already here keeps its row.
pub fn insert_headers(conn: &mut Connection, account: &str, folder: i64, headers: &[Header]) -> Result<Vec<i64>> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut ids = Vec::with_capacity(headers.len());
    // Oldest first, so an answer finds the message it answers.
    let mut order: Vec<&Header> = headers.iter().collect();
    order.sort_by_key(|h| h.date);
    for h in order {
        let thread = thread_for(&tx, account, folder, h)?;
        let changed = tx
            .execute(
                "INSERT OR IGNORE INTO messages (account_id, folder_id, uid, message_id, in_reply_to, refs, thread_id, subject, from_name, from_addr, to_json, cc_json, reply_to, date, size, flags, attachments)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    account, folder, h.uid, h.message_id, h.in_reply_to, h.refs.join(" "), thread, h.subject, h.from.name, h.from.addr,
                    serde_json::to_string(&h.to).unwrap_or_default(), serde_json::to_string(&h.cc).unwrap_or_default(), h.reply_to, h.date, h.size, h.flags, h.attachments
                ],
            )
            .map_err(db_err)?;
        if changed == 0 {
            continue;
        }
        let id = tx.last_insert_rowid();
        ids.push(id);
        // Messages that arrived before the one they answer named their conversation after it.
        if !h.message_id.is_empty() && thread != h.message_id {
            tx.execute("UPDATE messages SET thread_id = ?3 WHERE account_id = ?1 AND thread_id = ?2", params![account, h.message_id, thread]).map_err(db_err)?;
        }
        let recipients = h.to.iter().chain(h.cc.iter()).map(|a| format!("{} {}", a.name, a.addr)).collect::<Vec<_>>().join(" ");
        tx.execute(
            "INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?1, ?2, ?3, ?4, '')",
            params![id, h.subject, format!("{} {}", h.from.name, h.from.addr), recipients],
        )
        .map_err(db_err)?;
        if !h.from.addr.is_empty() {
            touch_contact(&tx, &h.from, h.date, 0)?;
        }
    }
    tx.commit().map_err(db_err)?;
    Ok(ids)
}

/// Remembers an address for the To field's suggestions; `uses` counts mail sent to it.
pub fn touch_contact(conn: &Connection, a: &Address, at: i64, uses: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO contacts (addr, name, uses, last) VALUES (?1, ?2, ?4, ?3)
         ON CONFLICT(addr) DO UPDATE SET name = CASE WHEN ?2 <> '' AND ?3 >= last THEN ?2 ELSE name END, uses = uses + ?4, last = MAX(last, ?3)",
        params![a.addr.to_lowercase(), a.name, at, uses],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn contacts(conn: &Connection, prefix: &str, limit: usize) -> Result<Vec<Address>> {
    let like = format!("%{}%", prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let mut stmt = conn
        .prepare("SELECT name, addr FROM contacts WHERE addr LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\' ORDER BY uses DESC, last DESC LIMIT ?2")
        .map_err(db_err)?;
    let rows = stmt.query_map(params![like, limit as i64], |r| Ok(Address { name: r.get(0)?, addr: r.get(1)? })).map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

/// The folder's messages held here: uid → flags.
pub fn folder_uids(conn: &Connection, folder: i64) -> Result<HashMap<u32, u32>> {
    let mut stmt = conn.prepare("SELECT uid, flags FROM messages WHERE folder_id = ?1").map_err(db_err)?;
    let rows = stmt.query_map([folder], |r| Ok((r.get(0)?, r.get(1)?))).map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

pub fn set_flags(conn: &Connection, folder: i64, uid: u32, flags: u32) -> Result<()> {
    conn.execute("UPDATE messages SET flags = ?3 WHERE folder_id = ?1 AND uid = ?2", params![folder, uid, flags]).map_err(db_err)?;
    Ok(())
}

pub fn delete_uids(conn: &mut Connection, folder: i64, uids: &[u32]) -> Result<()> {
    let tx = conn.transaction().map_err(db_err)?;
    for uid in uids {
        tx.execute("DELETE FROM messages WHERE folder_id = ?1 AND uid = ?2", params![folder, uid]).map_err(db_err)?;
    }
    tx.commit().map_err(db_err)
}

/// The message's text is here now: its preview line, whether it carries files, and its words
/// for the search.
pub fn set_body(conn: &Connection, folder: i64, uid: u32, snippet: &str, attachments: bool, text: &str) -> Result<()> {
    let id: Option<i64> = conn.query_row("SELECT id FROM messages WHERE folder_id = ?1 AND uid = ?2", params![folder, uid], |r| r.get(0)).optional().map_err(db_err)?;
    let Some(id) = id else { return Ok(()) };
    conn.execute("UPDATE messages SET body = 1, snippet = ?2, attachments = ?3 WHERE id = ?1", params![id, snippet, attachments]).map_err(db_err)?;
    conn.execute("UPDATE messages_fts SET body = ?2 WHERE rowid = ?1", params![id, text]).map_err(db_err)?;
    Ok(())
}

/// The folder's messages whose text isn't here yet, newest first.
pub fn without_body(conn: &Connection, folder: i64, max_size: u32, limit: usize) -> Result<Vec<u32>> {
    let mut stmt = conn.prepare("SELECT uid FROM messages WHERE folder_id = ?1 AND body = 0 AND size <= ?2 ORDER BY date DESC LIMIT ?3").map_err(db_err)?;
    let rows = stmt.query_map(params![folder, max_size, limit as i64], |r| r.get(0)).map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

/// One message, as the page lists it in a conversation.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: i64,
    pub account_id: String,
    pub folder_id: i64,
    pub folder_role: String,
    pub uid: u32,
    pub message_id: String,
    pub thread_id: String,
    pub subject: String,
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub reply_to: String,
    /// Seconds since the epoch.
    pub date: i64,
    pub size: u32,
    pub seen: bool,
    pub flagged: bool,
    pub answered: bool,
    pub attachments: bool,
    pub snippet: String,
    pub body: bool,
    #[serde(skip)]
    pub refs: String,
}

const MESSAGE_COLUMNS: &str = "m.id, m.account_id, m.folder_id, f.role, m.uid, m.message_id, m.thread_id, m.subject, m.from_name, m.from_addr, m.to_json, m.cc_json, m.reply_to, m.date, m.size, m.flags, m.attachments, m.snippet, m.body, m.refs";

fn message_row(r: &Row) -> rusqlite::Result<Message> {
    let flags: u32 = r.get(15)?;
    let list = |i: usize| -> rusqlite::Result<Vec<Address>> { Ok(serde_json::from_str(&r.get::<_, String>(i)?).unwrap_or_default()) };
    Ok(Message {
        id: r.get(0)?,
        account_id: r.get(1)?,
        folder_id: r.get(2)?,
        folder_role: r.get(3)?,
        uid: r.get(4)?,
        message_id: r.get(5)?,
        thread_id: r.get(6)?,
        subject: r.get(7)?,
        from: Address { name: r.get(8)?, addr: r.get(9)? },
        to: list(10)?,
        cc: list(11)?,
        reply_to: r.get(12)?,
        date: r.get(13)?,
        size: r.get(14)?,
        seen: flags & SEEN != 0,
        flagged: flags & FLAGGED != 0,
        answered: flags & ANSWERED != 0,
        attachments: r.get(16)?,
        snippet: r.get(17)?,
        body: r.get(18)?,
        refs: r.get(19)?,
    })
}

pub fn message(conn: &Connection, id: i64) -> Result<Message> {
    conn.query_row(&format!("SELECT {MESSAGE_COLUMNS} FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?1"), [id], message_row)
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| "That message isn't here any more.".to_string())
}

pub fn messages_by_ids(conn: &Connection, ids: &[i64]) -> Result<Vec<Message>> {
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Ok(m) = message(conn, *id) {
            out.push(m);
        }
    }
    Ok(out)
}

/// A conversation, oldest first. Copies of one message in several folders show once; what's in
/// Trash or Junk shows only from that folder (`within`).
pub fn thread(conn: &Connection, account: &str, thread: &str, within: Option<i64>) -> Result<Vec<Message>> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE m.account_id = ?1 AND m.thread_id = ?2 AND (f.role NOT IN ('trash', 'junk') OR m.folder_id = ?3)
             ORDER BY m.date, m.id"
        ))
        .map_err(db_err)?;
    let rows = stmt.query_map(params![account, thread, within], message_row).map_err(db_err)?;
    let all: Vec<Message> = rows.collect::<rusqlite::Result<_>>().map_err(db_err)?;
    let mut out: Vec<Message> = Vec::with_capacity(all.len());
    for m in all {
        match out.iter_mut().find(|x| !m.message_id.is_empty() && x.message_id == m.message_id) {
            // The copy in the folder being looked at wins, then one outside Sent.
            Some(kept) => {
                if Some(m.folder_id) == within || (kept.folder_role == "sent" && Some(kept.folder_id) != within) {
                    *kept = m;
                }
            }
            None => out.push(m),
        }
    }
    Ok(out)
}

/// What the list shows.
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    /// One folder.
    pub folder: Option<i64>,
    /// Every account's folder of this kind ("inbox": all inboxes), or `account`'s only.
    pub role: Option<String>,
    pub account: Option<String>,
    pub starred: bool,
    pub unread: bool,
    pub search: String,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// One row of the list: a conversation, shown by its newest message in the view.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    /// The newest message's row.
    pub id: i64,
    pub account_id: String,
    pub folder_id: i64,
    pub folder_role: String,
    pub thread_id: String,
    pub subject: String,
    pub from: Address,
    pub to: Vec<Address>,
    pub snippet: String,
    pub date: i64,
    /// Messages of the conversation in this view.
    pub count: u32,
    pub unread: u32,
    pub flagged: bool,
    pub attachments: bool,
    /// Who wrote in it, oldest first.
    pub names: Vec<String>,
    /// Its messages' rows in this view (what an action on the row applies to).
    pub ids: Vec<i64>,
}

/// Turns what was typed into an FTS5 query: every word must appear, the last as a prefix.
fn fts_query(search: &str) -> Option<String> {
    let words: Vec<String> = search
        .split(|c: char| !(c.is_alphanumeric() || c == '@' || c == '.' || c == '-' || c == '_'))
        .flat_map(|w| w.split(['@', '.', '-', '_']))
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{}\"*", w.replace('"', "")))
        .collect();
    (!words.is_empty()).then(|| words.join(" "))
}

pub fn threads(conn: &Connection, q: &Query) -> Result<Vec<Thread>> {
    let mut wheres: Vec<String> = Vec::new();
    let mut args: Vec<Value> = Vec::new();
    let mut arg = |v: Value| {
        args.push(v);
        format!("?{}", args.len())
    };
    if let Some(folder) = q.folder {
        wheres.push(format!("m.folder_id = {}", arg(Value::Integer(folder))));
    } else {
        if let Some(role) = q.role.as_deref().filter(|r| !r.is_empty()) {
            wheres.push(format!("f.role = {}", arg(Value::Text(role.into()))));
        } else {
            wheres.push("f.role NOT IN ('trash', 'junk', 'drafts')".into());
        }
        if let Some(account) = q.account.as_deref().filter(|a| !a.is_empty()) {
            wheres.push(format!("m.account_id = {}", arg(Value::Text(account.into()))));
        }
    }
    if q.starred {
        wheres.push("m.flagged = 1".into());
    }
    if q.unread {
        wheres.push("m.seen = 0".into());
    }
    if let Some(fts) = fts_query(&q.search) {
        wheres.push(format!("m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH {})", arg(Value::Text(fts))));
    }
    let limit = arg(Value::Integer(q.limit.unwrap_or(60).clamp(1, 500) as i64));
    let offset = arg(Value::Integer(q.offset.unwrap_or(0) as i64));
    // With one MAX(), SQLite takes the other plain columns from the row that holds it: the newest.
    let sql = format!(
        "SELECT m.id, m.account_id, m.folder_id, f.role, m.thread_id, m.subject, m.from_name, m.from_addr, m.to_json, m.snippet,
                MAX(m.date), COUNT(*), SUM(m.seen = 0), SUM(m.flagged), SUM(m.attachments), GROUP_CONCAT(m.id)
         FROM messages m JOIN folders f ON f.id = m.folder_id
         WHERE {} GROUP BY m.account_id, m.thread_id ORDER BY MAX(m.date) DESC, m.id DESC LIMIT {limit} OFFSET {offset}",
        wheres.join(" AND ")
    );
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let rows = stmt
        .query_map(params_from_iter(args.iter()), |r| {
            let ids: String = r.get(15)?;
            Ok(Thread {
                id: r.get(0)?,
                account_id: r.get(1)?,
                folder_id: r.get(2)?,
                folder_role: r.get(3)?,
                thread_id: r.get(4)?,
                subject: r.get(5)?,
                from: Address { name: r.get(6)?, addr: r.get(7)? },
                to: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or_default(),
                snippet: r.get(9)?,
                date: r.get(10)?,
                count: r.get(11)?,
                unread: r.get(12)?,
                flagged: r.get::<_, i64>(13)? > 0,
                attachments: r.get::<_, i64>(14)? > 0,
                names: Vec::new(),
                ids: ids.split(',').filter_map(|s| s.parse().ok()).collect(),
            })
        })
        .map_err(db_err)?;
    let mut threads: Vec<Thread> = rows.collect::<rusqlite::Result<_>>().map_err(db_err)?;
    let mut names = conn
        .prepare_cached("SELECT CASE WHEN from_name <> '' THEN from_name ELSE from_addr END FROM messages WHERE account_id = ?1 AND thread_id = ?2 ORDER BY date")
        .map_err(db_err)?;
    for t in threads.iter_mut().filter(|t| t.count > 1) {
        let rows = names.query_map(params![t.account_id, t.thread_id], |r| r.get::<_, String>(0)).map_err(db_err)?;
        for name in rows.flatten() {
            if !t.names.contains(&name) {
                t.names.push(name);
            }
        }
    }
    Ok(threads)
}

/// Unread messages in every inbox.
pub fn unread_inbox(conn: &Connection) -> Result<u32> {
    conn.query_row("SELECT COALESCE(SUM(unread), 0) FROM folders WHERE role = 'inbox'", [], |r| r.get(0)).map_err(db_err)
}

// ---- drafts

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: String,
    pub account_id: String,
    /// The compose sheet's state, as the page wrote it.
    pub json: String,
    pub updated: i64,
}

pub fn drafts(conn: &Connection) -> Result<Vec<Draft>> {
    let mut stmt = conn.prepare("SELECT id, account_id, json, updated FROM drafts ORDER BY updated DESC").map_err(db_err)?;
    let rows = stmt.query_map([], |r| Ok(Draft { id: r.get(0)?, account_id: r.get(1)?, json: r.get(2)?, updated: r.get(3)? })).map_err(db_err)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_err)
}

pub fn save_draft(conn: &Connection, id: &str, account: &str, json: &str, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO drafts (id, account_id, json, updated) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET account_id = ?2, json = ?3, updated = ?4",
        params![id, account, json, now],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn delete_draft(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM drafts WHERE id = ?1", [id]).map_err(db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        let a = Account {
            id: "a".into(), email: "me@example.com".into(), name: "Me".into(), color: "blue".into(), username: "me@example.com".into(),
            imap: Server { host: "imap.example.com".into(), port: 993, security: "ssl".into() },
            smtp: Server { host: "smtp.example.com".into(), port: 465, security: "ssl".into() },
            signature: String::new(), synced: 0, error: None,
        };
        save_account(&conn, &a, 1).unwrap();
        let listed = [
            Listed { path: "INBOX".into(), name: "Inbox".into(), role: "inbox".into(), delim: "/".into(), selectable: true },
            Listed { path: "Sent".into(), name: "Sent".into(), role: "sent".into(), delim: "/".into(), selectable: true },
            Listed { path: "Trash".into(), name: "Trash".into(), role: "trash".into(), delim: "/".into(), selectable: true },
        ];
        set_folders(&mut conn, "a", &listed).unwrap();
        conn
    }

    fn header(uid: u32, id: &str, reply: &str, refs: &[&str], subject: &str, date: i64) -> Header {
        Header {
            uid, message_id: id.into(), in_reply_to: reply.into(), refs: refs.iter().map(|s| s.to_string()).collect(), subject: subject.into(),
            from: Address { name: "Ann".into(), addr: "ann@example.com".into() }, date, ..Header::default()
        }
    }

    #[test]
    fn conversations_join_across_folders_and_out_of_order() {
        let mut conn = open();
        let inbox = folder_by_role(&conn, "a", "inbox").unwrap().unwrap().id;
        let sent = folder_by_role(&conn, "a", "sent").unwrap().unwrap().id;
        // The answer arrives before the message it answers is synced.
        insert_headers(&mut conn, "a", inbox, &[header(2, "b@x", "a@x", &["a@x"], "Re: Lunch", 20)]).unwrap();
        insert_headers(&mut conn, "a", sent, &[header(1, "a@x", "", &[], "Lunch", 10)]).unwrap();
        insert_headers(&mut conn, "a", inbox, &[header(3, "c@x", "b@x", &["a@x", "b@x"], "Re: Lunch", 30), header(4, "z@x", "", &[], "Other", 25)]).unwrap();
        let all = thread(&conn, "a", "a@x", None).unwrap();
        assert_eq!(all.iter().map(|m| m.uid).collect::<Vec<_>>(), [1, 2, 3]);

        let list = threads(&conn, &Query { role: Some("inbox".into()), ..Query::default() }).unwrap();
        assert_eq!(list.len(), 2, "two conversations in the inbox");
        assert_eq!((list[0].subject.as_str(), list[0].count, list[0].date), ("Re: Lunch", 2, 30));
        assert_eq!(list[0].unread, 2);
        assert_eq!(list[1].subject, "Other");
    }

    #[test]
    fn search_finds_words_in_subject_sender_and_body() {
        let mut conn = open();
        let inbox = folder_by_role(&conn, "a", "inbox").unwrap().unwrap().id;
        insert_headers(&mut conn, "a", inbox, &[header(1, "a@x", "", &[], "Quarterly invoice", 10), header(2, "b@x", "", &[], "Hello", 20)]).unwrap();
        set_body(&conn, inbox, 2, "See the attached", true, "the budget spreadsheet is attached").unwrap();
        fn find(conn: &Connection, s: &str) -> Vec<String> {
            threads(conn, &Query { search: s.into(), ..Query::default() }).unwrap().iter().map(|t| t.subject.clone()).collect()
        }
        assert_eq!(find(&conn, "invoi"), ["Quarterly invoice"]);
        assert_eq!(find(&conn, "budget spread"), ["Hello"]);
        assert_eq!(find(&conn, "ann@example.com").len(), 2);
        assert!(find(&conn, "nothing-like-this").is_empty());
        // Deleting a message takes its words with it.
        delete_uids(&mut conn, inbox, &[2]).unwrap();
        assert!(find(&conn, "budget").is_empty());
    }

    #[test]
    fn folders_follow_the_server_list() {
        let mut conn = open();
        let trash = folder_by_role(&conn, "a", "trash").unwrap().unwrap().id;
        insert_headers(&mut conn, "a", trash, &[header(1, "a@x", "", &[], "Gone", 10)]).unwrap();
        let listed = [Listed { path: "INBOX".into(), name: "Inbox".into(), role: "inbox".into(), delim: "/".into(), selectable: true }];
        let gone = set_folders(&mut conn, "a", &listed).unwrap();
        assert_eq!(gone.len(), 2);
        assert_eq!(folders(&conn, Some("a")).unwrap().len(), 1);
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "a folder's messages go with it");
    }
}
