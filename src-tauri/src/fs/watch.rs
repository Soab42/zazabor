//! Non-recursive folder watching, reference-counted per path and debounced.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;

const DEBOUNCE: Duration = Duration::from_millis(150);

struct Watch {
    count: usize,
    _watcher: RecommendedWatcher,
}

#[derive(Serialize, Clone)]
struct Changed {
    path: String,
}

fn watches() -> &'static Mutex<HashMap<PathBuf, Watch>> {
    static WATCHES: OnceLock<Mutex<HashMap<PathBuf, Watch>>> = OnceLock::new();
    WATCHES.get_or_init(Default::default)
}

/// Whether an event changes what a listing shows. Opening or reading a file doesn't, and listing
/// the folder opens it: counting those would make every listing set off another, forever.
fn is_change(kind: &notify::EventKind) -> bool {
    use notify::event::{AccessKind, AccessMode};
    match kind {
        // A file closed after writing has new contents.
        notify::EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        notify::EventKind::Access(_) => false,
        _ => true,
    }
}

/// Emits `fs-changed` once per burst of events: the first event arms a timer, later ones
/// within the window are absorbed.
fn make_watcher(app: tauri::AppHandle, folder: &Path) -> Result<RecommendedWatcher, String> {
    let pending = Arc::new(AtomicBool::new(false));
    let shown = folder.to_string_lossy().into_owned();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if !is_change(&event.kind) || pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let (app, pending, path) = (app.clone(), pending.clone(), shown.clone());
        std::thread::spawn(move || {
            std::thread::sleep(DEBOUNCE);
            pending.store(false, Ordering::SeqCst);
            let _ = app.emit("fs-changed", Changed { path });
        });
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(folder, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Cannot watch {}: {e}", folder.display()))?;
    Ok(watcher)
}

pub fn watch(app: tauri::AppHandle, folder: PathBuf) -> Result<(), String> {
    let mut map = watches().lock().map_err(|e| e.to_string())?;
    if let Some(existing) = map.get_mut(&folder) {
        existing.count += 1;
        return Ok(());
    }
    let watcher = make_watcher(app, &folder)?;
    map.insert(folder, Watch { count: 1, _watcher: watcher });
    Ok(())
}

pub fn unwatch(folder: &Path) {
    if let Ok(mut map) = watches().lock() {
        if let Some(existing) = map.get_mut(folder) {
            existing.count -= 1;
            if existing.count == 0 {
                map.remove(folder);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, AccessMode, CreateKind, ModifyKind};
    use notify::EventKind;

    #[test]
    fn reading_is_not_a_change() {
        assert!(!is_change(&EventKind::Access(AccessKind::Open(AccessMode::Any))));
        assert!(!is_change(&EventKind::Access(AccessKind::Close(AccessMode::Read))));
        assert!(is_change(&EventKind::Create(CreateKind::File)));
        assert!(is_change(&EventKind::Modify(ModifyKind::Any)));
        assert!(is_change(&EventKind::Access(AccessKind::Close(AccessMode::Write))));
    }
}
