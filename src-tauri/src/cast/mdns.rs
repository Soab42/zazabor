//! Bonjour (mDNS) adverts: `_googlecast._tcp` so VLC's "Play on…" lists Zazabor, and
//! `_zazabor-mirror._tcp` so the Zazabor Cast phone app finds the PC. Runs alongside Avahi.

use mdns_sd::{IfKind, ServiceDaemon, ServiceInfo};
use std::collections::HashMap;
use std::sync::Mutex;

use super::Settings;

pub const CAST_TYPE: &str = "_googlecast._tcp.local.";
pub const MIRROR_TYPE: &str = "_zazabor-mirror._tcp.local.";

static DAEMON: Mutex<Option<ServiceDaemon>> = Mutex::new(None);

pub fn start(_generation: u64, settings: &Settings, cast_port: Option<u16>, mirror_port: Option<u16>) -> Result<(), String> {
    stop();
    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
    // Docker, VPN and VM bridges never lead to a phone; announcing there only adds noise.
    let virtual_ifs: Vec<IfKind> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| super::is_virtual(&i.name))
        .map(|i| IfKind::Name(i.name))
        .collect();
    if !virtual_ifs.is_empty() {
        let _ = daemon.disable_interface(virtual_ifs);
    }
    let id: String = settings.id.chars().filter(char::is_ascii_hexdigit).collect::<String>().to_lowercase();
    let short = &id[..id.len().min(8)];
    let host = format!("zazabor-{short}.local.");
    let mut errors = Vec::new();
    if let Some(port) = cast_port {
        let txt: HashMap<String, String> = [
            ("id", id.as_str()),
            ("cd", id.as_str()),
            ("rm", ""),
            ("ve", "05"),
            ("md", "Zazabor"),
            ("ic", "/setup/icon.png"),
            ("fn", settings.name.as_str()),
            // Video and audio out.
            ("ca", "4101"),
            ("st", "0"),
            ("bs", "FA8F00000000"),
            ("nf", "1"),
            ("rs", ""),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        match ServiceInfo::new(CAST_TYPE, &format!("Zazabor-{id}"), &host, "", port, Some(txt)) {
            Ok(info) => {
                if let Err(e) = daemon.register(info.enable_addr_auto()) {
                    errors.push(format!("Cast: {e}"));
                }
            }
            Err(e) => errors.push(format!("Cast: {e}")),
        }
    }
    if let Some(port) = mirror_port {
        let txt: HashMap<String, String> = [("name", settings.name.as_str()), ("id", id.as_str()), ("v", "1")].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        match ServiceInfo::new(MIRROR_TYPE, &instance_name(&settings.name, short), &host, "", port, Some(txt)) {
            Ok(info) => {
                if let Err(e) = daemon.register(info.enable_addr_auto()) {
                    errors.push(format!("mirroring: {e}"));
                }
            }
            Err(e) => errors.push(format!("mirroring: {e}")),
        }
    }
    *DAEMON.lock().unwrap_or_else(|e| e.into_inner()) = Some(daemon);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// An mDNS instance name: the user's name, without dots, at most 63 bytes.
fn instance_name(name: &str, short: &str) -> String {
    let clean: String = name.chars().map(|c| if c == '.' { ' ' } else { c }).collect();
    let mut out = clean.trim().to_string();
    if out.is_empty() {
        out = format!("Zazabor {short}");
    }
    while out.len() > 63 {
        out.pop();
    }
    out
}

/// Withdraws the adverts (sends goodbyes).
pub fn stop() {
    if let Some(daemon) = DAEMON.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = daemon.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_names_are_valid() {
        assert_eq!(instance_name("Zazabor on desk.local", "ab"), "Zazabor on desk local");
        assert_eq!(instance_name("  ", "ab"), "Zazabor ab");
        assert!(instance_name(&"é".repeat(60), "ab").len() <= 63);
    }
}
