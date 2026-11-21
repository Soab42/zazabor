//! `tv.db`: every title the crawl has seen (name-parsed fields at once, the video link and poster
//! once a card is looked at), when each was last played, and the live channels (`live.rs`).

use std::path::Path;

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub type Result<T> = std::result::Result<T, String>;

pub fn db_err(e: rusqlite::Error) -> String {
    format!("The TV catalog: {e}")
}

/// What a folder's name says; the crawl's output.
#[derive(Debug, Clone, PartialEq)]
pub struct NewItem {
    pub title: String,
    pub year: Option<i32>,
    pub quality: String,
    pub tags: Vec<String>,
    pub kind: String,
    pub section: String,
    pub category: String,
    pub category_url: String,
    pub folder_url: String,
    pub added: i64,
    pub rank: Option<u32>,
}

/// What looking inside a title's folder found.
#[derive(Debug, Clone, Default)]
pub struct Resolved {
    pub video_url: String,
    pub size: i64,
    pub poster: String,
    pub tags: Vec<String>,
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub title: String,
    pub year: Option<i32>,
    pub quality: String,
    pub tags: Vec<String>,
    pub kind: String,
    pub section: String,
    pub category: String,
    pub category_url: String,
    pub folder_url: String,
    pub video_url: String,
    pub size: i64,
    /// The poster's file in the cache, when it is there.
    pub poster: Option<String>,
    /// Looked at and the folder has no picture: don't ask again.
    pub no_poster: bool,
    pub added: i64,
    pub rank: Option<u32>,
    pub played: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    pub section: Option<String>,
    pub kind: Option<String>,
    pub category_url: Option<String>,
    pub q: Option<String>,
    pub year: Option<i32>,
    pub quality: Option<String>,
    /// "new" (server time), "az", "year", "rank" or "played".
    pub sort: Option<String>,
    pub played: bool,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

pub fn make_id(folder_url: &str) -> String {
    let digest = Sha256::digest(folder_url.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, year INTEGER, quality TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, section TEXT NOT NULL,
  category TEXT NOT NULL, category_url TEXT NOT NULL, folder_url TEXT NOT NULL,
  video_url TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, poster TEXT NOT NULL DEFAULT '',
  resolved INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0, rank INTEGER,
  played INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS items_added ON items(added);
CREATE INDEX IF NOT EXISTS items_cat ON items(category_url);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("The TV catalog can't make its folder: {e}"))?;
    }
    let conn = Connection::open(path).map_err(db_err)?;
    init(&conn)?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA).map_err(db_err)?;
    super::live::schema(conn)
}

pub fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0)).optional().ok().flatten()
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2", params![key, value]);
}

/// Adds the titles a crawl found and refreshes what a name can change; poster, video link,
/// last-played time and a kind the folder's contents settled stay. Returns how many are new.
pub fn upsert(conn: &mut Connection, items: &[NewItem], stamp: i64) -> Result<usize> {
    let tx = conn.transaction().map_err(db_err)?;
    let mut fresh = 0;
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO items(id,title,year,quality,tags,kind,section,category,category_url,folder_url,added,rank,seen)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
                 ON CONFLICT(id) DO UPDATE SET title=?2, year=?3, quality=?4, tags=CASE WHEN resolved=1 THEN tags ELSE ?5 END,
                   section=?7, category=?8, category_url=?9, added=?11, rank=?12, seen=?13",
            )
            .map_err(db_err)?;
        for it in items {
            let id = make_id(&it.folder_url);
            let existed: bool = tx.query_row("SELECT 1 FROM items WHERE id=?1", [&id], |_| Ok(true)).optional().map_err(db_err)?.unwrap_or(false);
            insert
                .execute(params![id, it.title, it.year, it.quality, it.tags.join(","), it.kind, it.section, it.category, it.category_url, it.folder_url, it.added, it.rank, stamp])
                .map_err(db_err)?;
            if !existed {
                fresh += 1;
            }
        }
    }
    tx.commit().map_err(db_err)?;
    Ok(fresh)
}

/// Forgets what a finished crawl of a category no longer saw.
pub fn prune(conn: &Connection, category_url: &str, stamp: i64) -> usize {
    conn.execute("DELETE FROM items WHERE category_url=?1 AND seen<?2", params![category_url, stamp]).unwrap_or(0)
}

/// Drops categories that are no longer wanted.
pub fn keep_categories(conn: &Connection, urls: &[String]) {
    if urls.is_empty() {
        let _ = conn.execute("DELETE FROM items", []);
        return;
    }
    let marks = vec!["?"; urls.len()].join(",");
    let _ = conn.execute(&format!("DELETE FROM items WHERE category_url NOT IN ({marks})"), params_from_iter(urls.iter()));
}

const COLUMNS: &str = "id,title,year,quality,tags,kind,section,category,category_url,folder_url,video_url,size,poster,resolved,added,rank,played";

fn item_from_row(r: &Row) -> rusqlite::Result<Item> {
    let tags: String = r.get(4)?;
    let poster: String = r.get(12)?;
    let resolved: i64 = r.get(13)?;
    let there = !poster.is_empty() && Path::new(&poster).exists();
    Ok(Item {
        id: r.get(0)?,
        title: r.get(1)?,
        year: r.get(2)?,
        quality: r.get(3)?,
        tags: tags.split(',').filter(|t| !t.is_empty()).map(String::from).collect(),
        kind: r.get(5)?,
        section: r.get(6)?,
        category: r.get(7)?,
        category_url: r.get(8)?,
        folder_url: r.get(9)?,
        video_url: r.get(10)?,
        size: r.get(11)?,
        no_poster: poster.is_empty() && resolved == 1,
        poster: there.then_some(poster),
        added: r.get(14)?,
        rank: r.get(15)?,
        played: r.get(16)?,
    })
}

pub fn get(conn: &Connection, id: &str) -> Option<Item> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM items WHERE id=?1"), [id], item_from_row).optional().ok().flatten()
}

/// The stored poster path (even when its file has gone) and whether the folder was looked at.
pub fn poster_state(conn: &Connection, id: &str) -> Option<(String, bool)> {
    conn.query_row("SELECT poster,resolved FROM items WHERE id=?1", [id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? == 1))).optional().ok().flatten()
}

fn like(q: &str) -> String {
    format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

fn where_clause(f: &Filter, with_year: bool, with_quality: bool) -> (String, Vec<Value>) {
    let mut parts: Vec<String> = Vec::new();
    let mut args: Vec<Value> = Vec::new();
    fn add(parts: &mut Vec<String>, args: &mut Vec<Value>, sql: &str, v: Value) {
        parts.push(sql.to_string());
        args.push(v);
    }
    if let Some(s) = &f.section {
        add(&mut parts, &mut args, "section=?", Value::Text(s.clone()));
    }
    if let Some(k) = &f.kind {
        add(&mut parts, &mut args, "kind=?", Value::Text(k.clone()));
    }
    if let Some(c) = &f.category_url {
        add(&mut parts, &mut args, "category_url=?", Value::Text(c.clone()));
    }
    if let Some(q) = f.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        for word in q.split_whitespace() {
            add(&mut parts, &mut args, "(title LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')", Value::Text(like(word)));
            args.push(Value::Text(like(word)));
        }
    }
    if with_year {
        if let Some(y) = f.year {
            add(&mut parts, &mut args, "year=?", Value::Integer(y as i64));
        }
    }
    if with_quality {
        if let Some(q) = f.quality.as_deref().filter(|q| !q.is_empty()) {
            add(&mut parts, &mut args, "quality=?", Value::Text(q.to_string()));
        }
    }
    if f.played {
        parts.push("played>0".to_string());
    }
    (if parts.is_empty() { String::new() } else { format!(" WHERE {}", parts.join(" AND ")) }, args)
}

pub fn query(conn: &Connection, f: &Filter) -> Result<(Vec<Item>, i64)> {
    let (clause, args) = where_clause(f, true, true);
    let total: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM items{clause}"), params_from_iter(args.iter()), |r| r.get(0)).map_err(db_err)?;
    let order = match f.sort.as_deref() {
        Some("az") => "title COLLATE NOCASE ASC, year DESC",
        Some("year") => "COALESCE(year,0) DESC, added DESC",
        Some("rank") => "COALESCE(rank,100000) ASC, added DESC",
        Some("played") => "played DESC",
        _ => "added DESC, title COLLATE NOCASE ASC",
    };
    let sql = format!("SELECT {COLUMNS} FROM items{clause} ORDER BY {order} LIMIT {} OFFSET {}", f.limit.unwrap_or(60).clamp(1, 2000), f.offset.unwrap_or(0).max(0));
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), item_from_row).map_err(db_err)?;
    Ok((rows.filter_map(|r| r.ok()).collect(), total))
}

/// The years and qualities a filter's titles have (ignoring the filter's own year and quality).
pub fn facets(conn: &Connection, f: &Filter) -> Result<(Vec<(i32, i64)>, Vec<(String, i64)>)> {
    let (clause, args) = where_clause(f, false, false);
    let mut years = Vec::new();
    let mut stmt = conn.prepare(&format!("SELECT year,COUNT(*) FROM items{clause}{} year IS NOT NULL GROUP BY year ORDER BY year DESC", if clause.is_empty() { " WHERE" } else { " AND" })).map_err(db_err)?;
    for row in stmt.query_map(params_from_iter(args.iter()), |r| Ok((r.get::<_, i32>(0)?, r.get::<_, i64>(1)?))).map_err(db_err)? {
        years.push(row.map_err(db_err)?);
    }
    let mut qualities = Vec::new();
    let mut stmt = conn.prepare(&format!("SELECT quality,COUNT(*) FROM items{clause}{} quality<>'' GROUP BY quality ORDER BY COUNT(*) DESC", if clause.is_empty() { " WHERE" } else { " AND" })).map_err(db_err)?;
    for row in stmt.query_map(params_from_iter(args.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(db_err)? {
        qualities.push(row.map_err(db_err)?);
    }
    Ok((years, qualities))
}

/// (url, label, section, kind, count) of the categories that have titles.
pub fn categories(conn: &Connection) -> Result<Vec<(String, String, String, String, i64)>> {
    let mut stmt = conn
        .prepare("SELECT category_url,category,section,MIN(kind),COUNT(*) FROM items GROUP BY category_url ORDER BY MAX(added) DESC")
        .map_err(db_err)?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(db_err)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn set_resolved(conn: &Connection, id: &str, r: &Resolved) -> Result<()> {
    let tags = {
        let current: String = conn.query_row("SELECT tags FROM items WHERE id=?1", [id], |row| row.get(0)).optional().map_err(db_err)?.unwrap_or_default();
        let mut all: Vec<String> = current.split(',').filter(|t| !t.is_empty()).map(String::from).collect();
        for t in &r.tags {
            if !all.contains(t) {
                all.push(t.clone());
            }
        }
        all.join(",")
    };
    conn.execute(
        "UPDATE items SET video_url=?2,size=?3,poster=?4,tags=?5,kind=COALESCE(?6,kind),resolved=1 WHERE id=?1",
        params![id, r.video_url, r.size, r.poster, tags, r.kind],
    )
    .map_err(db_err)?;
    Ok(())
}

pub fn touch_played(conn: &Connection, id: &str, now: i64) {
    let _ = conn.execute("UPDATE items SET played=?2 WHERE id=?1", params![id, now]);
}

/// Forgets every poster (the cache was cleared): cards fetch theirs again when seen.
pub fn forget_posters(conn: &Connection) {
    let _ = conn.execute("UPDATE items SET poster='', resolved=0", []);
}

pub fn count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(title: &str, year: i32, added: i64, category: &str) -> NewItem {
        NewItem {
            title: title.into(),
            year: Some(year),
            quality: "1080p".into(),
            tags: vec!["Dual Audio".into()],
            kind: "movie".into(),
            section: "movies".into(),
            category: category.into(),
            category_url: format!("http://h/{category}/"),
            folder_url: format!("http://h/{category}/{title}/"),
            added,
            rank: None,
        }
    }

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    #[test]
    fn merge_keeps_what_the_user_and_the_folder_gave() {
        let mut c = mem();
        let a = new("Anaconda", 2025, 100, "English");
        assert_eq!(upsert(&mut c, &[a.clone(), new("Afterburn", 2025, 300, "English")], 1).unwrap(), 2);
        let id = make_id(&a.folder_url);
        set_resolved(&c, &id, &Resolved { video_url: "http://h/a.mkv".into(), size: 5, poster: "/nope.jpg".into(), tags: vec!["HEVC".into()], kind: None }).unwrap();
        touch_played(&c, &id, 777);
        // the next crawl sees it again with a newer time, and one more title
        let mut again = a.clone();
        again.added = 900;
        assert_eq!(upsert(&mut c, &[again, new("Zodiac", 2007, 50, "English")], 2).unwrap(), 1);
        let item = get(&c, &id).unwrap();
        assert_eq!((item.added, item.played, item.video_url.as_str(), item.size), (900, 777, "http://h/a.mkv", 5));
        assert_eq!(item.tags, vec!["Dual Audio", "HEVC"]);
        assert_eq!(item.poster, None, "the poster file isn't there");
        assert!(!item.no_poster);
        assert_eq!(count(&c), 3);
        // Afterburn wasn't seen in the second crawl: pruned once it completes
        assert_eq!(prune(&c, &a.category_url, 2), 1);
        assert_eq!(count(&c), 2);
    }

    #[test]
    fn queries_sort_filter_and_search() {
        let mut c = mem();
        let mut imdb = new("The Godfather", 1972, 10, "IMDb");
        imdb.rank = Some(2);
        let mut shawshank = new("The Shawshank Redemption", 1994, 20, "IMDb");
        shawshank.rank = Some(1);
        let mut show = new("18 Again", 2020, 40, "Korean");
        show.kind = "series".into();
        show.quality = "720p".into();
        upsert(&mut c, &[imdb, shawshank, show, new("Anaconda", 2025, 30, "English")], 1).unwrap();
        let titles = |f: Filter| query(&c, &f).unwrap().0.into_iter().map(|i| i.title).collect::<Vec<_>>();
        assert_eq!(titles(Filter::default()), vec!["18 Again", "Anaconda", "The Shawshank Redemption", "The Godfather"]);
        assert_eq!(titles(Filter { sort: Some("rank".into()), category_url: Some("http://h/IMDb/".into()), ..Default::default() }), vec!["The Shawshank Redemption", "The Godfather"]);
        assert_eq!(titles(Filter { kind: Some("series".into()), ..Default::default() }), vec!["18 Again"]);
        assert_eq!(titles(Filter { q: Some("the god".into()), ..Default::default() }), vec!["The Godfather"]);
        assert_eq!(titles(Filter { quality: Some("720p".into()), ..Default::default() }), vec!["18 Again"]);
        assert_eq!(titles(Filter { year: Some(1994), ..Default::default() }), vec!["The Shawshank Redemption"]);
        assert_eq!(titles(Filter { sort: Some("az".into()), limit: Some(2), ..Default::default() }), vec!["18 Again", "Anaconda"]);
        assert_eq!(titles(Filter { q: Some("100%".into()), ..Default::default() }), Vec::<String>::new());
        let (years, qualities) = facets(&c, &Filter::default()).unwrap();
        assert_eq!(years.first(), Some(&(2025, 1)));
        assert_eq!(qualities[0], ("1080p".to_string(), 3));
        assert_eq!(categories(&c).unwrap().len(), 3);
        keep_categories(&c, &["http://h/IMDb/".to_string()]);
        assert_eq!(count(&c), 2);
    }

    #[test]
    fn ids_are_stable() {
        assert_eq!(make_id("http://h/a/"), make_id("http://h/a/"));
        assert_ne!(make_id("http://h/a/"), make_id("http://h/b/"));
        assert_eq!(make_id("x").len(), 16);
    }
}
