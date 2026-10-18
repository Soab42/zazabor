//! Colour tags kept in the `user.xdg.tags` extended attribute (comma-separated), the convention
//! GNOME and KDE file managers share.

use std::collections::HashMap;
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

const ATTR: &str = "user.xdg.tags";

fn c_path(path: &Path) -> Result<CString, String> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| "invalid path".to_string())
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn failure(path: &Path) -> String {
    if errno() == libc::ENOTSUP {
        format!("{} is on a filesystem that does not support tags", path.display())
    } else {
        format!("{}: {}", path.display(), std::io::Error::last_os_error())
    }
}

fn parse(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// The tags of one path; empty when it has none or the filesystem cannot hold any.
pub fn get(path: &Path) -> Vec<String> {
    let Ok(c) = c_path(path) else { return Vec::new() };
    let name = CString::new(ATTR).unwrap();
    let mut buf = vec![0u8; 1024];
    // SAFETY: valid NUL-terminated strings and a buffer of the stated length.
    let len = unsafe { libc::getxattr(c.as_ptr(), name.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
    if len < 0 {
        return Vec::new();
    }
    buf.truncate(len as usize);
    parse(&buf)
}

/// Tags for many paths at once; paths without tags are left out.
pub fn get_many(paths: &[String]) -> HashMap<String, Vec<String>> {
    paths
        .iter()
        .filter_map(|p| {
            let tags = get(Path::new(p));
            (!tags.is_empty()).then(|| (p.clone(), tags))
        })
        .collect()
}

/// Replaces the tags of a path; an empty list removes the attribute.
pub fn set(path: &Path, tags: &[String]) -> Result<(), String> {
    let c = c_path(path)?;
    let name = CString::new(ATTR).unwrap();
    let clean: Vec<&str> = tags.iter().map(|t| t.trim()).filter(|t| !t.is_empty() && !t.contains(',')).collect();
    if clean.is_empty() {
        // SAFETY: valid NUL-terminated strings.
        let rc = unsafe { libc::removexattr(c.as_ptr(), name.as_ptr()) };
        if rc < 0 && errno() != libc::ENODATA {
            return Err(failure(path));
        }
        return Ok(());
    }
    let value = clean.join(",");
    // SAFETY: valid NUL-terminated strings and a value buffer of the stated length.
    let rc = unsafe { libc::setxattr(c.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0) };
    if rc < 0 {
        return Err(failure(path));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join(format!("corepro-tags-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("t.txt");
        std::fs::write(&file, b"x").unwrap();
        let tags = vec!["Red".to_string(), "Blue".to_string()];
        if set(&file, &tags).is_err() {
            eprintln!("user xattrs unsupported here; skipping");
            return;
        }
        assert_eq!(get(&file), tags);
        let map = get_many(&[file.to_string_lossy().into_owned(), "/nonexistent".into()]);
        assert_eq!(map.len(), 1);
        set(&file, &[]).unwrap();
        assert!(get(&file).is_empty());
        set(&file, &[]).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_trims_and_skips_empty() {
        assert_eq!(parse(b" Red, ,Blue,"), vec!["Red", "Blue"]);
    }
}
