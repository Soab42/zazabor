//! One-time move of an earlier name's folders into this app's: CorePro's (2026-10-27) and
//! SliderPro's before it.
//!
//! Settings and data (notes, wallet, time log, clipboard history, downloaded models…) are copied,
//! and the old folders are kept as they were, as a backup. The cache is renamed, and left in
//! place if that fails since it can always be rebuilt.

use std::fs;
use std::io;
use std::path::Path;

/// The app's earlier identifiers, newest first: the first one found is the one moved over.
const OLD_IDENTIFIERS: [&str; 2] = ["dev.soab.corepro", "dev.soab.sliderpro"];

/// Caches the web view keeps in the data folder; they're rebuilt rather than copied.
const SKIP_IN_DATA: [&str; 2] = ["WebKitCache", "CacheStorage"];

/// Copies a folder tree, creating `to` and everything below it, leaving out top-level `skip`.
pub fn copy_dir(from: &Path, to: &Path, skip: &[&str]) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for item in fs::read_dir(from)? {
        let item = item?;
        if skip.iter().any(|s| item.file_name() == *s) {
            continue;
        }
        let target = to.join(item.file_name());
        let kind = item.file_type()?;
        if kind.is_dir() {
            copy_dir(&item.path(), &target, &[])?;
        } else if kind.is_symlink() {
            std::os::unix::fs::symlink(fs::read_link(item.path())?, &target)?;
        } else {
            fs::copy(item.path(), &target)?;
        }
    }
    Ok(())
}

/// Copies `old` to `new` when only the old one exists. Returns whether it copied.
pub fn migrate_copy(old: &Path, new: &Path, skip: &[&str]) -> bool {
    if new.exists() || !old.is_dir() {
        return false;
    }
    if copy_dir(old, new, skip).is_err() {
        // Do not leave a half-copied folder that would block a retry.
        let _ = fs::remove_dir_all(new);
        return false;
    }
    true
}

/// Moves `old` to `new` when only the old one exists. Returns whether it moved.
pub fn migrate_move(old: &Path, new: &Path) -> bool {
    if new.exists() || !old.is_dir() {
        return false;
    }
    if let Some(parent) = new.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::rename(old, new).is_ok()
}

/// The newest earlier folder beside `dir` (`~/.config/dev.soab.corepro` beside `…/dev.soab.zazabor`).
fn old_beside(dir: &Path) -> Option<std::path::PathBuf> {
    let parent = dir.parent()?;
    OLD_IDENTIFIERS.iter().map(|id| parent.join(id)).find(|p| p.is_dir())
}

/// Brings the settings, data and cache of an earlier name over, once. Returns whether the
/// settings came from an earlier name (the first start after a rename).
pub fn run(config_dir: &Path, data_dir: &Path, cache_dir: &Path) -> bool {
    let moved = old_beside(config_dir).is_some_and(|old| migrate_copy(&old, config_dir, &[]));
    if let Some(old) = old_beside(data_dir) {
        migrate_copy(&old, data_dir, &SKIP_IN_DATA);
    }
    if let Some(old) = old_beside(cache_dir) {
        migrate_move(&old, cache_dir);
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("app-migrate-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn folders_are_copied_and_old_ones_kept() {
        let root = temp("copy");
        let (old, new) = (root.join("old"), root.join("new"));
        fs::create_dir_all(old.join("sub")).unwrap();
        fs::write(old.join("config.json"), "{}").unwrap();
        fs::write(old.join("sub/deep.txt"), "x").unwrap();
        assert!(migrate_copy(&old, &new, &[]));
        assert_eq!(fs::read_to_string(new.join("config.json")).unwrap(), "{}");
        assert!(new.join("sub/deep.txt").exists());
        assert!(old.join("config.json").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_new_folder_is_never_overwritten() {
        let root = temp("keep");
        let (old, new) = (root.join("old"), root.join("new"));
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join("config.json"), "old").unwrap();
        assert!(!migrate_copy(&old, &new, &[]));
        assert!(!new.join("config.json").exists());
        assert!(!migrate_copy(&root.join("missing"), &root.join("other"), &[]));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn data_leaves_the_web_caches_behind() {
        let root = temp("data");
        let (old, new) = (root.join("old"), root.join("new"));
        fs::create_dir_all(old.join("wallet")).unwrap();
        fs::create_dir_all(old.join("WebKitCache")).unwrap();
        fs::write(old.join("wallet/wallet.db"), "db").unwrap();
        fs::write(old.join("WebKitCache/blob"), "x").unwrap();
        assert!(migrate_copy(&old, &new, &SKIP_IN_DATA));
        assert!(new.join("wallet/wallet.db").exists());
        assert!(!new.join("WebKitCache").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_is_moved() {
        let root = temp("cache");
        let (old, new) = (root.join("old"), root.join("new"));
        fs::create_dir_all(old.join("renders")).unwrap();
        fs::write(old.join("renders/a.jpg"), "x").unwrap();
        assert!(migrate_move(&old, &new));
        assert!(new.join("renders/a.jpg").exists());
        assert!(!old.exists());
        assert!(!migrate_move(&old, &new));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn run_takes_the_newest_earlier_name() {
        let root = temp("run");
        let (config, data, cache) = (root.join("config"), root.join("data"), root.join("cache"));
        for (id, text) in [("dev.soab.corepro", "corepro"), ("dev.soab.sliderpro", "sliderpro")] {
            fs::create_dir_all(config.join(id)).unwrap();
            fs::write(config.join(id).join("config.json"), text).unwrap();
        }
        fs::create_dir_all(data.join("dev.soab.corepro/notes")).unwrap();
        fs::create_dir_all(cache.join("dev.soab.corepro")).unwrap();
        let new = |dir: &Path| dir.join("dev.soab.zazabor");
        assert!(run(&new(&config), &new(&data), &new(&cache)));
        assert_eq!(fs::read_to_string(new(&config).join("config.json")).unwrap(), "corepro");
        assert!(new(&data).join("notes").is_dir());
        assert!(new(&cache).is_dir());
        // Only once.
        assert!(!run(&new(&config), &new(&data), &new(&cache)));
        let _ = fs::remove_dir_all(&root);
    }
}
