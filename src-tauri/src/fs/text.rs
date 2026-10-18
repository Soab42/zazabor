//! Reading the start of a text file for Quick Look.

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
