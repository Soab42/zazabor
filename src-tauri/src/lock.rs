//! App lock. While locked, the backend refuses to scan folders or serve any image, so the
//! lock screen is enforced here rather than only drawn over the UI.
//!
//! Two ways to unlock: the system's administrator authentication (polkit's own dialog, so the
//! password never passes through this app), or a custom password stored as an Argon2 hash.
//! This keeps photos private from people using the computer; files on disk stay unencrypted.

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

static LOCKED: AtomicBool = AtomicBool::new(false);
static SETTINGS: Mutex<Option<(PathBuf, LockFile)>> = Mutex::new(None);

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LockMode {
    #[default]
    Off,
    System,
    Custom,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct LockFile {
    mode: LockMode,
    /// Argon2 PHC string for custom passwords.
    hash: Option<String>,
}

#[derive(Serialize)]
pub struct LockStatus {
    mode: LockMode,
    locked: bool,
    #[serde(rename = "systemAvailable")]
    system_available: bool,
}

pub fn is_locked() -> bool {
    LOCKED.load(Ordering::SeqCst)
}

/// Loads the lock settings; a configured lock starts the app locked.
pub fn init(config_dir: PathBuf) {
    let path = config_dir.join("lock.json");
    let file: LockFile = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    LOCKED.store(file.mode != LockMode::Off, Ordering::SeqCst);
    *SETTINGS.lock().unwrap() = Some((path, file));
}

fn current() -> (PathBuf, LockFile) {
    SETTINGS.lock().unwrap().clone().unwrap_or_default()
}

fn save(path: PathBuf, file: LockFile) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    *SETTINGS.lock().unwrap() = Some((path, file));
    Ok(())
}

fn system_auth_available() -> bool {
    cfg!(target_os = "linux") && Command::new("pkexec").arg("--version").output().is_ok()
}

/// Shows the system's administrator authentication dialog; true when it succeeds.
fn system_authenticate() -> bool {
    Command::new("pkexec")
        .arg("/bin/true")
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn verify_custom(file: &LockFile, password: &str) -> bool {
    let Some(hash) = file.hash.as_deref() else { return false };
    let Ok(parsed) = PasswordHash::new(hash) else { return false };
    let ok = Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok();
    if !ok {
        // Slow down guessing.
        std::thread::sleep(Duration::from_millis(900));
    }
    ok
}

/// Checks the credentials for the current lock mode (a password, or the system dialog).
fn authenticate(file: &LockFile, password: Option<&str>) -> bool {
    match file.mode {
        LockMode::Off => true,
        LockMode::System => system_authenticate(),
        LockMode::Custom => password.is_some_and(|p| verify_custom(file, p)),
    }
}

#[tauri::command]
pub fn lock_status() -> LockStatus {
    LockStatus { mode: current().1.mode, locked: is_locked(), system_available: system_auth_available() }
}

#[tauri::command]
pub fn lock_now() {
    if current().1.mode != LockMode::Off {
        LOCKED.store(true, Ordering::SeqCst);
        crate::video::stop_all();
    }
}

/// Unlocks with a custom password, or with the system dialog when `password` is omitted.
#[tauri::command]
pub async fn unlock(password: Option<String>) -> bool {
    let (_, file) = current();
    let ok = tauri::async_runtime::spawn_blocking(move || authenticate(&file, password.as_deref()))
        .await
        .unwrap_or(false);
    if ok {
        LOCKED.store(false, Ordering::SeqCst);
    }
    ok
}

/// Confirms the user's identity without changing the lock state (e.g. to reveal private albums).
#[tauri::command]
pub async fn confirm_identity(password: Option<String>) -> bool {
    let (_, file) = current();
    tauri::async_runtime::spawn_blocking(move || authenticate(&file, password.as_deref()))
        .await
        .unwrap_or(false)
}

/// Changes the lock. Requires the current credentials whenever a lock is already set.
#[tauri::command]
pub async fn set_lock(
    mode: LockMode,
    new_password: Option<String>,
    current_password: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, file) = current();
        if is_locked() {
            return Err("Unlock first.".into());
        }
        if !authenticate(&file, current_password.as_deref()) {
            return Err("The current password is not correct.".into());
        }
        let hash = match mode {
            LockMode::Custom => {
                let password = new_password.filter(|p| p.chars().count() >= 4).ok_or("Use at least 4 characters.")?;
                let salt = SaltString::generate(&mut OsRng);
                Some(
                    Argon2::default()
                        .hash_password(password.as_bytes(), &salt)
                        .map_err(|e| e.to_string())?
                        .to_string(),
                )
            }
            LockMode::System => {
                if !system_auth_available() {
                    return Err("System authentication (polkit) is not available on this computer.".into());
                }
                // Prove it works before relying on it, so nobody locks themselves out.
                if file.mode != LockMode::System && !system_authenticate() {
                    return Err("System authentication was cancelled.".into());
                }
                None
            }
            LockMode::Off => None,
        };
        save(path, LockFile { mode, hash })
    })
    .await
    .map_err(|e| e.to_string())?
}
