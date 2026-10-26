//! Keeps the notes in step with a folder: one Markdown file per note (`format.rs`), so a cloud
//! drive's folder (Google Drive or OneDrive through GNOME Online Accounts, Nextcloud, Dropbox,
//! Syncthing…) carries them to other computers and to the web.
//!
//! Three-way: for every note the last synced version (`Base`, as a hash of its file) tells which
//! side changed. One side changed: it wins. Both changed: the newer one wins and the other is kept
//! as a new note, so nothing is lost. A note deleted on one side goes from the other, unless that
//! side changed it since. Deleted notes stay in Recently Deleted for 30 days either way.
//!
//! The sync runs on its own thread: shortly after a change, when the folder changes, every minute,
//! and on request.

use super::{format, new_id, now, store, Note, APP};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;
use xxhash_rust::xxh3::xxh3_64;

const EVERY: Duration = Duration::from_secs(60);
/// A burst of edits (typing) syncs once, this long after the last one.
const SETTLE: Duration = Duration::from_millis(1500);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub folder: Option<String>,
    /// "off", "idle", "syncing" or "error".
    pub state: &'static str,
    /// When the last sync finished, ms since the epoch.
    pub last: Option<i64>,
    pub error: Option<String>,
}

/// What a file looked like when last seen; unchanged files aren't read again.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
struct Stamp {
    mtime: i64,
    size: u64,
}

/// A note as it was when both sides last agreed.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Base {
    /// The file's key in the folder (its name on disk).
    file: String,
    /// The name shown for it (on a cloud drive, the key is an id).
    name: String,
    hash: u64,
    stamp: Stamp,
}

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    folder: Option<PathBuf>,
    base: HashMap<String, Base>,
    last: Option<i64>,
}

enum Msg {
    Changed,
    Now,
    SetFolder(Option<PathBuf>),
}

static TX: OnceLock<Sender<Msg>> = OnceLock::new();
static STATUS: Mutex<Option<SyncStatus>> = Mutex::new(None);

pub fn start(dir: PathBuf) {
    let (tx, rx) = mpsc::channel();
    let _ = TX.set(tx);
    let path = dir.join("sync.json");
    let saved = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let worker = Worker { path, saved, watcher: None };
    worker.publish(None, None);
    std::thread::Builder::new()
        .name("notes-sync".into())
        .spawn(move || worker.run(rx))
        .expect("starting the notes sync");
}

/// The notes changed here: sync soon.
pub fn kick() {
    send(Msg::Changed);
}

fn send(msg: Msg) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(msg);
    }
}

fn status() -> SyncStatus {
    STATUS.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or(SyncStatus { folder: None, state: "off", last: None, error: None })
}

#[tauri::command]
pub fn notes_sync_status() -> SyncStatus {
    status()
}

/// Syncs with `folder` from now on; `None` turns sync off (the folder's files stay).
#[tauri::command]
pub fn notes_sync_set_folder(folder: Option<String>) -> Result<(), String> {
    let folder = folder.map(PathBuf::from);
    if let Some(dir) = &folder {
        if !dir.is_dir() {
            return Err(format!("{} isn’t a folder.", dir.display()));
        }
    }
    send(Msg::SetFolder(folder));
    Ok(())
}

#[tauri::command]
pub fn notes_sync_now() {
    send(Msg::Now);
}

struct Worker {
    path: PathBuf,
    saved: Saved,
    watcher: Option<RecommendedWatcher>,
}

impl Worker {
    fn run(mut self, rx: mpsc::Receiver<Msg>) {
        self.watch();
        self.sync();
        loop {
            match rx.recv_timeout(EVERY) {
                Ok(Msg::Changed) => {
                    // Let the burst finish; a new folder or "now" still applies at once.
                    loop {
                        match rx.recv_timeout(SETTLE) {
                            Ok(Msg::Changed) => continue,
                            Ok(Msg::Now) => break,
                            Ok(Msg::SetFolder(folder)) => self.set_folder(folder),
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    self.sync();
                }
                Ok(Msg::Now) | Err(RecvTimeoutError::Timeout) => self.sync(),
                Ok(Msg::SetFolder(folder)) => {
                    self.set_folder(folder);
                    self.sync();
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    /// A new folder starts from nothing: what was synced with the old one says nothing about it.
    fn set_folder(&mut self, folder: Option<PathBuf>) {
        if folder == self.saved.folder {
            return;
        }
        self.saved = Saved { folder, ..Default::default() };
        self.save();
        self.watch();
        self.publish(None, None);
    }

    /// Changes made in the folder by a sync client wake the sync. (A cloud drive mounted by GVfs
    /// sends no events; the minute timer covers it.)
    fn watch(&mut self) {
        self.watcher = None;
        let Some(folder) = self.saved.folder.clone().filter(|f| !is_cloud(f)) else { return };
        let watcher = notify::recommended_watcher(|event: notify::Result<notify::Event>| {
            use notify::event::{AccessKind, AccessMode, EventKind};
            let Ok(event) = event else { return };
            let ours = event.paths.iter().all(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.')));
            match event.kind {
                _ if ours => {}
                EventKind::Access(AccessKind::Close(AccessMode::Write)) => kick(),
                EventKind::Access(_) => {}
                _ => kick(),
            }
        });
        if let Ok(mut w) = watcher {
            if w.watch(&folder, RecursiveMode::NonRecursive).is_ok() {
                self.watcher = Some(w);
            }
        }
    }

    fn save(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("json.tmp");
        if let Ok(json) = serde_json::to_vec_pretty(&self.saved) {
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    fn publish(&self, state: Option<&'static str>, error: Option<String>) {
        let folder = self.saved.folder.as_ref().map(|f| f.to_string_lossy().into_owned());
        let state = if folder.is_none() { "off" } else { state.unwrap_or("idle") };
        let status = SyncStatus { folder, state, last: self.saved.last, error };
        *STATUS.lock().unwrap_or_else(|e| e.into_inner()) = Some(status.clone());
        if let Some(app) = APP.get() {
            let _ = app.emit("notes-sync", status);
        }
    }

    fn sync(&mut self) {
        let Some(folder) = self.saved.folder.clone() else { return };
        self.publish(Some("syncing"), None);
        let remote = FolderRemote::new(folder);
        let result = remote.check().and_then(|()| sync_with(&remote, &mut self.saved.base));
        match result {
            Ok(()) => {
                self.saved.last = Some(now());
                self.save();
                self.publish(Some("idle"), None);
            }
            Err(err) => {
                self.save();
                self.publish(Some("error"), Some(err));
            }
        }
    }
}

// ---- where notes go ---------------------------------------------------------------------------

/// A file there: its key (name on disk), shown name, and stamp.
struct Listed {
    key: String,
    name: String,
    stamp: Stamp,
}

/// Where notes sync to. A folder today; another service (OneNote) can be one too.
trait Remote {
    fn list(&self) -> Result<Vec<Listed>, String>;
    fn read(&self, key: &str) -> Result<String, String>;
    /// Writes over the file `key`, or creates a new file called `name` (or a free variant of it).
    fn write(&self, key: Option<&str>, name: &str, text: &str) -> Result<Listed, String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

/// A cloud drive mounted by GVfs, whose files are named by id on disk.
fn is_cloud(path: &Path) -> bool {
    crate::fs::is_cloud(path)
}

struct FolderRemote {
    dir: PathBuf,
    cloud: bool,
    /// Names in use, so a new file never lands on another note's.
    names: RefCell<HashSet<String>>,
}

fn io_err(what: &str, path: &Path, err: std::io::Error) -> String {
    format!("Couldn’t {what} {}: {err}", path.display())
}

fn stamp_of(meta: &std::fs::Metadata) -> Stamp {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Stamp { mtime, size: meta.len() }
}

fn is_note_file(name: &str) -> bool {
    !name.starts_with('.') && name.to_ascii_lowercase().ends_with(".md")
}

impl FolderRemote {
    fn new(dir: PathBuf) -> Self {
        let cloud = is_cloud(&dir);
        FolderRemote { dir, cloud, names: RefCell::default() }
    }

    fn check(&self) -> Result<(), String> {
        if self.dir.is_dir() {
            Ok(())
        } else {
            Err(format!("The sync folder isn’t available: {}. Is the drive connected?", self.dir.display()))
        }
    }

    fn free_name(&self, name: &str) -> String {
        let names = self.names.borrow();
        if !names.contains(name) {
            return name.to_string();
        }
        let stem = name.strip_suffix(".md").unwrap_or(name);
        (2..).map(|n| format!("{stem} {n}.md")).find(|n| !names.contains(n)).expect("a free name")
    }
}

impl Remote for FolderRemote {
    fn list(&self) -> Result<Vec<Listed>, String> {
        let mut out = Vec::new();
        if self.cloud {
            // GIO knows the titles; on disk the files are named by id.
            for entry in crate::fs::cloud_list(&self.dir)? {
                if entry.dir || !is_note_file(&entry.name) {
                    continue;
                }
                let key = Path::new(&entry.path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let stamp = Stamp { mtime: (entry.mtime * 1000.0) as i64, size: entry.size as u64 };
                out.push(Listed { key, name: entry.name, stamp });
            }
        } else {
            for entry in std::fs::read_dir(&self.dir).map_err(|e| io_err("read", &self.dir, e))? {
                let entry = entry.map_err(|e| io_err("read", &self.dir, e))?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if !is_note_file(&name) {
                    continue;
                }
                let Ok(meta) = std::fs::metadata(entry.path()) else { continue };
                if meta.is_file() {
                    out.push(Listed { key: name.clone(), name, stamp: stamp_of(&meta) });
                }
            }
        }
        *self.names.borrow_mut() = out.iter().map(|l| l.name.clone()).collect();
        Ok(out)
    }

    fn read(&self, key: &str) -> Result<String, String> {
        let path = self.dir.join(key);
        let bytes = std::fs::read(&path).map_err(|e| io_err("read", &path, e))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    fn write(&self, key: Option<&str>, name: &str, text: &str) -> Result<Listed, String> {
        let name = match key {
            Some(key) => key.to_string(),
            None => self.free_name(name),
        };
        let path = self.dir.join(&name);
        if self.cloud {
            std::fs::write(&path, text).map_err(|e| io_err("write", &path, e))?;
        } else {
            // Whole or not at all: a sync client never picks up half a note.
            let tmp = self.dir.join(format!(".{name}.tmp"));
            std::fs::write(&tmp, text).map_err(|e| io_err("write", &tmp, e))?;
            std::fs::rename(&tmp, &path).map_err(|e| io_err("write", &path, e))?;
        }
        self.names.borrow_mut().insert(name.clone());
        let stamp = std::fs::metadata(&path).map(|m| stamp_of(&m)).unwrap_or(Stamp { mtime: 0, size: 0 });
        Ok(Listed { key: name.clone(), name, stamp })
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        let path = self.dir.join(key);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_err("remove", &path, e)),
        }
        self.names.borrow_mut().remove(key);
        Ok(())
    }
}

// ---- the sync itself --------------------------------------------------------------------------

/// A note file found in the folder.
struct There {
    key: String,
    name: String,
    stamp: Stamp,
    hash: u64,
    /// Read only when the file changed since the last sync.
    text: Option<String>,
}

fn hash(text: &str) -> u64 {
    xxh3_64(text.as_bytes())
}

fn local_hash(note: &Note) -> u64 {
    hash(&format::to_file(note))
}

/// A note made from a file: its own fields where it has them, else `fallback`'s, else defaults.
fn note_from(text: &str, id: &str, mtime: i64, fallback: Option<&Note>) -> Note {
    let parsed = format::parse(text);
    let updated = match (parsed.updated, fallback) {
        // Changed without its date moving on: edited by hand, when the file changed.
        (Some(updated), Some(known)) if updated <= known.updated => mtime,
        (Some(updated), _) => updated,
        (None, _) => mtime,
    };
    Note {
        id: id.to_string(),
        title: parsed.title,
        body: parsed.body,
        color: parsed.color.or_else(|| fallback.map(|n| n.color.clone())).unwrap_or_else(|| "yellow".into()),
        pinned: parsed.pinned,
        status: parsed.status,
        position: parsed.position,
        created: parsed.created.or(fallback.map(|n| n.created)).unwrap_or(mtime),
        updated,
        deleted: None,
    }
}

/// Local changes the sync makes, applied together at the end. Each one only applies if the note
/// is still as it was when the sync started; an edit made meanwhile wins and syncs next time.
#[derive(Default)]
struct LocalChanges {
    put: Vec<(Option<Note>, Note)>,
}

impl LocalChanges {
    fn put(&mut self, expected: Option<&Note>, note: Note) {
        self.put.push((expected.cloned(), note));
    }

    /// Applies what still fits; returns the ids that did.
    fn apply(self) -> HashSet<String> {
        let mut applied = HashSet::new();
        if self.put.is_empty() {
            return applied;
        }
        let mut store = store();
        let mut changed = Vec::new();
        for (expected, note) in self.put {
            let current = store.saved.notes.iter_mut().find(|n| n.id == note.id);
            match (current, &expected) {
                (Some(current), Some(expected)) if current == expected => *current = note.clone(),
                (None, None) => store.saved.notes.push(note.clone()),
                _ => continue,
            }
            applied.insert(note.id.clone());
            changed.push(note);
        }
        store.save();
        if let Some(app) = APP.get() {
            let _ = app.emit("notes-changed", serde_json::json!({ "notes": changed, "removed": [], "origin": null }));
        }
        applied
    }
}

fn sync_with(remote: &dyn Remote, base: &mut HashMap<String, Base>) -> Result<(), String> {
    let mut files = remote.list()?;
    if files.is_empty() && !base.is_empty() {
        // An unmounted drive looks like an empty folder; never take that as "every note deleted".
        return Err("The sync folder is empty, so nothing was changed. If the drive is connected and you emptied it on purpose, turn sync off and on again.".into());
    }

    // Files synced before (and unchanged since) are known without reading them.
    let known: HashMap<&str, &str> = base.iter().map(|(id, b)| (b.file.as_str(), id.as_str())).collect();
    files.sort_by_key(|f| !known.contains_key(f.key.as_str()));
    let mut there: HashMap<String, There> = HashMap::new();
    let mut fresh: Vec<There> = Vec::new();
    for file in files {
        if let Some(&id) = known.get(file.key.as_str()) {
            let b = &base[id];
            if b.stamp == file.stamp && !there.contains_key(id) {
                there.insert(id.to_string(), There { key: file.key, name: file.name, stamp: file.stamp, hash: b.hash, text: None });
                continue;
            }
        }
        let text = remote.read(&file.key)?;
        let found = There { key: file.key, name: file.name, stamp: file.stamp, hash: hash(&text), text: Some(text) };
        match format::parse(found.text.as_deref().unwrap_or_default()).id {
            // A second file with the same id (a drive's conflict copy) becomes a note of its own.
            Some(id) if !there.contains_key(&id) => {
                there.insert(id, found);
            }
            _ => fresh.push(found),
        }
    }
    drop(known);

    let snapshot: Vec<Note> = store().saved.notes.clone();
    let local: HashMap<&str, &Note> = snapshot.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut ids: Vec<String> = local.keys().map(|s| s.to_string()).collect();
    ids.extend(there.keys().cloned());
    ids.extend(base.keys().cloned());
    ids.sort();
    ids.dedup();

    let mut changes = LocalChanges::default();
    // Files to write once the local side took the notes: (note, the file it replaces).
    let mut uploads: Vec<(Note, Option<(String, String)>)> = Vec::new();
    // Files whose note now matches them, recorded as the new base if the local change applied.
    let mut imported: Vec<(String, There)> = Vec::new();
    let read = |t: &There| -> Result<String, String> { t.text.clone().map_or_else(|| remote.read(&t.key), Ok) };

    for id in ids {
        let l = local.get(id.as_str()).copied();
        let r = there.remove(&id);
        let b = base.get(&id).cloned();
        match (l, r) {
            (Some(n), Some(r)) if n.deleted.is_none() => {
                let lhash = local_hash(n);
                let lch = b.as_ref().is_none_or(|b| b.hash != lhash);
                let rch = b.as_ref().is_none_or(|b| b.hash != r.hash);
                if lhash == r.hash {
                    base.insert(id, Base { file: r.key, name: r.name, hash: r.hash, stamp: r.stamp });
                } else if lch && !rch {
                    uploads.push((n.clone(), Some((r.key, r.name))));
                } else if !lch && rch {
                    let text = read(&r)?;
                    changes.put(Some(n), note_from(&text, &id, r.stamp.mtime, Some(n)));
                    imported.push((id, There { text: Some(text), ..r }));
                } else {
                    // Both changed: the newer wins, the other stays as a note of its own.
                    let text = read(&r)?;
                    let theirs = note_from(&text, &id, r.stamp.mtime, Some(n));
                    let at = now();
                    if n.updated >= theirs.updated {
                        let copy = Note { id: new_id(), created: at, ..theirs };
                        changes.put(None, copy.clone());
                        uploads.push((copy, None));
                        uploads.push((n.clone(), Some((r.key, r.name))));
                    } else {
                        let copy = Note { id: new_id(), created: at, ..n.clone() };
                        changes.put(None, copy.clone());
                        uploads.push((copy, None));
                        changes.put(Some(n), theirs);
                        imported.push((id, There { text: Some(text), ..r }));
                    }
                }
            }
            (Some(n), None) if n.deleted.is_none() => {
                let unchanged = b.as_ref().is_some_and(|b| b.hash == local_hash(n));
                if unchanged {
                    // Deleted elsewhere: to Recently Deleted here too.
                    changes.put(Some(n), Note { deleted: Some(now()), ..n.clone() });
                    base.remove(&id);
                } else {
                    uploads.push((n.clone(), None));
                }
            }
            (Some(n), Some(r)) => {
                // Deleted here.
                if b.as_ref().is_some_and(|b| b.hash == r.hash) {
                    remote.remove(&r.key)?;
                    base.remove(&id);
                } else {
                    // Changed there since: it comes back.
                    let text = read(&r)?;
                    changes.put(Some(n), note_from(&text, &id, r.stamp.mtime, Some(n)));
                    imported.push((id, There { text: Some(text), ..r }));
                }
            }
            (Some(_), None) | (None, None) => {
                base.remove(&id);
            }
            (None, Some(r)) => {
                if b.as_ref().is_some_and(|b| b.hash == r.hash) {
                    // Removed for good here.
                    remote.remove(&r.key)?;
                    base.remove(&id);
                } else {
                    let text = read(&r)?;
                    changes.put(None, note_from(&text, &id, r.stamp.mtime, None));
                    imported.push((id, There { text: Some(text), ..r }));
                }
            }
        }
    }

    // Markdown files without a note id (written by hand, or a drive's conflict copy) become notes.
    for f in fresh {
        let text = f.text.clone().unwrap_or_default();
        let note = note_from(&text, &new_id(), f.stamp.mtime, None);
        changes.put(None, note.clone());
        imported.push((note.id, f));
    }

    let applied = changes.apply();
    for (id, r) in imported {
        if !applied.contains(&id) {
            continue;
        }
        let note = store().saved.notes.iter().find(|n| n.id == id).cloned();
        let Some(note) = note else { continue };
        // A file not in our own format (no id yet, hand-edited) is rewritten so both sides match.
        if format::to_file(&note) == r.text.as_deref().unwrap_or_default() && format::file_name(&note) == r.name {
            base.insert(id, Base { file: r.key, name: r.name, hash: r.hash, stamp: r.stamp });
        } else {
            uploads.push((note, Some((r.key, r.name))));
        }
    }

    for (note, current) in uploads {
        // Only notes that still exist here as written (a copy that didn't apply is dropped).
        let live = store().saved.notes.iter().any(|n| n.id == note.id);
        if !live {
            continue;
        }
        let text = format::to_file(&note);
        let name = format::file_name(&note);
        let written = match &current {
            Some((key, shown)) if *shown == name => remote.write(Some(key), &name, &text)?,
            Some((key, _)) => {
                let written = remote.write(None, &name, &text)?;
                remote.remove(key)?;
                written
            }
            None => remote.write(None, &name, &text)?,
        };
        base.insert(note.id, Base { file: written.key, name: written.name, hash: hash(&text), stamp: written.stamp });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{notes_create, notes_delete, notes_update, Saved as Notes, Store, STORE};
    use super::*;

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    fn note(id: &str) -> Option<Note> {
        store().saved.notes.iter().find(|n| n.id == id).cloned()
    }

    /// Edits a note's file as another computer or a person on the web would.
    fn edit_file(dir: &Path, name: &str, edit: impl Fn(&str) -> String) {
        let path = dir.join(name);
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, edit(&text)).unwrap();
    }

    // One test: the note store is global to the process.
    #[test]
    fn syncs_with_a_folder() {
        let root = std::env::temp_dir().join(format!("corepro-notes-sync-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("drive");
        std::fs::create_dir_all(&dir).unwrap();
        let _ = STORE.set(Mutex::new(Store { path: root.join("notes.json"), saved: Notes::default() }));
        let remote = FolderRemote::new(dir.clone());
        let mut base = HashMap::new();
        let sync = |base: &mut HashMap<String, Base>| sync_with(&FolderRemote::new(dir.clone()), base);

        // A note goes up as a Markdown file named after its first line.
        let a = notes_create(Some("green".into()), Some("Shopping\n- [ ] Milk".into()), None, None).unwrap();
        sync(&mut base).unwrap();
        let a_file = format!("Shopping ({}).md", &a.id[..6]);
        assert_eq!(files(&dir), [a_file.clone()]);
        assert_eq!(format::parse(&std::fs::read_to_string(dir.join(&a_file)).unwrap()).body, "Shopping\n- [ ] Milk");

        // Nothing changed: nothing is written.
        let before = std::fs::metadata(dir.join(&a_file)).unwrap().modified().unwrap();
        sync(&mut base).unwrap();
        assert_eq!(std::fs::metadata(dir.join(&a_file)).unwrap().modified().unwrap(), before);

        // An edit made elsewhere comes in.
        edit_file(&dir, &a_file, |t| t.replace("- [ ] Milk", "- [x] Milk\n- [ ] Eggs"));
        sync(&mut base).unwrap();
        assert_eq!(note(&a.id).unwrap().body, "Shopping\n- [x] Milk\n- [ ] Eggs");

        // A new first line renames the file.
        notes_update(a.id.clone(), None, Some("Groceries\n- [x] Milk\n- [ ] Eggs".into()), None, None, None, None, None).unwrap();
        sync(&mut base).unwrap();
        let a_file = format!("Groceries ({}).md", &a.id[..6]);
        assert_eq!(files(&dir), [a_file.clone()]);

        // Changed on both sides: the newer one wins, the other stays as a note of its own.
        edit_file(&dir, &a_file, |t| t.replace("- [ ] Eggs", "- [ ] Eggs from the phone"));
        std::thread::sleep(Duration::from_millis(5));
        notes_update(a.id.clone(), None, Some("Groceries\n- [x] Milk\n- [ ] Eggs from the laptop".into()), None, None, None, None, None).unwrap();
        sync(&mut base).unwrap();
        assert_eq!(note(&a.id).unwrap().body, "Groceries\n- [x] Milk\n- [ ] Eggs from the laptop");
        let copies: Vec<Note> = store().saved.notes.iter().filter(|n| n.body.contains("from the phone")).cloned().collect();
        assert_eq!(copies.len(), 1);
        assert_ne!(copies[0].id, a.id);
        assert_eq!(files(&dir).len(), 2);
        assert!(std::fs::read_to_string(dir.join(&a_file)).unwrap().contains("from the laptop"));

        // A Markdown file written by hand becomes a note, and gets an id and a date.
        std::fs::write(dir.join("Ideas.md"), "Ideas\n- **ship it**\n").unwrap();
        sync(&mut base).unwrap();
        let idea = store().saved.notes.iter().find(|n| n.body == "Ideas\n- **ship it**").cloned().expect("imported");
        assert!(!dir.join("Ideas.md").exists());
        let idea_file = format!("Ideas ({}).md", &idea.id[..6]);
        assert_eq!(format::parse(&std::fs::read_to_string(dir.join(&idea_file)).unwrap()).id.as_deref(), Some(idea.id.as_str()));
        // ...and stays one note on the next sync.
        sync(&mut base).unwrap();
        assert_eq!(store().saved.notes.iter().filter(|n| n.body == "Ideas\n- **ship it**").count(), 1);

        // Deleted elsewhere: to Recently Deleted here.
        std::fs::remove_file(dir.join(&idea_file)).unwrap();
        sync(&mut base).unwrap();
        assert!(note(&idea.id).unwrap().deleted.is_some());

        // Deleted here: the file goes.
        notes_delete(copies[0].id.clone()).unwrap();
        sync(&mut base).unwrap();
        assert_eq!(files(&dir), [a_file.clone()]);

        // An empty folder (an unmounted drive) changes nothing here.
        std::fs::remove_file(dir.join(&a_file)).unwrap();
        assert!(sync(&mut base).is_err());
        assert!(note(&a.id).unwrap().deleted.is_none());

        drop(remote);
        let _ = std::fs::remove_dir_all(&root);
    }
}
