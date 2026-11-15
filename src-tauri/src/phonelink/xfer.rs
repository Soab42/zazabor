//! File transfers over the link, both ways (docs/plans/phone-link.md §1, `file.*`, `files.get`,
//! `files.put`, `xfer.cancel`).
//!
//! A file coming in is written to a hidden part file next to where it goes, hashed as it arrives,
//! and renamed into place (" (2)" when the name is taken) only once its SHA-256 matches the one
//! the phone sent. A file going out is read in 256 KiB pieces and ends with its hash. The page
//! hears about each transfer at most every 250 ms, and always when it ends.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::link::{hex, Link, CHUNK};
use super::{lock, Hub};

/// How often a running transfer tells the page.
const EMIT_EVERY: Duration = Duration::from_millis(250);
/// Finished transfers the tray keeps.
const KEEP_FINISHED: usize = 100;

/// One transfer, as the page sees it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: u32,
    pub phone_id: String,
    pub name: String,
    pub size: u64,
    pub done: u64,
    /// "in" (phone → PC) or "out".
    pub dir: &'static str,
    /// "queued", "running", "done", "failed" or "cancelled".
    pub state: &'static str,
    /// Where it went: the PC path for "in", the phone's for "out".
    pub path: Option<String>,
    pub error: Option<String>,
}

impl Transfer {
    pub fn finished(&self) -> bool {
        matches!(self.state, "done" | "failed" | "cancelled")
    }
}

/// A file being written.
struct Sink {
    file: File,
    part: PathBuf,
    dir: PathBuf,
    hasher: Sha256,
}

struct Entry {
    t: Transfer,
    /// The id on the wire (the PC's even ids are the same as `t.id`; the phone's odd ones aren't).
    wire: u32,
    sink: Option<Sink>,
    last_emit: Option<Instant>,
    /// A download whose `files.get` answer (size, name) hasn't been read yet.
    awaiting_answer: bool,
}

pub struct Transfers {
    all: Mutex<BTreeMap<u32, Entry>>,
    next: AtomicU32,
}

/// A file name from the phone, safe to put in a folder.
pub fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control()).collect();
    let clean = clean.trim().trim_start_matches('.').to_string();
    if clean.is_empty() {
        "file".into()
    } else {
        clean
    }
}

/// `dir/name`, or `dir/name (2).ext`, `(3)`… when that's taken.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).expect("a free name")
}

/// A phone folder and a name under it ("Download/Zazabor" + "a" → "Download/Zazabor/a").
pub fn phone_join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{}/{name}", dir.trim_end_matches('/'))
    }
}

impl Transfers {
    pub fn new() -> Transfers {
        Transfers { all: Mutex::new(BTreeMap::new()), next: AtomicU32::new(2) }
    }

    fn new_id(&self) -> u32 {
        self.next.fetch_add(2, Ordering::SeqCst)
    }

    pub fn list(&self) -> Vec<Transfer> {
        lock(&self.all).values().map(|e| e.t.clone()).collect()
    }

    pub fn get(&self, id: u32) -> Option<Transfer> {
        lock(&self.all).get(&id).map(|e| e.t.clone())
    }

    fn add(&self, hub: &Hub, t: Transfer, wire: u32, sink: Option<Sink>) {
        let snapshot = t.clone();
        let mut all = lock(&self.all);
        all.insert(t.id, Entry { t, wire, sink, last_emit: Some(Instant::now()), awaiting_answer: false });
        // Forget the oldest finished ones.
        let finished: Vec<u32> = all.iter().filter(|(_, e)| e.t.finished()).map(|(id, _)| *id).collect();
        for id in finished.iter().take(finished.len().saturating_sub(KEEP_FINISHED)) {
            all.remove(id);
        }
        drop(all);
        hub.transfer_changed(&snapshot);
    }

    fn find(all: &BTreeMap<u32, Entry>, phone_id: &str, wire: u32) -> Option<u32> {
        all.iter().find(|(_, e)| e.wire == wire && e.t.phone_id == phone_id && !e.t.finished()).map(|(id, _)| *id)
    }

    /// Ends a transfer: drops a partial file, tells the page.
    fn finish(&self, hub: &Hub, id: u32, state: &'static str, error: Option<String>) -> Option<Transfer> {
        let mut all = lock(&self.all);
        let e = all.get_mut(&id).filter(|e| !e.t.finished())?;
        e.t.state = state;
        e.t.error = error;
        if let Some(sink) = e.sink.take() {
            drop(sink.file);
            let _ = std::fs::remove_file(&sink.part);
        }
        let t = e.t.clone();
        drop(all);
        hub.transfer_changed(&t);
        Some(t)
    }

    fn update(&self, hub: &Hub, id: u32, f: impl FnOnce(&mut Transfer)) {
        let mut all = lock(&self.all);
        let Some(e) = all.get_mut(&id) else { return };
        f(&mut e.t);
        e.last_emit = Some(Instant::now());
        let t = e.t.clone();
        drop(all);
        hub.transfer_changed(&t);
    }

    /// Counts bytes sent or received, telling the page at most every 250 ms.
    fn progress(&self, hub: &Hub, id: u32, n: u64) {
        let mut all = lock(&self.all);
        let Some(e) = all.get_mut(&id) else { return };
        e.t.done += n;
        if e.last_emit.is_some_and(|at| at.elapsed() < EMIT_EVERY) {
            return;
        }
        e.last_emit = Some(Instant::now());
        let t = e.t.clone();
        drop(all);
        hub.transfer_changed(&t);
    }

    fn is_cancelled(&self, id: u32) -> bool {
        lock(&self.all).get(&id).is_none_or(|e| e.t.finished())
    }

    // ---- coming in

    /// Starts receiving a file into `dir`; returns its id. `wire` is the phone's id for a
    /// transfer it offered, None for one the PC asks for (then the wire id is the PC's own).
    fn incoming(&self, hub: &Hub, phone_id: &str, wire: Option<u32>, name: &str, size: u64, dir: &Path) -> Result<u32, String> {
        let id = self.new_id();
        let name = safe_name(name);
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't make the folder {}: {e}", dir.display()))?;
        let part = dir.join(format!(".{name}.{id}.zazabor-part"));
        let file = File::create(&part).map_err(|e| format!("Couldn't write in {}: {e}", dir.display()))?;
        let t = Transfer { id, phone_id: phone_id.into(), name, size, done: 0, dir: "in", state: "running", path: None, error: None };
        self.add(hub, t, wire.unwrap_or(id), Some(Sink { file, part, dir: dir.to_path_buf(), hasher: Sha256::new() }));
        Ok(id)
    }

    /// The phone offers a file (its share sheet): take it into the download folder.
    pub(super) fn offered(&self, hub: &Hub, link: &Link, msg: &Value) {
        let Some(wire) = msg.get("xfer").and_then(Value::as_u64).map(|x| x as u32) else { return };
        let name = msg.get("name").and_then(Value::as_str).unwrap_or("file");
        let size = msg.get("size").and_then(Value::as_u64).unwrap_or(0);
        match self.incoming(hub, &link.phone_id, Some(wire), name, size, &hub.download_dir()) {
            Ok(_) => {
                let _ = link.send(json!({"t": "file.accept", "xfer": wire}));
            }
            Err(err) => {
                eprintln!("Phone Link: {err}");
                let _ = link.send(json!({"t": "file.reject", "xfer": wire}));
            }
        }
    }

    /// A `2`-frame.
    pub(super) fn data(&self, hub: &Hub, phone_id: &str, wire: u32, bytes: &[u8]) {
        let mut all = lock(&self.all);
        let Some(id) = Self::find(&all, phone_id, wire) else { return };
        let e = all.get_mut(&id).expect("found");
        let Some(sink) = e.sink.as_mut() else { return };
        sink.hasher.update(bytes);
        if let Err(err) = sink.file.write_all(bytes) {
            drop(all);
            self.finish(hub, id, "failed", Some(format!("Couldn't save the file: {err}")));
            return;
        }
        drop(all);
        self.progress(hub, id, bytes.len() as u64);
    }

    /// `file.end`: check the hash, then put the file in place.
    pub(super) fn ended(&self, hub: &Hub, phone_id: &str, msg: &Value) {
        let Some(wire) = msg.get("xfer").and_then(Value::as_u64).map(|x| x as u32) else { return };
        let sha = msg.get("sha256").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
        // A small file can end before the thread that asked for it has read the answer (which
        // may rename it); give that thread a moment.
        for _ in 0..200 {
            let all = lock(&self.all);
            let waiting = Self::find(&all, phone_id, wire).and_then(|id| all.get(&id)).is_some_and(|e| e.awaiting_answer);
            drop(all);
            if !waiting {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let mut all = lock(&self.all);
        let Some(id) = Self::find(&all, phone_id, wire) else { return };
        let e = all.get_mut(&id).expect("found");
        let Some(mut sink) = e.sink.take() else { return };
        let name = e.t.name.clone();
        drop(all);
        let got = hex(&sink.hasher.finalize_reset());
        let flushed = sink.file.flush().and_then(|_| sink.file.sync_all());
        drop(sink.file);
        let result = if got != sha {
            Err("The file arrived damaged. Try again.".to_string())
        } else if let Err(e) = flushed {
            Err(format!("Couldn't save the file: {e}"))
        } else {
            let dest = unique_path(&sink.dir, &name);
            std::fs::rename(&sink.part, &dest).map(|_| dest).map_err(|e| format!("Couldn't save the file: {e}"))
        };
        match result {
            Ok(dest) => self.update(hub, id, |t| {
                t.state = "done";
                t.path = Some(dest.to_string_lossy().into_owned());
                t.name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name);
                if t.size == 0 {
                    t.size = t.done;
                }
            }),
            Err(err) => {
                let _ = std::fs::remove_file(&sink.part);
                self.finish(hub, id, "failed", Some(err));
            }
        }
    }

    /// The phone cancelled a transfer.
    pub(super) fn cancelled(&self, hub: &Hub, phone_id: &str, msg: &Value) {
        let Some(wire) = msg.get("xfer").and_then(Value::as_u64).map(|x| x as u32) else { return };
        let id = Self::find(&lock(&self.all), phone_id, wire);
        if let Some(id) = id {
            self.finish(hub, id, "cancelled", None);
        }
    }

    /// The user cancelled a transfer; the phone hears about it too.
    pub fn cancel(&self, hub: &Hub, id: u32) -> Result<(), String> {
        let (phone_id, wire) = {
            let all = lock(&self.all);
            let e = all.get(&id).ok_or("That transfer is gone.")?;
            (e.t.phone_id.clone(), e.wire)
        };
        if self.finish(hub, id, "cancelled", None).is_some() {
            if let Some(link) = hub.link(&phone_id) {
                let _ = link.send(json!({"t": "xfer.cancel", "xfer": wire}));
            }
        }
        Ok(())
    }

    /// The phone went away: whatever was moving with it failed.
    pub(super) fn phone_gone(&self, hub: &Hub, phone_id: &str) {
        let ids: Vec<u32> = lock(&self.all).iter().filter(|(_, e)| e.t.phone_id == phone_id && !e.t.finished()).map(|(id, _)| *id).collect();
        for id in ids {
            self.finish(hub, id, "failed", Some("The phone disconnected.".into()));
        }
    }
}

// ---- downloads and uploads, each on its own thread

/// Fetches phone files into `dest`, one after another. Returns their transfer ids at once.
pub(super) fn download(hub: &Arc<Hub>, link: Arc<Link>, items: Vec<(String, Option<String>)>, dest: PathBuf) -> Vec<u32> {
    let xf = &hub.transfers;
    let ids: Vec<u32> = items
        .iter()
        .map(|(p, name)| {
            let name = safe_name(name.as_deref().unwrap_or(p));
            let t = Transfer { id: xf.new_id(), phone_id: link.phone_id.clone(), name, size: 0, done: 0, dir: "in", state: "queued", path: None, error: None };
            let id = t.id;
            xf.add(hub, t, id, None);
            id
        })
        .collect();
    let hub = hub.clone();
    let queue = ids.clone();
    std::thread::spawn(move || {
        let xf = &hub.transfers;
        for (id, (path, _)) in queue.into_iter().zip(items) {
            if xf.is_cancelled(id) {
                continue;
            }
            if let Err(err) = fetch(&hub, &link, id, &path, &dest) {
                xf.finish(&hub, id, "failed", Some(err));
            }
        }
    });
    ids
}

/// One download: open the part file, ask the phone, wait while the reader thread fills it.
/// `path` goes to the phone as it is (a file path or a `content://` URI).
fn fetch(hub: &Arc<Hub>, link: &Link, id: u32, path: &str, dest: &Path) -> Result<(), String> {
    let xf = &hub.transfers;
    let Some(name) = xf.get(id).map(|t| t.name) else { return Ok(()) };
    std::fs::create_dir_all(dest).map_err(|e| format!("Couldn't make the folder {}: {e}", dest.display()))?;
    let part = dest.join(format!(".{name}.{id}.zazabor-part"));
    let file = File::create(&part).map_err(|e| format!("Couldn't write in {}: {e}", dest.display()))?;
    {
        let mut all = lock(&xf.all);
        let Some(e) = all.get_mut(&id).filter(|e| !e.t.finished()) else {
            let _ = std::fs::remove_file(&part);
            return Ok(());
        };
        e.t.state = "running";
        e.awaiting_answer = true;
        e.sink = Some(Sink { file, part, dir: dest.to_path_buf(), hasher: Sha256::new() });
    }
    xf.update(hub, id, |_| {});
    let answer = link.request(json!({"t": "files.get", "path": path, "xfer": id}), hub.timing.request);
    {
        let mut all = lock(&xf.all);
        if let Some(e) = all.get_mut(&id) {
            e.awaiting_answer = false;
        }
        let got = answer.as_ref().ok();
        if let (Some(e), Some(answer)) = (all.get_mut(&id), got) {
            if let Some(size) = answer.get("size").and_then(Value::as_u64) {
                e.t.size = size;
            }
            // A name the phone knows better (a content URI's display name), unless the page gave one.
            let given = e.t.name != safe_name(path);
            if let Some(n) = answer.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty() && !given && !e.t.finished()) {
                e.t.name = safe_name(n);
            }
        }
    }
    answer?;
    // The data and `file.end` come in on the reader thread; wait for the end, or a stall.
    let mut last = (0, Instant::now());
    loop {
        std::thread::sleep(Duration::from_millis(50));
        let Some(t) = xf.get(id) else { return Ok(()) };
        if t.finished() {
            return Ok(());
        }
        if link.is_closed() {
            return Err("The phone disconnected.".into());
        }
        if t.done != last.0 {
            last = (t.done, Instant::now());
        } else if last.1.elapsed() > hub.timing.stall {
            let _ = link.send(json!({"t": "xfer.cancel", "xfer": id}));
            return Err("The phone stopped sending the file.".into());
        }
    }
}

/// What uploading a list of PC paths sends: each file, and the phone folder it goes into.
/// Folders recurse; their own name becomes a folder on the phone.
pub fn expand(paths: &[PathBuf], dir: &str) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    for p in paths {
        if p.is_dir() {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let sub = phone_join(dir, &name);
            let mut kids: Vec<PathBuf> = std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default();
            kids.sort();
            out.extend(expand(&kids, &sub));
        } else if p.is_file() {
            out.push((p.clone(), dir.to_string()));
        }
    }
    out
}

/// Sends PC files to the phone's folder `dir`, one after another. Returns their ids at once.
pub(super) fn upload(hub: &Arc<Hub>, link: Arc<Link>, paths: Vec<PathBuf>, dir: String) -> Result<Vec<u32>, String> {
    let items = expand(&paths, &dir);
    if items.is_empty() {
        return Err("There's nothing to send there.".into());
    }
    let xf = &hub.transfers;
    let queued: Vec<(u32, PathBuf, String)> = items
        .into_iter()
        .map(|(path, dir)| {
            let id = xf.new_id();
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            xf.add(hub, Transfer { id, phone_id: link.phone_id.clone(), name, size, done: 0, dir: "out", state: "queued", path: None, error: None }, id, None);
            (id, path, dir)
        })
        .collect();
    let ids = queued.iter().map(|q| q.0).collect();
    let hub = hub.clone();
    std::thread::spawn(move || {
        for (id, path, dir) in queued {
            if hub.transfers.is_cancelled(id) {
                continue;
            }
            if let Err(err) = put(&hub, &link, id, &path, &dir) {
                if hub.transfers.finish(&hub, id, "failed", Some(err)).is_some() {
                    let _ = link.send(json!({"t": "xfer.cancel", "xfer": id}));
                }
            }
        }
    });
    Ok(ids)
}

/// One upload.
fn put(hub: &Hub, link: &Link, id: u32, path: &Path, dir: &str) -> Result<(), String> {
    let xf = &hub.transfers;
    let mut file = File::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    xf.update(hub, id, |t| t.state = "running");
    let answer = link.request(json!({"t": "files.put", "dir": dir, "name": name, "size": size, "xfer": id}), hub.timing.request)?;
    let final_path = answer.get("path").and_then(Value::as_str).map(str::to_string);
    xf.update(hub, id, |t| t.path = final_path);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        if xf.is_cancelled(id) {
            return Ok(());
        }
        let n = file.read(&mut buf).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        link.send_data(id, &buf[..n])?;
        xf.progress(hub, id, n as u64);
    }
    link.send(json!({"t": "file.end", "xfer": id, "sha256": hex(&hasher.finalize())}))?;
    xf.update(hub, id, |t| t.state = "done");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe_and_unique() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("/storage/emulated/0/DCIM/a.jpg"), "a.jpg");
        assert_eq!(safe_name(".."), "file");
        assert_eq!(safe_name(".hidden"), "hidden");
        let dir = std::env::temp_dir().join(format!("zlnk-names-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.jpg"), b"x").unwrap();
        std::fs::write(dir.join("a (2).jpg"), b"x").unwrap();
        std::fs::write(dir.join("notes"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "a.jpg"), dir.join("a (3).jpg"));
        assert_eq!(unique_path(&dir, "notes"), dir.join("notes (2)"));
        assert_eq!(unique_path(&dir, "b.jpg"), dir.join("b.jpg"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn folders_recurse_into_phone_folders() {
        let root = std::env::temp_dir().join(format!("zlnk-expand-{}", std::process::id()));
        std::fs::create_dir_all(root.join("Trip/day1")).unwrap();
        std::fs::write(root.join("Trip/a.jpg"), b"a").unwrap();
        std::fs::write(root.join("Trip/day1/b.jpg"), b"b").unwrap();
        std::fs::write(root.join("c.txt"), b"c").unwrap();
        let got = expand(&[root.join("Trip"), root.join("c.txt")], "Download/Zazabor");
        assert_eq!(
            got,
            vec![
                (root.join("Trip/a.jpg"), "Download/Zazabor/Trip".to_string()),
                (root.join("Trip/day1/b.jpg"), "Download/Zazabor/Trip/day1".to_string()),
                (root.join("c.txt"), "Download/Zazabor".to_string()),
            ]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
