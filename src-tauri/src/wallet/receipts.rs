//! Receipts: pictures and PDFs attached to a transaction. Each file is copied into the wallet's own
//! folder (`wallet/receipts/<hash>.<ext>`), so moving or deleting the original never breaks the
//! link; the same file attached twice is stored once.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};

use super::db::{db_err, Result};
use crate::notes::new_id;

/// A receipt larger than this is refused (a phone photo is a few MB, a scanned PDF more).
const MAX_BYTES: u64 = 40 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub transaction_id: String,
    /// The stored copy, inside the wallet's folder.
    pub path: String,
    /// The original file's name.
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub created: i64,
}

pub fn dir(wallet: &Path) -> PathBuf {
    wallet.join("receipts")
}

/// The content type of a receipt by its extension; `None` for files that aren't pictures or PDFs.
fn mime_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "heic" => "image/heic",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

/// Copies `source` into the store and attaches it to a transaction.
pub fn attach(conn: &Connection, wallet: &Path, transaction_id: &str, source: &Path, now: i64) -> Result<Receipt> {
    let found: Option<i64> = conn.query_row("SELECT 1 FROM transactions WHERE id = ?1", [transaction_id], |r| r.get(0)).optional().map_err(db_err)?;
    if found.is_none() {
        return Err("That transaction no longer exists.".into());
    }
    let name = source.file_name().map(|n| n.to_string_lossy().to_string()).ok_or("That isn't a file.")?;
    let ext = source.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mime = mime_of(&ext).ok_or_else(|| format!("“{name}” isn't a picture or a PDF."))?;
    let bytes = crate::fs::text::read_bytes(source, MAX_BYTES).map_err(|e| if e.contains("too large") || e.contains("larger") { format!("“{name}” is larger than 40 MB.") } else { e })?;
    let hash = xxhash_rust::xxh3::xxh3_128(&bytes);
    let file = format!("{hash:032x}.{ext}");
    let folder = dir(wallet);
    std::fs::create_dir_all(&folder).map_err(|e| format!("Can't make the receipts folder: {e}"))?;
    let stored = folder.join(&file);
    if !stored.exists() {
        crate::fs::text::write_bytes(&stored, &bytes)?;
    }
    let id = new_id();
    conn.execute(
        "INSERT INTO receipts (id, transaction_id, file, name, mime, size, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, transaction_id, file, name, mime, bytes.len() as i64, now],
    )
    .map_err(db_err)?;
    Ok(Receipt { id, transaction_id: transaction_id.into(), path: stored.to_string_lossy().to_string(), name, mime: mime.into(), size: bytes.len() as i64, created: now })
}

pub fn list(conn: &Connection, wallet: &Path, transaction_id: &str) -> Result<Vec<Receipt>> {
    let folder = dir(wallet);
    let mut stmt = conn
        .prepare("SELECT id, transaction_id, file, name, mime, size, created FROM receipts WHERE transaction_id = ?1 ORDER BY created")
        .map_err(db_err)?;
    let rows = stmt
        .query_map([transaction_id], |r| {
            Ok(Receipt {
                id: r.get(0)?,
                transaction_id: r.get(1)?,
                path: folder.join(r.get::<_, String>(2)?).to_string_lossy().to_string(),
                name: r.get(3)?,
                mime: r.get(4)?,
                size: r.get(5)?,
                created: r.get(6)?,
            })
        })
        .map_err(db_err)?;
    rows.collect::<std::result::Result<_, _>>().map_err(db_err)
}

pub fn remove(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM receipts WHERE id = ?1", [id]).map_err(db_err)?;
    Ok(())
}

/// Deletes stored files no receipt points to any more (after transactions or receipts went), once
/// they are older than `grace`.
pub fn sweep(conn: &Connection, wallet: &Path, grace: std::time::Duration) -> Result<usize> {
    let used: std::collections::HashSet<String> = {
        let mut stmt = conn.prepare("SELECT DISTINCT file FROM receipts").map_err(db_err)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(db_err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(db_err)?
    };
    let mut gone = 0;
    for entry in std::fs::read_dir(dir(wallet)).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Only files named like the store's own (a hash and an extension).
        let ours = name.split_once('.').is_some_and(|(h, _)| h.len() == 32 && h.chars().all(|c| c.is_ascii_hexdigit()));
        let old = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age >= grace);
        if ours && old && !used.contains(&name) && std::fs::remove_file(entry.path()).is_ok() {
            gone += 1;
        }
    }
    Ok(gone)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::db::{self, tests::fresh};

    #[test]
    fn receipts_are_copies_that_outlive_the_original() {
        let mut conn = fresh();
        let root = std::env::temp_dir().join(format!("corepro-receipts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let original = root.join("bill.png");
        std::fs::write(&original, b"\x89PNG fake").unwrap();
        let wallet = root.join("wallet");
        let cash = db::accounts(&conn).unwrap()[0].id.clone();
        let t = db::save_tx(&conn, db::TxInput { id: None, kind: "expense".into(), account_id: cash, amount: "90".into(), date: "2026-10-26".into(), category_id: None, payee: "".into(), note: "".into() }, 1).unwrap();
        let r = attach(&conn, &wallet, &t.id, &original, 2).unwrap();
        std::fs::remove_file(&original).unwrap();
        assert!(Path::new(&r.path).exists());
        assert_eq!(db::tx(&conn, &t.id).unwrap().receipts, 1);
        assert!(attach(&conn, &wallet, &t.id, &root.join("notes.txt"), 3).is_err());
        // Deleting the transaction takes its receipts; the sweep removes the file.
        db::delete_txs(&mut conn, &[t.id.clone()]).unwrap();
        assert!(list(&conn, &wallet, &t.id).unwrap().is_empty());
        assert_eq!(sweep(&conn, &wallet, std::time::Duration::from_secs(3600)).unwrap(), 0);
        assert_eq!(sweep(&conn, &wallet, std::time::Duration::ZERO).unwrap(), 1);
        assert!(!Path::new(&r.path).exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
