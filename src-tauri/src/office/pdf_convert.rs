//! PDF → Word with LibreOffice, when it's installed (docs/plans/pdf.md §4.10, decision 6): a
//! separate program, never linked. Its PDF import places each piece of the page where it was, so
//! it keeps the layout; Zazabor's own conversion (in the page) makes flowing, editable text.
//! LibreOffice runs headless with a profile of its own, so it can't clash with one the user has
//! open.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::ipc::{InvokeBody, Request, Response};

/// A conversion taking longer than this is given up.
const TIMEOUT: Duration = Duration::from_secs(180);

fn soffice() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| ["soffice", "libreoffice"].map(|name| dir.join(name)))
        .find(|p| p.is_file())
}

/// Whether LibreOffice is installed.
#[tauri::command]
pub fn pdf_libreoffice() -> bool {
    soffice().is_some()
}

/// The PDF that is the body, converted to .docx by LibreOffice.
#[tauri::command]
pub async fn pdf_convert_libreoffice(request: Request<'_>) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err("Nothing to convert.".into());
    };
    let body = body.to_vec();
    let out = tauri::async_runtime::spawn_blocking(move || convert(&body)).await.map_err(|e| e.to_string())??;
    Ok(Response::new(out))
}

fn convert(pdf: &[u8]) -> Result<Vec<u8>, String> {
    let program = soffice().ok_or("LibreOffice isn't installed.")?;
    let dir = std::env::temp_dir().join(format!("zazabor-lo-{}-{}", std::process::id(), rand_suffix()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let result = (|| {
        let input = dir.join("document.pdf");
        std::fs::write(&input, pdf).map_err(|e| e.to_string())?;
        let profile = format!("file://{}", dir.join("profile").display());
        let mut child = Command::new(program)
            .arg(format!("-env:UserInstallation={profile}"))
            .args(["--headless", "--norestore", "--nolockcheck", "--infilter=writer_pdf_import", "--convert-to", "docx:MS Word 2007 XML", "--outdir"])
            .arg(&dir)
            .arg(&input)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("LibreOffice couldn't start: {e}"))?;
        let started = Instant::now();
        loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(_) => break,
                None if started.elapsed() > TIMEOUT => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("LibreOffice took too long, so it was stopped.".to_string());
                }
                None => std::thread::sleep(Duration::from_millis(200)),
            }
        }
        std::fs::read(dir.join("document.docx")).map_err(|_| "LibreOffice couldn't convert this file.".to_string())
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}
