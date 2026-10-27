//! Recursive search for the Files toolbar: a case-insensitive substring match with a simple
//! fuzzy fallback, ranked so word starts and consecutive letters come first. The walk runs on
//! its own thread and streams batches as `fs-search` events; a newer search cancels the old one.

use super::cloud;
use super::list::{self, FsEntry};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;
use walkdir::WalkDir;

/// Results beyond this are dropped; the search stops there.
pub const MAX_RESULTS: usize = 5000;
const BATCH: usize = 200;
const BATCH_EVERY: Duration = Duration::from_millis(90);

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    /// Look inside hidden folders and match hidden files.
    pub show_hidden: bool,
    /// Also walk `node_modules` and `.git`.
    pub include_ignored: bool,
}

/// The payload of the `fs-search` event.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchEvent {
    pub id: u64,
    pub results: Vec<FsEntry>,
    /// Relevance of each result (higher is better), parallel to `results`.
    pub scores: Vec<u32>,
    /// Entries looked at so far.
    pub scanned: u64,
    pub done: bool,
    /// The result cap was hit.
    pub truncated: bool,
}

type Sink<'a> = dyn FnMut(Vec<FsEntry>, Vec<u32>, u64, bool, bool) + 'a;

fn is_word_start(chars: &[char], i: usize) -> bool {
    i == 0 || !chars[i - 1].is_alphanumeric() || (chars[i - 1].is_lowercase() && chars[i].is_uppercase())
}

/// How well `name` matches `query` (already lower-case, non-empty); `None` when it does not.
/// Exact name > prefix > word start > substring (earlier is better) > fuzzy subsequence.
pub fn score(name: &str, query: &str) -> Option<u32> {
    let chars: Vec<char> = name.chars().collect();
    let lower: Vec<char> = name.to_lowercase().chars().collect();
    let q: Vec<char> = query.chars().collect();
    if q.is_empty() {
        return None;
    }
    if lower.len() != chars.len() {
        // Case folding changed the length (rare): a plain substring check will do.
        return name.to_lowercase().contains(query).then_some(300);
    }
    // Shorter names are closer to what was typed.
    let tidy = 50u32.saturating_sub(chars.len().min(50) as u32);
    if lower == q {
        return Some(1000 + tidy);
    }
    let mut best: Option<u32> = None;
    if lower.len() >= q.len() {
        for start in 0..=lower.len() - q.len() {
            if lower[start..start + q.len()] != q[..] {
                continue;
            }
            let s = if start == 0 {
                800
            } else if is_word_start(&chars, start) {
                600
            } else {
                400u32.saturating_sub(start.min(100) as u32)
            };
            best = Some(best.map_or(s, |b| b.max(s)));
            if start == 0 {
                break;
            }
        }
    }
    if let Some(s) = best {
        return Some(s + tidy);
    }
    // Fuzzy: the letters in order, preferring runs and word starts. Three letters or more, so
    // short queries don't match everything.
    if q.len() < 3 {
        return None;
    }
    let (mut qi, mut run, mut total) = (0usize, 0u32, 0u32);
    for (i, c) in lower.iter().enumerate() {
        if qi < q.len() && *c == q[qi] {
            run += 1;
            total += 4 + run * 6 + if is_word_start(&chars, i) { 12 } else { 0 };
            qi += 1;
        } else {
            run = 0;
        }
    }
    (qi == q.len()).then(|| (total.min(250) + tidy / 5).min(299))
}

/// Folders skipped unless asked for.
fn ignored(name: &str) -> bool {
    name == "node_modules" || name == ".git"
}

fn flush(batch: &mut Vec<(FsEntry, u32)>, scanned: u64, done: bool, truncated: bool, sink: &mut Sink) {
    batch.sort_by(|a, b| b.1.cmp(&a.1));
    let (results, scores): (Vec<_>, Vec<_>) = batch.drain(..).unzip();
    sink(results, scores, scanned, done, truncated);
}

/// Walks `root`, reporting ranked batches to `sink(results, scores, scanned, done, truncated)`.
/// `cancel` stops the walk early (the sink then gets no further calls).
pub fn run(root: &Path, query: &str, opts: &SearchOptions, cancel: &AtomicBool, sink: &mut Sink) {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        sink(Vec::new(), Vec::new(), 0, true, false);
        return;
    }
    if cloud::is_cloud(root) {
        return run_cloud(root, &q, opts, cancel, sink);
    }
    let mut batch: Vec<(FsEntry, u32)> = Vec::new();
    let (mut scanned, mut found, mut truncated) = (0u64, 0usize, false);
    let mut last = Instant::now();
    let walker = WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| {
        if e.depth() == 0 {
            return true;
        }
        let name = e.file_name().to_string_lossy();
        if !opts.show_hidden && name.starts_with('.') {
            return false;
        }
        !(e.file_type().is_dir() && !opts.include_ignored && ignored(&name))
    });
    for item in walker {
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        let Ok(item) = item else { continue };
        if item.depth() == 0 {
            continue;
        }
        scanned += 1;
        let name = item.file_name().to_string_lossy();
        if let Some(s) = score(&name, &q) {
            if let Ok(entry) = list::stat(item.path()) {
                batch.push((entry, s));
                found += 1;
            }
            if found >= MAX_RESULTS {
                truncated = true;
                break;
            }
        }
        if batch.len() >= BATCH || (!batch.is_empty() && last.elapsed() >= BATCH_EVERY) {
            flush(&mut batch, scanned, false, false, sink);
            last = Instant::now();
        }
    }
    if cancel.load(Ordering::SeqCst) {
        return;
    }
    flush(&mut batch, scanned, true, truncated, sink);
}

/// The same search on a cloud drive, folder by folder through GIO, matching titles (on disk the
/// names are ids). Each folder is a network request, so results arrive as folders are read.
fn run_cloud(root: &Path, q: &str, opts: &SearchOptions, cancel: &AtomicBool, sink: &mut Sink) {
    let mut batch: Vec<(FsEntry, u32)> = Vec::new();
    let (mut scanned, mut found, mut truncated) = (0u64, 0usize, false);
    let mut last = Instant::now();
    let mut folders = VecDeque::from([root.to_path_buf()]);
    'walk: while let Some(folder) = folders.pop_front() {
        let Ok(entries) = cloud::list(&folder, opts.show_hidden) else { continue };
        for entry in entries {
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            scanned += 1;
            if entry.dir && (opts.include_ignored || !ignored(&entry.name)) {
                folders.push_back(entry.path.clone().into());
            }
            if let Some(s) = score(&entry.name, q) {
                batch.push((entry, s));
                found += 1;
                if found >= MAX_RESULTS {
                    truncated = true;
                    break 'walk;
                }
            }
        }
        if !batch.is_empty() && (batch.len() >= BATCH || last.elapsed() >= BATCH_EVERY) {
            flush(&mut batch, scanned, false, false, sink);
            last = Instant::now();
        }
    }
    if cancel.load(Ordering::SeqCst) {
        return;
    }
    flush(&mut batch, scanned, true, truncated, sink);
}

fn registry() -> &'static Mutex<HashMap<u64, Arc<AtomicBool>>> {
    static SEARCHES: OnceLock<Mutex<HashMap<u64, Arc<AtomicBool>>>> = OnceLock::new();
    SEARCHES.get_or_init(Default::default)
}

/// Starts a search on its own thread, emitting `fs-search`; returns its id.
pub fn start(app: tauri::AppHandle, root: String, query: String, opts: SearchOptions) -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let cancel = Arc::new(AtomicBool::new(false));
    registry().lock().unwrap().insert(id, cancel.clone());
    std::thread::spawn(move || {
        let mut sink = |results, scores, scanned, done, truncated| {
            let _ = app.emit("fs-search", SearchEvent { id, results, scores, scanned, done, truncated });
        };
        run(Path::new(&root), &query, &opts, &cancel, &mut sink);
        registry().lock().unwrap().remove(&id);
    });
    id
}

pub fn cancel(id: u64) {
    if let Some(flag) = registry().lock().unwrap().get(&id) {
        flag.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zazabor-search-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: PathBuf) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x").unwrap();
    }

    fn search(root: &Path, query: &str, opts: &SearchOptions) -> Vec<String> {
        let mut out: Vec<(String, u32)> = Vec::new();
        let cancel = AtomicBool::new(false);
        run(root, query, opts, &cancel, &mut |r, s, _, _, _| {
            out.extend(r.into_iter().map(|e| e.name).zip(s));
        });
        out.sort_by(|a, b| b.1.cmp(&a.1));
        out.into_iter().map(|(n, _)| n).collect()
    }

    #[test]
    fn ranking_prefers_exact_prefix_word_start_then_substring() {
        let exact = score("report", "report").unwrap();
        let prefix = score("report final.txt", "report").unwrap();
        let word = score("final report.txt", "report").unwrap();
        let inner = score("myreports.txt", "report").unwrap();
        assert!(exact > prefix && prefix > word && word > inner, "{exact} {prefix} {word} {inner}");
        assert!(score("budget.xlsx", "report").is_none());
    }

    #[test]
    fn fuzzy_needs_the_letters_in_order_and_ranks_below_substrings() {
        let fuzzy = score("abxxr.pdf", "abr").unwrap();
        let loose = score("axbxr.pdf", "abr").unwrap();
        assert!(fuzzy > loose, "{fuzzy} {loose}");
        assert!(fuzzy < score("xabrx", "abr").unwrap());
        assert!(score("bar.txt", "abr").is_none());
        assert!(score("xyz", "xz").is_none(), "two letters never match fuzzily");
    }

    #[test]
    fn case_is_ignored_for_names_with_capitals() {
        assert!(score("Holiday Photos", "holiday").is_some());
        assert!(score("MyHolidayPhotos", "holiday").unwrap() >= 600, "camel case counts as a word start");
    }

    #[test]
    fn finds_nested_files_best_first() {
        let root = temp("nested");
        touch(root.join("a/deep/notes.txt"));
        touch(root.join("a/my-notes-old.txt"));
        touch(root.join("other.txt"));
        let found = search(&root, "notes", &SearchOptions::default());
        assert_eq!(found, vec!["notes.txt", "my-notes-old.txt"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_hidden_and_ignored_folders_by_default() {
        let root = temp("skip");
        touch(root.join("node_modules/pkg/target.js"));
        touch(root.join(".git/target.cfg"));
        touch(root.join(".hidden/target.txt"));
        touch(root.join(".target-dot"));
        touch(root.join("src/target.rs"));
        assert_eq!(search(&root, "target", &SearchOptions::default()), vec!["target.rs"]);
        let hidden = search(&root, "target", &SearchOptions { show_hidden: true, include_ignored: false });
        assert_eq!(hidden.len(), 3, "{hidden:?}");
        let all = search(&root, "target", &SearchOptions { show_hidden: true, include_ignored: true });
        assert_eq!(all.len(), 5, "{all:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn caps_results_and_reports_truncation() {
        let root = temp("cap");
        for i in 0..(MAX_RESULTS + 40) {
            touch(root.join(format!("d{}/hit{i}.txt", i % 7)));
        }
        let (mut count, mut truncated, mut done) = (0, false, false);
        let cancel = AtomicBool::new(false);
        run(&root, "hit", &SearchOptions::default(), &cancel, &mut |r, _, _, d, t| {
            count += r.len();
            truncated |= t;
            done |= d;
        });
        assert_eq!(count, MAX_RESULTS);
        assert!(truncated && done);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_cancelled_search_goes_quiet() {
        let root = temp("cancel");
        touch(root.join("hit.txt"));
        let cancel = AtomicBool::new(true);
        let mut calls = 0;
        run(&root, "hit", &SearchOptions::default(), &cancel, &mut |_, _, _, _, _| calls += 1);
        assert_eq!(calls, 0);
        let _ = fs::remove_dir_all(&root);
    }
}
