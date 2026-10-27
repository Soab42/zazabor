//! "Install codecs": adds the GStreamer packages this system lacks (AAC and phone-video
//! decoders, x264, HEVC) when the user asks, through `pkexec apt-get`, which shows the system's
//! own password prompt. Only the packages below can be asked for. Afterwards GStreamer looks for
//! new plugins, so they work without restarting Zazabor.

use super::export::{self, Encoders};
use super::media;
use std::process::Command;

/// What Zazabor may offer to install.
pub const ALLOWED: [&str; 3] = ["gstreamer1.0-libav", "gstreamer1.0-plugins-ugly", "gstreamer1.0-plugins-bad"];

/// Checks the list, then runs `program args… packages…` (pkexec apt-get, or a stand-in for tests).
pub fn install_with(program: &str, args: &[&str], packages: &[String]) -> Result<(), String> {
    if packages.is_empty() {
        return Err("Nothing to install.".into());
    }
    if let Some(p) = packages.iter().find(|p| !ALLOWED.contains(&p.as_str())) {
        return Err(format!("Zazabor doesn't install “{p}”."));
    }
    let output = Command::new(program)
        .args(args)
        .args(packages)
        .env("DEBIAN_FRONTEND", "noninteractive")
        .output()
        .map_err(|e| format!("Couldn't start the installer ({program}): {e}"))?;
    match output.status.code() {
        Some(0) => Ok(()),
        // pkexec: the password prompt was dismissed, or the user isn't allowed.
        Some(126) | Some(127) => Err("The installation was cancelled.".into()),
        code => {
            let text = String::from_utf8_lossy(&output.stderr);
            let tail: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).rev().take(3).collect();
            let tail: Vec<&str> = tail.into_iter().rev().collect();
            Err(format!("The installation failed{}{}", code.map_or(String::new(), |c| format!(" (code {c})")), if tail.is_empty() { ".".into() } else { format!(": {}", tail.join(" ")) }))
        }
    }
}

/// Installs `packages` and returns what the system can encode now.
pub fn install(packages: &[String]) -> Result<Encoders, String> {
    // For tests and other package managers: a program that takes the package names.
    if let Ok(program) = std::env::var("ZAZABOR_CODEC_INSTALL_COMMAND") {
        install_with(&program, &[], packages)?;
    } else {
        if Command::new("sh").args(["-c", "command -v apt-get && command -v pkexec"]).output().map_or(true, |o| !o.status.success()) {
            return Err(format!("This system doesn't use apt with pkexec. Install {} with your package manager, then restart Zazabor.", packages.join(", ")));
        }
        install_with("pkexec", &["apt-get", "install", "-y"], packages)?;
    }
    rescan();
    export::encoders()
}

/// Makes GStreamer pick up plugins installed while Zazabor runs.
pub fn rescan() {
    if media::init().is_ok() {
        let _ = gstreamer::update_registry();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn script(name: &str, body: &str) -> String {
        let dir = std::env::temp_dir().join(format!("zazabor-codecs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn a_successful_install_gets_exactly_the_packages() {
        let log = std::env::temp_dir().join(format!("zazabor-codecs-{}-args", std::process::id()));
        let fake = script("ok.sh", &format!("echo \"$@\" > {}", log.display()));
        // Run through sh: executing a script another test thread is still writing fails with ETXTBSY.
        install_with("/bin/sh", &[&fake, "install", "-y"], &["gstreamer1.0-libav".into(), "gstreamer1.0-plugins-ugly".into()]).unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap().trim(), "install -y gstreamer1.0-libav gstreamer1.0-plugins-ugly");
    }

    #[test]
    fn failures_and_cancels_say_so() {
        let cancelled = script("cancel.sh", "exit 126");
        assert_eq!(install_with("/bin/sh", &[&cancelled], &["gstreamer1.0-libav".into()]).unwrap_err(), "The installation was cancelled.");
        let broken = script("broken.sh", "echo 'E: Unable to locate package' >&2; exit 100");
        let err = install_with("/bin/sh", &[&broken], &["gstreamer1.0-libav".into()]).unwrap_err();
        assert!(err.contains("code 100") && err.contains("Unable to locate package"), "{err}");
    }

    #[test]
    fn only_codec_packages_can_be_installed() {
        let fake = script("never.sh", "exit 0");
        assert!(install_with("/bin/sh", &[&fake], &["sudo".into()]).is_err());
        assert!(install_with("/bin/sh", &[&fake], &["gstreamer1.0-libav; rm -rf /".into()]).is_err());
        assert!(install_with("/bin/sh", &[&fake], &[]).is_err());
    }
}
