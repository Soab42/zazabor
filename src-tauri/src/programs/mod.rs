//! The Apps section: every installed app in one list, like Windows' "Installed apps", and
//! uninstalling one the way it was installed (see `scan` for finding them and `remove` for removing).

mod remove;
mod scan;

use crate::fs::apps;
use remove::{Options, Outcome, Plan};
use scan::{Env, Found, Source};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    /// Stable between scans: "deb:vlc", "flatpak:user:org.gimp.GIMP", "appimage:/home/…".
    pub id: String,
    pub name: String,
    pub summary: String,
    /// A `data:` URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub source: Source,
    /// Flatpak: "user" or "system".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installation: Option<String>,
    /// The package, Flatpak id or Snap name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    /// Bytes on disk, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// When it was installed or last updated, ms since the epoch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<f64>,
    /// Its file or folder, for Show in Files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// The launcher that starts it (a desktop file id), when its program is there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launcher: Option<String>,
    /// The names of its other launchers ("TACHYON Widget").
    pub launchers: Vec<String>,
    /// Zazabor itself.
    pub is_self: bool,
}

const ICON_SIZES: [&str; 8] = ["64x64", "48x48", "96x96", "128x128", "scalable", "256x256", "32x32", "512x512"];

fn icon_for(env: &Env, names: &[&str]) -> Option<String> {
    names.iter().filter(|n| !n.is_empty()).find_map(|n| apps::resolve_icon_sized(&env.dirs, n, &ICON_SIZES).and_then(|p| apps::icon_data_url(&p)))
}

fn program_of(env: &Env, all: &scan::Scan, f: &Found) -> Program {
    let main = f.main();
    let mut p = Program {
        id: f.key.clone(),
        name: if main.name.is_empty() { main.id.trim_end_matches(".desktop").to_string() } else { main.name.clone() },
        summary: main.comment.clone(),
        icon: icon_for(env, &[&main.icon]),
        source: f.source,
        installation: f.installation.clone(),
        package: f.package.clone(),
        version: main.version.clone(),
        publisher: None,
        size: None,
        installed: None,
        location: None,
        launcher: (f.source != Source::Missing).then(|| main.id.clone()),
        launchers: f.launchers.iter().filter(|l| l.visible && l.path != main.path).map(|l| l.name.clone()).filter(|n| *n != main.name).collect(),
        is_self: f.launchers.iter().any(|l| l.id == "zazabor.desktop"),
    };
    p.launchers.sort();
    p.launchers.dedup();
    match f.source {
        Source::Deb => {
            if let Some(info) = f.package.as_ref().and_then(|pkg| all.debs.get(pkg)) {
                p.version = Some(info.version.clone());
                p.size = Some(info.size).filter(|s| *s > 0);
                p.publisher = Some(info.maintainer.clone()).filter(|m| !m.is_empty());
                p.installed = f.package.as_deref().and_then(|pkg| scan::deb_date(pkg, &info.arch));
            }
        }
        Source::Flatpak => {
            let installation = f.installation.as_deref().unwrap_or("user");
            if let Some(info) = all.flatpaks.iter().find(|x| Some(&x.id) == f.package.as_ref() && x.installation == installation) {
                fill_flatpak(&mut p, info, &env.home);
            }
        }
        Source::Snap => {
            if let Some(info) = all.snaps.iter().find(|s| Some(&s.name) == f.package.as_ref()) {
                fill_snap(&mut p, info);
            }
        }
        Source::AppImage | Source::Folder | Source::File => {
            let target = &f.install[0];
            p.size = Some(scan::disk_size(target));
            p.installed = scan::modified_ms(target);
            p.location = Some(target.to_string_lossy().into_owned());
        }
        Source::Web => {
            p.publisher = Some("Web app".into());
            p.installed = scan::modified_ms(&main.path);
        }
        Source::Steam => {
            p.publisher = Some("Steam".into());
            p.installed = scan::modified_ms(&main.path);
        }
        Source::Launcher | Source::Missing | Source::Manual => {
            p.installed = scan::modified_ms(&main.path);
            p.location = f.program.as_ref().and_then(|x| x.parent()).map(|x| x.to_string_lossy().into_owned());
        }
    }
    p
}

fn fill_flatpak(p: &mut Program, info: &scan::FlatpakInfo, home: &Path) {
    p.version = Some(info.version.clone()).filter(|v| !v.is_empty());
    p.size = info.size;
    p.publisher = Some(match info.origin.as_str() {
        "flathub" => "Flathub".to_string(),
        other => other.to_string(),
    });
    let mut parts = info.reference.split('/');
    let (_, arch, branch) = (parts.next(), parts.next().unwrap_or("x86_64"), parts.next().unwrap_or(&info.branch));
    let dir = scan::flatpak_base(&info.installation, home).join("app").join(&info.id);
    p.installed = scan::modified_ms(&dir.join(arch).join(branch).join("active"));
    p.location = Some(dir.to_string_lossy().into_owned());
}

fn fill_snap(p: &mut Program, info: &scan::SnapInfo) {
    p.version = Some(info.version.clone());
    p.publisher = Some(info.publisher.clone());
    let file = PathBuf::from(format!("/var/lib/snapd/snaps/{}_{}.snap", info.name, info.revision));
    p.size = std::fs::metadata(&file).ok().map(|m| m.len());
    p.installed = scan::modified_ms(&file);
}

/// Every app, plus Flatpaks and Snaps without a launcher.
fn list(env: &Env) -> Vec<Program> {
    let all = scan::scan(env);
    let mut programs: Vec<Program> = all.found.iter().map(|f| program_of(env, &all, f)).collect();
    for info in &all.flatpaks {
        let id = format!("flatpak:{}:{}", info.installation, info.id);
        if programs.iter().any(|p| p.id == id) {
            continue;
        }
        let mut p = bare(id, &info.name, Source::Flatpak);
        p.package = Some(info.id.clone());
        p.installation = Some(info.installation.clone());
        p.icon = icon_for(env, &[&info.id]);
        fill_flatpak(&mut p, info, &env.home);
        programs.push(p);
    }
    for info in all.snaps.iter().filter(|s| !scan::is_system_snap(s)) {
        let id = format!("snap:{}", info.name);
        if programs.iter().any(|p| p.id == id) {
            continue;
        }
        let mut p = bare(id, &info.name, Source::Snap);
        p.package = Some(info.name.clone());
        fill_snap(&mut p, info);
        programs.push(p);
    }
    programs.sort_by_key(|p| p.name.to_lowercase());
    programs
}

fn bare(id: String, name: &str, source: Source) -> Program {
    Program {
        id,
        name: name.to_string(),
        summary: String::new(),
        icon: None,
        source,
        installation: None,
        package: None,
        version: None,
        publisher: None,
        size: None,
        installed: None,
        location: None,
        launcher: None,
        launchers: Vec::new(),
        is_self: false,
    }
}

// ---- commands -----------------------------------------------------------------------------------------

/// Every installed app.
#[tauri::command]
pub async fn programs_list() -> Result<Vec<Program>, String> {
    tauri::async_runtime::spawn_blocking(|| list(&Env::from_env())).await.map_err(|e| e.to_string())
}

/// What uninstalling an app would do, for the page to show before it's confirmed.
#[tauri::command]
pub async fn programs_plan(id: String) -> Result<Plan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let env = Env::from_env();
        let all = scan::scan(&env);
        remove::plan(&env, &all, &id).map(|(plan, _)| plan)
    })
    .await
    .map_err(|e| e.to_string())?
}

static BUSY: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    id: String,
    line: String,
}

/// Uninstalls an app as its plan said, with the choices made on the page. The plan is worked out
/// again here, from a fresh look at the system, so only what it offers can happen. Each line of
/// progress is a `programs-progress` event.
#[tauri::command]
pub async fn programs_uninstall(app: tauri::AppHandle, id: String, options: Options) -> Result<Outcome, String> {
    crate::ensure_unlocked()?;
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("Another app is being uninstalled. Wait for it to finish.".into());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let env = Env::from_env();
        let all = scan::scan(&env);
        let (plan, ctx) = remove::plan(&env, &all, &id)?;
        let report = |line: &str| {
            let _ = app.emit("programs-progress", ProgressEvent { id: id.clone(), line: line.to_string() });
        };
        remove::uninstall(&env, &plan, &ctx, &options, &report)
    })
    .await
    .map_err(|e| e.to_string());
    BUSY.store(false, Ordering::SeqCst);
    result?
}

/// Starts an app from its launcher (a desktop file id from the list).
#[tauri::command]
pub async fn programs_open(launcher: String) -> Result<(), String> {
    if launcher.contains('/') || !launcher.ends_with(".desktop") {
        return Err("That isn’t an app’s launcher.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let path = apps::find_desktop(&apps::Dirs::from_env(), &launcher).ok_or("Couldn’t find how to start this app.")?;
        apps::launch(&path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// True when uninstalls only pretend (`ZAZABOR_UNINSTALL_DRY_RUN`), for the page to say so.
#[tauri::command]
pub fn programs_dry_run() -> bool {
    remove::dry_run()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the Apps section lists on this computer, and the plan for one app of each kind (or the
    /// app in `ZAZABOR_PLAN`). Plans only look: apt is only simulated and nothing is removed.
    /// `cargo test --lib programs::tests::this_computer -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn this_computer() {
        let env = Env::from_env();
        let started = std::time::Instant::now();
        let programs = list(&env);
        eprintln!("{} apps in {:?}", programs.len(), started.elapsed());
        for p in &programs {
            let size = p.size.map(|s| format!("{:.1} MB", s as f64 / 1e6)).unwrap_or_default();
            eprintln!("{:<9} {:<38} {:>10}  {:<28} {}", format!("{:?}", p.source), p.name, size, p.version.clone().unwrap_or_default(), p.id);
        }
        let all = scan::scan(&env);
        let wanted = std::env::var("ZAZABOR_PLAN").ok();
        let mut seen = std::collections::HashSet::new();
        for f in &all.found {
            let pick = match &wanted {
                Some(id) => &f.key == id,
                None => seen.insert(f.source),
            };
            if pick {
                let started = std::time::Instant::now();
                let (plan, ctx) = remove::plan(&env, &all, &f.key).unwrap();
                eprintln!("\n== {} ({:?})\n{plan:#?}\nfiles: {:#?}", f.key, started.elapsed(), ctx.files);
            }
        }
    }
}
