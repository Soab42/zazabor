//! Default apps (Settings → General → Default apps): what opens photos, videos, PDFs, Word and
//! Excel files and folders when they're double-clicked, here and everywhere on the desktop. Each
//! kind is the MIME types Zazabor's launcher declares (scripts/install-linux.sh and the website's
//! install.sh write the same list); choosing an app makes it the default for every type of the kind
//! it handles, in the user's `mimeapps.list` (`fs::apps::set_default`).

use crate::fs::apps::{self, AppInfo, Dirs};
use serde::Serialize;

/// Zazabor's desktop file, as the installers name it.
pub const ZAZABOR: &str = "zazabor.desktop";

pub struct Kind {
    pub id: &'static str,
    pub mimes: &'static [&'static str],
}

pub const KINDS: [Kind; 6] = [
    Kind { id: "photos", mimes: &["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/tiff"] },
    Kind { id: "videos", mimes: &["video/mp4", "video/x-matroska", "video/webm", "video/quicktime", "video/x-msvideo"] },
    Kind { id: "pdf", mimes: &["application/pdf"] },
    Kind { id: "word", mimes: &["application/vnd.openxmlformats-officedocument.wordprocessingml.document"] },
    Kind {
        id: "sheets",
        mimes: &["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel.sheet.macroEnabled.12", "text/csv", "text/tab-separated-values"],
    },
    Kind { id: "folders", mimes: &["inode/directory"] },
];

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KindState {
    id: &'static str,
    /// The app that opens the kind's first type now, if any does.
    current: Option<AppInfo>,
    /// Not every type of the kind opens in `current`.
    mixed: bool,
    /// Zazabor opens every type of the kind.
    zazabor: bool,
    /// The apps that can open the kind (its first type), current one first.
    apps: Vec<AppInfo>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// Zazabor's launcher is installed (a development build that never was can't be a default).
    installed: bool,
    kinds: Vec<KindState>,
}

/// Each kind's default and the apps to choose from.
fn state(dirs: &Dirs) -> State {
    let kinds = KINDS
        .iter()
        .map(|kind| {
            let apps = apps::apps_for_mime(dirs, kind.mimes[0]);
            let current = apps.first().cloned();
            let opener = |mime: &str| apps::apps_for_mime(dirs, mime).into_iter().next().map(|a| a.id);
            let openers: Vec<Option<String>> = kind.mimes.iter().map(|m| opener(m)).collect();
            KindState {
                id: kind.id,
                mixed: openers.iter().any(|o| o.as_deref() != current.as_ref().map(|c| c.id.as_str())),
                zazabor: openers.iter().all(|o| o.as_deref() == Some(ZAZABOR)),
                current,
                apps,
            }
        })
        .collect();
    State { installed: apps::find_desktop(dirs, ZAZABOR).is_some(), kinds }
}

/// The types of `kind` that `app_id` can open (all of them for Zazabor, whose launcher lists them).
fn types_for(dirs: &Dirs, kind: &Kind, app_id: &str) -> Vec<&'static str> {
    kind.mimes.iter().copied().filter(|mime| app_id == ZAZABOR || apps::apps_for_mime(dirs, mime).iter().any(|a| a.id == app_id)).collect()
}

#[tauri::command]
pub async fn defaults_state() -> Result<State, String> {
    crate::ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(|| {
        let mut s = state(&Dirs::from_env());
        for app in s.kinds.iter_mut().flat_map(|k| k.current.iter_mut().chain(k.apps.iter_mut())) {
            app.icon = app.icon.as_deref().and_then(apps::icon_data_url);
        }
        s
    })
    .await
    .map_err(|e| e.to_string())
}

/// Makes `app_id` the default for the kinds named (for each type of them it can open).
#[tauri::command]
pub async fn defaults_set(kinds: Vec<String>, app_id: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(move || {
        let dirs = Dirs::from_env();
        if apps::find_desktop(&dirs, &app_id).is_none() {
            return Err(if app_id == ZAZABOR { "Install Zazabor first: a development build can't be a default app." } else { "That app isn't installed any more." }.to_string());
        }
        for id in &kinds {
            let kind = KINDS.iter().find(|k| k.id == id).ok_or_else(|| format!("There's no kind of file “{id}”."))?;
            let types = types_for(&dirs, kind, &app_id);
            if types.is_empty() {
                return Err("That app can't open these files.".into());
            }
            for mime in types {
                apps::set_default(mime, &app_id)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn desktop(dir: &Path, file: &str, body: &str) {
        let path = dir.join("applications").join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("[Desktop Entry]\nType=Application\n{body}\n")).unwrap();
    }

    fn fixture(tag: &str) -> (PathBuf, Dirs) {
        let root = std::env::temp_dir().join(format!("zazabor-defaults-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (data, cfg) = (root.join("data"), root.join("cfg"));
        fs::create_dir_all(&cfg).unwrap();
        desktop(&data, "zazabor.desktop", &format!("Name=Zazabor\nMimeType={};", KINDS.iter().flat_map(|k| k.mimes).copied().collect::<Vec<_>>().join(";")));
        desktop(&data, "eog.desktop", "Name=Image Viewer\nMimeType=image/jpeg;image/png;image/gif;");
        desktop(&data, "evince.desktop", "Name=Document Viewer\nMimeType=application/pdf;");
        (root, Dirs { data: vec![data], config: vec![cfg], desktops: vec!["pop".into(), "gnome".into()] })
    }

    fn kind<'a>(s: &'a State, id: &str) -> &'a KindState {
        s.kinds.iter().find(|k| k.id == id).unwrap()
    }

    #[test]
    fn a_kind_opens_in_zazabor_only_when_every_type_does() {
        let (root, dirs) = fixture("state");
        // JPEG and PNG in Zazabor, GIF left to the image viewer: photos are mixed.
        fs::write(dirs.config[0].join("mimeapps.list"), "[Default Applications]\nimage/jpeg=zazabor.desktop\nimage/png=zazabor.desktop\nimage/gif=eog.desktop\napplication/pdf=evince.desktop\n").unwrap();
        let s = state(&dirs);
        assert!(s.installed);
        let photos = kind(&s, "photos");
        assert_eq!(photos.current.as_ref().unwrap().id, "zazabor.desktop");
        assert!(photos.mixed && !photos.zazabor);
        let pdf = kind(&s, "pdf");
        assert_eq!(pdf.current.as_ref().unwrap().name, "Document Viewer");
        assert!(!pdf.mixed && !pdf.zazabor);
        assert!(pdf.apps.iter().any(|a| a.id == "zazabor.desktop"), "Zazabor is offered for PDFs");
        // Only Zazabor opens Word files here, so it's what opens them without being chosen.
        assert!(kind(&s, "word").zazabor);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn another_app_becomes_the_default_only_for_the_types_it_opens() {
        let (root, dirs) = fixture("types");
        let photos = &KINDS[0];
        assert_eq!(types_for(&dirs, photos, "eog.desktop"), ["image/jpeg", "image/png", "image/gif"]);
        assert_eq!(types_for(&dirs, photos, ZAZABOR), photos.mimes);
        assert!(types_for(&dirs, &KINDS[2], "eog.desktop").is_empty());
        let _ = fs::remove_dir_all(root);
    }

    /// What the desktop ships (gnome-mimeapps.list, defaults.list) counts, under the user's own choice.
    #[test]
    fn the_desktops_own_defaults_count_and_the_users_choice_wins() {
        let (root, dirs) = fixture("desktop");
        let apps = dirs.data[0].join("applications");
        fs::write(apps.join("defaults.list"), "[Default Applications]\nimage/jpeg=zazabor.desktop\napplication/pdf=zazabor.desktop\n").unwrap();
        fs::write(apps.join("gnome-mimeapps.list"), "[Default Applications]\nimage/jpeg=eog.desktop\n").unwrap();
        let s = state(&dirs);
        assert_eq!(kind(&s, "photos").current.as_ref().unwrap().id, "eog.desktop", "the desktop's list over defaults.list");
        assert_eq!(kind(&s, "pdf").current.as_ref().unwrap().id, "zazabor.desktop", "defaults.list when nothing else says");
        fs::write(dirs.config[0].join("mimeapps.list"), "[Default Applications]\nimage/jpeg=zazabor.desktop\n").unwrap();
        assert_eq!(kind(&state(&dirs), "photos").current.as_ref().unwrap().id, "zazabor.desktop", "the user's choice over the desktop's");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn without_zazabors_launcher_it_isnt_installed() {
        let (root, dirs) = fixture("missing");
        fs::remove_file(dirs.data[0].join("applications/zazabor.desktop")).unwrap();
        assert!(!state(&dirs).installed);
        let _ = fs::remove_dir_all(root);
    }

    /// Every type a kind sets is one Zazabor's launcher declares, in both installers.
    #[test]
    fn the_kinds_are_what_the_installers_declare() {
        for script in ["../scripts/install-linux.sh", "../content/site/install.sh"] {
            let text = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(script)).unwrap();
            let line = text.lines().find(|l| l.starts_with("MimeType=")).unwrap();
            let declared: Vec<&str> = line.trim_start_matches("MimeType=").split(';').filter(|m| !m.is_empty()).collect();
            for mime in KINDS.iter().flat_map(|k| k.mimes) {
                assert!(declared.contains(mime), "{script} doesn't declare {mime}");
            }
        }
    }
}
