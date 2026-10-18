//! Get Info: metadata for one path, and streamed folder sizes.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::CStr;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tauri::Emitter;

/// Everything Get Info shows about a path.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsInfo {
    /// "folder", "file" or "link".
    pub kind: &'static str,
    pub size: u64,
    /// Direct children of a folder (0 otherwise).
    pub items: u64,
    pub created: Option<f64>,
    pub modified: f64,
    pub accessed: f64,
    /// "rwxr-xr-x".
    pub permissions: String,
    /// Octal, e.g. "755".
    pub mode: String,
    pub owner: String,
    pub group: String,
    pub link_target: Option<String>,
    pub read_only: bool,
}

fn seconds(time: std::io::Result<SystemTime>) -> Option<f64> {
    let t = time.ok()?;
    Some(match t.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => d.as_secs_f64(),
        Err(e) => -e.duration().as_secs_f64(),
    })
}

/// "rwxr-xr-x" from the permission bits (set-id and sticky bits shown like `ls`).
fn mode_string(mode: u32) -> String {
    let mut out = String::with_capacity(9);
    for (i, shift) in [6u32, 3, 0].into_iter().enumerate() {
        let bits = (mode >> shift) & 7;
        out.push(if bits & 4 != 0 { 'r' } else { '-' });
        out.push(if bits & 2 != 0 { 'w' } else { '-' });
        let special = match i {
            0 => mode & 0o4000 != 0,
            1 => mode & 0o2000 != 0,
            _ => mode & 0o1000 != 0,
        };
        let exec = bits & 1 != 0;
        out.push(match (special, exec, i) {
            (true, true, 2) => 't',
            (true, false, 2) => 'T',
            (true, true, _) => 's',
            (true, false, _) => 'S',
            (false, true, _) => 'x',
            (false, false, _) => '-',
        });
    }
    out
}

fn user_name(uid: u32) -> String {
    let mut buf = vec![0 as libc::c_char; 4096];
    // SAFETY: an all-zero passwd is a valid out-parameter for getpwuid_r.
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: the buffer and out-pointers outlive the call; the name is copied before they drop.
    let rc = unsafe { libc::getpwuid_r(uid, &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result) };
    if rc == 0 && !result.is_null() {
        // SAFETY: on success pw_name points at a NUL-terminated string inside `buf`.
        return unsafe { CStr::from_ptr(pwd.pw_name) }.to_string_lossy().into_owned();
    }
    uid.to_string()
}

fn group_name(gid: u32) -> String {
    let mut buf = vec![0 as libc::c_char; 4096];
    // SAFETY: an all-zero group is a valid out-parameter for getgrgid_r.
    let mut grp: libc::group = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::group = std::ptr::null_mut();
    // SAFETY: as in `user_name`.
    let rc = unsafe { libc::getgrgid_r(gid, &mut grp, buf.as_mut_ptr(), buf.len(), &mut result) };
    if rc == 0 && !result.is_null() {
        // SAFETY: on success gr_name points at a NUL-terminated string inside `buf`.
        return unsafe { CStr::from_ptr(grp.gr_name) }.to_string_lossy().into_owned();
    }
    gid.to_string()
}

/// Metadata of the path itself (a symlink is described, not followed).
pub fn info(path: &Path) -> Result<FsInfo, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let link = meta.file_type().is_symlink();
    let link_target = if link { std::fs::read_link(path).ok().map(|t| t.to_string_lossy().into_owned()) } else { None };
    // For a link to a folder, count what it points at.
    let is_dir = if link { path.is_dir() } else { meta.is_dir() };
    let items = if is_dir { std::fs::read_dir(path).map(|d| d.count() as u64).unwrap_or(0) } else { 0 };
    let bits = meta.permissions().mode() & 0o7777;
    let read_only = !link && bits & 0o222 == 0;
    Ok(FsInfo {
        kind: if link { "link" } else if meta.is_dir() { "folder" } else { "file" },
        size: if meta.is_dir() { 0 } else { meta.len() },
        items,
        created: seconds(meta.created()),
        modified: seconds(meta.modified()).unwrap_or(0.0),
        accessed: seconds(meta.accessed()).unwrap_or(0.0),
        permissions: mode_string(bits),
        mode: format!("{bits:o}"),
        owner: user_name(meta.uid()),
        group: group_name(meta.gid()),
        link_target,
        read_only,
    })
}

#[derive(Serialize, Clone)]
struct SizeEvent {
    id: u64,
    bytes: u64,
    files: u64,
    done: bool,
}

fn jobs() -> &'static Mutex<HashMap<u64, Arc<AtomicBool>>> {
    static JOBS: OnceLock<Mutex<HashMap<u64, Arc<AtomicBool>>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

/// Walks a folder without following symlinks, counting each inode once. `progress` gets
/// `(bytes, files, done)` roughly five times a second and once at the end; a cancelled walk
/// stops without the final report.
fn measure(root: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, u64, bool)) {
    let (mut bytes, mut files) = (0u64, 0u64);
    let mut seen: HashSet<(u64, u64)> = HashSet::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut last = Instant::now();
    while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for entry in read.flatten() {
            let Ok(meta) = entry.metadata() else { continue }; // does not follow links
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.nlink() > 1 && !seen.insert((meta.dev(), meta.ino())) {
                continue;
            } else {
                files += 1;
                bytes += meta.len();
            }
            if last.elapsed() >= Duration::from_millis(200) {
                last = Instant::now();
                progress(bytes, files, false);
            }
        }
    }
    if !cancel.load(Ordering::Relaxed) {
        progress(bytes, files, true);
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Starts measuring a folder in the background; progress arrives as `fs-size` events.
pub fn start_folder_size(app: tauri::AppHandle, path: PathBuf) -> u64 {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = jobs().lock() {
        map.insert(id, cancel.clone());
    }
    std::thread::spawn(move || {
        measure(&path, &cancel, |bytes, files, done| {
            if !cancel.load(Ordering::Relaxed) {
                let _ = app.emit("fs-size", SizeEvent { id, bytes, files, done });
            }
        });
        if let Ok(mut map) = jobs().lock() {
            map.remove(&id);
        }
    });
    id
}

/// Stops a running measurement (no further events).
pub fn cancel_folder_size(id: u64) {
    if let Ok(map) = jobs().lock() {
        if let Some(flag) = map.get(&id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("corepro-info-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn mode_strings() {
        assert_eq!(mode_string(0o755), "rwxr-xr-x");
        assert_eq!(mode_string(0o640), "rw-r-----");
        assert_eq!(mode_string(0o4755), "rwsr-xr-x");
        assert_eq!(mode_string(0o1777), "rwxrwxrwt");
    }

    #[test]
    fn file_folder_and_link() {
        let dir = temp_dir("fields");
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hello").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
        std::fs::create_dir(dir.join("sub")).unwrap();
        std::os::unix::fs::symlink(&file, dir.join("ln")).unwrap();

        let f = info(&file).unwrap();
        assert_eq!((f.kind, f.size, f.mode.as_str(), f.permissions.as_str()), ("file", 5, "640", "rw-r-----"));
        assert!(!f.read_only && !f.owner.is_empty() && !f.group.is_empty());
        assert!(f.modified > 0.0);

        let d = info(&dir).unwrap();
        assert_eq!((d.kind, d.items), ("folder", 3));

        let l = info(&dir.join("ln")).unwrap();
        assert_eq!(l.kind, "link");
        assert_eq!(l.link_target.as_deref(), Some(file.to_string_lossy().as_ref()));

        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o444)).unwrap();
        assert!(info(&file).unwrap().read_only);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_size_skips_links_and_counts_hard_links_once() {
        let dir = temp_dir("size");
        std::fs::create_dir(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a"), vec![1u8; 10_000]).unwrap();
        std::fs::write(dir.join("sub/b"), vec![1u8; 5_000]).unwrap();
        std::fs::hard_link(dir.join("a"), dir.join("sub/a2")).unwrap();
        std::os::unix::fs::symlink(&dir, dir.join("loop")).unwrap();

        let mut last = (0, 0, false);
        measure(&dir, &AtomicBool::new(false), |b, f, d| last = (b, f, d));
        assert!(last.2);
        assert_eq!(last.1, 3); // a, b and the link itself; the hard link is not counted twice
        assert!(last.0 >= 15_000 && last.0 < 15_000 + 4096);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancelled_measure_reports_nothing_final() {
        let dir = temp_dir("cancel");
        std::fs::write(dir.join("a"), b"x").unwrap();
        let mut done = false;
        measure(&dir, &AtomicBool::new(true), |_, _, d| done = d);
        assert!(!done);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
