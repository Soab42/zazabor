//! Reading the start of a text file for Quick Look, and saving text files from the editor.

use serde::Serialize;
use std::io::Read;
use std::path::Path;

/// The beginning of a file as text.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub text: String,
    /// The file is longer than what was read.
    pub truncated: bool,
    /// The content looks like binary data; `text` is empty then.
    pub binary: bool,
}

/// Reads at most `max_bytes` and decodes them as lossy UTF-8.
pub fn read_text(path: &Path, max_bytes: usize) -> Result<TextPreview, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut bytes = Vec::new();
    // One extra byte tells whether the file goes on.
    file.take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let truncated = bytes.len() > max_bytes;
    bytes.truncate(max_bytes);
    if looks_binary(&bytes, truncated) {
        return Ok(TextPreview { text: String::new(), truncated, binary: true });
    }
    Ok(TextPreview { text: String::from_utf8_lossy(&bytes).into_owned(), truncated, binary: false })
}

/// The whole file as bytes, refusing files larger than `max_bytes` (PDF preview needs raw bytes,
/// which the `cs:` protocol does not serve for documents).
pub fn read_bytes(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if meta.len() > max_bytes {
        return Err(format!("{} is too large to preview", path.display()));
    }
    std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Saves `text` over a file the way editors do; see `write_bytes`.
pub fn write_text(path: &Path, text: &str) -> Result<f64, String> {
    write_bytes(path, text.as_bytes())
}

/// Saves `bytes` over a file the way editors do: written to a hidden temporary file in the same
/// folder, flushed, given the original's permissions, then renamed over it, so a crash or a full
/// disk never leaves a half-written file. Returns the new modification time.
pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<f64, String> {
    use std::io::Write;
    let shown = path.display();
    let dir = path.parent().ok_or_else(|| format!("Can’t save {shown}"))?;
    let name = path.file_name().ok_or_else(|| format!("Can’t save {shown}"))?.to_string_lossy();
    let existing = std::fs::metadata(path).ok();
    let tmp = dir.join(format!(".{name}.{}.corepro-save", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Some(meta) = &existing {
            std::fs::set_permissions(&tmp, meta.permissions())?;
        }
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Couldn’t save {shown}: {e}"));
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("{shown}: {e}"))?;
    Ok(crate::scan::unix_seconds(meta.modified()))
}

/// NUL bytes, or more than a few percent of invalid UTF-8, mean binary. A multi-byte character
/// cut off at the end of a truncated read is not counted as invalid.
fn looks_binary(bytes: &[u8], truncated: bool) -> bool {
    if bytes.contains(&0) {
        return true;
    }
    let mut invalid = 0usize;
    let mut rest = bytes;
    while let Err(e) = std::str::from_utf8(rest) {
        let skip = e.valid_up_to();
        match e.error_len() {
            Some(len) => {
                invalid += len;
                rest = &rest[skip + len..];
            }
            None => {
                if !truncated {
                    invalid += rest.len() - skip;
                }
                break;
            }
        }
    }
    invalid * 100 > bytes.len() * 2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saving_replaces_the_file_and_keeps_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp("saved.rs", b"fn old() {}\n");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        write_text(&path, "fn new() {}\r\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "fn new() {}\r\n");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("corepro-save")).collect();
        assert!(leftovers.is_empty());
        // A new file can be saved too.
        let fresh = path.with_file_name("fresh.txt");
        write_text(&fresh, "hello").unwrap();
        assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "hello");
    }

    fn temp(name: &str, content: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("corepro-text-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn reads_utf8() {
        let path = temp("a.txt", "héllo\nwörld".as_bytes());
        let preview = read_text(&path, 1024).unwrap();
        assert_eq!(preview, TextPreview { text: "héllo\nwörld".into(), truncated: false, binary: false });
    }

    #[test]
    fn read_bytes_respects_the_limit() {
        let path = temp("e.bin", &[1, 2, 3, 4]);
        assert_eq!(read_bytes(&path, 4).unwrap(), vec![1, 2, 3, 4]);
        assert!(read_bytes(&path, 3).is_err());
        assert!(read_bytes(path.parent().unwrap(), 10).is_err());
    }

    #[test]
    fn detects_binary() {
        let path = temp("b.bin", &[0x7f, b'E', b'L', b'F', 0, 1, 2, 3]);
        let preview = read_text(&path, 1024).unwrap();
        assert!(preview.binary && preview.text.is_empty());
        let path = temp("c.bin", &[0xff, 0xfe, 0xfd, 0xfc, 0xfb, b'a']);
        assert!(read_text(&path, 1024).unwrap().binary);
    }

    #[test]
    fn truncates_without_calling_a_split_character_binary() {
        let path = temp("d.txt", "ééééé".as_bytes());
        let preview = read_text(&path, 5).unwrap();
        assert!(preview.truncated && !preview.binary);
        assert!(preview.text.starts_with("éé"));
        let whole = read_text(&path, 10).unwrap();
        assert!(!whole.truncated);
    }
}
