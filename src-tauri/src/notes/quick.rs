//! Quick notes from anywhere: `corepro --new-note` opens one new note on the desktop and nothing
//! else. A CorePro that is already running takes the request over a socket, so the note opens
//! at once in that process; otherwise this process starts with only the note (no main window).
//! `corepro --clipboard` (the Win+V popup, see `clipboard::popup`) travels the same way.
//!
//! Settings can bind each to a desktop keyboard shortcut (GNOME's custom shortcuts, which Pop!_OS,
//! Ubuntu and Budgie share), so a note is one key press away even when CorePro isn't running.

use gio::prelude::*;
use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

pub const FLAG: &str = "--new-note";
const REQUEST: &str = "new-note";
pub const CLIPBOARD_FLAG: &str = "--clipboard";
const CLIPBOARD_REQUEST: &str = "clipboard";
/// A plain launch: show the main window (and open the file given, if any).
const SHOW_REQUEST: &str = "show";
/// `corepro --quit`: the running CorePro quits (it's the only way out of the background mode
/// besides Settings).
pub const QUIT_FLAG: &str = "--quit";
const QUIT_REQUEST: &str = "quit";

/// GNOME's custom keyboard shortcuts.
const KEYS_SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys";
const KEY_SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";

/// One desktop shortcut CorePro manages: where GNOME keeps it, its name there, and what it runs.
pub struct Slot {
    path: &'static str,
    name: &'static str,
    flag: &'static str,
    pub default: &'static str,
}

pub const NOTE: Slot = Slot { path: "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/corepro-new-note/", name: "CorePro: New Note", flag: FLAG, default: "<Super><Alt>n" };
pub const CLIPBOARD: Slot = Slot { path: "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/corepro-clipboard/", name: "CorePro: Clipboard", flag: CLIPBOARD_FLAG, default: "<Super>v" };

/// This launch asks for a quick note or the clipboard popup (and nothing else).
pub fn requested() -> bool {
    std::env::args().skip(1).any(|a| a == FLAG || a == CLIPBOARD_FLAG)
}

/// This launch asks for the clipboard popup.
pub fn clipboard_requested() -> bool {
    std::env::args().skip(1).any(|a| a == CLIPBOARD_FLAG)
}

/// This launch asks the running CorePro to quit.
pub fn quit_requested() -> bool {
    std::env::args().skip(1).any(|a| a == QUIT_FLAG)
}

/// Asks a running CorePro to quit; false when none is running.
pub fn forward_quit() -> bool {
    let Ok(mut stream) = UnixStream::connect(socket_path()) else { return false };
    stream.write_all(format!("{QUIT_REQUEST}\n").as_bytes()).is_ok()
}

fn socket_path() -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    // One socket per copy of CorePro, so the installed one and a development build don't take
    // each other's launches.
    let exe = std::env::current_exe().ok().and_then(|p| p.canonicalize().ok()).unwrap_or_default();
    let copy = xxhash_rust::xxh3::xxh3_64(exe.as_os_str().as_bytes()) as u32;
    // SAFETY: getuid has no preconditions.
    dir.join(format!("corepro-{}-{copy:08x}.sock", unsafe { libc::getuid() }))
}

/// This CorePro is already running (it answers on its socket).
pub fn running() -> bool {
    UnixStream::connect(socket_path()).is_ok()
}

/// Hands a plain launch to a running CorePro, which shows its window and opens `path`; false
/// when none answers (within a second), so this launch starts CorePro itself.
pub fn forward_show(path: Option<&str>) -> bool {
    let Ok(mut stream) = UnixStream::connect(socket_path()) else { return false };
    let path = path.filter(|p| !p.contains('\n'));
    let line = path.map_or_else(|| format!("{SHOW_REQUEST}\n"), |p| format!("{SHOW_REQUEST}\t{p}\n"));
    if stream.write_all(line.as_bytes()).is_err() {
        return false;
    }
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(1)));
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).is_ok() && reply.trim() == "ok"
}

/// Hands the request to a running CorePro; false when none answers.
pub fn forward() -> bool {
    let Ok(mut stream) = UnixStream::connect(socket_path()) else { return false };
    let request = if clipboard_requested() { CLIPBOARD_REQUEST } else { REQUEST };
    stream.write_all(format!("{request}\n").as_bytes()).is_ok()
}

/// Takes requests from later launches (`corepro --new-note`) for as long as this CorePro runs.
pub fn serve(app: tauri::AppHandle) {
    let path = socket_path();
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        // A socket nobody answers on is left over from a CorePro that didn't exit cleanly.
        Err(_) if UnixStream::connect(&path).is_err() => {
            let _ = std::fs::remove_file(&path);
            match UnixListener::bind(&path) {
                Ok(listener) => listener,
                Err(err) => return eprintln!("Quick notes can't listen on {}: {err}", path.display()),
            }
        }
        // Another CorePro already listens; it gets the quick notes.
        Err(_) => return,
    };
    let _ = std::thread::Builder::new().name("quick-notes".into()).spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut line = String::new();
            if BufReader::new(&stream).read_line(&mut line).is_err() {
                continue;
            }
            let line = line.trim_end_matches(['\n', '\r']);
            let (request, arg) = line.split_once('\t').map_or((line, None), |(r, a)| (r, Some(a.to_string())));
            match request {
                SHOW_REQUEST => {
                    crate::background::cancel_quit();
                    crate::show_main(&app, arg);
                    let _ = stream.write_all(b"ok\n");
                }
                REQUEST => new_note(&app),
                QUIT_REQUEST => crate::background::quit(&app),
                CLIPBOARD_REQUEST => {
                    if let Err(err) = crate::clipboard::popup::toggle(&app) {
                        eprintln!("Could not open the clipboard: {err}");
                    }
                }
                _ => {}
            }
        }
    });
}

/// A new, empty note in its own window.
pub fn new_note(app: &tauri::AppHandle) {
    // Made even while CorePro is locked: its window asks for the password before showing it.
    let note = super::create(None, None, None, None);
    if let Err(err) = super::open_window(app, &note.id) {
        eprintln!("Could not open the quick note: {err}");
    }
}

// ---- the desktop shortcut ---------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcut {
    /// The desktop has GNOME-style custom shortcuts CorePro can add to.
    supported: bool,
    /// "none", "installed", or "other" (bound, but to another CorePro, e.g. before a reinstall).
    state: &'static str,
    /// GTK accelerator, e.g. `<Super><Alt>n`.
    binding: String,
    /// What the shortcut should run: this CorePro with `--new-note` (or `--clipboard`).
    command: String,
}

/// What the shortcut runs. A dev build loads its pages from the dev server, which is gone once
/// `tauri dev` stops ("connection refused"), so from one it runs the installed CorePro instead.
fn command(slot: &Slot) -> Result<String, String> {
    let exe = if cfg!(debug_assertions) { installed() } else { std::env::current_exe().ok() };
    let exe = exe.ok_or("This development build can’t be the shortcut’s target. Install CorePro (scripts/install-linux.sh) and set the shortcut there.")?;
    Ok(format!("\"{}\" {}", exe.to_string_lossy(), slot.flag))
}

/// The installed CorePro: where `scripts/install-linux.sh` puts it, or else on the PATH.
fn installed() -> Option<PathBuf> {
    let local = std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/bin/corepro"));
    let on_path = std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|dir| dir.join("corepro")).find(|p| p.is_file()));
    local.filter(|p| p.is_file()).or(on_path)
}

pub fn schema_installed(id: &str) -> bool {
    gio::SettingsSchemaSource::default().and_then(|s| s.lookup(id, true)).is_some()
}

pub fn shortcut_status(slot: &Slot) -> Shortcut {
    let command = command(slot).unwrap_or_default();
    if !schema_installed(KEYS_SCHEMA) || !schema_installed(KEY_SCHEMA) {
        return Shortcut { supported: false, state: "none", binding: slot.default.into(), command };
    }
    let listed = gio::Settings::new(KEYS_SCHEMA).strv("custom-keybindings").iter().any(|p| p.as_str() == slot.path);
    let key = gio::Settings::with_path(KEY_SCHEMA, slot.path);
    let binding = key.string("binding").to_string();
    let state = if !listed || binding.is_empty() {
        "none"
    } else if key.string("command").as_str() == command {
        "installed"
    } else {
        "other"
    };
    Shortcut { supported: true, state, binding: if binding.is_empty() { slot.default.into() } else { binding }, command }
}

#[tauri::command]
pub fn notes_shortcut() -> Shortcut {
    shortcut_status(&NOTE)
}

/// Adds (or updates) the desktop shortcut that opens a quick note; `binding` is a GTK accelerator.
#[tauri::command]
pub fn notes_set_shortcut(binding: Option<String>) -> Result<Shortcut, String> {
    set_shortcut(&NOTE, binding)
}

/// Adds, updates or (with `None`) removes one of CorePro's desktop shortcuts.
pub fn set_shortcut(slot: &Slot, binding: Option<String>) -> Result<Shortcut, String> {
    if !schema_installed(KEYS_SCHEMA) || !schema_installed(KEY_SCHEMA) {
        return Err("This desktop doesn’t offer custom keyboard shortcuts CorePro can set. Add one in your desktop’s keyboard settings instead.".into());
    }
    let command = if binding.is_some() { command(slot)? } else { String::new() };
    let list = gio::Settings::new(KEYS_SCHEMA);
    let key = gio::Settings::with_path(KEY_SCHEMA, slot.path);
    let result = (|| -> Result<(), gio::glib::BoolError> {
        match binding {
            Some(binding) => {
                key.set_string("name", slot.name)?;
                key.set_string("command", &command)?;
                key.set_string("binding", &binding)?;
                let mut paths: Vec<String> = list.strv("custom-keybindings").iter().map(|p| p.to_string()).collect();
                if !paths.iter().any(|p| p == slot.path) {
                    paths.push(slot.path.into());
                    list.set_strv("custom-keybindings", paths.iter().map(String::as_str).collect::<Vec<_>>())?;
                }
            }
            None => {
                let paths: Vec<String> = list.strv("custom-keybindings").iter().map(|p| p.to_string()).filter(|p| p != slot.path).collect();
                list.set_strv("custom-keybindings", paths.iter().map(String::as_str).collect::<Vec<_>>())?;
                for name in ["name", "command", "binding"] {
                    key.reset(name);
                }
            }
        }
        Ok(())
    })();
    gio::Settings::sync();
    result.map_err(|e| format!("Couldn’t change the shortcut: {e}"))?;
    Ok(shortcut_status(slot))
}
