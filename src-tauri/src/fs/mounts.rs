//! Phones, cloud accounts and network shares through GIO/GVfs: listing, mounting with a
//! credentials flow, unmounting and ejecting. Every GIO object lives on the GTK main thread;
//! commands hop there with `run_on_main_thread` and wait on a channel from a blocking task,
//! so the UI never stalls and every wait has a timeout.

use gio::prelude::*;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Once};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const TIMEOUT: Duration = Duration::from_secs(20);

/// A mounted (or mountable) location the sidebar shows.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MountInfo {
    pub name: String,
    /// `"disk" | "usb" | "phone" | "network" | "cloud"`.
    pub kind: &'static str,
    /// Local (FUSE or real) path; empty while not mounted.
    pub path: String,
    pub uri: String,
    pub mounted: bool,
    pub can_eject: bool,
    pub can_unmount: bool,
    /// Bytes; 0 when unknown (only measured for local disks).
    pub total: f64,
    pub free: f64,
    /// Phones only: the device is known but exposes no storage (locked, or charge-only).
    pub locked: bool,
}

const NETWORK_SCHEMES: [&str; 12] = [
    "smb", "sftp", "ssh", "ftp", "ftps", "dav", "davs", "afp", "nfs", "network", "http", "https",
];
const CLOUD_SCHEMES: [&str; 4] = ["google-drive", "onedrive", "owncloud", "nextcloud"];

/// Which sidebar group a location belongs to.
pub fn classify(scheme: &str, removable: bool) -> &'static str {
    let scheme = scheme.to_ascii_lowercase();
    match scheme.as_str() {
        "mtp" | "gphoto2" | "afc" => "phone",
        s if CLOUD_SCHEMES.contains(&s) => "cloud",
        s if NETWORK_SCHEMES.contains(&s) => "network",
        _ if removable => "usb",
        _ => "disk",
    }
}

const ADDRESS_SCHEMES: [&str; 9] = ["smb", "sftp", "ssh", "ftp", "ftps", "dav", "davs", "afp", "nfs"];

/// Turns what the user typed into a mountable URI: a bare host becomes `smb://host`,
/// `\\host\share` becomes `smb://host/share`, `ssh` is `sftp`, and unknown schemes are refused.
pub fn normalize_address(input: &str) -> Result<String, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("Enter a server address, for example smb://nas/photos".into());
    }
    if text.chars().any(char::is_whitespace) {
        return Err("The address cannot contain spaces".into());
    }
    if let Some(rest) = text.strip_prefix("\\\\") {
        return normalize_address(&format!("smb://{}", rest.replace('\\', "/")));
    }
    let Some((scheme, rest)) = text.split_once("://") else {
        return normalize_address(&format!("smb://{text}"));
    };
    let mut scheme = scheme.to_ascii_lowercase();
    if scheme == "ssh" {
        scheme = "sftp".into();
    }
    if !ADDRESS_SCHEMES.contains(&scheme.as_str()) {
        return Err(format!("\"{scheme}\" addresses are not supported"));
    }
    if rest.trim_matches('/').is_empty() {
        return Err("The address is missing a server name".into());
    }
    Ok(format!("{scheme}://{rest}"))
}

/// A friendlier label for what GIO reports: device names use underscores.
pub fn display_name(raw: &str, kind: &str) -> String {
    let name = if kind == "phone" { raw.replace('_', " ") } else { raw.to_string() };
    let name = name.trim();
    if name.is_empty() {
        "Untitled".to_string()
    } else {
        name.to_string()
    }
}

/// Pulls a readable line out of a GIO error.
fn readable(err: &gio::glib::Error) -> String {
    let message = err.message().to_string();
    if err.matches(gio::IOErrorEnum::TimedOut) {
        "The server did not respond in time".into()
    } else if err.matches(gio::IOErrorEnum::HostNotFound) {
        "The server could not be found".into()
    } else if err.matches(gio::IOErrorEnum::Cancelled) {
        "Cancelled".into()
    } else if err.matches(gio::IOErrorEnum::NotSupported) {
        format!("Not supported (is gvfs-backends installed?): {message}")
    } else {
        message
    }
}

fn describe(mount: &gio::Mount) -> Option<MountInfo> {
    if mount.is_shadowed() {
        return None;
    }
    let root = mount.root();
    let uri = root.uri().to_string();
    let scheme = root.uri_scheme().map(|s| s.to_string()).unwrap_or_default();
    let removable = mount.drive().map(|d| d.is_removable() || d.is_media_removable()).unwrap_or(false)
        || mount.can_eject();
    let kind = classify(&scheme, removable);
    let path = root.path().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let (total, free) = if matches!(kind, "disk" | "usb") && !path.is_empty() {
        super::volumes::space(&path)
    } else {
        (0.0, 0.0)
    };
    Some(MountInfo {
        name: display_name(&mount.name(), kind),
        kind,
        path,
        uri,
        mounted: true,
        can_eject: mount.can_eject(),
        can_unmount: mount.can_unmount(),
        total,
        free,
        locked: false,
    })
}

/// Phones the system knows about that are not mounted yet.
fn describe_volume(volume: &gio::Volume) -> Option<MountInfo> {
    if volume.get_mount().is_some() {
        return None;
    }
    let root = volume.activation_root()?;
    let scheme = root.uri_scheme()?.to_string();
    let kind = classify(&scheme, false);
    if kind != "phone" {
        return None;
    }
    Some(MountInfo {
        name: display_name(&volume.name(), kind),
        kind,
        path: String::new(),
        uri: root.uri().to_string(),
        mounted: false,
        can_eject: false,
        can_unmount: false,
        total: 0.0,
        free: 0.0,
        locked: true,
    })
}

fn snapshot() -> Vec<MountInfo> {
    let monitor = gio::VolumeMonitor::get();
    let mut out: Vec<MountInfo> = monitor.mounts().iter().filter_map(describe).collect();
    out.extend(monitor.volumes().iter().filter_map(describe_volume));
    out
}

/// A mounted phone with nothing readable at its root has no storage exposed yet.
fn probe_phones(mounts: &mut [MountInfo]) {
    for mount in mounts.iter_mut().filter(|m| m.kind == "phone" && m.mounted && !m.path.is_empty()) {
        let path = mount.path.clone();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let count = std::fs::read_dir(&path).map(|r| r.count()).unwrap_or(0);
            let _ = tx.send(count);
        });
        mount.locked = rx.recv_timeout(Duration::from_millis(1500)).map(|n| n == 0).unwrap_or(false);
    }
}

/// Runs `f` on the GTK main thread and waits for its result, up to `TIMEOUT`.
fn on_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(TIMEOUT).map_err(|_| "The system did not respond in time".to_string())
}

/// Watches the volume monitor once and tells the frontend something changed.
fn watch_monitor(app: &AppHandle) {
    static ONCE: Once = Once::new();
    let app = app.clone();
    ONCE.call_once(|| {
        let monitor = gio::VolumeMonitor::get();
        let notify = move || {
            let _ = app.emit("fs-mounts-changed", ());
        };
        macro_rules! hook {
            ($($signal:ident),*) => {$({
                let notify = notify.clone();
                monitor.$signal(move |_, _| notify());
            })*};
        }
        hook!(
            connect_mount_added, connect_mount_removed, connect_mount_changed,
            connect_volume_added, connect_volume_removed, connect_volume_changed,
            connect_drive_connected, connect_drive_disconnected
        );
    });
}

pub fn list(app: &AppHandle) -> Result<Vec<MountInfo>, String> {
    let handle = app.clone();
    let mut mounts = on_main(app, move || {
        watch_monitor(&handle);
        snapshot()
    })?;
    probe_phones(&mut mounts);
    Ok(mounts)
}

struct Credentials {
    username: Option<String>,
    domain: Option<String>,
    password: Option<String>,
    remember: bool,
}

/// A mount operation that answers password prompts from `creds`, never shows UI, and records
/// when credentials were needed but missing or wrong.
fn operation(creds: Credentials, auth: Arc<AtomicBool>, wrong: Arc<AtomicBool>) -> gio::MountOperation {
    let op = gio::MountOperation::new();
    let asked = Arc::new(AtomicU32::new(0));
    op.connect_ask_password(move |op, _message, default_user, default_domain, flags| {
        let attempt = asked.fetch_add(1, Ordering::SeqCst);
        let want_password = flags.contains(gio::AskPasswordFlags::NEED_PASSWORD);
        let missing = want_password && creds.password.is_none();
        if missing || attempt > 0 {
            if attempt > 0 {
                wrong.store(true, Ordering::SeqCst);
            }
            auth.store(true, Ordering::SeqCst);
            op.reply(gio::MountOperationResult::Aborted);
            return;
        }
        if flags.contains(gio::AskPasswordFlags::NEED_USERNAME) {
            let user = creds.username.as_deref().filter(|u| !u.is_empty()).unwrap_or(default_user);
            op.set_username(Some(user));
        }
        if flags.contains(gio::AskPasswordFlags::NEED_DOMAIN) {
            let domain = creds.domain.as_deref().filter(|d| !d.is_empty()).unwrap_or(default_domain);
            op.set_domain(Some(domain));
        }
        if want_password {
            op.set_password(creds.password.as_deref());
        }
        if flags.contains(gio::AskPasswordFlags::SAVING_SUPPORTED) {
            op.set_password_save(if creds.remember {
                gio::PasswordSave::Permanently
            } else {
                gio::PasswordSave::Never
            });
        }
        op.reply(gio::MountOperationResult::Handled);
    });
    // Host-key and anonymous-login questions: accept the affirmative choice, otherwise abort.
    op.connect_local("ask-question", false, |args| {
        let op = args[0].get::<gio::MountOperation>().ok()?;
        let choices = args[2].get::<Vec<String>>().unwrap_or_default();
        let pick = choices.iter().position(|c| {
            let c = c.to_lowercase();
            c.contains("yes") || c.contains("log in") || c.contains("continue")
        });
        match pick {
            Some(index) => {
                op.set_choice(index as i32);
                op.reply(gio::MountOperationResult::Handled);
            }
            None => op.reply(gio::MountOperationResult::Aborted),
        }
        None
    });
    op
}

type Outcome = Result<(), gio::glib::Error>;

/// Starts `start` on the main thread and waits for its callback, cancelling after `TIMEOUT`.
fn run_async(
    app: &AppHandle,
    start: impl FnOnce(gio::Cancellable, Sender<Outcome>) + Send + 'static,
) -> Result<Outcome, String> {
    let cancel = gio::Cancellable::new();
    let (tx, rx) = mpsc::channel();
    let inner = cancel.clone();
    app.run_on_main_thread(move || start(inner, tx)).map_err(|e| e.to_string())?;
    match rx.recv_timeout(TIMEOUT) {
        Ok(result) => Ok(result),
        Err(_) => {
            cancel.cancel();
            Err("The server did not respond in time".into())
        }
    }
}

pub fn mount(
    app: &AppHandle,
    uri: &str,
    username: Option<String>,
    domain: Option<String>,
    password: Option<String>,
    remember: bool,
) -> Result<MountInfo, String> {
    let uri = normalize_address(uri)?;
    let auth = Arc::new(AtomicBool::new(false));
    let wrong = Arc::new(AtomicBool::new(false));
    let (auth_flag, wrong_flag, target) = (auth.clone(), wrong.clone(), uri.clone());
    let creds = Credentials { username, domain, password, remember };
    let result = run_async(app, move |cancel, tx| {
        let op = operation(creds, auth_flag, wrong_flag);
        let file = gio::File::for_uri(&target);
        file.mount_enclosing_volume(gio::MountMountFlags::NONE, Some(&op), Some(&cancel), move |r| {
            let _ = tx.send(r);
        });
    })?;
    match result {
        Ok(()) => {}
        Err(err) if err.matches(gio::IOErrorEnum::AlreadyMounted) => {}
        Err(err) => {
            if wrong.load(Ordering::SeqCst) {
                return Err("auth:Wrong user name or password".into());
            }
            if auth.load(Ordering::SeqCst) {
                return Err("auth:This server needs a user name and password".into());
            }
            return Err(readable(&err));
        }
    }
    let wanted = uri.clone();
    let found = on_main(app, move || {
        let file = gio::File::for_uri(&wanted);
        file.find_enclosing_mount(gio::Cancellable::NONE).ok().and_then(|m| describe(&m))
    })?;
    found.ok_or_else(|| "The share mounted but could not be located".to_string())
}

/// Finds a mount by URI or by local path (the path may be inside the mount).
fn find_mount(target: &str) -> Option<gio::Mount> {
    let monitor = gio::VolumeMonitor::get();
    let mut best: Option<(usize, gio::Mount)> = None;
    for mount in monitor.mounts() {
        let root = mount.root();
        let uri = root.uri().to_string();
        let path = root.path().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let hit = target.trim_end_matches('/') == uri.trim_end_matches('/')
            || (!path.is_empty() && (target == path || target.starts_with(&format!("{path}/"))));
        if hit && best.as_ref().map_or(true, |(len, _)| path.len() >= *len) {
            best = Some((path.len(), mount));
        }
    }
    best.map(|(_, m)| m)
}

fn leave(app: &AppHandle, target: &str, eject: bool) -> Result<(), String> {
    let target = target.to_string();
    let result = run_async(app, move |cancel, tx| {
        let Some(mount) = find_mount(&target) else {
            let _ = tx.send(Err(gio::glib::Error::new(gio::IOErrorEnum::NotMounted, "It is not mounted")));
            return;
        };
        let op = gio::MountOperation::new();
        let done = move |r| {
            let _ = tx.send(r);
        };
        if eject && mount.can_eject() {
            mount.eject_with_operation(gio::MountUnmountFlags::NONE, Some(&op), Some(&cancel), done);
        } else {
            mount.unmount_with_operation(gio::MountUnmountFlags::NONE, Some(&op), Some(&cancel), done);
        }
    })?;
    result.map_err(|e| {
        if e.matches(gio::IOErrorEnum::Busy) {
            "It is in use: close the files that are open on it and try again".to_string()
        } else {
            readable(&e)
        }
    })
}

pub fn unmount(app: &AppHandle, target: &str) -> Result<(), String> {
    leave(app, target, false)
}

pub fn eject(app: &AppHandle, target: &str) -> Result<(), String> {
    leave(app, target, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_scheme() {
        assert_eq!(classify("mtp", false), "phone");
        assert_eq!(classify("gphoto2", false), "phone");
        assert_eq!(classify("smb", false), "network");
        assert_eq!(classify("SFTP", false), "network");
        assert_eq!(classify("google-drive", false), "cloud");
        assert_eq!(classify("file", true), "usb");
        assert_eq!(classify("file", false), "disk");
    }

    #[test]
    fn normalizes_addresses() {
        assert_eq!(normalize_address("nas").unwrap(), "smb://nas");
        assert_eq!(normalize_address("  nas/photos ").unwrap(), "smb://nas/photos");
        assert_eq!(normalize_address("\\\\nas\\photos").unwrap(), "smb://nas/photos");
        assert_eq!(normalize_address("SMB://nas/x").unwrap(), "smb://nas/x");
        assert_eq!(normalize_address("ssh://me@host/home").unwrap(), "sftp://me@host/home");
        assert_eq!(
            normalize_address("davs://cloud.example/remote.php").unwrap(),
            "davs://cloud.example/remote.php"
        );
        assert_eq!(normalize_address("ftp://host").unwrap(), "ftp://host");
    }

    #[test]
    fn rejects_bad_addresses() {
        assert!(normalize_address("").is_err());
        assert!(normalize_address("my server").is_err());
        assert!(normalize_address("file:///etc").is_err());
        assert!(normalize_address("smb://").is_err());
    }

    #[test]
    fn names_devices() {
        assert_eq!(display_name("SAMSUNG_Android", "phone"), "SAMSUNG Android");
        assert_eq!(display_name("my_share", "network"), "my_share");
        assert_eq!(display_name("  ", "disk"), "Untitled");
    }
}
