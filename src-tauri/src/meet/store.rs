//! `meet.db`: meetings with their invitees, the recordings made, and Meet's settings.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, String>;

fn db_err(e: rusqlite::Error) -> String {
    format!("Meet's database: {e}")
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Invitee {
    pub email: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sent_at: Option<i64>,
    #[serde(default)]
    pub error: Option<String>,
}

/// A meeting as stored; `Meeting` (the page's shape) adds what the rooms know.
#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub id: String,
    pub code: String,
    pub title: String,
    pub kind: String,
    pub starts_at: Option<i64>,
    pub minutes: i64,
    pub auto_record: bool,
    pub lobby: bool,
    pub invitees: Vec<Invitee>,
    pub created_at: i64,
    /// The link the invitations carried, and the account that sent them.
    pub invite_url: Option<String>,
    pub invite_account: Option<String>,
    /// "is starting" went out.
    pub started_mail: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub id: String,
    pub meeting_id: String,
    pub title: String,
    pub path: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub bytes: i64,
}

pub fn open(path: &std::path::Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Meet can't make its folder: {e}"))?;
    }
    let conn = Connection::open(path).map_err(db_err)?;
    migrate(&conn)?;
    Ok(conn)
}

pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS meetings (
             id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'meeting',
             starts_at INTEGER, minutes INTEGER NOT NULL DEFAULT 30, auto_record INTEGER NOT NULL DEFAULT 1,
             lobby INTEGER NOT NULL DEFAULT 1, invitees TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
             invite_url TEXT, invite_account TEXT, started_mail INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS recordings (
             id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, title TEXT NOT NULL, path TEXT NOT NULL,
             started_at INTEGER NOT NULL, ended_at INTEGER, bytes INTEGER NOT NULL DEFAULT 0);",
    )
    .map_err(db_err)
}

const COLS: &str = "id, code, title, kind, starts_at, minutes, auto_record, lobby, invitees, created_at, invite_url, invite_account, started_mail";

fn row(r: &Row) -> rusqlite::Result<Stored> {
    let invitees: String = r.get(8)?;
    Ok(Stored {
        id: r.get(0)?,
        code: r.get(1)?,
        title: r.get(2)?,
        kind: r.get(3)?,
        starts_at: r.get(4)?,
        minutes: r.get(5)?,
        auto_record: r.get::<_, i64>(6)? != 0,
        lobby: r.get::<_, i64>(7)? != 0,
        invitees: serde_json::from_str(&invitees).unwrap_or_default(),
        created_at: r.get(9)?,
        invite_url: r.get(10)?,
        invite_account: r.get(11)?,
        started_mail: r.get::<_, i64>(12)? != 0,
    })
}

/// Join codes use [a-z2-9] (no 0 or 1 to misread).
const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz23456789";

pub fn random_bytes<const N: usize>() -> [u8; N] {
    use ring::rand::SecureRandom;
    let mut out = [0u8; N];
    ring::rand::SystemRandom::new().fill(&mut out).expect("the system's random source");
    out
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn new_id() -> String {
    hex(&random_bytes::<8>())
}

/// A join code: 10 characters, `abcdefghij` (shown as abc-defg-hij).
pub fn new_code() -> String {
    // Rejection sampling keeps every letter equally likely.
    let limit = 256 - 256 % ALPHABET.len();
    let mut out = String::new();
    while out.len() < 10 {
        for b in random_bytes::<16>() {
            if (b as usize) < limit && out.len() < 10 {
                out.push(ALPHABET[b as usize % ALPHABET.len()] as char);
            }
        }
    }
    out
}

pub fn valid_code(code: &str) -> bool {
    code.len() == 10 && code.bytes().all(|b| ALPHABET.contains(&b))
}

/// `abc-defg-hij`.
pub fn pretty_code(code: &str) -> String {
    if code.len() == 10 {
        format!("{}-{}-{}", &code[..3], &code[3..7], &code[7..])
    } else {
        code.to_string()
    }
}

pub struct Fields {
    pub title: String,
    pub kind: String,
    pub starts_at: Option<i64>,
    pub minutes: i64,
    pub auto_record: bool,
    pub lobby: bool,
    pub invitees: Vec<Invitee>,
}

pub fn create(conn: &Connection, f: &Fields, now: i64) -> Result<Stored> {
    let id = new_id();
    let mut code = new_code();
    while conn.query_row("SELECT 1 FROM meetings WHERE code = ?1", [&code], |_| Ok(())).optional().map_err(db_err)?.is_some() {
        code = new_code();
    }
    let invitees = serde_json::to_string(&f.invitees).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO meetings (id, code, title, kind, starts_at, minutes, auto_record, lobby, invitees, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![id, code, f.title, f.kind, f.starts_at, f.minutes, f.auto_record, f.lobby, invitees, now],
    )
    .map_err(db_err)?;
    get(conn, &id)
}

pub fn update(conn: &Connection, id: &str, f: &Fields) -> Result<Stored> {
    let invitees = serde_json::to_string(&f.invitees).map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE meetings SET title=?2, kind=?3, starts_at=?4, minutes=?5, auto_record=?6, lobby=?7, invitees=?8, started_mail=0 WHERE id=?1",
            params![id, f.title, f.kind, f.starts_at, f.minutes, f.auto_record, f.lobby, invitees],
        )
        .map_err(db_err)?;
    if n == 0 {
        return Err("That meeting isn't there any more.".into());
    }
    get(conn, id)
}

pub fn set_invitees(conn: &Connection, id: &str, invitees: &[Invitee], url: Option<&str>, account: Option<&str>) -> Result<()> {
    let json = serde_json::to_string(invitees).map_err(|e| e.to_string())?;
    conn.execute("UPDATE meetings SET invitees=?2, invite_url=COALESCE(?3, invite_url), invite_account=COALESCE(?4, invite_account) WHERE id=?1", params![id, json, url, account]).map_err(db_err)?;
    Ok(())
}

pub fn set_started_mail(conn: &Connection, id: &str, url: &str) -> Result<()> {
    conn.execute("UPDATE meetings SET started_mail=1, invite_url=?2 WHERE id=?1", params![id, url]).map_err(db_err)?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM meetings WHERE id=?1", [id]).map_err(db_err)?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> Result<Stored> {
    conn.query_row(&format!("SELECT {COLS} FROM meetings WHERE id=?1"), [id], row).optional().map_err(db_err)?.ok_or_else(|| "That meeting isn't there any more.".to_string())
}

pub fn by_code(conn: &Connection, code: &str) -> Result<Option<Stored>> {
    conn.query_row(&format!("SELECT {COLS} FROM meetings WHERE code=?1"), [code], row).optional().map_err(db_err)
}

pub fn all(conn: &Connection) -> Result<Vec<Stored>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM meetings ORDER BY created_at DESC")).map_err(db_err)?;
    let rows = stmt.query_map([], row).map_err(db_err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?;
    Ok(rows)
}

// ---- recordings

pub fn add_recording(conn: &Connection, r: &Recording) -> Result<()> {
    conn.execute(
        "INSERT INTO recordings (id, meeting_id, title, path, started_at, ended_at, bytes) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![r.id, r.meeting_id, r.title, r.path, r.started_at, r.ended_at, r.bytes],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn grow_recording(conn: &Connection, id: &str, bytes: i64, now: i64) -> Result<()> {
    conn.execute("UPDATE recordings SET bytes=?2, ended_at=?3 WHERE id=?1", params![id, bytes, now]).map_err(db_err)?;
    Ok(())
}

pub fn recordings(conn: &Connection) -> Result<Vec<Recording>> {
    let mut stmt = conn.prepare("SELECT id, meeting_id, title, path, started_at, ended_at, bytes FROM recordings ORDER BY started_at DESC").map_err(db_err)?;
    let rows = stmt
        .query_map([], |r| Ok(Recording { id: r.get(0)?, meeting_id: r.get(1)?, title: r.get(2)?, path: r.get(3)?, started_at: r.get(4)?, ended_at: r.get(5)?, bytes: r.get(6)? }))
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)?;
    Ok(rows)
}

pub fn recording(conn: &Connection, id: &str) -> Result<Recording> {
    recordings(conn)?.into_iter().find(|r| r.id == id).ok_or_else(|| "That recording isn't there any more.".to_string())
}

pub fn delete_recording(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM recordings WHERE id=?1", [id]).map_err(db_err)?;
    Ok(())
}

// ---- settings

pub fn meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0)).optional().ok().flatten()
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value]).map_err(db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c
    }

    fn fields(title: &str) -> Fields {
        Fields { title: title.into(), kind: "meeting".into(), starts_at: Some(1_000), minutes: 30, auto_record: true, lobby: true, invitees: vec![Invitee { email: "a@b.c".into(), name: "Ann".into(), ..Default::default() }] }
    }

    #[test]
    fn codes_have_the_promised_shape() {
        for _ in 0..200 {
            let c = new_code();
            assert!(valid_code(&c), "{c}");
        }
        assert_eq!(pretty_code("abcdefghjk"), "abc-defg-hjk");
        assert!(valid_code("abcdefghij"));
        assert!(!valid_code("abc-defg-hj"));
        assert!(!valid_code("abcdefghi0"));
        assert_ne!(new_code(), new_code());
    }

    #[test]
    fn meetings_are_kept_changed_and_deleted() {
        let c = mem();
        let m = create(&c, &fields("Standup"), 5).unwrap();
        assert_eq!(m.id.len(), 16);
        assert!(m.auto_record && m.lobby);
        assert_eq!(by_code(&c, &m.code).unwrap().unwrap().id, m.id);
        let mut f = fields("Standup 2");
        f.lobby = false;
        let m2 = update(&c, &m.id, &f).unwrap();
        assert_eq!((m2.title.as_str(), m2.lobby, m2.invitees.len()), ("Standup 2", false, 1));
        set_invitees(&c, &m.id, &[Invitee { email: "a@b.c".into(), name: "Ann".into(), sent_at: Some(9), error: None }], Some("https://x.trycloudflare.com"), Some("acc")).unwrap();
        let m3 = get(&c, &m.id).unwrap();
        assert_eq!(m3.invitees[0].sent_at, Some(9));
        assert_eq!(m3.invite_url.as_deref(), Some("https://x.trycloudflare.com"));
        assert_eq!(all(&c).unwrap().len(), 1);
        delete(&c, &m.id).unwrap();
        assert!(get(&c, &m.id).is_err());
        assert!(update(&c, "nope", &f).is_err());
    }

    #[test]
    fn recordings_and_settings_round_trip() {
        let c = mem();
        let r = Recording { id: "r1".into(), meeting_id: "m".into(), title: "T".into(), path: "/x/T.webm".into(), started_at: 1, ended_at: None, bytes: 0 };
        add_recording(&c, &r).unwrap();
        grow_recording(&c, "r1", 500, 9).unwrap();
        let got = recording(&c, "r1").unwrap();
        assert_eq!((got.bytes, got.ended_at), (500, Some(9)));
        delete_recording(&c, "r1").unwrap();
        assert!(recordings(&c).unwrap().is_empty());
        assert_eq!(meta(&c, "k"), None);
        set_meta(&c, "k", "v").unwrap();
        set_meta(&c, "k", "w").unwrap();
        assert_eq!(meta(&c, "k").as_deref(), Some("w"));
    }
}
