//! Running in the background, like Windows' clipboard service: `corepro --background` starts
//! CorePro with no window (at login, from an autostart entry), and while that entry exists,
//! closing the last window leaves CorePro running, so the clipboard history keeps recording and
//! Super+V, quick notes and the time tracker answer at once. Launching CorePro again shows its
//! window (see `notes::quick`, which carries the request).

use std::path::PathBuf;

pub const FLAG: &str = "--background";

/// This launch only starts CorePro in the background.
pub fn requested() -> bool {
    std::env::args().skip(1).any(|a| a == FLAG)
}

/// The desktop's autostart entry (XDG): `~/.config/autostart/corepro.desktop`.
fn entry() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(config.join("autostart").join("corepro.desktop"))
}

/// CorePro starts at login and stays running when its last window closes.
pub fn enabled() -> bool {
    entry().is_some_and(|p| p.exists())
}

/// Keeps running with no window: started in the background, or set to.
pub fn keep_running() -> bool {
    requested() || enabled()
}

fn entry_text(exe: &str) -> String {
    // The Exec line quotes a path with spaces (desktop entry spec).
    let exe = if exe.contains(' ') { format!("\"{exe}\"") } else { exe.to_string() };
    format!(
        "[Desktop Entry]\nType=Application\nName=CorePro\nComment=Keeps the clipboard history, quick notes and the time tracker ready\n\
         Exec={exe} {FLAG}\nIcon=corepro\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n"
    )
}

#[tauri::command]
pub fn app_background() -> bool {
    enabled()
}

/// Turns starting at login (and staying open with no window) on or off.
#[tauri::command]
pub fn app_set_background(on: bool) -> Result<(), String> {
    let path = entry().ok_or("No home folder to keep the autostart entry in.")?;
    if !on {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    crate::fs::text::write_text(&path, &entry_text(&exe.to_string_lossy())).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entry_starts_this_corepro_in_the_background() {
        let text = entry_text("/home/me/.local/bin/corepro");
        assert!(text.contains("Exec=/home/me/.local/bin/corepro --background\n"));
        assert!(text.starts_with("[Desktop Entry]\n"));
    }
}
