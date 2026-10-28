//! Updates. Each release on GitHub (scripts/release.sh) carries a manifest, `latest.json`, signed
//! with the release key: the version, what's new, and the Linux build's size and SHA-256. Zazabor
//! asks for the latest one, and installs a newer version over itself the way
//! scripts/install-linux.sh put it there: the program in ~/.local/bin, its sound effects in
//! ~/.local/lib/Zazabor. The running copy carries on; the new one starts with Restart, which quits
//! as Quit does (asking about unsaved files first), or with the next start.

use crate::download::{fetch, sha256_of};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};

/// The latest release's files. `ZAZABOR_UPDATE_URL` points elsewhere for testing (the manifest
/// must still be signed with the release key).
const LATEST_URL: &str = "https://github.com/Soab42/zazabor/releases/latest/download";
/// Where release downloads may come from.
const DOWNLOADS_FROM: &str = "https://github.com/Soab42/zazabor/releases/download/";
const KIND: &str = "zazabor-update";
/// The build this copy updates to (its key in the manifest).
const PLATFORM: &str = "linux-x86_64";
/// No release is bigger than this.
const MAX_BYTES: u64 = 1 << 30;

fn latest_url() -> String {
    std::env::var("ZAZABOR_UPDATE_URL").unwrap_or_else(|_| LATEST_URL.into()).trim_end_matches('/').to_string()
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Deserialize, Clone)]
struct Build {
    url: String,
    bytes: u64,
    sha256: String,
}

#[derive(Deserialize, Clone)]
struct Manifest {
    kind: String,
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    published: u64,
    #[serde(default)]
    builds: std::collections::HashMap<String, Build>,
}

/// Reads a manifest after checking its signature and kind.
fn parse(bytes: &[u8], signature: &str) -> Result<Manifest, String> {
    crate::signing::verify(bytes, signature)?;
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|e| format!("The update's manifest isn't readable: {e}"))?;
    if manifest.kind != KIND {
        return Err("That isn't a Zazabor update.".into());
    }
    semver::Version::parse(&manifest.version).map_err(|_| format!("“{}” isn't a version number.", manifest.version))?;
    Ok(manifest)
}

/// Whether `latest` is newer than `current`.
fn newer(latest: &str, current: &str) -> bool {
    match (semver::Version::parse(latest), semver::Version::parse(current)) {
        (Ok(l), Ok(c)) => l > c,
        _ => false,
    }
}

/// Why this copy can't install updates itself, if it can't.
fn why_not(exe: &Path) -> Option<String> {
    if cfg!(debug_assertions) {
        return Some("This is a development build; updates are for installed copies.".into());
    }
    if !cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        return Some("Updates are installed for you on Linux (x86-64) only for now.".into());
    }
    let dir = exe.parent()?;
    let probe = dir.join(".zazabor-update-probe");
    if std::fs::write(&probe, b"").is_err() {
        return Some(format!("Zazabor can't write to {}. Install the update the way Zazabor was installed.", dir.display()));
    }
    let _ = std::fs::remove_file(probe);
    None
}

/// The program's own path, as it was before any update replaced it.
fn own_exe() -> Result<PathBuf, String> {
    static EXE: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    EXE.get_or_init(|| {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        // Replaced under a running copy, Linux names it "… (deleted)".
        let name = exe.to_string_lossy();
        Ok(name.strip_suffix(" (deleted)").map(PathBuf::from).unwrap_or(exe))
    })
    .clone()
}

#[derive(Default)]
struct State {
    /// The version installed over this copy, waiting for a restart.
    installed: Mutex<Option<String>>,
    running: AtomicBool,
    done: AtomicU64,
    total: AtomicU64,
    error: Mutex<Option<String>>,
}

fn state() -> &'static State {
    static S: OnceLock<State> = OnceLock::new();
    S.get_or_init(Default::default)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    current: String,
    /// The latest version, when it's newer than this one.
    available: Option<String>,
    notes: String,
    published: u64,
    bytes: u64,
    /// Why this copy can't install it itself (then the release page is the way).
    why_not: Option<String>,
    /// A version already installed, starting at the next restart.
    installed: Option<String>,
}

/// The latest release's manifest, or None when no release has one yet.
fn latest() -> Result<Option<Manifest>, String> {
    let base = latest_url();
    let Some(bytes) = crate::content::get_small_if_there(&format!("{base}/latest.json"), 1 << 20)? else {
        return Ok(None);
    };
    let sig = String::from_utf8(crate::content::get_small(&format!("{base}/latest.json.sig"), 1024)?).map_err(|e| e.to_string())?;
    parse(&bytes, &sig).map(Some)
}

/// Asks GitHub whether there's a newer Zazabor.
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Check, String> {
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = latest()?;
        let build = manifest.as_ref().and_then(|m| m.builds.get(PLATFORM));
        let available = manifest.as_ref().filter(|m| newer(&m.version, &current) && build.is_some()).map(|m| m.version.clone());
        Ok(Check {
            why_not: available.as_ref().and_then(|_| own_exe().ok().map_or(Some("Zazabor couldn't find its own program file.".into()), |exe| why_not(&exe))),
            installed: lock(&state().installed).clone(),
            notes: available.as_ref().and(manifest.as_ref()).map(|m| m.notes.clone()).unwrap_or_default(),
            published: manifest.as_ref().map_or(0, |m| m.published),
            bytes: build.map_or(0, |b| b.bytes),
            available,
            current,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Progress {
    running: bool,
    done: u64,
    total: u64,
    error: Option<String>,
    installed: Option<String>,
}

/// How the update's download and installation are going.
#[tauri::command]
pub fn update_progress() -> Progress {
    let s = state();
    Progress {
        running: s.running.load(Ordering::Relaxed),
        done: s.done.load(Ordering::Relaxed),
        total: s.total.load(Ordering::Relaxed),
        error: lock(&s.error).clone(),
        installed: lock(&s.installed).clone(),
    }
}

/// Downloads the latest version and installs it over this copy (in the background; see
/// `update_progress`, and the `update-installed` event when it's done).
#[tauri::command]
pub fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    let s = state();
    if s.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    *lock(&s.error) = None;
    s.done.store(0, Ordering::Relaxed);
    let current = app.package_info().version.to_string();
    std::thread::Builder::new()
        .name("update".into())
        .spawn(move || {
            let result = install(&app, &current);
            let s = state();
            match result {
                Ok(version) => {
                    *lock(&s.installed) = Some(version.clone());
                    let _ = app.emit("update-installed", version);
                }
                Err(why) => {
                    eprintln!("[update] {why}");
                    *lock(&s.error) = Some(why);
                }
            }
            s.running.store(false, Ordering::SeqCst);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn install(app: &tauri::AppHandle, current: &str) -> Result<String, String> {
    let exe = own_exe()?;
    if let Some(why) = why_not(&exe) {
        return Err(why);
    }
    let manifest = latest()?.ok_or("There's no release to update to yet.")?;
    if !newer(&manifest.version, current) {
        return Err("This is the latest version already.".into());
    }
    let build = manifest.builds.get(PLATFORM).cloned().ok_or("There's no Linux build of the latest version.")?;
    let from_test_server = std::env::var("ZAZABOR_UPDATE_URL").is_ok_and(|base| build.url.starts_with(base.trim_end_matches('/')));
    if !build.url.starts_with(DOWNLOADS_FROM) && !from_test_server {
        return Err("The update points somewhere other than Zazabor's releases, so it wasn't downloaded.".into());
    }
    if build.bytes > MAX_BYTES || build.sha256.len() != 64 {
        return Err("The update's manifest isn't right.".into());
    }
    let work = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("update");
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let archive = work.join(format!("zazabor-{}.tar.gz", manifest.version));
    let part = work.join(format!("zazabor-{}.tar.gz.part", manifest.version));
    let s = state();
    s.total.store(build.bytes, Ordering::Relaxed);
    if sha256_of(&archive).ok().as_deref() != Some(build.sha256.as_str()) {
        fetch(&build.url, &part, build.bytes, &s.done, &AtomicBool::new(false))?;
        if sha256_of(&part)? != build.sha256.to_ascii_lowercase() {
            let _ = std::fs::remove_file(&part);
            return Err("The update didn't match its checksum, so it was deleted. Try again.".into());
        }
        std::fs::rename(&part, &archive).map_err(|e| e.to_string())?;
    }
    s.done.store(build.bytes, Ordering::Relaxed);

    // Unpacked beside the archive first, so a broken archive changes nothing.
    let unpacked = work.join(&manifest.version);
    let _ = std::fs::remove_dir_all(&unpacked);
    unpack(&archive, &unpacked)?;
    let program = unpacked.join("zazabor");
    if !program.is_file() {
        return Err("The update has no program in it.".into());
    }
    // Sound effects first (they're only read when used), then the program, swapped in one step.
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?.join("resources");
    let sfx = unpacked.join("resources").join("sfx");
    if sfx.is_dir() && std::fs::create_dir_all(resources.join("sfx")).is_ok() {
        for entry in std::fs::read_dir(&sfx).map_err(|e| e.to_string())?.flatten() {
            let _ = std::fs::copy(entry.path(), resources.join("sfx").join(entry.file_name()));
        }
    }
    let staged = exe.with_file_name(".zazabor.new");
    std::fs::copy(&program, &staged).map_err(|e| format!("Couldn't put the update in place: {e}"))?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&staged, &exe).map_err(|e| {
        let _ = std::fs::remove_file(&staged);
        format!("Couldn't put the update in place: {e}")
    })?;
    let _ = std::fs::remove_dir_all(&unpacked);
    let _ = std::fs::remove_file(&archive);
    Ok(manifest.version)
}

/// Unpacks a release archive: only `zazabor` and `resources/sfx/<name>`, nothing outside `into`.
fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    for entry in tar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| format!("The update's archive is damaged: {e}"))?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let parts: Vec<_> = path.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        let parts: Vec<&str> = parts.iter().map(String::as_str).filter(|p| *p != ".").collect();
        let wanted = matches!(parts.as_slice(), ["zazabor"] | ["resources", "sfx", _]);
        if wanted && entry.header().entry_type().is_file() {
            entry.unpack_in(into).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Restarts into the installed update: quits as Quit does (windows with unsaved work ask
/// first), then the new version starts.
#[tauri::command]
pub fn update_restart(app: tauri::AppHandle) -> Result<(), String> {
    crate::background::restart(&app, own_exe()?);
    Ok(())
}

/// Starts `exe` once this process has ended (so it doesn't find this one still running).
pub fn relaunch(exe: &Path) {
    use std::os::unix::process::CommandExt;
    let _ = std::process::Command::new("sh")
        .arg("-c")
        .arg(r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2""#)
        .arg("sh")
        .arg(std::process::id().to_string())
        .arg(exe)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_numbers() {
        assert!(newer("0.2.0", "0.1.0"));
        assert!(newer("0.10.0", "0.9.3"));
        assert!(!newer("0.1.0", "0.1.0"));
        assert!(!newer("0.1.0", "0.2.0"));
        assert!(!newer("latest", "0.1.0"));
    }

    #[test]
    fn unsigned_manifests_are_refused() {
        assert!(parse(br#"{"kind":"zazabor-update","version":"9.9.9"}"#, "AAAA").is_err());
    }

    #[test]
    fn archives_unpack_only_the_program_and_sound_effects() {
        let dir = std::env::temp_dir().join(format!("zazabor-unpack-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("a.tar.gz");
        {
            let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(std::fs::File::create(&archive).unwrap(), flate2::Compression::fast()));
            let mut add = |name: &str, body: &[u8]| {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                tar.append_data(&mut header, name, body).unwrap();
            };
            add("zazabor", b"program");
            add("resources/sfx/pop.ogg", b"pop");
            add("resources/music/big.ogg", b"not wanted");
            add("notes.txt", b"not wanted");
            tar.into_inner().unwrap().finish().unwrap();
        }
        let into = dir.join("out");
        unpack(&archive, &into).unwrap();
        assert_eq!(std::fs::read(into.join("zazabor")).unwrap(), b"program");
        assert_eq!(std::fs::read(into.join("resources/sfx/pop.ogg")).unwrap(), b"pop");
        assert!(!into.join("resources/music").exists() && !into.join("notes.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
