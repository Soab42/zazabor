//! The freedesktop.org Trash: `~/.local/share/Trash/{files,info}` with `.trashinfo` records,
//! and `$topdir/.Trash-$uid` (or `$topdir/.Trash/$uid`) for items on other mounts, so moving to
//! the Trash is always a rename and never a slow copy. Every function takes the home trash
//! folder explicitly, which keeps tests off the real Trash.

use super::names::{unique_name, Style};
use super::ops::{plain, UndoOp};
use std::fs;
use std::io::Write;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// The home trash: `$XDG_DATA_HOME/Trash`, else `~/.local/share/Trash`.
pub fn home_trash() -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(data.join("Trash"))
}

/// True for a trash folder: `…/Trash`, `…/.Trash-uid` or `…/.Trash/uid`.
fn is_trash_dir(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    name == "Trash"
        || name.starts_with(".Trash-")
        || path.parent().and_then(Path::file_name).is_some_and(|n| n == ".Trash")
}

/// True for a folder that is a trash's `files` directory (the Trash view).
pub fn is_trash_files_dir(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n == "files") && path.parent().is_some_and(is_trash_dir)
}

/// True when `path` is a trash's `files` folder or something inside it.
pub fn is_in_trash(path: &Path) -> bool {
    path.ancestors().any(is_trash_files_dir)
}

/// The `.trashinfo` file that belongs to an item directly inside a trash's `files` folder.
pub fn info_path(trashed: &Path) -> Option<PathBuf> {
    let files = trashed.parent().filter(|p| is_trash_files_dir(p))?;
    Some(files.parent()?.join("info").join(format!("{}.trashinfo", trashed.file_name()?.to_string_lossy())))
}

fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

fn dev_of(path: &Path) -> std::io::Result<u64> {
    fs::symlink_metadata(path).map(|m| m.dev())
}

/// The trash folder that serves `path`: the home trash on its filesystem, else the one at the
/// top of the mount that holds it.
fn trash_dir_for(path: &Path, home: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(home).map_err(|e| format!("Can’t open the Trash: {}", plain(&e)))?;
    let dev = dev_of(path).map_err(|e| plain(&e))?;
    if dev_of(home).map_err(|e| plain(&e))? == dev {
        return Ok(home.to_path_buf());
    }
    let mut top = path.parent().ok_or("Can’t trash this item.")?;
    while let Some(up) = top.parent() {
        if dev_of(up).ok() != Some(dev) {
            break;
        }
        top = up;
    }
    let shared = top.join(".Trash");
    let shared_ok = fs::symlink_metadata(&shared)
        .map(|m| m.is_dir() && !m.file_type().is_symlink() && m.permissions().mode() & 0o1000 != 0)
        .unwrap_or(false);
    let dir = if shared_ok { shared.join(uid().to_string()) } else { top.join(format!(".Trash-{}", uid())) };
    fs::create_dir_all(&dir)
        .map_err(|_| "Can’t put this item in the Trash: this drive has no Trash folder you can write to.".to_string())?;
    let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    Ok(dir)
}

/// Percent-encodes a path for `Path=`, keeping `/` and unreserved characters.
fn encode(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Local time as `YYYY-MM-DDThh:mm:ss`, the format of `DeletionDate`.
fn deletion_date() -> String {
    // SAFETY: `tm` is plain data; localtime_r only writes to it.
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec
        )
    }
}

/// The top of the mount a non-home trash folder belongs to, for relative `Path=` values.
fn topdir_of(trash: &Path) -> Option<PathBuf> {
    let name = trash.file_name()?.to_string_lossy();
    if name.starts_with(".Trash-") {
        return trash.parent().map(Path::to_path_buf);
    }
    let up = trash.parent()?;
    if up.file_name()? == ".Trash" {
        up.parent().map(Path::to_path_buf)
    } else {
        None
    }
}

/// Moves one item into the Trash and returns the record that undoes it.
pub fn trash_one(path: &Path, home: &Path) -> Result<UndoOp, String> {
    let shown = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if is_in_trash(path) {
        return Err(format!("“{shown}” is already in the Trash."));
    }
    let meta = fs::symlink_metadata(path).map_err(|e| format!("Can’t find “{shown}”: {}", plain(&e)))?;
    let trash = trash_dir_for(path, home)?;
    let (files, info) = (trash.join("files"), trash.join("info"));
    for dir in [&files, &info] {
        fs::create_dir_all(dir).map_err(|e| format!("Can’t open the Trash: {}", plain(&e)))?;
    }
    let recorded = topdir_of(&trash)
        .and_then(|top| path.strip_prefix(top).ok().map(Path::to_path_buf))
        .unwrap_or_else(|| path.to_path_buf());
    let body = format!("[Trash Info]\nPath={}\nDeletionDate={}\n", encode(&recorded.to_string_lossy()), deletion_date());

    // Claim a free name by creating its info file exclusively, so concurrent trashing can't clash.
    let mut tried: Vec<String> = Vec::new();
    let mut name = shown.clone();
    let info_file = loop {
        let info_file = info.join(format!("{name}.trashinfo"));
        if fs::symlink_metadata(files.join(&name)).is_err() {
            match fs::OpenOptions::new().write(true).create_new(true).open(&info_file) {
                Ok(mut f) => {
                    f.write_all(body.as_bytes()).map_err(|e| plain(&e))?;
                    break info_file;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(format!("Can’t write to the Trash: {}", plain(&e))),
            }
        }
        tried.push(name.clone());
        name = unique_name(&shown, meta.is_dir(), Style::Numbered, &|c| tried.iter().any(|t| t == c));
    };
    let target = files.join(&name);
    if let Err(e) = fs::rename(path, &target) {
        let _ = fs::remove_file(&info_file);
        return Err(format!("Couldn’t move “{shown}” to the Trash: {}", plain(&e)));
    }
    Ok(UndoOp::Trashed { original: path.to_string_lossy().into_owned(), trashed: target.to_string_lossy().into_owned() })
}

/// The original location recorded for an item in a trash's `files` folder.
pub fn original_of(trashed: &Path) -> Result<PathBuf, String> {
    let info = info_path(trashed).ok_or("This item isn’t in the Trash.")?;
    let text = fs::read_to_string(&info).map_err(|_| "The Trash has no record of where this item came from.".to_string())?;
    let value = text.lines().find_map(|l| l.strip_prefix("Path=")).ok_or("The Trash record for this item is damaged.")?;
    let path = PathBuf::from(decode(value.trim()));
    if path.is_absolute() {
        return Ok(path);
    }
    let trash = trashed.parent().and_then(Path::parent).ok_or("This item isn’t in the Trash.")?;
    topdir_of(trash).map(|top| top.join(path)).ok_or_else(|| "Can’t tell where this item came from.".to_string())
}

/// Puts an item back where it came from (under a free name if that place is taken now) and
/// returns the restored path.
pub fn restore_one(trashed: &Path) -> Result<PathBuf, String> {
    let shown = trashed.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let original = original_of(trashed)?;
    let dir = original.parent().ok_or("Can’t tell where this item came from.")?;
    fs::create_dir_all(dir).map_err(|e| format!("Can’t restore “{shown}”: {}", plain(&e)))?;
    let is_dir = fs::symlink_metadata(trashed).map(|m| m.is_dir()).unwrap_or(false);
    let name = original.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| shown.clone());
    let free = unique_name(&name, is_dir, Style::Numbered, &|n| fs::symlink_metadata(dir.join(n)).is_ok());
    let target = dir.join(free);
    fs::rename(trashed, &target).map_err(|e| format!("Can’t restore “{shown}”: {}", plain(&e)))?;
    if let Some(info) = info_path(trashed) {
        let _ = fs::remove_file(info);
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("corepro-trash-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn trashed_path(op: UndoOp) -> String {
        match op {
            UndoOp::Trashed { trashed, .. } => trashed,
            _ => panic!("not a trash record"),
        }
    }

    #[test]
    fn encodes_and_decodes_paths() {
        let raw = "/home/a b/é%x.txt";
        assert_eq!(decode(&encode(raw)), raw);
        assert_eq!(encode("/a b"), "/a%20b");
    }

    #[test]
    fn recognises_trash_folders() {
        assert!(is_trash_files_dir(Path::new("/home/u/.local/share/Trash/files")));
        assert!(is_trash_files_dir(Path::new("/mnt/usb/.Trash-1000/files")));
        assert!(is_trash_files_dir(Path::new("/mnt/usb/.Trash/1000/files")));
        assert!(!is_trash_files_dir(Path::new("/home/u/files")));
        assert!(is_in_trash(Path::new("/home/u/.local/share/Trash/files/x/y")));
        assert!(!is_in_trash(Path::new("/home/u/Documents")));
    }

    #[test]
    fn trash_then_restore_roundtrip() {
        let root = scratch("roundtrip");
        let home = root.join("Trash");
        let file = root.join("work/a b.txt");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "hi").unwrap();

        let record = trash_one(&file, &home).unwrap();
        let UndoOp::Trashed { original, trashed } = &record else { panic!() };
        assert_eq!(PathBuf::from(original), file);
        assert!(!file.exists());
        assert!(Path::new(trashed).exists());
        let info = fs::read_to_string(info_path(Path::new(trashed)).unwrap()).unwrap();
        assert!(info.starts_with("[Trash Info]\nPath="));
        assert!(info.contains("a%20b.txt"));
        assert!(info.contains("DeletionDate="));

        let restored = restore_one(Path::new(trashed)).unwrap();
        assert_eq!(restored, file);
        assert_eq!(fs::read_to_string(&file).unwrap(), "hi");
        assert!(!info_path(Path::new(trashed)).unwrap().exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn same_names_get_unique_slots() {
        let root = scratch("unique");
        let home = root.join("Trash");
        let mut slots = Vec::new();
        for i in 0..3 {
            let f = root.join(format!("d{i}/same.txt"));
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(&f, i.to_string()).unwrap();
            slots.push(trashed_path(trash_one(&f, &home).unwrap()));
        }
        slots.sort();
        slots.dedup();
        assert_eq!(slots.len(), 3);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn restore_avoids_overwriting() {
        let root = scratch("restore-taken");
        let home = root.join("Trash");
        let f = root.join("x.txt");
        fs::write(&f, "old").unwrap();
        let trashed = trashed_path(trash_one(&f, &home).unwrap());
        fs::write(&f, "new").unwrap();
        let restored = restore_one(Path::new(&trashed)).unwrap();
        assert_eq!(restored, root.join("x 2.txt"));
        assert_eq!(fs::read_to_string(&f).unwrap(), "new");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_items_already_in_trash_and_missing_items() {
        let root = scratch("refuse");
        let home = root.join("Trash");
        assert!(trash_one(&root.join("missing"), &home).is_err());
        let f = root.join("y.txt");
        fs::write(&f, "").unwrap();
        let trashed = trashed_path(trash_one(&f, &home).unwrap());
        assert!(trash_one(Path::new(&trashed), &home).unwrap_err().contains("already in the Trash"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn other_mounts_use_their_own_trash() {
        // /dev/shm is a separate tmpfs on most Linux systems; skip where it is not.
        let shm = Path::new("/dev/shm");
        let root = scratch("mounts");
        if !shm.is_dir() || dev_of(shm).ok() == dev_of(&root).ok() {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        let dir = shm.join(format!("corepro-trash-mount-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("z.txt");
        fs::write(&f, "z").unwrap();
        let trashed = trashed_path(trash_one(&f, &root.join("Trash")).unwrap());
        assert!(trashed.starts_with("/dev/shm/.Trash-"), "{trashed}");
        let info = fs::read_to_string(info_path(Path::new(&trashed)).unwrap()).unwrap();
        assert!(info.contains(&format!("Path=corepro-trash-mount-{}/z.txt", std::process::id())));
        assert_eq!(restore_one(Path::new(&trashed)).unwrap(), f);
        let _ = fs::remove_dir_all(shm.join(format!(".Trash-{}", uid())));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&root);
    }
}
