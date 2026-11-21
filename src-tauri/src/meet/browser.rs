//! Opening the host's meeting window: a Chrome/Chromium/Edge/Brave app window of its own (no tabs,
//! no address bar) with its own profile, else the default browser.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// (command, name shown) in the order they're tried.
const BROWSERS: [(&str, &str); 5] = [
    ("google-chrome", "Google Chrome"),
    ("chromium", "Chromium"),
    ("chromium-browser", "Chromium"),
    ("microsoft-edge", "Microsoft Edge"),
    ("brave-browser", "Brave"),
];

fn on_path(name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::var_os("PATH")?.to_str()?.split(':').map(|d| Path::new(d).join(name)).find(|p| p.is_file() && std::fs::metadata(p).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false))
}

/// The browser the window opens in.
pub fn find() -> Option<(PathBuf, &'static str)> {
    BROWSERS.iter().find_map(|(cmd, label)| on_path(cmd).map(|p| (p, *label)))
}

pub fn label() -> Option<String> {
    find().map(|(_, l)| l.to_string())
}

pub fn app_args(url: &str, profile: &Path) -> Vec<String> {
    vec![format!("--app={url}"), format!("--user-data-dir={}", profile.display()), "--no-first-run".into(), "--no-default-browser-check".into()]
}

/// Opens `url` in an app window (or the default browser), detached.
pub fn open(url: &str, profile: &Path) -> Result<(), String> {
    let mut cmd = match find() {
        Some((path, _)) => {
            let _ = std::fs::create_dir_all(profile);
            let mut c = Command::new(path);
            c.args(app_args(url, profile));
            c
        }
        None => {
            let mut c = Command::new("xdg-open");
            c.arg(url);
            c
        }
    };
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("The meeting window couldn't open: {e}"))?;
    // Reap it when it exits, without waiting here.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_app_window_has_its_own_profile() {
        let args = app_args("http://127.0.0.1:1/m/x", Path::new("/data/meet-browser"));
        assert_eq!(args[0], "--app=http://127.0.0.1:1/m/x");
        assert!(args.contains(&"--user-data-dir=/data/meet-browser".to_string()));
        assert!(args.contains(&"--no-first-run".to_string()) && args.contains(&"--no-default-browser-check".to_string()));
    }
}
