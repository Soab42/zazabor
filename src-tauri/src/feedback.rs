//! Reporting a bug or asking for a feature (Settings → Zazabor → Feedback) goes to GitHub's issue
//! forms (.github/ISSUE_TEMPLATE), with the system filled in from here.

/// The system, for a report: "Pop!_OS 22.04 LTS · GNOME on Wayland · x86_64".
#[tauri::command]
pub fn system_details() -> String {
    let os = std::fs::read_to_string("/etc/os-release").ok().and_then(|text| pretty_name(&text)).unwrap_or_else(|| std::env::consts::OS.to_string());
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").ok().filter(|d| !d.is_empty()).map(|d| d.split(':').last().unwrap_or(&d).to_string());
    let session = std::env::var("XDG_SESSION_TYPE").ok().filter(|s| !s.is_empty()).map(|s| if s == "x11" { "X11".to_string() } else { capitalize(&s) });
    let shell = match (desktop, session) {
        (Some(d), Some(s)) => Some(format!("{d} on {s}")),
        (d, s) => d.or(s),
    };
    [Some(os), shell, Some(std::env::consts::ARCH.to_string())].into_iter().flatten().collect::<Vec<_>>().join(" · ")
}

/// `PRETTY_NAME` from os-release.
fn pretty_name(os_release: &str) -> Option<String> {
    os_release.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=")).map(|v| v.trim().trim_matches('"').to_string()).filter(|v| !v.is_empty())
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_release_gives_its_pretty_name() {
        assert_eq!(pretty_name("NAME=\"Pop!_OS\"\nPRETTY_NAME=\"Pop!_OS 22.04 LTS\"\nID=pop\n").as_deref(), Some("Pop!_OS 22.04 LTS"));
        assert_eq!(pretty_name("NAME=Fedora\n"), None);
        assert_eq!(capitalize("wayland"), "Wayland");
        assert!(!system_details().is_empty());
    }
}
