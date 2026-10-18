//! Terminals: the user's shell in a pseudo-terminal, streamed to xterm.js in the window that opened
//! it (`term-data` events), with input, resizing and an exit event (`term-exit`). Used by the
//! Terminal section and the editor's terminal panel.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager};

struct Term {
    window: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

static TERMS: Mutex<Option<HashMap<u32, Term>>> = Mutex::new(None);
static NEXT: AtomicU32 = AtomicU32::new(1);

fn terms() -> MutexGuard<'static, Option<HashMap<u32, Term>>> {
    TERMS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn with_term<T>(id: u32, f: impl FnOnce(&mut Term) -> Result<T, String>) -> Result<T, String> {
    let mut guard = terms();
    let term = guard.as_mut().and_then(|m| m.get_mut(&id)).ok_or("That terminal has closed.")?;
    f(term)
}

#[derive(Serialize, Clone)]
struct Data {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct Exit {
    id: u32,
    code: Option<u32>,
}

/// Splits off a multi-byte UTF-8 character cut at the end of a read, to prepend to the next one.
fn split_utf8(bytes: &[u8]) -> usize {
    // The last complete character ends at `bytes.len()` unless a lead byte starts a sequence that
    // isn't finished; look back at most three bytes.
    for back in 1..=bytes.len().min(3) {
        let b = bytes[bytes.len() - back];
        if b & 0b1100_0000 == 0b1000_0000 {
            continue; // continuation byte
        }
        let needed = if b >= 0b1111_0000 { 4 } else if b >= 0b1110_0000 { 3 } else if b >= 0b1100_0000 { 2 } else { 1 };
        return if back < needed { bytes.len() - back } else { bytes.len() };
    }
    bytes.len()
}

/// A folder to start in: the one asked for if it exists, else the home folder.
fn start_dir(cwd: Option<String>) -> PathBuf {
    cwd.map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"))
}

// ---- shell integration ------------------------------------------------------------------------

/// Scripts that make the shell mark prompts, commands and exit codes (OSC 133 / 633 / 7) for the
/// command blocks. Each loads the user's own startup files first; none of those are changed.
const SCRIPTS: [(&str, &str); 6] = [
    ("zsh/.zshenv", include_str!("../shell/zsh/.zshenv")),
    ("zsh/.zprofile", include_str!("../shell/zsh/.zprofile")),
    ("zsh/.zshrc", include_str!("../shell/zsh/.zshrc")),
    ("zsh/.zlogin", include_str!("../shell/zsh/.zlogin")),
    ("corepro.bash", include_str!("../shell/corepro.bash")),
    ("corepro.fish", include_str!("../shell/corepro.fish")),
];

/// Writes the scripts to a private folder in the app's cache (once per launch) and returns it.
fn integration_dir(app: &AppHandle) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let dir = app.path().app_cache_dir().ok()?.join("shell-integration");
    for (name, text) in SCRIPTS {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent()?).ok()?;
        if std::fs::read_to_string(&path).ok().as_deref() != Some(text) {
            std::fs::write(&path, text).ok()?;
        }
    }
    // Only this user may write where zsh is told to read its startup files.
    for sub in [dir.clone(), dir.join("zsh")] {
        let _ = std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o700));
    }
    Some(dir)
}

/// The user's login shell: $SHELL, else their passwd entry, else bash.
fn default_shell() -> String {
    if let Some(shell) = std::env::var_os("SHELL").filter(|s| !s.is_empty()) {
        return shell.to_string_lossy().into_owned();
    }
    let user = std::env::var("USER").unwrap_or_default();
    std::fs::read_to_string("/etc/passwd")
        .ok()
        .and_then(|text| text.lines().find(|l| l.split(':').next() == Some(&user)).and_then(|l| l.rsplit(':').next().map(str::to_string)))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/bash".into())
}

/// A random token the integration script stamps on command lines, so output can't fake them.
fn nonce() -> String {
    let mut h = RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    format!("{:016x}", h.finish())
}

/// The command to run `shell`, with the integration script when it's on and the shell is known.
fn shell_command(shell: &str, integration: Option<&Path>) -> CommandBuilder {
    let name = Path::new(shell).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut cmd = CommandBuilder::new(shell);
    match (name.as_str(), integration) {
        ("zsh", Some(dir)) => {
            cmd.arg("-l");
            let user = std::env::var_os("ZDOTDIR").or_else(|| std::env::var_os("HOME")).unwrap_or_default();
            cmd.env("COREPRO_USER_ZDOTDIR", user);
            cmd.env("ZDOTDIR", dir.join("zsh"));
        }
        ("bash", Some(dir)) => {
            cmd.arg("--init-file");
            cmd.arg(dir.join("corepro.bash"));
        }
        ("fish", Some(dir)) => {
            cmd.arg("-l");
            cmd.arg("--init-command");
            cmd.arg(format!("source '{}'", dir.join("corepro.fish").display()));
        }
        ("zsh" | "bash" | "fish", None) => cmd.arg("-l"),
        _ => {}
    }
    cmd
}

/// A shell to offer in the new-terminal menu.
#[derive(Serialize)]
pub struct ShellInfo {
    name: String,
    path: String,
    default: bool,
}

/// The shells installed (from /etc/shells), the user's own first.
#[tauri::command]
pub fn term_shells() -> Vec<ShellInfo> {
    let mine = default_shell();
    let mine_name = Path::new(&mine).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut shells = vec![ShellInfo { name: mine_name.clone(), path: mine.clone(), default: true }];
    seen.insert(mine_name);
    for line in std::fs::read_to_string("/etc/shells").unwrap_or_default().lines() {
        let path = line.trim();
        if path.is_empty() || path.starts_with('#') || !Path::new(path).exists() {
            continue;
        }
        let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        // A restricted shell isn't something to open by choice.
        if name.starts_with('r') && name.ends_with("bash") || !seen.insert(name.clone()) {
            continue;
        }
        shells.push(ShellInfo { name, path: path.to_string(), default: false });
    }
    shells
}

/// Starts a shell (the user's own unless `shell` names one) in a terminal of `cols` × `rows` for
/// this window; returns its id. `integration` adds the command-block marks; `nonce` is the token
/// genuine command-line marks carry.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn term_spawn(
    app: AppHandle,
    window: tauri::Window,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    integration: Option<bool>,
    nonce: Option<String>,
) -> Result<u32, String> {
    crate::ensure_unlocked()?;
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Couldn’t open a terminal: {e}"))?;
    let shell = shell.filter(|s| Path::new(s).exists()).unwrap_or_else(default_shell);
    let scripts = if integration.unwrap_or(true) { integration_dir(&app) } else { None };
    let mut cmd = shell_command(&shell, scripts.as_deref());
    // The terminal checks command lines against this token; it picks one, or gets a random one.
    cmd.env("COREPRO_NONCE", nonce.filter(|n| !n.is_empty()).unwrap_or_else(self::nonce));
    cmd.cwd(start_dir(cwd));
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "CorePro");
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("Couldn’t start your shell: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let label = window.label().to_string();
    terms().get_or_insert_with(HashMap::new).insert(id, Term { window: label.clone(), master: pair.master, writer, child });

    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let cut = split_utf8(&carry);
                    let data = String::from_utf8_lossy(&carry[..cut]).into_owned();
                    carry.drain(..cut);
                    let _ = app.emit_to(label.as_str(), "term-data", Data { id, data });
                }
            }
        }
        // The shell is gone: collect its exit code and forget the terminal.
        let code = terms().as_mut().and_then(|m| m.remove(&id)).and_then(|mut t| t.child.wait().ok()).map(|s| s.exit_code());
        let _ = app.emit_to(label.as_str(), "term-exit", Exit { id, code });
    });
    Ok(id)
}

/// Types into a terminal (keys, pasted text).
#[tauri::command]
pub fn term_write(id: u32, data: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    with_term(id, |t| {
        t.writer.write_all(data.as_bytes()).and_then(|_| t.writer.flush()).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn term_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    with_term(id, |t| {
        t.master
            .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    })
}

/// Ends a terminal's shell (and what runs in it).
#[tauri::command]
pub fn term_kill(id: u32) -> Result<(), String> {
    if let Some(mut term) = terms().as_mut().and_then(|m| m.remove(&id)) {
        let _ = term.child.kill();
    }
    Ok(())
}

/// What a terminal is doing, for its tab: the program in front ("vim", "cargo", or the shell) and
/// the shell's folder.
#[derive(Serialize)]
pub struct TermInfo {
    program: String,
    cwd: String,
}

#[tauri::command]
pub fn term_info(id: u32) -> Result<TermInfo, String> {
    with_term(id, |t| {
        let shell = t.child.process_id();
        let front = t.master.process_group_leader().map(|p| p as u32).or(shell);
        let program = front
            .and_then(|pid| std::fs::read_to_string(format!("/proc/{pid}/comm")).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let cwd = shell
            .and_then(|pid| std::fs::read_link(format!("/proc/{pid}/cwd")).ok())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(TermInfo { program, cwd })
    })
}

/// A window closed: end the terminals it showed.
pub fn window_closed(label: &str) {
    let mut guard = terms();
    let Some(map) = guard.as_mut() else { return };
    let ids: Vec<u32> = map.iter().filter(|(_, t)| t.window == label).map(|(id, _)| *id).collect();
    for id in ids {
        if let Some(mut term) = map.remove(&id) {
            let _ = term.child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_split_keeps_unfinished_characters_for_the_next_read() {
        assert_eq!(split_utf8(b"plain"), 5);
        let s = "aé€😀".as_bytes(); // 1 + 2 + 3 + 4 bytes
        assert_eq!(split_utf8(s), s.len());
        assert_eq!(split_utf8(&s[..2]), 1); // "a" + half of "é"
        assert_eq!(split_utf8(&s[..5]), 3); // "aé" + two thirds of "€"
        assert_eq!(split_utf8(&s[..8]), 6); // "aé€" + two bytes of the emoji
        assert_eq!(split_utf8(&s[..6]), 6);
        assert_eq!(split_utf8(b""), 0);
    }

    #[test]
    fn shells_get_their_integration_script() {
        let dir = Path::new("/tmp/si");
        let zsh = shell_command("/usr/bin/zsh", Some(dir));
        assert_eq!(zsh.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>(), ["/usr/bin/zsh", "-l"]);
        assert_eq!(zsh.get_env("ZDOTDIR").map(|v| v.to_string_lossy().into_owned()).as_deref(), Some("/tmp/si/zsh"));
        let bash = shell_command("/bin/bash", Some(dir));
        assert_eq!(bash.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>(), ["/bin/bash", "--init-file", "/tmp/si/corepro.bash"]);
        let plain = shell_command("/bin/dash", Some(dir));
        assert_eq!(plain.get_argv().len(), 1);
        let off = shell_command("/usr/bin/zsh", None);
        assert!(off.get_env("ZDOTDIR").is_none() || off.get_env("ZDOTDIR") == std::env::var_os("ZDOTDIR").as_deref());
        assert_ne!(nonce(), nonce());
    }

    #[test]
    fn a_missing_start_folder_falls_back_to_home() {
        assert_eq!(start_dir(Some("/definitely/not/here".into())), start_dir(None));
        assert_eq!(start_dir(Some("/".into())), PathBuf::from("/"));
    }
}
