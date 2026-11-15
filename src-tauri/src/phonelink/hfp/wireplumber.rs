//! PipeWire registers the Bluetooth hands-free role (HFP HF, UUID 0x111E) itself, and BlueZ lets
//! only one program register it. While Bluetooth calls are on, a WirePlumber drop-in takes that
//! role (and only that one) away from PipeWire, so Zazabor can register it. The PC keeps the
//! audio-gateway role it uses with headsets (`hfp_ag`) and everything else.
//!
//! WirePlumber 0.4 reads Lua drop-ins from `~/.config/wireplumber/bluetooth.lua.d/`; 0.5 reads
//! SPA-JSON drop-ins from `~/.config/wireplumber/wireplumber.conf.d/`. Zazabor writes one file for
//! the version installed and removes both when calls are switched off.

use std::path::{Path, PathBuf};
use std::process::Command;

const NAME: &str = "51-zazabor-calls";

/// PipeWire's default roles (`[ a2dp_sink a2dp_source bap_sink bap_source hfp_hf hfp_ag ]`, the
/// same in WirePlumber 0.4 and 0.5) without `hfp_hf`.
const ROLES: &str = "[ a2dp_sink a2dp_source bap_sink bap_source hfp_ag ]";

/// The drop-in for WirePlumber 0.4. It runs after `50-bluez-config.lua` (which sets up
/// `bluez_monitor.properties`) and before `90-enable-all.lua` starts the monitor.
pub fn lua_text() -> String {
    format!(
        "-- Written by Zazabor Home (Phone → Bluetooth calls). Zazabor Home answers phone calls as the\n\
         -- Bluetooth hands-free unit itself, so PipeWire leaves that role (hfp_hf) to it. Turning\n\
         -- Bluetooth calls off in Zazabor Home removes this file.\n\
         if bluez_monitor ~= nil and bluez_monitor.properties ~= nil then\n  \
         bluez_monitor.properties[\"bluez5.roles\"] = \"{ROLES}\"\n\
         end\n"
    )
}

/// The drop-in for WirePlumber 0.5.
pub fn conf_text() -> String {
    format!(
        "# Written by Zazabor Home (Phone → Bluetooth calls). Zazabor Home answers phone calls as the\n\
         # Bluetooth hands-free unit itself, so PipeWire leaves that role (hfp_hf) to it. Turning\n\
         # Bluetooth calls off in Zazabor removes this file.\n\
         monitor.bluez.properties = {{\n  \
         bluez5.roles = {ROLES}\n\
         }}\n"
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    /// WirePlumber 0.4: Lua.
    Lua,
    /// WirePlumber 0.5: SPA-JSON.
    Conf,
}

/// `~/.config` (or `$XDG_CONFIG_HOME`).
pub fn config_home() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
}

pub fn path(config_home: &Path, layout: Layout) -> PathBuf {
    let dir = config_home.join("wireplumber");
    match layout {
        Layout::Lua => dir.join("bluetooth.lua.d").join(format!("{NAME}.lua")),
        Layout::Conf => dir.join("wireplumber.conf.d").join(format!("{NAME}.conf")),
    }
}

/// The layout from `wireplumber --version` ("Linked with libwireplumber 0.4.17").
pub fn layout_from_version(text: &str) -> Option<Layout> {
    let version = text.lines().rev().find_map(|l| l.split_whitespace().last().filter(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit())))?;
    let mut parts = version.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let (major, minor) = (parts.next()?, parts.next().unwrap_or(0));
    Some(if (major, minor) < (0, 5) { Layout::Lua } else { Layout::Conf })
}

/// The installed WirePlumber's layout; 0.4's Lua directories decide when the version can't be read.
pub fn detect() -> Layout {
    let version = Command::new("wireplumber").arg("--version").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
    if let Some(layout) = version.as_deref().and_then(layout_from_version) {
        return layout;
    }
    let lua = ["/usr/share/wireplumber/bluetooth.lua.d", "/etc/wireplumber/bluetooth.lua.d"].iter().any(|d| Path::new(d).is_dir());
    if lua {
        Layout::Lua
    } else {
        Layout::Conf
    }
}

/// The drop-in is in place.
pub fn present(config_home: &Path) -> bool {
    [Layout::Lua, Layout::Conf].iter().any(|&l| path(config_home, l).is_file())
}

/// Writes the drop-in for `layout`. Returns whether anything changed (WirePlumber then needs a
/// restart).
pub fn write(config_home: &Path, layout: Layout) -> Result<bool, String> {
    let path = path(config_home, layout);
    let text = match layout {
        Layout::Lua => lua_text(),
        Layout::Conf => conf_text(),
    };
    if std::fs::read_to_string(&path).is_ok_and(|t| t == text) {
        return Ok(false);
    }
    let dir = path.parent().ok_or("Bad WirePlumber folder")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    Ok(true)
}

/// Removes the drop-in (both layouts). Returns whether a file was removed.
pub fn remove(config_home: &Path) -> Result<bool, String> {
    let mut removed = false;
    for layout in [Layout::Lua, Layout::Conf] {
        let path = path(config_home, layout);
        match std::fs::remove_file(&path) {
            Ok(()) => removed = true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Couldn't remove {}: {e}", path.display())),
        }
    }
    Ok(removed)
}

/// `systemctl --user restart wireplumber`: PipeWire's Bluetooth devices reconnect with the new
/// roles (headsets drop for a moment).
pub fn restart() -> Result<(), String> {
    let status = Command::new("systemctl")
        .args(["--user", "restart", "wireplumber"])
        .status()
        .map_err(|e| format!("Couldn't run systemctl: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Couldn't restart WirePlumber (systemctl --user restart wireplumber failed).".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zazabor-hfp-wp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_and_removes_the_lua_drop_in() {
        let home = scratch("lua");
        assert!(!present(&home));
        assert!(write(&home, Layout::Lua).unwrap());
        let file = home.join("wireplumber/bluetooth.lua.d/51-zazabor-calls.lua");
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("bluez_monitor.properties[\"bluez5.roles\"] = \"[ a2dp_sink a2dp_source bap_sink bap_source hfp_ag ]\""));
        assert!(!text.contains("hfp_hf ") && !text.contains("hsp_hs"));
        assert!(present(&home));
        // The same text again changes nothing.
        assert!(!write(&home, Layout::Lua).unwrap());
        assert!(remove(&home).unwrap());
        assert!(!present(&home));
        assert!(!remove(&home).unwrap());
        // Only that one file: the folder stays, nothing else is written.
        assert_eq!(std::fs::read_dir(home.join("wireplumber/bluetooth.lua.d")).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn writes_and_removes_the_conf_drop_in() {
        let home = scratch("conf");
        assert!(write(&home, Layout::Conf).unwrap());
        let text = std::fs::read_to_string(home.join("wireplumber/wireplumber.conf.d/51-zazabor-calls.conf")).unwrap();
        assert!(text.contains("monitor.bluez.properties = {\n  bluez5.roles = [ a2dp_sink a2dp_source bap_sink bap_source hfp_ag ]\n}"));
        // Removing takes either layout away.
        assert!(remove(&home).unwrap());
        assert!(!present(&home));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn version_picks_the_layout() {
        assert_eq!(layout_from_version("wireplumber\nCompiled with libwireplumber 0.4.17\nLinked with libwireplumber 0.4.17\n"), Some(Layout::Lua));
        assert_eq!(layout_from_version("wireplumber\nCompiled with libwireplumber 0.5.6\nLinked with libwireplumber 0.5.6\n"), Some(Layout::Conf));
        assert_eq!(layout_from_version("nothing"), None);
    }

    #[test]
    fn lua_drop_in_is_valid_lua_shape() {
        let text = lua_text();
        assert_eq!(text.matches("if ").count(), 1);
        assert!(text.trim_end().ends_with("end"));
    }
}
