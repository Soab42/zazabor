//! Display sizes of photos, which the justified grid needs before any thumbnail loads.
//! Reading them means opening every file, so they are remembered across launches, keyed by
//! path, size and modification time.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::imaging;
use crate::scan::Photo;

/// File size, modification time, width and height; 0×0 marks a header that could not be read.
#[derive(Clone, Copy, Serialize, Deserialize)]
struct Entry(u64, f64, u32, u32);

#[derive(Default)]
struct Cache {
    entries: HashMap<String, Entry>,
    /// Paths looked up since launch; saving drops the rest (deleted files, removed folders).
    seen: HashSet<String>,
    dirty: bool,
}

static FILE: OnceLock<PathBuf> = OnceLock::new();
static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

pub fn init(file: PathBuf) {
    let _ = FILE.set(file);
}

fn with_cache<R>(f: impl FnOnce(&mut Cache) -> R) -> R {
    let mut slot = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = slot.get_or_insert_with(|| Cache {
        entries: FILE
            .get()
            .and_then(|file| fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default(),
        ..Cache::default()
    });
    f(cache)
}

/// Fills in each photo's `width` and `height`, reading new or changed files in parallel.
pub fn fill(photos: &mut [&mut Photo]) {
    let misses: Vec<usize> = with_cache(|cache| {
        let mut misses = Vec::new();
        for (i, photo) in photos.iter_mut().enumerate() {
            cache.seen.insert(photo.path.clone());
            match cache.entries.get(&photo.path) {
                Some(&Entry(size, mtime, w, h)) if size == photo.size && mtime == photo.mtime => {
                    (photo.width, photo.height) = (w, h);
                }
                _ => misses.push(i),
            }
        }
        misses
    });
    if misses.is_empty() {
        return;
    }
    let sizes: Vec<(u32, u32)> = misses
        .par_iter()
        .map(|&i| imaging::display_size(Path::new(&photos[i].path)).unwrap_or((0, 0)))
        .collect();
    with_cache(|cache| {
        for (&i, (w, h)) in misses.iter().zip(sizes) {
            let photo = &mut photos[i];
            (photo.width, photo.height) = (w, h);
            cache.entries.insert(photo.path.clone(), Entry(photo.size, photo.mtime, w, h));
        }
        cache.dirty = true;
    });
}

/// Writes the cache to disk if anything was added since the last save.
pub fn save() {
    let Some(file) = FILE.get() else { return };
    // Written under the lock so that two scans finishing together cannot interleave.
    with_cache(|cache| {
        if !cache.dirty {
            return;
        }
        let kept: HashMap<&String, &Entry> =
            cache.entries.iter().filter(|(path, _)| cache.seen.contains(*path)).collect();
        let Ok(json) = serde_json::to_vec(&kept) else { return };
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let tmp = file.with_extension("json.tmp");
        if fs::write(&tmp, json).and_then(|_| fs::rename(&tmp, file)).is_ok() {
            cache.dirty = false;
        }
    });
}
