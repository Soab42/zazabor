//! Mounted volumes from `/proc/self/mounts`, plus GVfs mounts (phones, SMB, SFTP).

use serde::Serialize;
use std::collections::HashSet;
use std::ffi::CString;
use std::path::Path;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub name: String,
    pub path: String,
    pub total: f64,
    pub free: f64,
    pub removable: bool,
}

#[derive(Debug, PartialEq)]
pub struct Mount {
    pub device: String,
    pub path: String,
    pub fstype: String,
}

const REMOVABLE_ROOTS: [&str; 2] = ["/media/", "/run/media/"];
const USER_ROOTS: [&str; 3] = ["/media/", "/run/media/", "/mnt/"];
/// Mounted block devices under these belong to the system, not the user.
const SYSTEM_ROOTS: [&str; 10] =
    ["/boot", "/snap", "/var", "/usr", "/etc", "/sys", "/proc", "/dev", "/run", "/tmp"];
const PSEUDO_FS: [&str; 24] = [
    "proc", "sysfs", "tmpfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "overlay", "squashfs",
    "securityfs", "debugfs", "tracefs", "configfs", "fusectl", "pstore", "bpf", "mqueue",
    "hugetlbfs", "autofs", "binfmt_misc", "efivarfs", "ramfs", "nsfs", "rpc_pipefs",
];

/// Decodes `\040`-style octal escapes used for spaces and tabs in mount paths.
fn unescape(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let octal = (bytes[i] == b'\\' && i + 3 < bytes.len())
            .then(|| std::str::from_utf8(&bytes[i + 1..i + 4]).ok())
            .flatten()
            .and_then(|digits| u8::from_str_radix(digits, 8).ok());
        match octal {
            Some(byte) => {
                out.push(byte);
                i += 4;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn parse_mounts(text: &str) -> Vec<Mount> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some(Mount {
                device: unescape(fields.next()?),
                path: unescape(fields.next()?),
                fstype: fields.next()?.to_string(),
            })
        })
        .collect()
}

fn under(path: &str, roots: &[&str]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

fn is_system_path(path: &str) -> bool {
    SYSTEM_ROOTS.iter().any(|r| path == *r || path.starts_with(&format!("{r}/")))
}

/// Whether a mount is a disk the user would care about.
fn is_user_volume(mount: &Mount) -> bool {
    if mount.path == "/" {
        return true;
    }
    if PSEUDO_FS.contains(&mount.fstype.as_str()) || mount.fstype.starts_with("fuse.") {
        return false;
    }
    if under(&mount.path, &USER_ROOTS) {
        return true;
    }
    mount.device.starts_with("/dev/") && !mount.device.starts_with("/dev/loop") && !is_system_path(&mount.path)
}

/// Turns a GVfs directory name such as `smb-share:server=nas,share=photos` into a label.
fn gvfs_label(dir_name: &str) -> String {
    let Some((scheme, params)) = dir_name.split_once(':') else {
        return dir_name.to_string();
    };
    let get = |key: &str| {
        params.split(',').find_map(|p| p.strip_prefix(key).and_then(|v| v.strip_prefix('=')))
    };
    match (scheme, get("share"), get("server").or_else(|| get("host"))) {
        ("smb-share", Some(share), Some(server)) => format!("{share} on {server}"),
        (_, _, Some(host)) => host.to_string(),
        _ => dir_name.to_string(),
    }
}

pub fn space(path: &str) -> (f64, f64) {
    statvfs(path)
}

fn statvfs(path: &str) -> (f64, f64) {
    let Ok(c_path) = CString::new(path) else { return (0.0, 0.0) };
    // SAFETY: `c_path` is a valid NUL-terminated string and `stat` is a plain-data out struct.
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c_path.as_ptr(), &mut stat) != 0 {
            return (0.0, 0.0);
        }
        let unit = stat.f_frsize as f64;
        (stat.f_blocks as f64 * unit, stat.f_bavail as f64 * unit)
    }
}

fn volume(name: String, path: String, removable: bool) -> Volume {
    let (total, free) = statvfs(&path);
    Volume { name, path, total, free, removable }
}

fn base_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Picks the volumes out of the mount table. GVfs parents are returned separately so the
/// caller can list their children.
pub fn select(mounts: &[Mount]) -> (Vec<Volume>, Vec<String>) {
    let mut seen_devices = HashSet::new();
    let mut seen_paths = HashSet::new();
    let mut volumes = Vec::new();
    let mut gvfs_roots = Vec::new();
    for mount in mounts {
        if mount.fstype == "fuse.gvfsd-fuse" {
            gvfs_roots.push(mount.path.clone());
            continue;
        }
        if !is_user_volume(mount) || !seen_paths.insert(mount.path.clone()) {
            continue;
        }
        // Bind mounts and btrfs subvolumes repeat a device: keep the first.
        if !seen_devices.insert(mount.device.clone()) && mount.path != "/" {
            continue;
        }
        let name = if mount.path == "/" { "Computer".to_string() } else { base_name(&mount.path) };
        volumes.push(volume(name, mount.path.clone(), under(&mount.path, &REMOVABLE_ROOTS)));
    }
    (volumes, gvfs_roots)
}

fn gvfs_volumes(root: &str) -> Vec<Volume> {
    let Ok(reader) = std::fs::read_dir(root) else { return Vec::new() };
    reader
        .flatten()
        .map(|child| {
            let name = gvfs_label(&child.file_name().to_string_lossy());
            volume(name, child.path().to_string_lossy().into_owned(), true)
        })
        .collect()
}

pub fn volumes() -> Vec<Volume> {
    let text = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    let (mut found, gvfs_roots) = select(&parse_mounts(&text));
    for root in gvfs_roots {
        found.extend(gvfs_volumes(&root));
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
sysfs /sys sysfs rw,nosuid 0 0
proc /proc proc rw 0 0
/dev/nvme0n1p2 / ext4 rw,relatime 0 0
tmpfs /run tmpfs rw 0 0
/dev/nvme0n1p1 /boot/efi vfat rw 0 0
/dev/loop3 /snap/core/1 squashfs ro 0 0
/dev/nvme0n1p2 /var/snap/bind ext4 rw 0 0
/dev/nvme0n1p3 /home ext4 rw 0 0
/dev/sdb1 /run/media/soab/My\\040Stick vfat rw 0 0
/dev/sdc1 /mnt/data ext4 rw 0 0
overlay /var/lib/docker/overlay2/x overlay rw 0 0
gvfsd-fuse /run/user/1000/gvfs fuse.gvfsd-fuse rw 0 0
portal /run/user/1000/doc fuse.portal rw 0 0
";

    #[test]
    fn decodes_octal_escapes() {
        assert_eq!(unescape("/media/My\\040Disk"), "/media/My Disk");
        assert_eq!(unescape("/plain\\"), "/plain\\");
    }

    #[test]
    fn parses_the_mount_table() {
        let mounts = parse_mounts(SAMPLE);
        assert_eq!(mounts.len(), 13);
        assert_eq!(mounts[8].path, "/run/media/soab/My Stick");
        assert_eq!(mounts[8].fstype, "vfat");
    }

    #[test]
    fn picks_user_volumes_and_gvfs_parents() {
        let (volumes, gvfs) = select(&parse_mounts(SAMPLE));
        let summary: Vec<_> = volumes.iter().map(|v| (v.name.as_str(), v.removable)).collect();
        assert_eq!(
            summary,
            [("Computer", false), ("home", false), ("My Stick", true), ("data", false)]
        );
        assert_eq!(gvfs, ["/run/user/1000/gvfs"]);
    }

    #[test]
    fn labels_gvfs_mounts() {
        assert_eq!(gvfs_label("smb-share:server=nas,share=photos"), "photos on nas");
        assert_eq!(gvfs_label("mtp:host=SAMSUNG_Galaxy_1234"), "SAMSUNG_Galaxy_1234");
        assert_eq!(gvfs_label("plain"), "plain");
    }

    #[test]
    fn root_reports_a_size() {
        let (total, free) = statvfs("/");
        assert!(total > 0.0 && free <= total);
    }
}
