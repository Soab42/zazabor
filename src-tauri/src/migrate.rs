//! One-time move of SliderPro's settings and caches into CorePro's folders.
//!
//! The config is copied (the old one is never deleted); the cache is renamed, and left in
//! place if that fails since it can always be rebuilt.

use std::fs;
use std::io;
use std::path::Path;

const OLD_IDENTIFIER: &str = "dev.soab.sliderpro";

/// Copies a folder tree, creating `to` and everything below it.
pub fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for item in fs::read_dir(from)? {
        let item = item?;
        let target = to.join(item.file_name());
        if item.file_type()?.is_dir() {
            copy_dir(&item.path(), &target)?;
        } else {
            fs::copy(item.path(), &target)?;
        }
    }
    Ok(())
}

/// Copies `old` to `new` when only the old one exists. Returns whether it copied.
pub fn migrate_config(old: &Path, new: &Path) -> bool {
    if new.exists() || !old.is_dir() {
        return false;
    }
    if copy_dir(old, new).is_err() {
        // Do not leave a half-copied config that would block a retry.
        let _ = fs::remove_dir_all(new);
        return false;
    }
    true
}

/// Moves `old` to `new` when only the old one exists. Returns whether it moved.
pub fn migrate_cache(old: &Path, new: &Path) -> bool {
    if new.exists() || !old.is_dir() {
        return false;
    }
    if let Some(parent) = new.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::rename(old, new).is_ok()
}

/// Migrates both folders, finding the old ones beside the new ones (`~/.config`, `~/.cache`).
pub fn run(config_dir: &Path, cache_dir: &Path) {
    if let Some(parent) = config_dir.parent() {
        migrate_config(&parent.join(OLD_IDENTIFIER), config_dir);
    }
    if let Some(parent) = cache_dir.parent() {
        migrate_cache(&parent.join(OLD_IDENTIFIER), cache_dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("corepro-migrate-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn config_is_copied_and_old_is_kept() {
        let root = temp("config");
        let (old, new) = (root.join("old"), root.join("new"));
        fs::create_dir_all(old.join("sub")).unwrap();
        fs::write(old.join("config.json"), "{}").unwrap();
        fs::write(old.join("sub/deep.txt"), "x").unwrap();
        assert!(migrate_config(&old, &new));
        assert_eq!(fs::read_to_string(new.join("config.json")).unwrap(), "{}");
        assert!(new.join("sub/deep.txt").exists());
        assert!(old.join("config.json").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_new_config_is_never_overwritten() {
        let root = temp("keep");
        let (old, new) = (root.join("old"), root.join("new"));
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join("config.json"), "old").unwrap();
        assert!(!migrate_config(&old, &new));
        assert!(!new.join("config.json").exists());
        assert!(!migrate_config(&root.join("missing"), &root.join("other")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_is_moved() {
        let root = temp("cache");
        let (old, new) = (root.join("old"), root.join("new"));
        fs::create_dir_all(old.join("renders")).unwrap();
        fs::write(old.join("renders/a.jpg"), "x").unwrap();
        assert!(migrate_cache(&old, &new));
        assert!(new.join("renders/a.jpg").exists());
        assert!(!old.exists());
        assert!(!migrate_cache(&old, &new));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn run_finds_old_folders_beside_new_ones() {
        let root = temp("run");
        let (config, cache) = (root.join("config"), root.join("cache"));
        fs::create_dir_all(config.join(OLD_IDENTIFIER)).unwrap();
        fs::create_dir_all(cache.join(OLD_IDENTIFIER)).unwrap();
        fs::write(config.join(OLD_IDENTIFIER).join("config.json"), "{}").unwrap();
        run(&config.join("dev.soab.corepro"), &cache.join("dev.soab.corepro"));
        assert!(config.join("dev.soab.corepro/config.json").exists());
        assert!(cache.join("dev.soab.corepro").is_dir());
        let _ = fs::remove_dir_all(&root);
    }
}
