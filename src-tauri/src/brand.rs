//! Zazabor became Zazabor Home in 0.2.5 (November 2026), with a new icon. The updater replaces only
//! the program, so a copy installed before then keeps a menu entry named Zazabor and the old icon:
//! the installed program renames its entry and puts in the new icons at its first start.

use std::path::{Path, PathBuf};

const ICONS: [(u32, &[u8]); 5] = [
    (32, include_bytes!("../icons/32x32.png")),
    (64, include_bytes!("../icons/64x64.png")),
    (128, include_bytes!("../icons/128x128.png")),
    (256, include_bytes!("../icons/128x128@2x.png")),
    (512, include_bytes!("../icons/icon.png")),
];

pub fn refresh() {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return };
    let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".local/share"));
    let Ok(exe) = std::env::current_exe() else { return };
    // Replaced under a running copy, Linux names it "… (deleted)".
    let exe = exe.to_string_lossy().trim_end_matches(" (deleted)").to_string();
    refresh_in(&data, &exe);
}

/// Only the program the menu entry starts does this, so a development build leaves it alone.
fn refresh_in(data: &Path, exe: &str) -> bool {
    let entry = data.join("applications/zazabor.desktop");
    let Ok(text) = std::fs::read_to_string(&entry) else { return false };
    if !text.lines().any(|l| l == format!("Exec={exe} %F")) {
        return false;
    }
    let Some(renamed) = renamed(&text) else { return false };
    let staged = entry.with_extension("desktop.new");
    if std::fs::write(&staged, renamed).and_then(|_| std::fs::rename(&staged, &entry)).is_err() {
        let _ = std::fs::remove_file(&staged);
        return false;
    }
    let theme = data.join("icons/hicolor");
    for (size, png) in ICONS {
        let icon = theme.join(format!("{size}x{size}/apps/zazabor.png"));
        if icon.exists() {
            let _ = std::fs::write(&icon, png);
        }
    }
    // A change to the theme folder tells the desktop to load its icons again.
    let touch = theme.join(".zazabor-icons");
    if std::fs::write(&touch, b"").is_ok() {
        let _ = std::fs::remove_file(touch);
    }
    true
}

/// The entry with its old names replaced, or None when there's nothing to replace.
fn renamed(text: &str) -> Option<String> {
    let mut changed = false;
    let lines: Vec<&str> = text
        .lines()
        .map(|line| match line {
            "Name=Zazabor" => {
                changed = true;
                "Name=Zazabor Home"
            }
            "Name=Quit Zazabor" => {
                changed = true;
                "Name=Quit Zazabor Home"
            }
            other => other,
        })
        .collect();
    changed.then(|| lines.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_the_installed_entry_and_its_icons_once() {
        let data = std::env::temp_dir().join(format!("zazabor-brand-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(data.join("applications")).unwrap();
        std::fs::create_dir_all(data.join("icons/hicolor/64x64/apps")).unwrap();
        std::fs::write(data.join("icons/hicolor/64x64/apps/zazabor.png"), b"old").unwrap();
        let entry = data.join("applications/zazabor.desktop");
        std::fs::write(
            &entry,
            "[Desktop Entry]\nName=Zazabor\nExec=/home/me/.local/bin/zazabor %F\n\n[Desktop Action quit]\nName=Quit Zazabor\n",
        )
        .unwrap();

        assert!(!refresh_in(&data, "/home/me/dev/target/debug/zazabor"), "a development build leaves it");
        assert!(refresh_in(&data, "/home/me/.local/bin/zazabor"));
        let text = std::fs::read_to_string(&entry).unwrap();
        assert!(text.contains("\nName=Zazabor Home\n") && text.contains("\nName=Quit Zazabor Home\n"), "{text}");
        assert_eq!(std::fs::read(data.join("icons/hicolor/64x64/apps/zazabor.png")).unwrap(), ICONS[1].1);
        assert!(!data.join("icons/hicolor/32x32/apps/zazabor.png").exists(), "only icons that were installed");
        assert!(!refresh_in(&data, "/home/me/.local/bin/zazabor"), "once");
        let _ = std::fs::remove_dir_all(&data);
    }
}
