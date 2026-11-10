//! Finding what is installed: every launcher in the applications menu, grouped into the app it
//! belongs to and where that app came from (an apt package, a Flatpak, a Snap, an AppImage, a
//! folder in the home folder, a web app, a Steam game, or a launcher whose program is gone).
//!
//! `classify` is pure: it takes the launchers and what dpkg says owns which file, so tests can feed
//! it fixture trees. `scan` gathers those facts from the system and adds versions, sizes and dates.

use crate::fs::apps::{self, Dirs};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// An apt (dpkg) package.
    Deb,
    Flatpak,
    Snap,
    /// One AppImage file.
    AppImage,
    /// An app unpacked into its own folder in the home folder (a .tar.gz install).
    Folder,
    /// One program file in the home folder (`~/.local/bin/tool`).
    File,
    /// A browser's installed web app (Chrome's "Install page as app").
    Web,
    /// A Steam game (Steam uninstalls it).
    Steam,
    /// A launcher the user made for a program that came from somewhere else.
    Launcher,
    /// A launcher whose program isn't there any more.
    Missing,
    /// Installed for everyone outside any package (`/opt`, `/usr/local`): not removable here.
    Manual,
}

/// One `.desktop` file.
#[derive(Clone, Debug, Default)]
pub struct Launcher {
    /// The desktop file id ("org.gnome.TextEditor.desktop").
    pub id: String,
    pub path: PathBuf,
    /// In the user's own applications folder (`$XDG_DATA_HOME/applications`).
    pub user: bool,
    pub name: String,
    pub comment: String,
    pub icon: String,
    /// `Exec` split into arguments, field codes (`%U`) dropped.
    pub exec: Vec<String>,
    pub try_exec: Option<String>,
    /// Shown in the applications menu (not `NoDisplay` or `Hidden`).
    pub visible: bool,
    /// `X-Flatpak`: the Flatpak app id.
    pub flatpak: Option<String>,
    /// `X-SnapInstanceName`.
    pub snap: Option<String>,
    pub wm_class: Option<String>,
    /// `X-AppImage-Version`.
    pub version: Option<String>,
}

/// Every launcher, grouped by desktop file id; within a group, highest priority (the user's own
/// copy) first, as the menu resolves them.
pub fn read_launchers(dirs: &Dirs) -> Vec<Vec<Launcher>> {
    let mut groups: BTreeMap<String, Vec<Launcher>> = BTreeMap::new();
    for (i, data) in dirs.data.iter().enumerate() {
        let root = data.join("applications");
        let mut files = Vec::new();
        apps::collect_desktop_files(&root, &root, &mut files);
        files.sort();
        for (id, path) in files {
            let Ok(text) = fs::read_to_string(&path) else { continue };
            let Some(keys) = apps::parse_desktop(&text) else { continue };
            let flag = |k: &str| keys.get(k).is_some_and(|v| v == "true");
            let get = |k: &str| keys.get(k).map(|v| unescape(v)).filter(|v| !v.is_empty());
            groups.entry(id.clone()).or_default().push(Launcher {
                id,
                user: i == 0,
                name: get("Name").unwrap_or_default(),
                comment: get("Comment").or_else(|| get("GenericName")).unwrap_or_default(),
                icon: get("Icon").unwrap_or_default(),
                exec: keys.get("Exec").map(|v| split_exec(v)).unwrap_or_default(),
                try_exec: get("TryExec"),
                visible: !flag("NoDisplay") && !flag("Hidden"),
                flatpak: get("X-Flatpak"),
                snap: get("X-SnapInstanceName"),
                wm_class: get("StartupWMClass"),
                version: get("X-AppImage-Version"),
                path,
            });
        }
    }
    groups.into_values().collect()
}

/// The string escapes of a desktop file value (`\s`, `\n`, `\t`, `\r`, `\\`).
fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// An `Exec` value as arguments: double quotes group, a backslash takes the next character as it
/// is, field codes (`%f`, `%U`…) are dropped and `%%` is a percent sign.
pub fn split_exec(value: &str) -> Vec<String> {
    let value = value.replace("\\\\", "\\");
    let mut args = Vec::new();
    let mut current = String::new();
    let (mut quoted, mut started) = (false, false);
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
                started = true;
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    args.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            c => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        args.push(current);
    }
    args.into_iter()
        .filter(|a| !(a.len() == 2 && a.starts_with('%') && a != "%%"))
        .map(|a| a.replace("%%", "%"))
        .collect()
}

/// The program a launcher starts: `Exec`'s first word after `env` and its `VAR=value`s. Shell
/// one-liners (`sh -c …`) say nothing, and neither do Flatpak's own `flatpak run` lines.
pub fn program_of(exec: &[String]) -> Option<&str> {
    let mut args = exec.iter().map(String::as_str);
    let mut first = args.next()?;
    if Path::new(first).file_name().is_some_and(|n| n == "env") {
        first = args.find(|a| !a.contains('=') && !a.starts_with('-'))?;
    }
    let name = Path::new(first).file_name()?.to_str()?;
    if matches!(name, "sh" | "bash" | "dash" | "zsh") {
        return None;
    }
    Some(first)
}

/// `program` as a file: as it is when absolute, else the first executable of that name on `path`.
pub fn find_program(program: &str, path: &[PathBuf]) -> Option<PathBuf> {
    if program.starts_with('/') {
        return Some(PathBuf::from(program));
    }
    if program.contains('/') {
        return None;
    }
    path.iter().map(|dir| dir.join(program)).find(|p| fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

/// True for an AppImage: its name, or the `AI\x02` mark AppImages carry at byte 8.
pub fn is_appimage(path: &Path) -> bool {
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("appimage")) {
        return true;
    }
    let mut head = [0u8; 11];
    use std::io::Read;
    fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && head[..4] == *b"\x7fELF" && head[8..11] == *b"AI\x02"
}

// ---- grouping launchers into apps ---------------------------------------------------------------

/// What the system knows that `classify` needs.
pub struct World<'a> {
    pub home: &'a Path,
    /// `$PATH`, for launchers that name a bare program.
    pub path: &'a [PathBuf],
    /// File → the dpkg package that owns it.
    pub owners: &'a HashMap<PathBuf, String>,
}

/// An app before its details are added.
#[derive(Debug, Clone)]
pub struct Found {
    /// The app's key: "deb:vlc", "flatpak:user:org.gimp.GIMP", "appimage:/home/me/Apps/x.AppImage"…
    pub key: String,
    pub source: Source,
    /// Every desktop file that belongs to it (each copy), main one first.
    pub launchers: Vec<Launcher>,
    /// The package, Flatpak app id, Snap name or Steam game id.
    pub package: Option<String>,
    /// Flatpak: "user" or "system".
    pub installation: Option<String>,
    /// What a home install is: the AppImage, the folder or the file (plus a symlink to it on PATH).
    pub install: Vec<PathBuf>,
    /// The program, when one was found.
    pub program: Option<PathBuf>,
}

impl Found {
    /// The launcher that names the app: one that's shown, named like the app, with the plainest command.
    pub fn main(&self) -> &Launcher {
        let stem = |l: &Launcher| l.id.trim_end_matches(".desktop").to_lowercase();
        let named = |l: &Launcher| self.package.as_deref().is_some_and(|p| stem(l) == p.to_lowercase() || stem(l).ends_with(&format!(".{}", p.to_lowercase())));
        self.launchers
            .iter()
            .min_by_key(|l| (!l.visible, !named(l), l.exec.len(), l.name.len()))
            .expect("an app has a launcher")
    }
}

/// Folders whose direct children are installs: an app unpacked into `~/Applications/Postman` is
/// the folder `Postman`; a program in `~/.local/bin` is just that file.
fn containers(home: &Path) -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = [
        "", "Applications", "applications", "Apps", "apps", "AppImages", "opt", ".opt", "Programs", "programs", "Software", "software",
        "tools", "Tools", "bin", ".bin", ".local", ".local/opt", ".local/share", ".local/lib", ".local/bin", ".local/apps",
        "Downloads", "Desktop", "Documents",
    ]
    .iter()
    .map(|p| home.join(p))
    .collect();
    list.dedup();
    list
}

/// Folders that are never an app's own folder, even when a program sits right inside them.
fn never_an_install(path: &Path, home: &Path) -> bool {
    if path == home || containers(home).iter().any(|c| c == path) {
        return true;
    }
    let Ok(rel) = path.strip_prefix(home) else { return true };
    let mut parts = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned());
    let first = parts.next().unwrap_or_default();
    let second = parts.next();
    // A hidden folder right in the home folder belongs to a tool chain (~/.cargo, ~/.nvm), not one app.
    if first.starts_with('.') && first != ".local" && first != ".opt" && second.is_none() {
        return true;
    }
    const OWNED: [&str; 12] = [
        ".local/share/applications", ".local/share/icons", ".local/share/flatpak", ".local/share/Trash", ".local/share/fonts",
        ".local/share/mime", ".local/share/zazabor", ".config", ".cache", ".var", ".ssh", ".gnupg",
    ];
    OWNED.iter().any(|o| rel.starts_with(o)) || path.join(".git").exists()
}

/// What a program in the home folder was installed as: the file itself when it sits in a
/// container, else its highest folder below one. `None` when that can't be told safely.
pub fn install_of(program: &Path, home: &Path) -> Option<PathBuf> {
    let containers = containers(home);
    let mut candidate = program.to_path_buf();
    for ancestor in program.ancestors() {
        let Some(parent) = ancestor.parent() else { return None };
        if !parent.starts_with(home) {
            return None;
        }
        if containers.iter().any(|c| c == parent) {
            candidate = ancestor.to_path_buf();
            break;
        }
    }
    if candidate == program {
        // The program file itself: fine anywhere below a container, as long as it isn't a folder.
        return (program.is_file() && program.parent().is_some_and(|p| containers.iter().any(|c| c == p))).then_some(candidate);
    }
    // An app's folder holds its program a few levels down (Postman/app/Postman, zed.app/bin/zed);
    // deeper, the folder is more likely a workspace or a tool's store (JetBrains Toolbox) than one app.
    let depth = program.strip_prefix(&candidate).map(|r| r.components().count()).unwrap_or(usize::MAX);
    if depth > 3 {
        return None;
    }
    // A source checkout anywhere on the way is someone's project, not an install.
    if program.ancestors().skip(1).take_while(|a| a.starts_with(&candidate)).any(|a| a.join(".git").exists()) {
        return None;
    }
    (!never_an_install(&candidate, home)).then_some(candidate)
}

/// Browsers whose web-app launchers say `--app-id=`.
fn is_browser(program: &str) -> bool {
    let name = Path::new(program).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    ["chrome", "chromium", "brave", "edge", "vivaldi", "opera"].iter().any(|b| name.contains(b))
}

/// The paths dpkg should be asked about: every launcher outside the user's folder, and every
/// program outside the home folder that a launcher of the user's names.
pub fn paths_to_ask(groups: &[Vec<Launcher>], world: &World) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for group in groups {
        for l in group {
            if !l.user {
                out.push(l.path.clone());
            } else if let Some(p) = program_of(&l.exec).and_then(|p| find_program(p, world.path)) {
                if !p.starts_with(world.home) {
                    out.extend(program_variants(&p));
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// A program as dpkg may have recorded it: as found, resolved through links, and with or without
/// `/usr` (merged-/usr systems link `/bin` to `/usr/bin`).
fn program_variants(path: &Path) -> Vec<PathBuf> {
    let mut list = vec![path.to_path_buf()];
    if let Ok(real) = fs::canonicalize(path) {
        list.push(real);
    }
    for p in list.clone() {
        if let Ok(rest) = p.strip_prefix("/usr") {
            if rest.starts_with("bin") || rest.starts_with("sbin") || rest.starts_with("lib") {
                list.push(Path::new("/").join(rest));
            }
        } else if p.starts_with("/bin") || p.starts_with("/sbin") {
            list.push(Path::new("/usr").join(p.strip_prefix("/").unwrap_or(&p)));
        }
    }
    list.dedup();
    list
}

fn owner_of(path: &Path, world: &World) -> Option<String> {
    program_variants(path).iter().find_map(|p| world.owners.get(p).cloned())
}

/// Sorts launchers into apps.
pub fn classify(groups: Vec<Vec<Launcher>>, world: &World) -> Vec<Found> {
    let mut found: BTreeMap<String, Found> = BTreeMap::new();
    let mut add = |key: String, source: Source, launchers: Vec<Launcher>, extra: Found| {
        let entry = found.entry(key.clone()).or_insert(Found { key, source, launchers: Vec::new(), ..extra });
        entry.launchers.extend(launchers);
    };
    let blank = |source: Source| Found { key: String::new(), source, launchers: Vec::new(), package: None, installation: None, install: Vec::new(), program: None };

    // A user's launcher that starts a program in the home folder is an install of its own, even
    // when it shares its id with a packaged app's (Zed's tarball and its Flatpak are both
    // dev.zed.Zed); otherwise a user's copy is an edited or hidden copy of the packaged one.
    let in_home = |l: &Launcher| program_of(&l.exec).and_then(|p| find_program(p, world.path)).is_some_and(|p| p.starts_with(world.home));
    let groups: Vec<Vec<Launcher>> = groups
        .into_iter()
        .flat_map(|group| {
            if group.iter().all(|l| l.user) || !group.iter().any(|l| l.user && in_home(l)) {
                return vec![group];
            }
            let (own, packaged): (Vec<Launcher>, Vec<Launcher>) = group.into_iter().partition(|l| l.user && in_home(l));
            vec![own, packaged]
        })
        .filter(|g| !g.is_empty())
        .collect();

    for group in groups {
        // Where the app came from is told by its copy outside the user's folder, when it has one.
        let origin = group.iter().find(|l| !l.user).unwrap_or(&group[0]).clone();
        let origin_path = origin.path.to_string_lossy().into_owned();

        if origin_path.contains("/flatpak/exports/share/applications/") {
            let app = origin.flatpak.clone().unwrap_or_else(|| origin.id.trim_end_matches(".desktop").to_string());
            let installation = if origin.path.starts_with(world.home) { "user" } else { "system" };
            add(format!("flatpak:{installation}:{app}"), Source::Flatpak, group, Found { package: Some(app), installation: Some(installation.into()), ..blank(Source::Flatpak) });
            continue;
        }
        if origin_path.starts_with("/var/lib/snapd/desktop/applications/") {
            let name = origin.snap.clone().unwrap_or_else(|| origin.id.split('_').next().unwrap_or_default().to_string());
            add(format!("snap:{name}"), Source::Snap, group, Found { package: Some(name), ..blank(Source::Snap) });
            continue;
        }
        if !origin.user {
            let program = program_of(&origin.exec).and_then(|p| find_program(p, world.path));
            let package = world.owners.get(&origin.path).cloned().or_else(|| program.as_deref().and_then(|p| owner_of(p, world)));
            match package {
                Some(pkg) => add(format!("deb:{pkg}"), Source::Deb, group, Found { package: Some(pkg), program, ..blank(Source::Deb) }),
                None => add(format!("manual:{}", origin.id), Source::Manual, group, Found { program, ..blank(Source::Manual) }),
            }
            continue;
        }

        // Only the user's own launcher: what it starts tells.
        let exec = &origin.exec;
        if let Some(game) = exec.iter().find_map(|a| a.strip_prefix("steam://rungameid/")) {
            let game = game.trim_end_matches('/').to_string();
            if !game.is_empty() && game.chars().all(|c| c.is_ascii_digit()) {
                add(format!("steam:{game}"), Source::Steam, group, Found { package: Some(game), ..blank(Source::Steam) });
                continue;
            }
        }
        let program_name = program_of(exec).or(origin.try_exec.as_deref());
        if program_name.is_some_and(is_browser) && exec.iter().any(|a| a.starts_with("--app-id=")) {
            add(format!("web:{}", origin.id), Source::Web, group, blank(Source::Web));
            continue;
        }
        let Some(name) = program_name else {
            add(format!("launcher:{}", origin.id), Source::Launcher, group, blank(Source::Launcher));
            continue;
        };
        let Some(program) = find_program(name, world.path).filter(|p| p.exists()) else {
            add(format!("missing:{}", origin.id), Source::Missing, group, blank(Source::Missing));
            continue;
        };
        if !program.starts_with(world.home) {
            match owner_of(&program, world) {
                Some(pkg) => add(format!("deb:{pkg}"), Source::Deb, group, Found { package: Some(pkg), program: Some(program), ..blank(Source::Deb) }),
                None => add(format!("launcher:{}", origin.id), Source::Launcher, group, Found { program: Some(program), ..blank(Source::Launcher) }),
            }
            continue;
        }
        // A program in the home folder; through a link (~/.local/bin/tool → ~/.local/share/tool/…)
        // the link goes too.
        let real = fs::canonicalize(&program).unwrap_or_else(|_| program.clone());
        let mut install = Vec::new();
        if real != program && real.starts_with(world.home) {
            install.push(program.clone());
        }
        let (source, target) = if is_appimage(&real) {
            (Source::AppImage, Some(real.clone()))
        } else {
            match install_of(&real, world.home) {
                Some(dir) if dir.is_dir() => (Source::Folder, Some(dir)),
                Some(file) => (Source::File, Some(file)),
                None => (Source::Launcher, None),
            }
        };
        let Some(target) = target else {
            add(format!("launcher:{}", origin.id), Source::Launcher, group, Found { program: Some(program), ..blank(Source::Launcher) });
            continue;
        };
        install.insert(0, target.clone());
        let key = format!("{}:{}", serde_json::to_value(source).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(), target.display());
        add(key, source, group, Found { install, program: Some(real), ..blank(source) });
    }

    // One install can have several launchers (a tool's "Widget" and "Screensaver" entries).
    let mut list: Vec<Found> = found.into_values().collect();
    // A folder that also holds another app's program is shared: only its launchers are the app's.
    let programs: Vec<(String, PathBuf)> = list.iter().filter_map(|f| Some((f.key.clone(), f.program.clone()?))).collect();
    for f in &mut list {
        if f.source != Source::Folder {
            continue;
        }
        let dir = f.install[0].clone();
        if programs.iter().any(|(key, p)| *key != f.key && p.starts_with(&dir)) {
            f.source = Source::Launcher;
            f.install.clear();
            f.key = format!("launcher:{}", f.main().id);
        }
    }
    for f in &mut list {
        f.launchers.sort_by(|a, b| a.path.cmp(&b.path));
        f.launchers.dedup_by(|a, b| a.path == b.path);
        let main = f.main().path.clone();
        f.launchers.sort_by_key(|l| l.path != main);
        f.install.dedup();
    }
    // Apps that show in the menu, and launchers the user can see.
    list.retain(|f| f.launchers.iter().any(|l| l.visible));
    list
}

// ---- asking the system ----------------------------------------------------------------------------

/// Runs a query with the C locale; its standard output, whatever the exit status.
fn query(program: &str, args: &[&str]) -> Option<String> {
    Command::new(program)
        .args(args)
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
}

pub fn has_program(name: &str) -> bool {
    let path: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    find_program(name, &path).is_some()
}

/// What dpkg says owns each path (`dpkg-query -S`, one call for all of them).
pub fn dpkg_owners(paths: &[PathBuf]) -> HashMap<PathBuf, String> {
    let mut owners = HashMap::new();
    // Patterns are globs to dpkg; paths with glob characters are skipped rather than mismatched.
    let args: Vec<String> = paths
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|p| !p.contains(['*', '?', '[', ']', '\\']))
        .collect();
    for chunk in args.chunks(400) {
        let mut all = vec!["-S"];
        all.extend(chunk.iter().map(String::as_str));
        let Some(out) = query("dpkg-query", &all) else { return owners };
        owners.extend(parse_dpkg_owners(&out));
    }
    owners
}

/// `pkg: /path` and `pkg1, pkg2: /path` lines; diversions are left out.
pub fn parse_dpkg_owners(out: &str) -> HashMap<PathBuf, String> {
    let mut owners = HashMap::new();
    for line in out.lines() {
        if line.starts_with("diversion ") {
            continue;
        }
        let Some((pkgs, path)) = line.split_once(": /") else { continue };
        let first = pkgs.split(',').next().unwrap_or_default().trim();
        let package = first.split(':').next().unwrap_or_default();
        if !package.is_empty() {
            owners.insert(PathBuf::from(format!("/{path}")), package.to_string());
        }
    }
    owners
}

#[derive(Debug, Clone, Default)]
pub struct DebInfo {
    pub version: String,
    /// Bytes (dpkg records KiB).
    pub size: u64,
    pub maintainer: String,
    pub priority: String,
    pub essential: bool,
    pub section: String,
    pub arch: String,
}

pub fn dpkg_info(packages: &[String]) -> HashMap<String, DebInfo> {
    let mut info = HashMap::new();
    for chunk in packages.chunks(400) {
        let mut args = vec!["-W", "-f=${Package}\t${Version}\t${Installed-Size}\t${Maintainer}\t${Priority}\t${Essential}\t${Section}\t${Architecture}\n"];
        args.extend(chunk.iter().map(String::as_str));
        let Some(out) = query("dpkg-query", &args) else { return info };
        for line in out.lines() {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() < 8 {
                continue;
            }
            info.insert(f[0].to_string(), DebInfo {
                version: f[1].to_string(),
                size: f[2].trim().parse::<u64>().unwrap_or(0) * 1024,
                maintainer: plain_name(f[3]),
                priority: f[4].to_string(),
                essential: f[5] == "yes",
                section: f[6].to_string(),
                arch: f[7].to_string(),
            });
        }
    }
    info
}

/// "Ubuntu Developers <x@y>" → "Ubuntu Developers".
fn plain_name(maintainer: &str) -> String {
    maintainer.split('<').next().unwrap_or_default().trim().trim_matches('"').to_string()
}

/// When dpkg last unpacked a package: its file list's time.
pub fn deb_date(package: &str, arch: &str) -> Option<f64> {
    let info = Path::new("/var/lib/dpkg/info");
    [format!("{package}.list"), format!("{package}:{arch}.list")].iter().find_map(|name| modified_ms(&info.join(name)))
}

pub fn modified_ms(path: &Path) -> Option<f64> {
    let time = fs::metadata(path).ok()?.modified().ok()?;
    Some(time.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as f64)
}

#[derive(Debug, Clone, Default)]
pub struct FlatpakInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub branch: String,
    pub origin: String,
    pub installation: String,
    pub size: Option<u64>,
    /// "org.gimp.GIMP/x86_64/stable".
    pub reference: String,
}

pub fn flatpak_list() -> Vec<FlatpakInfo> {
    if !has_program("flatpak") {
        return Vec::new();
    }
    let out = query("flatpak", &["list", "--app", "--columns=application,name,version,branch,origin,installation,size,ref"]).unwrap_or_default();
    parse_flatpak_list(&out)
}

pub fn parse_flatpak_list(out: &str) -> Vec<FlatpakInfo> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\t').collect();
            (f.len() >= 8 && !f[0].is_empty()).then(|| FlatpakInfo {
                id: f[0].to_string(),
                name: f[1].to_string(),
                version: f[2].to_string(),
                branch: f[3].to_string(),
                origin: f[4].to_string(),
                installation: f[5].to_string(),
                size: parse_size(f[6]),
                reference: f[7].to_string(),
            })
        })
        .collect()
}

/// GLib's sizes ("576.8 MB", "959.5 kB", "12 bytes", SI units) in bytes.
pub fn parse_size(text: &str) -> Option<u64> {
    // The separator is a no-break space, or "?" under the C locale.
    let text = text.trim();
    let split = text.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == ',')).unwrap_or(text.len());
    let (number, rest) = text.split_at(split);
    let unit: String = rest.chars().skip_while(|c| !c.is_ascii_alphabetic()).collect();
    let value: f64 = number.replace(',', ".").parse().ok()?;
    let scale = match if unit.is_empty() { "bytes" } else { unit.trim() } {
        "bytes" | "byte" | "B" => 1.0,
        "kB" | "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((value * scale) as u64)
}

/// Where a Flatpak installation keeps its apps.
pub fn flatpak_base(installation: &str, home: &Path) -> PathBuf {
    if installation == "user" {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".local/share")).join("flatpak")
    } else {
        PathBuf::from("/var/lib/flatpak")
    }
}

#[derive(Debug, Clone, Default)]
pub struct SnapInfo {
    pub name: String,
    pub version: String,
    pub revision: String,
    pub publisher: String,
    pub notes: String,
}

pub fn snap_list() -> Vec<SnapInfo> {
    if !has_program("snap") {
        return Vec::new();
    }
    parse_snap_list(&query("snap", &["list", "--unicode=never", "--color=never"]).unwrap_or_default())
}

/// `snap list`'s table: Name Version Rev Tracking Publisher Notes.
pub fn parse_snap_list(out: &str) -> Vec<SnapInfo> {
    out.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            (f.len() >= 5).then(|| SnapInfo {
                name: f[0].to_string(),
                version: f[1].to_string(),
                revision: f[2].to_string(),
                publisher: f[4].trim_end_matches('*').trim_end_matches('✓').to_string(),
                notes: f.get(5).unwrap_or(&"-").to_string(),
            })
        })
        .collect()
}

/// A snap that is part of the system (a base, the kernel, snapd itself) rather than an app.
pub fn is_system_snap(snap: &SnapInfo) -> bool {
    snap.notes.split(',').any(|n| matches!(n, "base" | "core" | "snapd" | "kernel" | "gadget")) || snap.name == "snapd" || snap.name.starts_with("core")
}

/// The size of a file or everything in a folder (links not followed).
pub fn disk_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else { return 0 };
    if !meta.is_dir() {
        return meta.len();
    }
    walkdir::WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| !m.is_dir())
        .map(|m| m.len())
        .sum()
}

/// The places to look in, from the environment.
pub struct Env {
    pub home: PathBuf,
    pub dirs: Dirs,
    pub path: Vec<PathBuf>,
    /// The home Trash, where removed files go.
    pub trash: Option<PathBuf>,
}

impl Env {
    pub fn from_env() -> Env {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let path = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        Env { home, dirs: Dirs::from_env(), path, trash: crate::fs::trash::home_trash() }
    }
}

/// Everything found: the apps and what the system said about them.
pub struct Scan {
    pub found: Vec<Found>,
    pub debs: HashMap<String, DebInfo>,
    pub flatpaks: Vec<FlatpakInfo>,
    pub snaps: Vec<SnapInfo>,
}

pub fn scan(env: &Env) -> Scan {
    let groups = read_launchers(&env.dirs);
    let no_owners = HashMap::new();
    let probe = World { home: &env.home, path: &env.path, owners: &no_owners };
    let owners = if has_program("dpkg-query") { dpkg_owners(&paths_to_ask(&groups, &probe)) } else { HashMap::new() };
    let world = World { home: &env.home, path: &env.path, owners: &owners };
    let found = classify(groups, &world);
    let packages: Vec<String> = found.iter().filter(|f| f.source == Source::Deb).filter_map(|f| f.package.clone()).collect::<HashSet<_>>().into_iter().collect();
    let debs = if packages.is_empty() { HashMap::new() } else { dpkg_info(&packages) };
    let (flatpaks, snaps) = std::thread::scope(|s| {
        let f = s.spawn(flatpak_list);
        let n = s.spawn(snap_list);
        (f.join().unwrap_or_default(), n.join().unwrap_or_default())
    });
    Scan { found, debs, flatpaks, snaps }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zazabor-programs-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    fn launcher(id: &str, path: &Path, user: bool, exec: &str) -> Launcher {
        Launcher { id: id.into(), path: path.to_path_buf(), user, name: id.trim_end_matches(".desktop").into(), exec: split_exec(exec), visible: true, ..Default::default() }
    }

    fn exe(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"#!/bin/sh\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn exec_lines_split_like_the_spec() {
        assert_eq!(split_exec(r#""/home/me/Applications/Antigravity IDE/antigravity-ide" %F"#), vec!["/home/me/Applications/Antigravity IDE/antigravity-ide"]);
        assert_eq!(split_exec("env GDK_BACKEND=x11 /opt/app/run --flag %U"), vec!["env", "GDK_BACKEND=x11", "/opt/app/run", "--flag"]);
        assert_eq!(split_exec(r#"sh -c "echo \"hi\" 100%%""#), vec!["sh", "-c", "echo \"hi\" 100%"]);
        assert_eq!(program_of(&split_exec("env A=1 B=2 tool --x")), Some("tool"));
        assert_eq!(program_of(&split_exec("sh -c 'x'")), None);
        assert_eq!(unescape(r"a\sb\\c"), "a b\\c");
    }

    #[test]
    fn dpkg_and_flatpak_and_snap_output_parse() {
        let owners = parse_dpkg_owners("vlc: /usr/share/applications/vlc.desktop\nlibfoo:amd64, libbar: /usr/bin/foo\ndiversion by x from: /usr/bin/y\n");
        assert_eq!(owners.get(Path::new("/usr/share/applications/vlc.desktop")).map(String::as_str), Some("vlc"));
        assert_eq!(owners.get(Path::new("/usr/bin/foo")).map(String::as_str), Some("libfoo"));
        assert_eq!(owners.len(), 2);
        let flatpaks = parse_flatpak_list("com.discordapp.Discord\tDiscord\t1.0.164\tstable\tflathub\tuser\t617.6\u{a0}MB\tcom.discordapp.Discord/x86_64/stable\n");
        assert_eq!(flatpaks[0].size, Some(617_600_000));
        assert_eq!(flatpaks[0].reference, "com.discordapp.Discord/x86_64/stable");
        assert_eq!(parse_size("959.5 kB"), Some(959_500));
        assert_eq!(parse_size("576.8?MB"), Some(576_800_000));
        assert_eq!(parse_size("12 bytes"), Some(12));
        let snaps = parse_snap_list("Name  Version  Rev  Tracking  Publisher  Notes\ncore22  20240111  1122  latest/stable  canonical**  base\nspotify  1.2  80  latest/stable  spotify**  -\n");
        assert_eq!(snaps.len(), 2);
        assert!(is_system_snap(&snaps[0]));
        assert!(!is_system_snap(&snaps[1]));
        assert_eq!(snaps[1].publisher, "spotify");
    }

    #[test]
    fn home_installs_are_told_apart() {
        let root = temp("installs");
        let home = root.join("home");
        let apps = home.join(".local/share/applications");
        // An AppImage, an unpacked folder, a lone program with two launchers, a web app, a Steam
        // game, a launcher whose program is gone and one for a system program nobody owns.
        exe(&home.join("Applications/Tool.AppImage"));
        exe(&home.join("Applications/Postman/Postman"));
        exe(&home.join("android-studio/bin/studio.sh"));
        exe(&home.join(".local/bin/tachyon"));
        exe(&home.join(".cargo/bin/rusty"));
        let sys = root.join("usr/bin");
        exe(&sys.join("steam"));
        exe(&sys.join("vlc"));
        let path = vec![home.join(".local/bin"), sys.clone()];
        let groups = vec![
            vec![launcher("tool.desktop", &apps.join("tool.desktop"), true, &format!("{}/Applications/Tool.AppImage %U", home.display()))],
            vec![launcher("postman.desktop", &apps.join("postman.desktop"), true, &format!("{}/Applications/Postman/Postman", home.display()))],
            vec![launcher("studio.desktop", &apps.join("studio.desktop"), true, &format!("{}/android-studio/bin/studio.sh", home.display()))],
            vec![launcher("tachyon.desktop", &apps.join("tachyon.desktop"), true, "tachyon")],
            vec![launcher("tachyon-widget.desktop", &apps.join("tachyon-widget.desktop"), true, "tachyon widget")],
            vec![launcher("rusty.desktop", &apps.join("rusty.desktop"), true, &format!("{}/.cargo/bin/rusty", home.display()))],
            vec![launcher("chrome-abc-Default.desktop", &apps.join("chrome-abc-Default.desktop"), true, "/opt/google/chrome/google-chrome --profile-directory=Default --app-id=abc")],
            vec![launcher("game.desktop", &apps.join("game.desktop"), true, "steam steam://rungameid/570")],
            vec![launcher("gone.desktop", &apps.join("gone.desktop"), true, "/usr/games/nothing-here")],
            vec![launcher("mine.desktop", &apps.join("mine.desktop"), true, &format!("{}/steam", sys.display()))],
            // The user's copy of a packaged launcher goes with the package.
            vec![
                launcher("vlc.desktop", &apps.join("vlc.desktop"), true, "vlc --started-from-file %U"),
                launcher("vlc.desktop", Path::new("/usr/share/applications/vlc.desktop"), false, "/usr/bin/vlc --started-from-file %U"),
            ],
        ];
        exe(&home.join(".local/zed.app/bin/zed"));
        let mut tarball = launcher("dev.zed.Zed.desktop", &apps.join("dev.zed.Zed.desktop"), true, &format!("{}/.local/zed.app/bin/zed %U", home.display()));
        tarball.name = "Zed".into();
        let flatpak_dir = root.join("flatpak/exports/share/applications");
        let mut flatpak = launcher("dev.zed.Zed.desktop", &flatpak_dir.join("dev.zed.Zed.desktop"), false, "/usr/bin/flatpak run dev.zed.Zed");
        flatpak.flatpak = Some("dev.zed.Zed".into());
        let mut groups = groups;
        groups.push(vec![tarball, flatpak]);
        let owners = HashMap::from([(PathBuf::from("/usr/share/applications/vlc.desktop"), "vlc".to_string())]);
        let world = World { home: &home, path: &path, owners: &owners };
        let found = classify(groups, &world);
        let by_key: HashMap<&str, &Found> = found.iter().map(|f| (f.key.as_str(), f)).collect();
        let key = |source: &str, p: &str| format!("{source}:{}", home.join(p).display());

        assert_eq!(by_key[key("appimage", "Applications/Tool.AppImage").as_str()].source, Source::AppImage);
        assert_eq!(by_key[key("folder", "Applications/Postman").as_str()].install, vec![home.join("Applications/Postman")]);
        assert!(by_key.contains_key(key("folder", "android-studio").as_str()));
        let tachyon = by_key[key("file", ".local/bin/tachyon").as_str()];
        assert_eq!(tachyon.launchers.len(), 2);
        assert_eq!(tachyon.main().id, "tachyon.desktop");
        // ~/.cargo is a tool chain's folder, never removed as one app.
        assert!(by_key.contains_key("launcher:rusty.desktop"));
        assert!(by_key.contains_key("web:chrome-abc-Default.desktop"));
        assert_eq!(by_key["steam:570"].package.as_deref(), Some("570"));
        assert!(by_key.contains_key("missing:gone.desktop"));
        assert!(by_key.contains_key("launcher:mine.desktop"));
        assert_eq!(by_key["deb:vlc"].launchers.len(), 2);
        assert!(by_key.contains_key(key("folder", ".local/zed.app").as_str()));
        assert!(by_key.contains_key("flatpak:system:dev.zed.Zed"));
        assert_eq!(found.len(), 12);
    }

    #[test]
    fn installs_stop_below_containers_and_skip_shared_folders() {
        let home = temp("install-of");
        exe(&home.join("Applications/Postman/app/Postman"));
        exe(&home.join(".local/zed.app/bin/zed"));
        exe(&home.join("Documents/project/run.sh"));
        fs::create_dir_all(home.join("code/thing/.git")).unwrap();
        exe(&home.join("code/thing/bin/x"));
        exe(&home.join(".nvm/bin/node"));
        assert_eq!(install_of(&home.join("Applications/Postman/app/Postman"), &home), Some(home.join("Applications/Postman")));
        assert_eq!(install_of(&home.join(".local/zed.app/bin/zed"), &home), Some(home.join(".local/zed.app")));
        assert_eq!(install_of(&home.join("Documents/project/run.sh"), &home), Some(home.join("Documents/project")));
        assert_eq!(install_of(&home.join("code/thing/bin/x"), &home), None, "a git checkout isn't an install");
        assert_eq!(install_of(&home.join(".nvm/bin/node"), &home), None, "a hidden tool-chain folder isn't an install");
        assert_eq!(install_of(Path::new("/usr/bin/vlc"), &home), None);
    }
}
