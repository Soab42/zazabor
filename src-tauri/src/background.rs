//! Running in the background, like Windows' clipboard service: `zazabor --background` starts
//! Zazabor with no window (at login, from an autostart entry), and while that entry exists,
//! closing the last window leaves Zazabor running, so the clipboard history keeps recording and
//! Super+V, quick notes and the time tracker answer at once. Launching Zazabor again shows its
//! window (see `notes::quick`, which carries the request). Quit (`zazabor --quit`, the menu
//! entry's action, or Settings) ends it.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

pub const FLAG: &str = "--background";

/// This launch only starts Zazabor in the background.
pub fn requested() -> bool {
    std::env::args().skip(1).any(|a| a == FLAG)
}

/// The desktop's autostart entry (XDG): `~/.config/autostart/zazabor.desktop`.
fn entry() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(config.join("autostart").join("zazabor.desktop"))
}

/// The first start after the rename from CorePro: a login entry CorePro left becomes Zazabor's
/// (same choice, the new program), and the old one goes.
pub fn adopt_old_entry() {
    let Some(new) = entry() else { return };
    let old = new.with_file_name("corepro.desktop");
    if !old.exists() {
        return;
    }
    if new.exists() || app_set_background(true).is_ok() {
        let _ = std::fs::remove_file(&old);
    }
}

/// Zazabor starts at login and stays running when its last window closes.
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
        "[Desktop Entry]\nType=Application\nName=Zazabor\nComment=Keeps the clipboard history, quick notes and the time tracker ready\n\
         Exec={exe} {FLAG}\nIcon=zazabor\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n"
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

/// Set by Quit until the windows that ask first have closed; a later launch clears it.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Windows that may hold unsaved work and ask before closing: the main window and section
/// windows (Office files among them). Notes and the clipboard popup simply close with Zazabor,
/// so the notes left open come back next time.
fn asks_first(label: &str) -> bool {
    label == "main" || label.starts_with("window-")
}

/// The program to start once Zazabor has quit (an update installed over it), while restarting.
static RESTART: std::sync::Mutex<Option<std::path::PathBuf>> = std::sync::Mutex::new(None);

/// Ends Zazabor, starting the new version first when restarting into an update.
fn exit(app: &tauri::AppHandle) {
    if let Some(exe) = RESTART.lock().unwrap_or_else(|e| e.into_inner()).take() {
        crate::update::relaunch(&exe);
    }
    app.exit(0);
}

/// Quits Zazabor, background mode or not. The main and section windows close as if their ×
/// was pressed, so Office still asks about unsaved files; Zazabor exits once they're gone.
pub fn quit(app: &tauri::AppHandle) {
    use tauri::Manager;
    let open: Vec<_> = app.webview_windows().into_iter().filter(|(label, _)| asks_first(label)).collect();
    if open.is_empty() {
        return exit(app);
    }
    QUITTING.store(true, Ordering::SeqCst);
    for (_, window) in open {
        let _ = window.close();
    }
}

/// A window was destroyed: while quitting, the last one that asks first ends Zazabor.
pub fn window_destroyed(app: &tauri::AppHandle, label: &str) {
    use tauri::Manager;
    if QUITTING.load(Ordering::SeqCst) && asks_first(label) && !app.webview_windows().keys().any(|l| l != label && asks_first(l)) {
        exit(app);
    }
}

/// Quits as `quit` does, then starts `exe` (the update installed over this copy).
pub fn restart(app: &tauri::AppHandle, exe: std::path::PathBuf) {
    *RESTART.lock().unwrap_or_else(|e| e.into_inner()) = Some(exe);
    quit(app);
}

/// Zazabor was opened again: a quit the user stopped (by keeping an unsaved file) is over.
pub fn cancel_quit() {
    QUITTING.store(false, Ordering::SeqCst);
    RESTART.lock().unwrap_or_else(|e| e.into_inner()).take();
}

#[tauri::command]
pub fn app_quit(app: tauri::AppHandle) {
    quit(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_main_and_section_windows_ask_before_quitting() {
        assert!(asks_first("main"));
        assert!(asks_first("window-3"));
        assert!(!asks_first("note-abc"));
        assert!(!asks_first("clipboard-popup"));
    }

    #[test]
    fn the_entry_starts_this_zazabor_in_the_background() {
        let text = entry_text("/home/me/.local/bin/zazabor");
        assert!(text.contains("Exec=/home/me/.local/bin/zazabor --background\n"));
        assert!(text.starts_with("[Desktop Entry]\n"));
    }
}
