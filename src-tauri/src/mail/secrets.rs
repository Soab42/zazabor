//! Where an account's password is kept: the desktop's keyring (Secret Service: GNOME Keyring,
//! KWallet), one entry per account; without a keyring, a file only the user can read. The page
//! never gets a password back.
//!
//! `ZAZABOR_MAIL_NO_KEYRING=1` keeps them in files (tests, which must never touch the real keyring).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static DIR: OnceLock<PathBuf> = OnceLock::new();
/// Passwords read this run, so a reconnect doesn't ask the keyring again.
static CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}

fn file(account: &str) -> Option<PathBuf> {
    let safe = !account.is_empty() && account.chars().all(|c| c.is_ascii_alphanumeric());
    safe.then(|| DIR.get().map(|dir| dir.join("secrets").join(account))).flatten()
}

fn use_keyring() -> bool {
    std::env::var_os("ZAZABOR_MAIL_NO_KEYRING").is_none()
}

#[cfg(target_os = "linux")]
mod keyring {
    use dbus_secret_service::{EncryptionType, SecretService};
    use std::collections::HashMap;

    fn attrs(account: &str) -> HashMap<&str, &str> {
        HashMap::from([("application", "zazabor"), ("purpose", "mail-password"), ("account", account)])
    }

    fn service() -> Option<SecretService> {
        SecretService::connect_with_max_prompt_timeout(EncryptionType::Plain, 60).ok()
    }

    pub fn get(account: &str) -> Option<String> {
        let ss = service()?;
        let found = ss.search_items(attrs(account)).ok()?;
        let item = found.unlocked.into_iter().next().or_else(|| found.locked.into_iter().next())?;
        let _ = item.ensure_unlocked();
        String::from_utf8(item.get_secret().ok()?).ok().filter(|s| !s.is_empty())
    }

    pub fn set(account: &str, label: &str, password: &str) -> bool {
        let Some(ss) = service() else { return false };
        let Ok(collection) = ss.get_default_collection().or_else(|_| ss.get_any_collection()) else { return false };
        if collection.ensure_unlocked().is_err() {
            return false;
        }
        collection.create_item(&format!("Zazabor Mail: {label}"), attrs(account), password.as_bytes(), true, "text/plain").is_ok()
    }

    pub fn clear(account: &str) {
        if let Some(ss) = service() {
            if let Ok(found) = ss.search_items(attrs(account)) {
                for item in found.unlocked.iter().chain(found.locked.iter()) {
                    let _ = item.delete();
                }
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod keyring {
    pub fn get(_account: &str) -> Option<String> {
        None
    }
    pub fn set(_account: &str, _label: &str, _password: &str) -> bool {
        false
    }
    pub fn clear(_account: &str) {}
}

pub fn get(account: &str) -> Option<String> {
    if let Some(found) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|c| c.get(account)) {
        return Some(found.clone());
    }
    let found = use_keyring()
        .then(|| keyring::get(account))
        .flatten()
        .or_else(|| std::fs::read_to_string(file(account)?).ok().map(|p| p.trim_end_matches('\n').to_string()).filter(|p| !p.is_empty()))?;
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(account.to_string(), found.clone());
    Some(found)
}

/// Keeps the password; `label` names the keyring entry (the address).
pub fn set(account: &str, label: &str, password: &str) -> Result<(), String> {
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(account.to_string(), password.to_string());
    let path = file(account).ok_or("No place to keep the password.")?;
    if use_keyring() {
        keyring::clear(account);
        if keyring::set(account, label, password) {
            let _ = std::fs::remove_file(&path);
            return Ok(());
        }
    }
    let folder = path.parent().ok_or("No place to keep the password.")?;
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let _ = std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::remove_file(&path);
        let mut out = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).map_err(|e| e.to_string())?;
        out.write_all(password.as_bytes()).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, password).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn clear(account: &str) {
    if let Some(cache) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        cache.remove(account);
    }
    if use_keyring() {
        keyring::clear(account);
    }
    if let Some(path) = file(account) {
        let _ = std::fs::remove_file(path);
    }
}
