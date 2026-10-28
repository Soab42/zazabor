//! Downloads that resume (a `.part` file and an HTTP range request) and can be cancelled, for the
//! captions models (`videoedit::models`), the content library (`content`) and updates (`update`).

use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Hashes a file (the whole of it).
pub fn sha256_of(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Downloads `url` into `part`, continuing after what's there. `done` follows the bytes on disk.
pub fn fetch(url: &str, part: &Path, total: u64, done: &AtomicU64, cancel: &AtomicBool) -> Result<(), String> {
    let have = std::fs::metadata(part).map_or(0, |m| m.len());
    if have > total {
        let _ = std::fs::remove_file(part);
        return fetch(url, part, total, done, cancel);
    }
    done.store(have, Ordering::Relaxed);
    if have == total {
        return Ok(());
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(std::time::Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut request = agent.get(url).header("User-Agent", "Zazabor");
    if have > 0 {
        request = request.header("Range", &format!("bytes={have}-"));
    }
    let response = request.call().map_err(|e| format!("Couldn't reach the download server: {e}"))?;
    let status = response.status().as_u16();
    let append = match status {
        206 => true,
        200 => false,
        416 if have > 0 => {
            // The server says there's nothing past what we have; check it as it is.
            return Ok(());
        }
        _ => return Err(format!("The download server answered {status}.")),
    };
    let mut file = std::fs::OpenOptions::new().create(true).write(true).append(append).truncate(!append).open(part).map_err(|e| e.to_string())?;
    let mut written = if append { have } else { 0 };
    done.store(written, Ordering::Relaxed);
    let mut body = response.into_body().into_reader();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            file.flush().map_err(|e| e.to_string())?;
            return Err("Cancelled".into());
        }
        let n = body.read(&mut buf).map_err(|e| format!("The download stopped: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        written += n as u64;
        done.store(written, Ordering::Relaxed);
        if written > total {
            return Err("The download server sent more than expected.".into());
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(())
}
