//! Where recordings go and what they're called, the free-space check, and the clock that leaves
//! pauses out of a recording's length.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Below this much free space a recording doesn't start.
pub const MIN_FREE_TO_START: u64 = 2 * 1024 * 1024 * 1024;
/// While recording: warn below this…
pub const WARN_FREE: u64 = 1024 * 1024 * 1024;
/// …and stop (keeping what's recorded) below this.
pub const STOP_FREE: u64 = 200 * 1024 * 1024;

/// Bytes free for this user on the disk that holds `dir` (or the nearest folder that exists).
pub fn free_space(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let mut probe = dir.to_path_buf();
    while !probe.exists() {
        probe = probe.parent()?.to_path_buf();
    }
    let c = std::ffi::CString::new(probe.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated path and `stat` is a properly sized out-parameter.
    if unsafe { libc::statvfs(c.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    Some(stat.f_bavail as u64 * stat.f_frsize as u64)
}

/// Why a recording can't start for lack of space, if it can't.
pub fn space_problem(free: Option<u64>) -> Option<String> {
    match free {
        Some(bytes) if bytes < MIN_FREE_TO_START => Some(format!(
            "There's only {} free on the disk recordings go to. Free up at least 2 GB, or pick another folder in Settings → Screen Recorder.",
            human(bytes)
        )),
        _ => None,
    }
}

pub fn human(bytes: u64) -> String {
    let gb = bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    if gb >= 1.0 {
        format!("{gb:.1} GB")
    } else {
        format!("{} MB", bytes / (1024 * 1024))
    }
}

/// "Recording 2026-10-27 15.30" for a moment given as local time parts.
pub fn base_name(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> String {
    format!("Recording {year:04}-{month:02}-{day:02} {hour:02}.{minute:02}")
}

/// The local time now as (year, month, day, hour, minute).
pub fn local_now() -> (i32, u32, u32, u32, u32) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as libc::time_t);
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: localtime_r writes into `tm`, which outlives the call.
    unsafe { libc::localtime_r(&now, &mut tm) };
    (tm.tm_year + 1900, (tm.tm_mon + 1) as u32, tm.tm_mday as u32, tm.tm_hour as u32, tm.tm_min as u32)
}

/// A file name in `dir` that isn't taken: "Recording … 15.30.mp4", then "… 15.30 (2).mp4".
pub fn unique(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let mut n = 1;
    loop {
        let name = if n == 1 { format!("{base}.{ext}") } else { format!("{base} ({n}).{ext}") };
        let path = dir.join(&name);
        // The part file of a recording in progress takes its name too.
        if !path.exists() && !part_of(&path).exists() {
            return path;
        }
        n += 1;
    }
}

/// Where a recording is written while it runs: a hidden file beside its final name.
pub fn part_of(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    path.with_file_name(format!(".{name}.part"))
}

/// The final name of a part file (".Recording ….mp4.part" → "Recording ….mp4").
pub fn final_of(part: &Path) -> Option<PathBuf> {
    let name = part.file_name()?.to_string_lossy();
    let inner = name.strip_prefix('.')?.strip_suffix(".part")?;
    (!inner.is_empty()).then(|| part.with_file_name(inner))
}

pub const EXTENSIONS: [&str; 3] = ["mp4", "webm", "mkv"];

/// The recordings in `dir`, newest first; part files left by a crash come back as `recovered`.
pub fn list(dir: &Path, active: Option<&Path>) -> Vec<(PathBuf, bool, u64, f64)> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let recovered = name.starts_with('.') && name.ends_with(".part");
        if active.is_some_and(|a| a == path) {
            continue;
        }
        let ext_of = |p: &Path| p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let ext = if recovered { final_of(&path).map(|f| ext_of(&f)).unwrap_or_default() } else { ext_of(&path) };
        if (!recovered && name.starts_with('.')) || !EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64());
        out.push((path, recovered, meta.len(), mtime));
    }
    out.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// A recording's running time: time spent recording, pauses left out.
#[derive(Debug, Default)]
pub struct PauseClock {
    banked: Duration,
    since: Option<Instant>,
}

impl PauseClock {
    pub fn start_at(&mut self, now: Instant) {
        if self.since.is_none() {
            self.since = Some(now);
        }
    }

    pub fn pause_at(&mut self, now: Instant) {
        if let Some(since) = self.since.take() {
            self.banked += now.saturating_duration_since(since);
        }
    }

    pub fn elapsed_at(&self, now: Instant) -> Duration {
        self.banked + self.since.map_or(Duration::ZERO, |s| now.saturating_duration_since(s))
    }

    #[cfg(test)]
    pub fn running(&self) -> bool {
        self.since.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_clock_and_never_clash() {
        assert_eq!(base_name(2026, 10, 27, 15, 30), "Recording 2026-10-27 15.30");
        let dir = std::env::temp_dir().join(format!("zazabor-rec-names-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique(&dir, "Recording 2026-10-27 15.30", "mp4");
        assert_eq!(first.file_name().unwrap(), "Recording 2026-10-27 15.30.mp4");
        std::fs::write(&first, b"x").unwrap();
        let second = unique(&dir, "Recording 2026-10-27 15.30", "mp4");
        assert_eq!(second.file_name().unwrap(), "Recording 2026-10-27 15.30 (2).mp4");
        // A recording still running holds its name through its part file.
        std::fs::write(part_of(&second), b"x").unwrap();
        assert_eq!(unique(&dir, "Recording 2026-10-27 15.30", "mp4").file_name().unwrap(), "Recording 2026-10-27 15.30 (3).mp4");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn part_files_map_back_to_their_names() {
        let p = Path::new("/r/Recording 2026-10-27 15.30.mp4");
        let part = part_of(p);
        assert_eq!(part, Path::new("/r/.Recording 2026-10-27 15.30.mp4.part"));
        assert_eq!(final_of(&part).unwrap(), p);
        assert!(final_of(Path::new("/r/notes.txt")).is_none());
    }

    #[test]
    fn listing_shows_recordings_and_crash_leftovers_but_not_the_one_running() {
        let dir = std::env::temp_dir().join(format!("zazabor-rec-list-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let done = dir.join("Recording 2026-10-27 10.00.mp4");
        let left = part_of(&dir.join("Recording 2026-10-27 11.00.mp4"));
        let running = part_of(&dir.join("Recording 2026-10-27 12.00.webm"));
        for f in [&done, &left, &running] {
            std::fs::write(f, b"x").unwrap();
        }
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        std::fs::write(dir.join(".hidden.mp4"), b"x").unwrap();
        let items = list(&dir, Some(&running));
        let names: Vec<_> = items.iter().map(|i| (i.0.file_name().unwrap().to_string_lossy().to_string(), i.1)).collect();
        assert_eq!(names.len(), 2, "{names:?}");
        assert!(names.contains(&("Recording 2026-10-27 10.00.mp4".into(), false)));
        assert!(names.contains(&(".Recording 2026-10-27 11.00.mp4.part".into(), true)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn free_space_is_checked_before_starting() {
        assert!(space_problem(Some(MIN_FREE_TO_START)).is_none());
        let why = space_problem(Some(500 * 1024 * 1024)).unwrap();
        assert!(why.contains("500 MB") && why.contains("2 GB"));
        assert!(space_problem(None).is_none());
        // A folder that doesn't exist yet is measured on the disk that will hold it.
        let deep = std::env::temp_dir().join("zazabor-rec-not-there/a/b");
        assert!(free_space(&deep).is_some());
        assert_eq!(human(3 * 1024 * 1024 * 1024 / 2), "1.5 GB");
    }

    #[test]
    fn pauses_are_left_out_of_the_length() {
        let t0 = Instant::now();
        let s = Duration::from_secs;
        let mut clock = PauseClock::default();
        assert_eq!(clock.elapsed_at(t0), Duration::ZERO);
        clock.start_at(t0);
        assert_eq!(clock.elapsed_at(t0 + s(4)), s(4));
        clock.pause_at(t0 + s(4));
        assert!(!clock.running());
        // Ten seconds paused don't count.
        assert_eq!(clock.elapsed_at(t0 + s(14)), s(4));
        clock.start_at(t0 + s(14));
        // Starting twice doesn't reset it.
        clock.start_at(t0 + s(15));
        assert_eq!(clock.elapsed_at(t0 + s(20)), s(10));
        clock.pause_at(t0 + s(20));
        clock.pause_at(t0 + s(30));
        assert_eq!(clock.elapsed_at(t0 + s(40)), s(10));
    }
}
