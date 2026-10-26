//! AutoRecover for the Video Editor: while a project has unsaved changes the page keeps a
//! snapshot of it here every 20 seconds. A snapshot left by a CorePro that is no longer running
//! (a crash, a power cut) is offered back on Studio's Home.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A snapshot bigger than this isn't one.
pub const MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub id: String,
    /// The project's title when it was taken.
    pub title: String,
    /// The project's file; None while it was never saved.
    pub path: Option<String>,
    /// When it was taken (ms since 1970).
    #[serde(default)]
    pub saved: i64,
    /// The CorePro that took it (its own snapshots are of projects still open).
    #[serde(default)]
    pub pid: u32,
}

/// A snapshot's id names its files: letters, digits and dashes only.
pub fn file(dir: &Path, id: &str, ext: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Bad AutoRecover id.".into());
    }
    Ok(dir.join(format!("{id}.{ext}")))
}

pub fn save(dir: &Path, mut meta: Snapshot, text: &str, pid: u32, now: i64) -> Result<(), String> {
    meta.pid = pid;
    meta.saved = now;
    let data = file(dir, &meta.id, "corevideo")?;
    let info = file(dir, &meta.id, "json")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    crate::fs::text::write_bytes(&data, text.as_bytes())?;
    crate::fs::text::write_bytes(&info, &serde_json::to_vec(&meta).map_err(|e| e.to_string())?)?;
    Ok(())
}

/// Snapshots other CorePros left behind, newest first.
pub fn list(dir: &Path, pid: u32) -> Vec<Snapshot> {
    let mut out: Vec<Snapshot> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
                .filter_map(|e| std::fs::read(e.path()).ok())
                .filter_map(|b| serde_json::from_slice::<Snapshot>(&b).ok())
                .filter(|s| s.pid != pid && file(dir, &s.id, "corevideo").is_ok_and(|p| p.exists()))
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|s| std::cmp::Reverse(s.saved));
    out
}

pub fn read(dir: &Path, id: &str) -> Result<String, String> {
    let bytes = crate::fs::text::read_bytes(&file(dir, id, "corevideo")?, MAX_BYTES)?;
    String::from_utf8(bytes).map_err(|_| "The snapshot is damaged.".to_string())
}

pub fn delete(dir: &Path, id: &str) -> Result<(), String> {
    let _ = std::fs::remove_file(file(dir, id, "corevideo")?);
    let _ = std::fs::remove_file(file(dir, id, "json")?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str) -> Snapshot {
        Snapshot { id: id.into(), title: "Untitled reel".into(), path: None, saved: 0, pid: 0 }
    }

    #[test]
    fn ids_cannot_leave_the_folder() {
        let dir = Path::new("/tmp/x");
        assert!(file(dir, "v-1a2b", "json").is_ok());
        assert!(file(dir, "../../etc/passwd", "json").is_err());
        assert!(file(dir, "a/b", "json").is_err());
        assert!(file(dir, "", "json").is_err());
    }

    #[test]
    fn only_snapshots_of_other_corepros_come_back_newest_first() {
        let dir = std::env::temp_dir().join(format!("corepro-recover-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        save(&dir, meta("v-old"), "{\"a\":1}", 111, 1000).unwrap();
        save(&dir, meta("v-new"), "{\"a\":2}", 222, 2000).unwrap();
        save(&dir, meta("v-mine"), "{\"a\":3}", 333, 3000).unwrap();
        let listed: Vec<String> = list(&dir, 333).into_iter().map(|s| s.id).collect();
        assert_eq!(listed, ["v-new", "v-old"]);
        assert_eq!(read(&dir, "v-old").unwrap(), "{\"a\":1}");
        // Saving again under the same id replaces it (and takes it over for this CorePro).
        save(&dir, meta("v-old"), "{\"a\":4}", 333, 4000).unwrap();
        assert_eq!(list(&dir, 333).len(), 1);
        assert_eq!(read(&dir, "v-old").unwrap(), "{\"a\":4}");
        delete(&dir, "v-new").unwrap();
        assert!(list(&dir, 333).is_empty());
        assert!(read(&dir, "v-new").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
