//! Uninstalling: first a plan the page shows (what goes, what needs a password, what stays), then
//! doing exactly that plan.
//!
//! - apt packages: `apt-get remove` through `pkexec`, after an `apt-get -s` simulation. Anything
//!   that would take a required package or the desktop with it is refused; packages that came with
//!   the app and nothing else needs any more can go too (only those this removal frees, not other
//!   leftovers `apt autoremove` would also take).
//! - Flatpaks: `flatpak uninstall` (Flatpak asks for a password itself for system installs).
//! - Snaps: `pkexec snap remove`.
//! - Everything installed in the home folder (AppImages, unpacked folders, launchers) goes to the
//!   Trash, with its launchers, its icons and its autostart entries, so it can be put back.
//! - Settings, data and caches in the home folder are found by the app's names and only go (to the
//!   Trash) when ticked.
//!
//! Set `ZAZABOR_UNINSTALL_DRY_RUN=1` to see each step reported without anything being changed.

use super::scan::{self, DebInfo, Env, Found, Source};
use crate::fs::trash;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Packages a desktop can't do without; a removal that takes one of them is refused.
const CORE: [&str; 30] = [
    "apt", "dpkg", "sudo", "systemd", "systemd-sysv", "init", "udev", "dbus", "policykit-1", "polkitd", "pkexec", "network-manager",
    "gnome-shell", "gnome-session", "gdm3", "gnome-settings-daemon", "mutter", "pop-session", "pop-shell", "cosmic-session",
    "cosmic-comp", "plasma-workspace", "plasma-desktop", "sddm", "lightdm", "xorg", "xserver-xorg-core", "xwayland",
    "pipewire", "pulseaudio",
];

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Leftover {
    pub path: String,
    pub size: u64,
    /// "settings", "data", "cache" or "state".
    pub kind: &'static str,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub source: Option<Source>,
    /// Asks for an administrator's password.
    pub admin: bool,
    /// What happens, in order, as plain sentences.
    pub steps: Vec<String>,
    /// apt: other packages that go too because they need this one.
    pub dependents: Vec<String>,
    /// apt: packages that came with it that nothing else needs once it's gone.
    pub extras: Vec<String>,
    /// apt: its system-wide settings can go too (purge). Snap: skip the snapshot of its data.
    pub can_purge: bool,
    /// Files in the home folder that look like its settings, data and caches.
    pub leftovers: Vec<Leftover>,
    pub warnings: Vec<String>,
    /// Why it can't be uninstalled here.
    pub blocked: Option<String>,
    /// The confirm button: "Uninstall", "Remove Launcher", "Uninstall in Steam".
    pub action: String,
    /// Everything is moved to the Trash (so it can be put back).
    pub undoable: bool,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    #[serde(default)]
    pub purge: bool,
    #[serde(default)]
    pub extras: bool,
    #[serde(default)]
    pub leftovers: Vec<String>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub message: String,
    /// Where the moved items are in the Trash (for Undo).
    pub trashed: Vec<String>,
    /// Some of it couldn't be done (the app is gone; a leftover stayed).
    pub problems: Vec<String>,
}

pub fn dry_run() -> bool {
    std::env::var_os("ZAZABOR_UNINSTALL_DRY_RUN").is_some_and(|v| !v.is_empty() && v != "0")
}

/// "~/Applications/Postman" for paths in the home folder.
pub fn shown(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rel) if !rel.as_os_str().is_empty() => format!("~/{}", rel.display()),
        _ => path.display().to_string(),
    }
}

fn is_self(found: &Found) -> bool {
    let exe = std::env::current_exe().ok().and_then(|p| fs::canonicalize(p).ok());
    found.launchers.iter().any(|l| l.id == "zazabor.desktop")
        || found.program.as_ref().and_then(|p| fs::canonicalize(p).ok()).is_some_and(|p| Some(&p) == exe.as_ref())
}

// ---- files that belong to an app in the home folder ------------------------------------------------

/// The launchers, icons and autostart entries of the user's that go with an app.
pub fn own_files(found: &Found, env: &Env, others: &HashSet<String>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = found.launchers.iter().filter(|l| l.user).map(|l| l.path.clone()).collect();
    let data_home = env.dirs.data.first().cloned().unwrap_or_else(|| env.home.join(".local/share"));
    let icon_roots = [data_home.join("icons"), env.home.join(".icons"), data_home.join("pixmaps")];
    // Icons in the user's folders belong to apps installed there; a packaged app's are the system's.
    let home_app = matches!(found.source, Source::AppImage | Source::Folder | Source::File | Source::Web | Source::Launcher | Source::Missing);
    for l in found.launchers.iter().filter(|_| home_app) {
        let icon = l.icon.trim();
        if icon.is_empty() {
            continue;
        }
        if icon.starts_with('/') {
            let p = PathBuf::from(icon);
            if icon_roots.iter().any(|r| p.starts_with(r)) && p.is_file() && !found.install.iter().any(|i| p.starts_with(i)) {
                out.push(p);
            }
        } else if !others.contains(icon) && !icon.contains('/') {
            for root in &icon_roots {
                out.extend(icon_files(root, icon));
            }
        }
    }
    // Autostart entries named like a launcher, or starting its program.
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| env.home.join(".config"));
    if let Ok(dir) = fs::read_dir(config.join("autostart")) {
        let ids: HashSet<&str> = found.launchers.iter().map(|l| l.id.as_str()).collect();
        for item in dir.flatten() {
            let path = item.path();
            let name = item.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".desktop") {
                continue;
            }
            let starts_it = fs::read_to_string(&path)
                .ok()
                .and_then(|text| crate::fs::apps::parse_desktop(&text))
                .and_then(|keys| keys.get("Exec").map(|e| scan::split_exec(e)))
                .and_then(|exec| scan::program_of(&exec).and_then(|p| scan::find_program(p, &env.path)))
                .is_some_and(|p| found.install.iter().any(|i| p.starts_with(i)) || found.program.as_ref() == Some(&p));
            if ids.contains(name.as_str()) || starts_it {
                out.push(path);
            }
        }
    }
    out.sort();
    out.dedup();
    out.retain(|p| !found.install.iter().any(|i| p.starts_with(i) && p != i));
    out
}

/// `<root>/<theme>/<size>/apps/<name>.*` and `<root>/<name>.*`.
fn icon_files(root: &Path, name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let matches = |p: &Path| p.file_stem().is_some_and(|s| s == name) && p.extension().is_some_and(|e| matches!(e.to_str(), Some("png" | "svg" | "xpm")));
    if let Ok(dir) = fs::read_dir(root) {
        for item in dir.flatten() {
            let p = item.path();
            if p.is_file() && matches(&p) {
                out.push(p);
            }
        }
    }
    for entry in walkdir::WalkDir::new(root).min_depth(3).max_depth(4).into_iter().flatten() {
        if entry.file_type().is_file() && matches(entry.path()) && entry.path().parent().is_some_and(|d| d.ends_with("apps")) {
            out.push(entry.path().to_path_buf());
        }
    }
    out
}

/// Every icon name the other apps' launchers use, so a shared one stays.
pub fn icons_in_use(all: &[Found], except: &str) -> HashSet<String> {
    all.iter().filter(|f| f.key != except).flat_map(|f| f.launchers.iter().map(|l| l.icon.clone())).collect()
}

// ---- leftovers ----------------------------------------------------------------------------------------

/// Names a program's own folders are likely to have: its package or app id, launcher ids,
/// window class, program name and app name.
pub fn names_of(found: &Found) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let mut add = |n: &str| {
        let n = n.trim();
        if n.chars().count() >= 3 {
            names.insert(n.to_lowercase());
        }
    };
    if let Some(p) = &found.package {
        add(p);
        if found.source == Source::Flatpak {
            add(p.rsplit('.').next().unwrap_or_default());
        }
    }
    for l in &found.launchers {
        let stem = l.id.trim_end_matches(".desktop");
        add(stem);
        if stem.matches('.').count() >= 2 {
            add(stem.rsplit('.').next().unwrap_or_default());
        }
        if let Some(c) = &l.wm_class {
            add(c);
        }
        add(&l.name);
        add(&l.name.replace(' ', ""));
        add(&l.name.replace(' ', "-"));
    }
    if let Some(program) = &found.program {
        let mut name = program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if scan::is_appimage(program) {
            name = name.trim_end_matches(".AppImage").trim_end_matches(".appimage").to_string();
            // "RemoteMouse-x86_64", "Obsidian-1.5.3" → "RemoteMouse", "Obsidian".
            if let Some((base, _)) = name.split_once(['-', '_']) {
                add(base);
            }
        }
        add(&name);
    }
    for generic in [
        "applications", "icons", "flatpak", "trash", "fonts", "mime", "systemd", "autostart", "dconf", "keyrings", "gtk-2.0", "gtk-3.0",
        "gtk-4.0", "pulse", "pipewire", "environment.d", "bin", "lib", "share", "state", "cache", "config", "local", "zazabor", "app",
        "apps", "steam", "google", "gnome", "kde", "desktop", "settings", "web", "the", "chrome", "chromium", "mozilla", "java",
        "electron", "nvidia", "code", "user", "data", "default", "applications-development", "tools", "files", "terminal", "videos",
        "music", "photos", "pictures", "documents", "downloads", "calendar", "contacts", "maps", "weather", "clocks", "calculator",
        "camera", "screenshot", "help", "software", "store", "browser", "editor", "player", "mail", "notes", "games", "system",
        "monitor", "update", "updates", "logs", "tmp", "temp", "templates", "public", "texteditor", "text-editor", "disks", "fonts",
        "backups", "recent", "session", "sessions", "plugins", "extensions", "profiles", "themes", "sounds",
    ] {
        names.remove(generic);
    }
    names
}

/// Folders and files in the home folder named like the app: in ~/.config, ~/.local/share,
/// ~/.local/state, ~/.cache, as ~/.<name>, ~/.var/app/<flatpak id> and ~/snap/<snap>.
pub fn leftovers(found: &Found, env: &Env, others: &BTreeSet<String>, keep: &[PathBuf]) -> Vec<Leftover> {
    let names: BTreeSet<String> = names_of(found).difference(others).cloned().collect();
    let home = &env.home;
    let data_home = env.dirs.data.first().cloned().unwrap_or_else(|| home.join(".local/share"));
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".config"));
    let cache = std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".cache"));
    let state = std::env::var_os("XDG_STATE_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".local/state"));
    let mut out: Vec<Leftover> = Vec::new();
    let mut push = |path: PathBuf, kind: &'static str| {
        if keep.iter().any(|k| path.starts_with(k) || k.starts_with(&path)) || out.iter().any(|o| Path::new(&o.path) == path) {
            return;
        }
        out.push(Leftover { size: scan::disk_size(&path), path: path.to_string_lossy().into_owned(), kind });
    };
    for (dir, kind, dotted) in [(&config, "settings", false), (&data_home, "data", false), (&state, "state", false), (&cache, "cache", false), (home, "settings", true)] {
        let Ok(reader) = fs::read_dir(dir) else { continue };
        for item in reader.flatten() {
            let file = item.file_name().to_string_lossy().into_owned();
            let name = if dotted {
                match file.strip_prefix('.') {
                    Some(n) => n.to_string(),
                    None => continue,
                }
            } else {
                file.clone()
            };
            // "vlc", "vlcrc", "Postman", "discord" — the whole name, or the name of a lone settings file.
            let lower = name.to_lowercase();
            let stem = lower.trim_end_matches("rc").trim_end_matches(".conf").trim_end_matches(".json").trim_end_matches(".ini").to_string();
            if names.contains(&lower) || (lower != stem && item.path().is_file() && names.contains(&stem)) {
                push(item.path(), kind);
            }
        }
    }
    if found.source == Source::Flatpak {
        if let Some(id) = &found.package {
            let dir = home.join(".var/app").join(id);
            if dir.exists() {
                push(dir, "data");
            }
        }
    }
    if found.source == Source::Snap {
        if let Some(name) = &found.package {
            let dir = home.join("snap").join(name);
            if dir.exists() {
                push(dir, "data");
            }
        }
    }
    out.sort_by(|a, b| b.size.cmp(&a.size));
    out
}

// ---- apt --------------------------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq)]
pub struct AptSim {
    pub removed: Vec<String>,
    /// "no longer required" after it.
    pub orphans: Vec<String>,
    /// apt refused; its messages.
    pub error: Option<String>,
}

pub fn parse_apt_sim(out: &str, ok: bool) -> AptSim {
    let mut sim = AptSim::default();
    let mut in_orphans = false;
    let mut errors = Vec::new();
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("Remv ").or_else(|| line.strip_prefix("Purg ")) {
            if let Some(name) = rest.split_whitespace().next() {
                sim.removed.push(name.split(':').next().unwrap_or(name).to_string());
            }
            continue;
        }
        if line.starts_with("The following packages were automatically installed and are no longer required") {
            in_orphans = true;
            continue;
        }
        if in_orphans {
            if line.starts_with("  ") {
                sim.orphans.extend(line.split_whitespace().map(|n| n.split(':').next().unwrap_or(n).to_string()));
                continue;
            }
            in_orphans = false;
        }
        if line.starts_with("E: ") || line.trim_start().starts_with(|c: char| c.is_ascii_alphanumeric()) && line.contains(" : ") && line.contains("Depends") {
            errors.push(line.trim().trim_start_matches("E: ").to_string());
        }
    }
    if !ok || !errors.is_empty() {
        sim.error = Some(if errors.is_empty() { "apt couldn’t work out the removal.".into() } else { errors.join("\n") });
    }
    sim
}

fn apt_simulate(args: &[&str]) -> AptSim {
    let out = Command::new("apt-get").arg("-s").args(args).env("LANG", "C").env("LC_ALL", "C").stdin(Stdio::null()).output();
    match out {
        Ok(o) => {
            let text = format!("{}\n{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
            parse_apt_sim(&text, o.status.success())
        }
        Err(e) => AptSim { error: Some(format!("Couldn’t run apt-get: {e}")), ..Default::default() },
    }
}

fn protected(name: &str, info: Option<&DebInfo>) -> bool {
    CORE.contains(&name) || info.is_some_and(|i| i.essential || matches!(i.priority.as_str(), "required" | "important"))
}

fn valid_package(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '-' | '.'))
}

/// The packages removing `package` (and `extras`) takes, by name.
fn apt_removal(package: &str, extras: &[String]) -> AptSim {
    let mut args = vec!["remove", package];
    args.extend(extras.iter().map(String::as_str));
    apt_simulate(&args)
}

fn plan_deb(plan: &mut Plan, package: &str, debs: &std::collections::HashMap<String, DebInfo>) {
    plan.admin = true;
    plan.can_purge = true;
    let info = debs.get(package);
    if !valid_package(package) {
        plan.blocked = Some("That isn’t a package name apt knows.".into());
        return;
    }
    if protected(package, info) {
        plan.blocked = Some(format!("“{package}” is a required part of the system."));
        return;
    }
    if !scan::has_program("pkexec") {
        plan.blocked = Some("Removing a package needs your password, and pkexec (polkit) isn’t installed to ask for it.".into());
        return;
    }
    let sim = apt_removal(package, &[]);
    if let Some(error) = sim.error {
        plan.blocked = Some(format!("Other parts of the system need it, so apt won’t remove it on its own.\n{error}"));
        return;
    }
    let removed: Vec<String> = sim.removed.clone();
    let infos = scan::dpkg_info(&removed);
    if let Some(core) = removed.iter().find(|n| protected(n, infos.get(*n))) {
        plan.blocked = Some(format!("Removing it would also remove “{core}”, which the system needs."));
        return;
    }
    let before: HashSet<String> = apt_simulate(&["autoremove"]).removed.into_iter().collect();
    let gone: HashSet<&String> = removed.iter().collect();
    let extras: Vec<String> = sim.orphans.into_iter().filter(|o| !before.contains(o) && !gone.contains(o)).collect();
    let extra_info = scan::dpkg_info(&extras);
    plan.extras = extras.into_iter().filter(|e| !protected(e, extra_info.get(e))).collect();
    plan.dependents = removed.into_iter().filter(|n| n != package).collect();
    for meta in plan.dependents.iter().filter(|n| n.ends_with("-desktop") || infos.get(*n).is_some_and(|i| i.section.contains("metapackages"))) {
        plan.warnings.push(format!(
            "This also removes “{meta}”, a package that only keeps the system’s standard apps together. Your other apps stay, but apt may later offer to remove some that came with it."
        ));
    }
    let size = info.map(|i| i.size).unwrap_or(0);
    plan.steps.push(format!("Removes the apt package “{package}”{} for everyone on this computer.", if size > 0 { format!(" ({})", human(size)) } else { String::new() }));
    if !plan.dependents.is_empty() {
        plan.steps.push(format!("Also removes {} that need{} it: {}.", count(plan.dependents.len(), "package"), if plan.dependents.len() == 1 { "s" } else { "" }, plan.dependents.join(", ")));
    }
}

// ---- plans ------------------------------------------------------------------------------------------

fn human(bytes: u64) -> String {
    let b = bytes as f64;
    if b >= 1e9 {
        format!("{:.1} GB", b / 1e9)
    } else if b >= 1e6 {
        format!("{:.1} MB", b / 1e6)
    } else if b >= 1e3 {
        format!("{:.0} KB", b / 1e3)
    } else {
        format!("{bytes} bytes")
    }
}

fn count(n: usize, what: &str) -> String {
    format!("{n} {what}{}", if n == 1 { "" } else { "s" })
}

/// What uninstalling `id` would do.
pub fn plan(env: &Env, all: &scan::Scan, id: &str) -> Result<(Plan, Context), String> {
    let found = all.found.iter().find(|f| f.key == id).cloned().or_else(|| extra_found(all, id)).ok_or("That app isn’t installed any more.")?;
    let name = found.launchers.first().map(|_| found.main().name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| found.package.clone().unwrap_or_default());
    let mut plan = Plan { id: id.to_string(), name: name.clone(), source: Some(found.source), action: "Uninstall".into(), ..Default::default() };
    let others_icons = icons_in_use(&all.found, &found.key);
    let files = own_files(&found, env, &others_icons);
    let home = &env.home;

    if is_self(&found) {
        plan.blocked = Some("This is Zazabor. It can’t uninstall itself while it’s running.".into());
        return Ok((plan, Context { reference: flatpak_ref(all, &found), found, files }));
    }

    let launcher_count = found.launchers.iter().filter(|l| l.user).count();
    match found.source {
        Source::Deb => {
            let package = found.package.clone().unwrap_or_default();
            plan_deb(&mut plan, &package, &all.debs);
        }
        Source::Flatpak => {
            let app = found.package.clone().unwrap_or_default();
            let installation = found.installation.clone().unwrap_or_else(|| "user".into());
            plan.admin = installation != "user";
            if !scan::has_program("flatpak") {
                plan.blocked = Some("Flatpak isn’t installed, so it can’t remove this app.".into());
            }
            plan.steps.push(format!(
                "Uninstalls the Flatpak “{app}” {}.",
                if installation == "user" { "installed for you" } else { "installed for everyone on this computer" }
            ));
            plan.steps.push("Shared runtimes other apps may use stay installed.".into());
        }
        Source::Snap => {
            let name = found.package.clone().unwrap_or_default();
            plan.admin = true;
            plan.can_purge = true;
            if !scan::has_program("pkexec") {
                plan.blocked = Some("Removing a snap needs your password, and pkexec (polkit) isn’t installed to ask for it.".into());
            }
            plan.steps.push(format!("Removes the snap “{name}” for everyone on this computer."));
        }
        Source::AppImage | Source::Folder | Source::File => {
            plan.undoable = true;
            for path in &found.install {
                let what = match (found.source, path == &found.install[0]) {
                    (Source::AppImage, true) => "the AppImage",
                    (Source::Folder, true) => "its folder",
                    (_, true) => "the program",
                    _ => "the link to it",
                };
                plan.steps.push(format!("Moves {what} {} ({}) to the Trash.", shown(path, home), human(scan::disk_size(path))));
                if let Some(parent) = path.parent() {
                    if fs::metadata(parent).is_ok_and(|m| m.permissions().readonly()) || access_denied(parent) {
                        plan.blocked = Some(format!("You can’t change {}, so it can’t be moved to the Trash.", shown(parent, home)));
                    }
                }
            }
        }
        Source::Web => {
            plan.undoable = true;
            plan.action = "Remove Launcher".into();
            let browser = found.launchers.first().and_then(|l| scan::program_of(&l.exec)).map(browser_name).unwrap_or("the browser");
            plan.steps.push(format!("Removes the web app’s launcher from the applications menu. The web app itself stays in {browser}; uninstall it there (its menu, or chrome://apps) if you want it gone."));
        }
        Source::Steam => {
            plan.action = "Uninstall in Steam".into();
            plan.steps.push("Steam asks you to confirm and removes the game, its launcher too.".into());
            if !scan::has_program("steam") && !scan::has_program("xdg-open") {
                plan.blocked = Some("Steam isn’t installed to uninstall the game.".into());
            }
        }
        Source::Launcher => {
            plan.undoable = true;
            plan.action = "Remove Launcher".into();
            match &found.program {
                Some(p) => plan.steps.push(format!("Removes the launcher from the applications menu. {} stays: it wasn’t installed with it.", shown(p, home))),
                None => plan.steps.push("Removes the launcher from the applications menu. What it starts isn’t installed with it, so it stays.".into()),
            }
        }
        Source::Missing => {
            plan.undoable = true;
            plan.action = "Remove Launcher".into();
            let program = found.launchers.first().and_then(|l| scan::program_of(&l.exec)).unwrap_or("its program").to_string();
            plan.steps.push(format!("{program} isn’t there any more; this removes the launcher it left in the applications menu."));
        }
        Source::Manual => {
            let place = found.program.as_ref().map(|p| shown(p, home)).unwrap_or_else(|| "outside a package".into());
            plan.blocked = Some(format!("It was installed for everyone by hand ({place}), not from a package, so Zazabor can’t tell which files are its own. Remove it the way it was installed."));
        }
    }

    let extra_files: Vec<&PathBuf> = files.iter().filter(|p| !found.launchers.iter().any(|l| &l.path == *p)).collect();
    let user_launchers = launcher_count;
    if user_launchers > 0 && !matches!(found.source, Source::Web | Source::Launcher | Source::Missing | Source::Steam) {
        plan.steps.push(format!("Removes {} from the applications menu.", if user_launchers == 1 { "its launcher".to_string() } else { format!("its {user_launchers} launchers") }));
    } else if user_launchers > 1 && matches!(found.source, Source::Web | Source::Launcher | Source::Missing) {
        plan.steps.push(format!("Its other {} go too.", count(user_launchers - 1, "launcher")));
    }
    if !extra_files.is_empty() && found.source != Source::Steam {
        let icons = extra_files.iter().filter(|p| !p.to_string_lossy().contains("/autostart/")).count();
        let autostart = extra_files.len() - icons;
        if icons > 0 {
            plan.steps.push(format!("Moves {} to the Trash.", if icons == 1 { "its icon".to_string() } else { format!("its {icons} icons") }));
        }
        if autostart > 0 {
            plan.steps.push("Stops it starting when you log in.".into());
        }
    }

    if !matches!(found.source, Source::Web | Source::Launcher | Source::Missing | Source::Steam | Source::Manual) && plan.blocked.is_none() {
        let mut others: BTreeSet<String> = BTreeSet::new();
        for f in all.found.iter().filter(|f| f.key != found.key) {
            others.extend(names_of(f));
        }
        let mut keep = found.install.clone();
        keep.extend(files.iter().cloned());
        keep.push(env.home.join(".local/share/zazabor"));
        plan.leftovers = leftovers(&found, env, &others, &keep);
    }
    Ok((plan, Context { reference: flatpak_ref(all, &found), found, files }))
}

fn flatpak_ref(all: &scan::Scan, found: &Found) -> Option<String> {
    (found.source == Source::Flatpak)
        .then(|| all.flatpaks.iter().find(|f| Some(&f.id) == found.package.as_ref() && Some(&f.installation) == found.installation.as_ref()))
        .flatten()
        .map(|f| f.reference.clone())
        .filter(|r| r.split('/').count() == 3 && !r.starts_with('-'))
}

/// A Flatpak or Snap that has no launcher (a command-line one) is still listed.
fn extra_found(all: &scan::Scan, id: &str) -> Option<Found> {
    let blank = |source, package: &str, installation: Option<String>| Found {
        key: id.to_string(),
        source,
        launchers: Vec::new(),
        package: Some(package.to_string()),
        installation,
        install: Vec::new(),
        program: None,
    };
    if let Some(rest) = id.strip_prefix("flatpak:") {
        let (installation, app) = rest.split_once(':')?;
        all.flatpaks.iter().find(|f| f.id == app && f.installation == installation).map(|f| blank(Source::Flatpak, &f.id, Some(f.installation.clone())))
    } else if let Some(name) = id.strip_prefix("snap:") {
        all.snaps.iter().find(|s| s.name == name && !scan::is_system_snap(s)).map(|s| blank(Source::Snap, &s.name, None))
    } else {
        None
    }
}

fn browser_name(program: &str) -> &'static str {
    let p = program.to_lowercase();
    if p.contains("chromium") {
        "Chromium"
    } else if p.contains("brave") {
        "Brave"
    } else if p.contains("edge") {
        "Edge"
    } else if p.contains("vivaldi") {
        "Vivaldi"
    } else if p.contains("opera") {
        "Opera"
    } else {
        "Chrome"
    }
}

fn access_denied(dir: &Path) -> bool {
    let Ok(c) = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes()) else { return true };
    // SAFETY: `c` is a valid NUL-terminated path; access only reads it.
    unsafe { libc::access(c.as_ptr(), libc::W_OK) != 0 }
}

/// What a plan was made from, for doing it.
pub struct Context {
    pub found: Found,
    /// Flatpak: the app's ref ("org.gimp.GIMP/x86_64/stable"), so one branch is named exactly.
    pub reference: Option<String>,
    /// The user's launchers, icons and autostart entries that go with it.
    pub files: Vec<PathBuf>,
}

// ---- doing it -----------------------------------------------------------------------------------------

/// Runs a command, passing each line it prints to `report`; its last lines when it fails.
fn run(program: &str, args: &[String], report: &(dyn Fn(&str) + Sync)) -> Result<(), (i32, String)> {
    report(&format!("$ {program} {}", args.join(" ")));
    if dry_run() {
        report("(dry run: not run)");
        return Ok(());
    }
    let mut child = Command::new(program)
        .args(args)
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| (-1, format!("Couldn’t run {program}: {e}")))?;
    let tail = std::sync::Mutex::new(Vec::<String>::new());
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    std::thread::scope(|s| {
        let read = |stream: Box<dyn std::io::Read + Send>| {
            let tail = &tail;
            move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    let line = line.trim_end().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    report(&line);
                    let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
                    t.push(line);
                    if t.len() > 12 {
                        t.remove(0);
                    }
                }
            }
        };
        if let Some(out) = stdout {
            s.spawn(read(Box::new(out)));
        }
        if let Some(err) = stderr {
            s.spawn(read(Box::new(err)));
        }
    });
    let status = child.wait().map_err(|e| (-1, e.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        let lines = tail.into_inner().unwrap_or_else(|e| e.into_inner());
        Err((status.code().unwrap_or(-1), lines.join("\n")))
    }
}

/// pkexec's own exit codes: 126 when the password prompt was dismissed, 127 when not allowed.
fn admin_error(code: i32, tail: String) -> String {
    match code {
        126 => "Cancelled: the password wasn’t given.".into(),
        127 => "Not allowed: your account can’t make changes for everyone on this computer.".into(),
        _ => tail,
    }
}

fn trash_path(path: &Path, home_trash: &Path, home: &Path, report: &(dyn Fn(&str) + Sync), outcome: &mut Outcome) {
    if fs::symlink_metadata(path).is_err() {
        return;
    }
    if dry_run() {
        report(&format!("(dry run) Would move {} to the Trash", shown(path, home)));
        return;
    }
    match trash::trash_one(path, home_trash) {
        Ok(crate::fs::ops::UndoOp::Trashed { trashed, .. }) => {
            report(&format!("Moved {} to the Trash", shown(path, home)));
            outcome.trashed.push(trashed);
        }
        Ok(_) => {}
        Err(e) => outcome.problems.push(e),
    }
}

/// Uninstalls following `plan` (made just now from a fresh scan) with the page's choices.
pub fn uninstall(env: &Env, plan: &Plan, ctx: &Context, options: &Options, report: &(dyn Fn(&str) + Sync)) -> Result<Outcome, String> {
    if let Some(reason) = &plan.blocked {
        return Err(reason.clone());
    }
    let found = &ctx.found;
    let home = &env.home;
    let home_trash = env.trash.clone().ok_or("Can’t find your Trash folder.")?;
    let mut outcome = Outcome::default();
    // Only what the plan offered can be picked.
    let allowed: HashSet<&str> = plan.leftovers.iter().map(|l| l.path.as_str()).collect();
    let chosen: Vec<PathBuf> = options.leftovers.iter().filter(|p| allowed.contains(p.as_str())).map(PathBuf::from).collect();

    match found.source {
        Source::Deb => {
            let package = found.package.clone().unwrap_or_default();
            let extras: Vec<String> = if options.extras { plan.extras.clone() } else { Vec::new() };
            // Nothing may go that the plan didn't show.
            let sim = apt_removal(&package, &extras);
            if let Some(e) = sim.error {
                return Err(format!("apt won’t remove it now:\n{e}"));
            }
            let expected: BTreeSet<&str> = std::iter::once(package.as_str()).chain(plan.dependents.iter().map(String::as_str)).chain(extras.iter().map(String::as_str)).collect();
            let actual: BTreeSet<&str> = sim.removed.iter().map(String::as_str).collect();
            if !actual.is_subset(&expected) {
                return Err("The installed packages changed since this was worked out. Close this and try again.".into());
            }
            let mut args: Vec<String> = ["/usr/bin/env", "DEBIAN_FRONTEND=noninteractive", "LANG=C", "LC_ALL=C", "apt-get", "-y", "-q", "-o", "DPkg::Lock::Timeout=120"]
                .iter()
                .map(|s| s.to_string())
                .collect();
            args.push(if options.purge { "purge" } else { "remove" }.into());
            args.push(package.clone());
            args.extend(extras);
            report("Asking for your password…");
            run("pkexec", &args, report).map_err(|(code, tail)| admin_error(code, tail))?;
            outcome.message = format!("{} was uninstalled.", plan.name);
        }
        Source::Flatpak => {
            let app = found.package.clone().unwrap_or_default();
            let installation = found.installation.clone().unwrap_or_else(|| "user".into());
            let flag = match installation.as_str() {
                "user" => "--user".to_string(),
                "system" => "--system".to_string(),
                other => format!("--installation={other}"),
            };
            let target = ctx.reference.as_ref().map(|r| format!("app/{r}")).unwrap_or(app);
            let args = vec!["uninstall".into(), "-y".into(), "--noninteractive".into(), flag, target];
            run("flatpak", &args, report).map_err(|(_, tail)| if tail.is_empty() { "Flatpak couldn’t remove it.".to_string() } else { tail })?;
            outcome.message = format!("{} was uninstalled.", plan.name);
        }
        Source::Snap => {
            let name = found.package.clone().unwrap_or_default();
            if !valid_package(&name) {
                return Err("That isn’t a snap name.".into());
            }
            let mut args: Vec<String> = vec!["snap".into(), "remove".into()];
            if options.purge {
                args.push("--purge".into());
            }
            args.push(name);
            report("Asking for your password…");
            run("pkexec", &args, report).map_err(|(code, tail)| admin_error(code, tail))?;
            outcome.message = format!("{} was uninstalled.", plan.name);
        }
        Source::Steam => {
            let game = found.package.clone().unwrap_or_default();
            if !game.chars().all(|c| c.is_ascii_digit()) {
                return Err("That isn’t a Steam game.".into());
            }
            let url = format!("steam://uninstall/{game}");
            let (program, args) = if scan::has_program("steam") { ("steam", vec![url]) } else { ("xdg-open", vec![url]) };
            report(&format!("$ {program} {}", args.join(" ")));
            if !dry_run() {
                Command::new(program).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("Couldn’t open Steam: {e}"))?;
            }
            outcome.message = "Steam will ask you to confirm.".into();
            return Ok(outcome);
        }
        Source::AppImage | Source::Folder | Source::File => {
            for path in &found.install {
                trash_path(path, &home_trash, home, report, &mut outcome);
            }
            if !outcome.problems.is_empty() {
                return Err(outcome.problems.join("\n"));
            }
            outcome.message = format!("{} was moved to the Trash.", plan.name);
        }
        Source::Web | Source::Launcher | Source::Missing => {
            outcome.message = format!("{}’s launcher was removed.", plan.name);
        }
        Source::Manual => return Err("Zazabor can’t uninstall this.".into()),
    }

    // The app is gone; its launchers, icons and autostart entries follow, then the ticked leftovers.
    for path in ctx.files.iter().chain(chosen.iter()) {
        trash_path(path, &home_trash, home, report, &mut outcome);
    }
    if !dry_run() && scan::has_program("update-desktop-database") {
        if let Some(apps) = env.dirs.data.first().map(|d| d.join("applications")) {
            let _ = Command::new("update-desktop-database").arg("-q").arg(apps).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
    }
    if dry_run() {
        outcome.message = format!("Dry run: {} was left as it was.", plan.name);
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::programs::scan::Launcher;

    #[test]
    fn apt_simulations_parse() {
        let out = "Reading package lists...\nThe following packages were automatically installed and are no longer required:\n  vlc-bin vlc-data\n  vlc-plugin-base\nUse 'apt autoremove' to remove them.\nThe following packages will be REMOVED:\n  vlc\nRemv vlc [3.0.16-1build7]\nRemv libfoo:amd64 [1.0]\n";
        let sim = parse_apt_sim(out, true);
        assert_eq!(sim.removed, vec!["vlc", "libfoo"]);
        assert_eq!(sim.orphans, vec!["vlc-bin", "vlc-data", "vlc-plugin-base"]);
        assert!(sim.error.is_none());
        let refused = "The following packages have unmet dependencies:\n pop-desktop : PreDepends: pop-de-gnome but it is not going to be installed\nE: Error, pkgProblemResolver::Resolve generated breaks, this may be caused by held packages.\n";
        let sim = parse_apt_sim(refused, false);
        let error = sim.error.unwrap();
        assert!(error.contains("pop-desktop : PreDepends"), "{error}");
        assert!(error.contains("pkgProblemResolver"));
    }

    #[test]
    fn package_names_are_checked() {
        assert!(valid_package("vlc"));
        assert!(valid_package("libreoffice-writer"));
        assert!(valid_package("g++-12"));
        assert!(!valid_package("-y"));
        assert!(!valid_package("vlc; rm"));
        assert!(!valid_package("VLC"));
        assert!(protected("apt", None));
        assert!(protected("x", Some(&DebInfo { priority: "required".into(), ..Default::default() })));
        assert!(!protected("vlc", Some(&DebInfo { priority: "optional".into(), ..Default::default() })));
    }

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zazabor-remove-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    fn env_at(home: &Path) -> Env {
        Env {
            home: home.to_path_buf(),
            dirs: crate::fs::apps::Dirs { data: vec![home.join(".local/share")], config: vec![home.join(".config")], desktops: vec![] },
            path: vec![home.join(".local/bin")],
            trash: Some(home.join(".local/share/Trash")),
        }
    }

    fn appimage_app(home: &Path) -> Found {
        let apps = home.join(".local/share/applications");
        fs::create_dir_all(&apps).unwrap();
        fs::create_dir_all(home.join("Applications")).unwrap();
        let image = home.join("Applications/RemoteMouse-x86_64.AppImage");
        fs::write(&image, b"\x7fELF\x02\x01\x01\x00AI\x02").unwrap();
        fs::write(apps.join("remotemouse.desktop"), "[Desktop Entry]\nType=Application\nName=Remote Mouse\nExec=x\nIcon=remotemouse\n").unwrap();
        let icon = home.join(".local/share/icons/hicolor/256x256/apps/remotemouse.png");
        fs::create_dir_all(icon.parent().unwrap()).unwrap();
        fs::write(&icon, b"png").unwrap();
        fs::create_dir_all(home.join(".config/autostart")).unwrap();
        fs::write(home.join(".config/autostart/remotemouse.desktop"), "[Desktop Entry]\nType=Application\nExec=x\n").unwrap();
        fs::create_dir_all(home.join(".config/RemoteMouse")).unwrap();
        fs::write(home.join(".config/RemoteMouse/settings.json"), b"{}").unwrap();
        fs::create_dir_all(home.join(".config/unrelated")).unwrap();
        Found {
            key: format!("appimage:{}", image.display()),
            source: Source::AppImage,
            launchers: vec![Launcher {
                id: "remotemouse.desktop".into(),
                path: apps.join("remotemouse.desktop"),
                user: true,
                name: "Remote Mouse".into(),
                icon: "remotemouse".into(),
                visible: true,
                ..Default::default()
            }],
            package: None,
            installation: None,
            install: vec![image.clone()],
            program: Some(image),
        }
    }

    #[test]
    fn a_home_app_takes_its_launcher_icon_and_autostart_and_finds_its_settings() {
        let home = temp("appimage");
        let env = env_at(&home);
        let found = appimage_app(&home);
        let files = own_files(&found, &env, &HashSet::new());
        assert!(files.contains(&home.join(".local/share/applications/remotemouse.desktop")));
        assert!(files.contains(&home.join(".local/share/icons/hicolor/256x256/apps/remotemouse.png")));
        assert!(files.contains(&home.join(".config/autostart/remotemouse.desktop")));
        assert_eq!(files.len(), 3);
        // An icon another app uses stays.
        let shared = own_files(&found, &env, &HashSet::from(["remotemouse".to_string()]));
        assert_eq!(shared.len(), 2);

        let found_left = leftovers(&found, &env, &BTreeSet::new(), &found.install);
        let paths: Vec<&str> = found_left.iter().map(|l| l.path.as_str()).collect();
        assert_eq!(paths, vec![home.join(".config/RemoteMouse").to_string_lossy()]);
        // A name another app also answers to isn't offered.
        let others = BTreeSet::from(["remotemouse".to_string()]);
        assert!(leftovers(&found, &env, &others, &found.install).is_empty());
    }

    #[test]
    fn uninstalling_a_home_app_moves_everything_to_the_trash() {
        let home = temp("trash");
        let env = env_at(&home);
        let found = appimage_app(&home);
        let all = scan::Scan { found: vec![found.clone()], debs: Default::default(), flatpaks: vec![], snaps: vec![] };
        let (plan, ctx) = plan(&env, &all, &found.key).unwrap();
        assert!(plan.blocked.is_none(), "{:?}", plan.blocked);
        assert!(plan.undoable);
        assert_eq!(plan.leftovers.len(), 1);
        let options = Options { leftovers: vec![plan.leftovers[0].path.clone(), home.join(".config/unrelated").to_string_lossy().into_owned()], ..Default::default() };
        let lines = std::sync::Mutex::new(Vec::new());
        let outcome = uninstall(&env, &plan, &ctx, &options, &|l| lines.lock().unwrap().push(l.to_string())).unwrap();
        assert!(outcome.problems.is_empty(), "{:?}", outcome.problems);
        assert_eq!(outcome.trashed.len(), 5, "{:?}", outcome.trashed);
        assert!(!home.join("Applications/RemoteMouse-x86_64.AppImage").exists());
        assert!(!home.join(".config/RemoteMouse").exists());
        assert!(!home.join(".config/autostart/remotemouse.desktop").exists());
        // Not offered, so not touched.
        assert!(home.join(".config/unrelated").exists());
        assert!(home.join(".local/share/Trash/files/RemoteMouse-x86_64.AppImage").exists());
    }
}
