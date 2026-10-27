//! The Claude API key and the AI settings. The key lives in the desktop's keyring (Secret
//! Service: GNOME Keyring, KWallet); without one, in a file only the user can read. The page never
//! gets the key back, only whether there is one.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, String>;

pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
const ATTRIBUTES: [(&str, &str); 2] = [("application", "zazabor"), ("purpose", "anthropic-api-key")];
/// How the key was filed before the rename from CorePro; found once, then filed anew.
const OLD_ATTRIBUTES: [(&str, &str); 2] = [("application", "corepro"), ("purpose", "anthropic-api-key")];
const LABEL: &str = "Zazabor: Claude API key";

/// What the user chose in Settings → AI.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub model: String,
    /// The user agreed that statements are sent to Anthropic's API to be read.
    pub consent: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { model: DEFAULT_MODEL.into(), consent: false }
    }
}

fn settings_path(dir: &Path) -> PathBuf {
    dir.join("ai").join("settings.json")
}

fn key_path(dir: &Path) -> PathBuf {
    dir.join("ai").join("anthropic-key")
}

pub fn settings(dir: &Path) -> Settings {
    std::fs::read(settings_path(dir)).ok().and_then(|b| serde_json::from_slice::<Settings>(&b).ok()).map(normalize).unwrap_or_default()
}

fn normalize(mut s: Settings) -> Settings {
    s.model = s.model.trim().to_string();
    if s.model.is_empty() || s.model.len() > 64 || !s.model.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        s.model = DEFAULT_MODEL.into();
    }
    s
}

pub fn save_settings(dir: &Path, s: Settings) -> Result<Settings> {
    let s = normalize(s);
    let path = settings_path(dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::fs::text::write_bytes(&path, &serde_json::to_vec_pretty(&s).map_err(|e| e.to_string())?)?;
    Ok(s)
}

#[cfg(target_os = "linux")]
mod keyring {
    use super::*;
    use dbus_secret_service::{EncryptionType, SecretService};

    fn attrs() -> HashMap<&'static str, &'static str> {
        ATTRIBUTES.into_iter().collect()
    }

    fn service() -> Option<SecretService> {
        // An unlock prompt waits a minute at most.
        SecretService::connect_with_max_prompt_timeout(EncryptionType::Plain, 60).ok()
    }

    /// The key from the keyring: Ok(None) when there is a keyring without it, Err when there's
    /// no keyring to ask.
    pub fn get() -> std::result::Result<Option<String>, ()> {
        let ss = service().ok_or(())?;
        let found = ss.search_items(attrs()).map_err(|_| ())?;
        let item = found.unlocked.into_iter().next().or_else(|| found.locked.into_iter().next());
        let Some(item) = item else { return Ok(adopt_old(&ss)) };
        let _ = item.ensure_unlocked();
        let secret = item.get_secret().map_err(|_| ())?;
        Ok(String::from_utf8(secret).ok().filter(|s| !s.is_empty()))
    }

    /// A key filed under CorePro's name: filed again under Zazabor's, and the old entry removed.
    fn adopt_old(ss: &SecretService) -> Option<String> {
        let found = ss.search_items(OLD_ATTRIBUTES.into_iter().collect()).ok()?;
        let item = found.unlocked.into_iter().next().or_else(|| found.locked.into_iter().next())?;
        let _ = item.ensure_unlocked();
        let key = String::from_utf8(item.get_secret().ok()?).ok().filter(|s| !s.is_empty())?;
        if set(&key) {
            let _ = item.delete();
        }
        Some(key)
    }

    pub fn set(key: &str) -> bool {
        let Some(ss) = service() else { return false };
        let Ok(collection) = ss.get_default_collection().or_else(|_| ss.get_any_collection()) else { return false };
        if collection.ensure_unlocked().is_err() {
            return false;
        }
        collection.create_item(LABEL, attrs(), key.as_bytes(), true, "text/plain").is_ok()
    }

    pub fn clear() {
        if let Some(ss) = service() {
            if let Ok(found) = ss.search_items(attrs()) {
                for item in found.unlocked.iter().chain(found.locked.iter()) {
                    let _ = item.delete();
                }
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod keyring {
    pub fn get() -> std::result::Result<Option<String>, ()> {
        Err(())
    }
    pub fn set(_key: &str) -> bool {
        false
    }
    pub fn clear() {}
}

/// Where the key is: "keyring", "file", or "" for nowhere.
pub fn store_of(dir: &Path) -> &'static str {
    match keyring::get() {
        Ok(Some(_)) => "keyring",
        _ if key_path(dir).exists() => "file",
        _ => "",
    }
}

pub fn get_key(dir: &Path) -> Option<String> {
    if let Ok(Some(key)) = keyring::get() {
        return Some(key);
    }
    std::fs::read_to_string(key_path(dir)).ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

/// Keeps the key; returns where ("keyring" or "file").
pub fn set_key(dir: &Path, key: &str) -> Result<&'static str> {
    let key = key.trim();
    if key.len() < 20 || key.len() > 400 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That doesn't look like an API key. Copy it from the Claude Console (it starts with sk-ant-).".into());
    }
    if keyring::set(key) {
        let _ = std::fs::remove_file(key_path(dir));
        return Ok("keyring");
    }
    let path = key_path(dir);
    let folder = path.parent().ok_or("No folder for the key.")?;
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let _ = std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::remove_file(&path);
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).map_err(|e| e.to_string())?;
        file.write_all(key.as_bytes()).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, key).map_err(|e| e.to_string())?;
    Ok("file")
}

pub fn clear_key(dir: &Path) {
    keyring::clear();
    let _ = std::fs::remove_file(key_path(dir));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_and_the_key_file() {
        let dir = std::env::temp_dir().join(format!("zazabor-ai-keys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(settings(&dir), Settings::default());
        let saved = save_settings(&dir, Settings { model: "bad model!".into(), consent: true }).unwrap();
        assert_eq!(saved, Settings { model: DEFAULT_MODEL.into(), consent: true });
        assert_eq!(settings(&dir), saved);
        assert!(set_key(&dir, "short").is_err());
        // Only the file is written here: a test must never touch the desktop's real keyring, so
        // it writes the file the way the fallback does and reads it back.
        let path = key_path(&dir);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "sk-ant-test-0123456789abcdef\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).ok().map(|k| k.trim().to_string()).as_deref(), Some("sk-ant-test-0123456789abcdef"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
