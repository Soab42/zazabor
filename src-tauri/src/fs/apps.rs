//! "Open With…" and "Open Terminal Here": finding the apps that handle a file type from the
//! XDG `.desktop` files and `mimeapps.list`, launching them, and starting a terminal in a folder.
//! Lookups take their search folders as a parameter so tests can use fixture trees.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// The desktop file id ("org.gnome.TextEditor.desktop").
    pub id: String,
    pub name: String,
    /// The icon as a `data:` URL (`fs_apps_for`) or an image path (lookups), when one was found.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub is_default: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppsFor {
    pub mime: String,
    pub apps: Vec<AppInfo>,
}

/// Where applications and their preferences live, highest priority first.
#[derive(Clone, Debug)]
pub struct Dirs {
    /// `$XDG_DATA_HOME` then `$XDG_DATA_DIRS`; applications are under `<dir>/applications`.
    pub data: Vec<PathBuf>,
    /// `$XDG_CONFIG_HOME` then `$XDG_CONFIG_DIRS`; holds `mimeapps.list`.
    pub config: Vec<PathBuf>,
    /// `$XDG_CURRENT_DESKTOP`, lowercased ("pop", "gnome"): their `<desktop>-mimeapps.list` files
    /// (where a desktop keeps its own defaults) come before `mimeapps.list` in each folder.
    pub desktops: Vec<String>,
}

fn env_dirs(var: &str, fallback: &str) -> Vec<PathBuf> {
    let value = std::env::var(var).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| fallback.to_string());
    value.split(':').filter(|s| !s.is_empty()).map(PathBuf::from).collect()
}

impl Dirs {
    pub fn from_env() -> Dirs {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let mut data = vec![std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".local/share"))];
        data.extend(env_dirs("XDG_DATA_DIRS", "/usr/local/share:/usr/share"));
        let mut config = vec![std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".config"))];
        config.extend(env_dirs("XDG_CONFIG_DIRS", "/etc/xdg"));
        let desktops = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().split(':').filter(|d| !d.is_empty()).map(str::to_lowercase).collect();
        Dirs { data, config, desktops }
    }
}

// ---- desktop files ------------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct Desktop {
    id: String,
    path: PathBuf,
    name: String,
    icon: String,
    mimes: Vec<String>,
    hidden: bool,
}

/// The `[Desktop Entry]` keys we use. Localised keys and other groups are ignored.
fn parse_desktop(text: &str) -> Option<HashMap<String, String>> {
    let mut keys = HashMap::new();
    let mut inside = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            inside = line == "[Desktop Entry]";
        } else if inside {
            if let Some((k, v)) = line.split_once('=') {
                keys.entry(k.trim().to_string()).or_insert_with(|| v.trim().to_string());
            }
        }
    }
    (keys.get("Type").map(String::as_str) == Some("Application")).then_some(keys)
}

fn collect_desktop_files(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(reader) = fs::read_dir(dir) else { return };
    for item in reader.flatten() {
        let path = item.path();
        if path.is_dir() {
            collect_desktop_files(root, &path, out);
        } else if path.extension() == Some(OsStr::new("desktop")) {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push((rel.to_string_lossy().replace('/', "-"), path));
            }
        }
    }
}

/// Every installed application, keyed by desktop file id; earlier folders shadow later ones.
fn installed(dirs: &Dirs) -> Vec<Desktop> {
    let mut seen = HashSet::new();
    let mut apps = Vec::new();
    for data in &dirs.data {
        let root = data.join("applications");
        let mut files = Vec::new();
        collect_desktop_files(&root, &root, &mut files);
        files.sort();
        for (id, path) in files {
            if !seen.insert(id.clone()) {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else { continue };
            let Some(keys) = parse_desktop(&text) else { continue };
            let flag = |k: &str| keys.get(k).is_some_and(|v| v == "true");
            apps.push(Desktop {
                id,
                path,
                name: keys.get("Name").cloned().unwrap_or_default(),
                icon: keys.get("Icon").cloned().unwrap_or_default(),
                mimes: keys.get("MimeType").map(|v| v.split(';').filter(|s| !s.is_empty()).map(str::to_string).collect()).unwrap_or_default(),
                hidden: flag("NoDisplay") || flag("Hidden"),
            });
        }
    }
    apps
}

// ---- mimeapps.list ------------------------------------------------------------------------------

#[derive(Default, Debug)]
struct Prefs {
    default: HashMap<String, Vec<String>>,
    added: HashMap<String, Vec<String>>,
    removed: HashMap<String, Vec<String>>,
}

/// The association files in priority order (the XDG MIME Applications spec): in each config folder,
/// then each `<data>/applications`, the desktop's own lists before `mimeapps.list`; last, the older
/// `defaults.list`, which GNOME still ships its defaults in.
fn prefs_files(dirs: &Dirs) -> Vec<PathBuf> {
    let folders = dirs.config.iter().cloned().chain(dirs.data.iter().map(|d| d.join("applications")));
    let mut files = Vec::new();
    for folder in folders {
        files.extend(dirs.desktops.iter().map(|d| folder.join(format!("{d}-mimeapps.list"))));
        files.push(folder.join("mimeapps.list"));
    }
    files.extend(dirs.data.iter().map(|d| d.join("applications/defaults.list")));
    files
}

fn read_prefs(dirs: &Dirs) -> Prefs {
    let mut prefs = Prefs::default();
    let files = prefs_files(dirs);
    for file in files {
        let Ok(text) = fs::read_to_string(&file) else { continue };
        let mut group = "";
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('[') {
                group = match line {
                    "[Default Applications]" => "default",
                    "[Added Associations]" => "added",
                    "[Removed Associations]" => "removed",
                    _ => "",
                };
            } else if let Some((mime, ids)) = line.split_once('=') {
                let target = match group {
                    "default" => &mut prefs.default,
                    "added" => &mut prefs.added,
                    "removed" => &mut prefs.removed,
                    _ => continue,
                };
                // Earlier (higher priority) files come first within a mime type.
                let list = target.entry(mime.trim().to_string()).or_default();
                for id in ids.split(';').map(str::trim).filter(|s| !s.is_empty()) {
                    if !list.iter().any(|x| x == id) {
                        list.push(id.to_string());
                    }
                }
            }
        }
    }
    prefs
}

/// `mime=a.desktop;b.desktop;` lines of every `mimeinfo.cache`.
fn read_cache(dirs: &Dirs, mime: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for data in &dirs.data {
        let Ok(text) = fs::read_to_string(data.join("applications/mimeinfo.cache")) else { continue };
        for line in text.lines() {
            if let Some((m, list)) = line.split_once('=') {
                if m == mime {
                    ids.extend(list.split(';').filter(|s| !s.is_empty()).map(str::to_string));
                }
            }
        }
    }
    ids
}

/// Types whose handlers are also fine for `mime` (everything textual opens in a text editor).
fn related_mimes(mime: &str) -> Vec<String> {
    let mut all = vec![mime.to_string()];
    let textual = mime.starts_with("text/")
        || mime.ends_with("+xml")
        || matches!(mime, "application/json" | "application/xml" | "application/x-shellscript" | "application/javascript" | "application/toml" | "application/x-yaml");
    if textual && mime != "text/plain" {
        all.push("text/plain".into());
    }
    all
}

/// The apps for a MIME type: the user's default first, then added and registered handlers.
pub fn apps_for_mime(dirs: &Dirs, mime: &str) -> Vec<AppInfo> {
    let apps = installed(dirs);
    let by_id: HashMap<&str, &Desktop> = apps.iter().map(|a| (a.id.as_str(), a)).collect();
    let prefs = read_prefs(dirs);
    let removed: HashSet<&str> = prefs.removed.get(mime).into_iter().flatten().map(String::as_str).collect();

    let mut order: Vec<String> = Vec::new();
    let mut push = |id: &str| {
        if !order.iter().any(|x| x == id) {
            order.push(id.to_string());
        }
    };
    for id in prefs.default.get(mime).into_iter().flatten() {
        push(id);
    }
    let first_default = prefs.default.get(mime).into_iter().flatten().find(|id| by_id.contains_key(id.as_str())).cloned();
    for kind in related_mimes(mime) {
        for id in prefs.added.get(&kind).into_iter().flatten() {
            push(id);
        }
        for id in read_cache(dirs, &kind) {
            push(&id);
        }
        for app in &apps {
            if app.mimes.iter().any(|m| *m == kind) {
                push(&app.id);
            }
        }
    }

    order
        .into_iter()
        .filter(|id| !removed.contains(id.as_str()) || first_default.as_deref() == Some(id))
        .filter_map(|id| {
            let app = by_id.get(id.as_str())?;
            let is_default = first_default.as_deref() == Some(id.as_str());
            if app.hidden && !is_default {
                return None;
            }
            Some(AppInfo {
                is_default,
                name: if app.name.is_empty() { id.trim_end_matches(".desktop").to_string() } else { app.name.clone() },
                icon: resolve_icon(dirs, &app.icon),
                id,
            })
        })
        .collect()
}

/// The `.desktop` file with this id.
pub fn find_desktop(dirs: &Dirs, id: &str) -> Option<PathBuf> {
    installed(dirs).into_iter().find(|a| a.id == id).map(|a| a.path)
}

// ---- icons --------------------------------------------------------------------------------------

/// A themed icon name to an image file: absolute paths as they are, otherwise the first match in
/// the usual theme folders (largest raster sizes first, then scalable), then `pixmaps`.
fn resolve_icon(dirs: &Dirs, name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    if name.starts_with('/') {
        return Path::new(name).is_file().then(|| name.to_string());
    }
    const THEMES: [&str; 5] = ["hicolor", "Yaru", "Adwaita", "gnome", "breeze"];
    const SIZES: [&str; 8] = ["128x128", "64x64", "96x96", "48x48", "256x256", "scalable", "32x32", "512x512"];
    let mut roots: Vec<PathBuf> = dirs.data.iter().map(|d| d.join("icons")).collect();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join(".icons"));
    }
    for root in &roots {
        for theme in THEMES {
            for size in SIZES {
                for ext in ["png", "svg"] {
                    let path = root.join(theme).join(size).join("apps").join(format!("{name}.{ext}"));
                    if path.is_file() {
                        return Some(path.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    for data in &dirs.data {
        for ext in ["png", "svg"] {
            let path = data.join("pixmaps").join(format!("{name}.{ext}"));
            if path.is_file() {
                return Some(path.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// An icon file as a `data:` URL, so the page can show it without a file protocol. Too-large or
/// unreadable files and unknown types give `None`.
pub fn icon_data_url(path: &str) -> Option<String> {
    let mime = match Path::new(path).extension()?.to_str()? {
        "png" => "image/png",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    let bytes = fs::read(path).ok().filter(|b| b.len() <= 300 * 1024)?;
    Some(format!("data:{mime};base64,{}", base64(&bytes)))
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

// ---- MIME type of a file --------------------------------------------------------------------------

/// The MIME type a file name suggests; folders are `inode/directory`. Unknown names fall back to
/// asking `xdg-mime` (content sniffing), then `application/octet-stream`.
pub fn mime_of(path: &Path) -> String {
    if path.is_dir() {
        return "inode/directory".into();
    }
    if let Some(guess) = mime_guess::from_path(path).first() {
        return guess.essence_str().to_string();
    }
    let sniffed = Command::new("xdg-mime").args(["query", "filetype"]).arg(path).stderr(Stdio::null()).output().ok();
    sniffed
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|m| m.contains('/'))
        .unwrap_or_else(|| "application/octet-stream".into())
}

// ---- launching ----------------------------------------------------------------------------------

/// Starts a command without waiting for it; a helper thread reaps it when it ends.
fn spawn_detached(mut command: Command) -> Result<(), String> {
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Opens `path` with the app whose desktop file id is `app_id`.
pub fn open_with(dirs: &Dirs, path: &Path, app_id: &str) -> Result<(), String> {
    if app_id.contains('/') || !app_id.ends_with(".desktop") {
        return Err("That isn’t an application.".into());
    }
    let desktop = find_desktop(dirs, app_id).ok_or("That application isn’t installed any more.")?;
    let mut gio = Command::new("gio");
    gio.arg("launch").arg(&desktop).arg(path);
    spawn_detached(gio).or_else(|_| {
        let mut gtk = Command::new("gtk-launch");
        gtk.arg(app_id).arg(path);
        spawn_detached(gtk).map_err(|_| "Couldn’t start the application (gio and gtk-launch are missing).".to_string())
    })
}

/// Makes `app_id` the default handler of `mime` (`xdg-mime default`, which edits `mimeapps.list`).
pub fn set_default(mime: &str, app_id: &str) -> Result<(), String> {
    if !mime.contains('/') || mime.contains(char::is_whitespace) || !app_id.ends_with(".desktop") || app_id.contains('/') {
        return Err("That isn’t a valid file type or application.".into());
    }
    let out = Command::new("xdg-mime")
        .args(["default", app_id, mime])
        .output()
        .map_err(|e| format!("Couldn’t run xdg-mime: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("Couldn’t change the default app: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

// ---- terminal -----------------------------------------------------------------------------------

const TERMINALS: [&str; 8] = ["x-terminal-emulator", "gnome-terminal", "kgx", "konsole", "xfce4-terminal", "alacritty", "kitty", "xterm"];

fn on_path(program: &str) -> bool {
    if program.contains('/') {
        return Path::new(program).is_file();
    }
    std::env::var_os("PATH").is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
}

/// The command that opens a terminal in `dir`: the chosen one, else the first installed.
pub fn terminal_command(dir: &Path, chosen: Option<&str>, exists: &dyn Fn(&str) -> bool) -> Option<(String, Vec<String>)> {
    let (program, mut args): (String, Vec<String>) = match chosen.map(str::trim).filter(|c| !c.is_empty()) {
        Some(custom) => {
            let mut parts = custom.split_whitespace().map(str::to_string);
            let program = parts.next()?;
            if !exists(&program) {
                return None;
            }
            (program, parts.collect())
        }
        None => (TERMINALS.iter().find(|t| exists(t))?.to_string(), Vec::new()),
    };
    let flag = Path::new(&program).file_name().and_then(|n| n.to_str()).unwrap_or(&program);
    let dir_arg = dir.to_string_lossy();
    match flag {
        "gnome-terminal" | "kgx" | "xfce4-terminal" => args.push(format!("--working-directory={dir_arg}")),
        "konsole" => args.extend(["--workdir".to_string(), dir_arg.into_owned()]),
        _ => {}
    }
    Some((program, args))
}

/// Opens a terminal in `dir`.
pub fn open_terminal(dir: &Path, chosen: Option<&str>) -> Result<(), String> {
    if !dir.is_dir() {
        return Err("That isn’t a folder.".into());
    }
    let (program, args) = terminal_command(dir, chosen, &on_path).ok_or_else(|| match chosen.map(str::trim).filter(|c| !c.is_empty()) {
        Some(custom) => format!("Couldn’t find the terminal “{custom}”. Change it in Settings."),
        None => "Couldn’t find a terminal app to open.".to_string(),
    })?;
    let mut command = Command::new(program);
    command.args(args).current_dir(dir);
    spawn_detached(command).map_err(|e| format!("Couldn’t open the terminal: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zazabor-apps-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn desktop(dir: &Path, file: &str, body: &str) {
        let path = dir.join("applications").join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("[Desktop Entry]\nType=Application\n{body}\n")).unwrap();
    }

    /// user data + system data + config, like a real session.
    fn fixture(tag: &str) -> (PathBuf, Dirs) {
        let root = temp(tag);
        let (user, sys, cfg) = (root.join("user"), root.join("sys"), root.join("cfg"));
        fs::create_dir_all(&cfg).unwrap();
        desktop(&sys, "editor.desktop", "Name=Text Editor\nIcon=editor\nMimeType=text/plain;text/markdown;");
        desktop(&sys, "viewer.desktop", "Name=Doc Viewer\nMimeType=application/pdf;");
        desktop(&sys, "reader.desktop", "Name=Reader\nMimeType=application/pdf;");
        desktop(&sys, "hidden.desktop", "Name=Hidden Helper\nNoDisplay=true\nMimeType=application/pdf;");
        desktop(&sys, "org.kde/nested.desktop", "Name=Nested\nMimeType=application/pdf;");
        // The user's copy shadows the system one.
        desktop(&user, "reader.desktop", "Name=My Reader\nMimeType=application/pdf;");
        fs::create_dir_all(sys.join("icons/hicolor/48x48/apps")).unwrap();
        fs::write(sys.join("icons/hicolor/48x48/apps/editor.png"), "png").unwrap();
        (root, Dirs { data: vec![user, sys], config: vec![cfg], desktops: vec![] })
    }

    fn names(apps: &[AppInfo]) -> Vec<&str> {
        apps.iter().map(|a| a.name.as_str()).collect()
    }

    #[test]
    fn lists_handlers_with_shadowing_and_hidden_apps_removed() {
        let (root, dirs) = fixture("list");
        let apps = apps_for_mime(&dirs, "application/pdf");
        assert_eq!(names(&apps), vec!["My Reader", "Nested", "Doc Viewer"]);
        assert!(apps.iter().all(|a| !a.is_default));
        assert_eq!(apps[1].id, "org.kde-nested.desktop");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn default_comes_first_and_is_marked() {
        let (root, dirs) = fixture("default");
        fs::write(dirs.config[0].join("mimeapps.list"), "[Default Applications]\napplication/pdf=gone.desktop;viewer.desktop;\n").unwrap();
        let apps = apps_for_mime(&dirs, "application/pdf");
        assert_eq!(apps[0].id, "viewer.desktop");
        assert!(apps[0].is_default);
        assert_eq!(apps.iter().filter(|a| a.is_default).count(), 1);
        assert_eq!(apps.len(), 3);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn added_and_removed_associations_apply() {
        let (root, dirs) = fixture("assoc");
        fs::write(
            dirs.config[0].join("mimeapps.list"),
            "[Added Associations]\napplication/pdf=editor.desktop;\n[Removed Associations]\napplication/pdf=viewer.desktop;\n",
        )
        .unwrap();
        let apps = apps_for_mime(&dirs, "application/pdf");
        assert!(apps.iter().any(|a| a.id == "editor.desktop"));
        assert!(!apps.iter().any(|a| a.id == "viewer.desktop"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mimeinfo_cache_and_text_inheritance() {
        let (root, dirs) = fixture("cache");
        fs::write(dirs.data[1].join("applications/mimeinfo.cache"), "[MIME Cache]\ntext/x-python=viewer.desktop;\n").unwrap();
        let apps = apps_for_mime(&dirs, "text/x-python");
        assert_eq!(names(&apps), vec!["Doc Viewer", "Text Editor"], "cache entries, then text/plain handlers");
        assert!(apps_for_mime(&dirs, "image/png").is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn icons_resolve_from_theme_folders() {
        let (root, dirs) = fixture("icon");
        let apps = apps_for_mime(&dirs, "text/plain");
        assert!(apps[0].icon.as_deref().unwrap().ends_with("icons/hicolor/48x48/apps/editor.png"));
        assert_eq!(resolve_icon(&dirs, "nothing-here"), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn finds_desktop_files_by_id() {
        let (root, dirs) = fixture("find");
        assert!(find_desktop(&dirs, "reader.desktop").unwrap().starts_with(&dirs.data[0]));
        assert!(find_desktop(&dirs, "org.kde-nested.desktop").is_some());
        assert!(find_desktop(&dirs, "missing.desktop").is_none());
        assert!(open_with(&dirs, Path::new("/tmp/x"), "../evil.desktop").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn icons_become_data_urls() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
        let (root, dirs) = fixture("dataurl");
        let apps = apps_for_mime(&dirs, "text/plain");
        let url = icon_data_url(apps[0].icon.as_deref().unwrap()).unwrap();
        assert_eq!(url, "data:image/png;base64,cG5n");
        assert_eq!(icon_data_url("/nonexistent/x.png"), None);
        assert_eq!(icon_data_url("/nonexistent/x.xpm"), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mime_comes_from_the_extension() {
        assert_eq!(mime_of(Path::new("/nonexistent/a.pdf")), "application/pdf");
        assert_eq!(mime_of(Path::new("/nonexistent/b.PNG")), "image/png");
        assert_eq!(mime_of(&std::env::temp_dir()), "inode/directory");
    }

    #[test]
    fn terminal_picks_the_first_installed_one() {
        let have = |names: &'static [&'static str]| move |p: &str| names.contains(&p);
        let dir = Path::new("/home/me/work");
        let (program, args) = terminal_command(dir, None, &have(&["kitty", "konsole", "xterm"])).unwrap();
        assert_eq!((program.as_str(), args), ("konsole", vec!["--workdir".to_string(), "/home/me/work".to_string()]));
        let (program, args) = terminal_command(dir, None, &have(&["x-terminal-emulator", "gnome-terminal"])).unwrap();
        assert_eq!((program.as_str(), args.len()), ("x-terminal-emulator", 0));
        let (_, args) = terminal_command(dir, None, &have(&["gnome-terminal"])).unwrap();
        assert_eq!(args, vec!["--working-directory=/home/me/work"]);
        assert!(terminal_command(dir, None, &have(&[])).is_none());
    }

    #[test]
    fn a_configured_terminal_wins_and_must_exist() {
        let dir = Path::new("/d");
        let have = |p: &str| p == "foot" || p == "xterm";
        assert_eq!(terminal_command(dir, Some("foot"), &have).unwrap().0, "foot");
        let (program, args) = terminal_command(dir, Some("foot --server"), &have).unwrap();
        assert_eq!((program.as_str(), args), ("foot", vec!["--server".to_string()]));
        assert!(terminal_command(dir, Some("missing"), &have).is_none());
        assert_eq!(terminal_command(dir, Some("  "), &have).unwrap().0, "xterm");
    }
}
