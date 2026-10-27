//! File operations: copy, move, trash, restore, delete, rename, new folder, duplicate and undo.
//!
//! Data safety rules: nothing is ever written under its final name until it is complete (files
//! and folders are built under a temporary sibling name, then renamed); a cross-filesystem move
//! deletes the source only after the copy was verified; "replace" sends the old item to the
//! Trash instead of destroying it; every operation reports the records needed to reverse it.

use super::cloud;
use super::jobs::{Conflict, Decision, JobCtx};
use super::names::{invalid_name, unique_name, Style};
use super::trash;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::{symlink, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use walkdir::WalkDir;

/// Why a unit of work stopped.
#[derive(Debug, PartialEq)]
pub enum OpError {
    Cancelled,
    Failed(String),
}

impl From<&str> for OpError {
    fn from(msg: &str) -> Self {
        OpError::Failed(msg.into())
    }
}

impl From<String> for OpError {
    fn from(msg: String) -> Self {
        OpError::Failed(msg)
    }
}

type Op<T = ()> = Result<T, OpError>;

/// An I/O error without the "(os error N)" suffix.
pub fn plain(e: &io::Error) -> String {
    let text = e.to_string();
    match text.find(" (os error") {
        Some(i) => text[..i].to_string(),
        None => text,
    }
}

/// One reversible step. Undo and redo are the same operation: apply the inverse of each record
/// (newest first) and keep the records it returns for the opposite direction.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum UndoOp {
    /// An item moved (or was renamed) from `from` to `to`.
    Move { from: String, to: String },
    /// A new item exists at `path` (created, copied or restored).
    Created { path: String },
    /// An item was put in the Trash.
    Trashed { original: String, trashed: String },
}

/// What `apply_undo` did: the records for the opposite direction and what went wrong.
#[derive(Serialize, Debug, Default)]
pub struct UndoReport {
    pub ops: Vec<UndoOp>,
    pub errors: Vec<String>,
}

fn shown(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Refuses paths nobody means to rename, trash or delete: relative paths, "/" and the home folder.
fn guard(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.parent().is_none() {
        return Err("That item can’t be changed.".into());
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if home.as_deref() == Some(path) {
        return Err("Your Home folder can’t be moved or deleted.".into());
    }
    Ok(())
}

// ---- measuring ----------------------------------------------------------------------------------

/// Items and bytes under a path (links count as items of size 0, never followed).
fn measure(path: &Path) -> (u64, u64) {
    let (mut items, mut bytes) = (0, 0);
    for entry in WalkDir::new(path).follow_links(false).into_iter().flatten() {
        items += 1;
        if entry.file_type().is_file() {
            bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    (items, bytes)
}

// ---- copying ------------------------------------------------------------------------------------

static TEMP: AtomicU64 = AtomicU64::new(0);

/// A hidden temporary name next to `dst`; the finished item is renamed to `dst`.
fn temp_sibling(dst: &Path) -> PathBuf {
    let n = TEMP.fetch_add(1, Ordering::SeqCst);
    let name = format!(".{}.{}-{n}.zazabor-part", shown(dst), std::process::id());
    dst.with_file_name(name)
}

/// Removes a tree even when copied folders are read-only.
fn force_remove(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() {
        return fs::remove_file(path);
    }
    for entry in WalkDir::new(path).follow_links(false).into_iter().flatten() {
        if entry.file_type().is_dir() {
            let _ = fs::set_permissions(entry.path(), fs::Permissions::from_mode(0o700));
        }
    }
    fs::remove_dir_all(path)
}

/// Copies times and permissions; filesystems without them (FAT) just keep the defaults.
fn copy_attributes(file: &fs::File, meta: &fs::Metadata, path: &Path) {
    let mut times = fs::FileTimes::new();
    if let Ok(m) = meta.modified() {
        times = times.set_modified(m);
    }
    if let Ok(a) = meta.accessed() {
        times = times.set_accessed(a);
    }
    let _ = file.set_times(times);
    let _ = fs::set_permissions(path, meta.permissions());
}

fn copy_file(ctx: &mut JobCtx, src: &Path, dst: &Path, meta: &fs::Metadata) -> Op {
    let tmp = temp_sibling(dst);
    let result = copy_file_into(ctx, src, &tmp, meta);
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        return result;
    }
    fs::rename(&tmp, dst).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        OpError::Failed(format!("Couldn’t copy “{}”: {}", shown(src), plain(&e)))
    })
}

fn copy_file_into(ctx: &mut JobCtx, src: &Path, tmp: &Path, meta: &fs::Metadata) -> Op {
    let fail = |e: io::Error| OpError::Failed(format!("Couldn’t copy “{}”: {}", shown(src), plain(&e)));
    let mut input = fs::File::open(src).map_err(fail)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(tmp)
        .map_err(|e| OpError::Failed(format!("Couldn’t copy “{}”: {}", shown(src), plain(&e))))?;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        ctx.check()?;
        let n = input.read(&mut buf).map_err(|e| OpError::Failed(format!("Couldn’t read “{}”: {}", shown(src), plain(&e))))?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n]).map_err(|e| OpError::Failed(format!("Couldn’t copy “{}”: {}", shown(src), plain(&e))))?;
        ctx.add_bytes(n as u64);
    }
    copy_attributes(&output, meta, tmp);
    Ok(())
}

fn copy_dir(ctx: &mut JobCtx, src: &Path, dst: &Path, meta: &fs::Metadata) -> Op {
    let tmp = temp_sibling(dst);
    fs::create_dir(&tmp).map_err(|e| OpError::Failed(format!("Couldn’t copy “{}”: {}", shown(src), plain(&e))))?;
    let built = (|| -> Op {
        let entries = fs::read_dir(src).map_err(|e| OpError::Failed(format!("Couldn’t read “{}”: {}", shown(src), plain(&e))))?;
        for entry in entries {
            ctx.check()?;
            let entry = entry.map_err(|e| OpError::Failed(format!("Couldn’t read “{}”: {}", shown(src), plain(&e))))?;
            // A cloud drive's files are named by id on disk; copies get their titles.
            let name = cloud::title(&entry.path()).map(Into::into).unwrap_or_else(|| entry.file_name());
            copy_node(ctx, &entry.path(), &tmp.join(name))?;
        }
        // Times and permissions last: a read-only source folder must stay writable while filling.
        if let Ok(dir) = fs::File::open(&tmp) {
            copy_attributes(&dir, meta, &tmp);
        }
        Ok(())
    })();
    if built.is_err() {
        let _ = force_remove(&tmp);
        return built;
    }
    fs::rename(&tmp, dst).map_err(|e| {
        let _ = force_remove(&tmp);
        OpError::Failed(format!("Couldn’t copy “{}”: {}", shown(src), plain(&e)))
    })
}

/// Copies a file, folder (recursively) or symlink (as a link) to `dst`, which must not exist.
fn copy_node(ctx: &mut JobCtx, src: &Path, dst: &Path) -> Op {
    ctx.check()?;
    let meta = fs::symlink_metadata(src).map_err(|e| OpError::Failed(format!("Can’t read “{}”: {}", shown(src), plain(&e))))?;
    let kind = meta.file_type();
    if kind.is_symlink() {
        let link = fs::read_link(src).map_err(|e| OpError::Failed(format!("Can’t read “{}”: {}", shown(src), plain(&e))))?;
        symlink(link, dst).map_err(|e| OpError::Failed(format!("Couldn’t copy “{}”: {}", shown(src), plain(&e))))
    } else if kind.is_dir() {
        copy_dir(ctx, src, dst, &meta)
    } else if kind.is_file() {
        copy_file(ctx, src, dst, &meta)
    } else {
        Err(OpError::Failed(format!("Can’t copy “{}”: special files aren’t supported.", shown(src))))
    }
}

// ---- moving -------------------------------------------------------------------------------------

fn remove_path(path: &Path) -> io::Result<()> {
    force_remove(path)
}

/// Moves `src` to `dst` (which must not exist): a rename on one filesystem; across filesystems a
/// copy, a size check, and only then the removal of the source. `size` is the item's bytes, for
/// progress when a rename makes the copy loop unnecessary.
fn move_node(ctx: &mut JobCtx, src: &Path, dst: &Path, size: u64) -> Op {
    match fs::rename(src, dst) {
        Ok(()) => {
            ctx.add_bytes(size);
            Ok(())
        }
        Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
            copy_node(ctx, src, dst)?;
            if measure(src) != measure(dst) {
                let _ = force_remove(dst);
                return Err(OpError::Failed(format!("Couldn’t move “{}”: the copy didn’t match the original, so nothing was removed.", shown(src))));
            }
            remove_path(src).map_err(|e| {
                OpError::Failed(format!("“{}” was copied but the original couldn’t be removed: {}", shown(src), plain(&e)))
            })
        }
        Err(e) => Err(OpError::Failed(format!("Couldn’t move “{}”: {}", shown(src), plain(&e)))),
    }
}

struct Planned {
    abs: PathBuf,
    name: String,
    is_dir: bool,
    bytes: u64,
}

fn plan(sources: &[PathBuf], dest: &Path, verb: &str, moving: bool) -> Op<Vec<Planned>> {
    let mut out = Vec::new();
    for src in sources {
        let name = shown(src);
        let parent = src.parent().ok_or("That item can’t be copied.")?;
        let abs = fs::canonicalize(parent).map_err(|e| format!("Can’t find “{name}”: {}", plain(&e)))?.join(&name);
        let meta = fs::symlink_metadata(&abs).map_err(|e| format!("Can’t find “{name}”: {}", plain(&e)))?;
        if moving {
            guard(&abs)?;
        }
        if meta.is_dir() && dest.starts_with(&abs) {
            return Err(OpError::Failed(format!("Can’t {verb} “{name}” into itself.")));
        }
        let (_, bytes) = measure(&abs);
        let name = cloud::title(&abs).unwrap_or(name);
        out.push(Planned { abs, name, is_dir: meta.is_dir(), bytes });
    }
    Ok(out)
}

/// Copies or moves `sources` into `dest_dir`, asking about conflicts.
pub fn transfer(ctx: &mut JobCtx, sources: &[PathBuf], dest_dir: &Path, moving: bool) -> Op {
    let dest = fs::canonicalize(dest_dir).map_err(|e| format!("Can’t open the destination: {}", plain(&e)))?;
    if !dest.is_dir() {
        return Err(OpError::Failed("The destination isn’t a folder.".into()));
    }
    let verb = if moving { "move" } else { "copy" };
    let items = plan(sources, &dest, verb, moving)?;
    ctx.total = items.len() as u64;
    ctx.total_bytes = items.iter().map(|i| i.bytes).sum();
    for item in &items {
        ctx.check()?;
        ctx.begin(&item.name);
        match transfer_one(ctx, item, &dest, moving) {
            Err(OpError::Cancelled) => return Err(OpError::Cancelled),
            Err(OpError::Failed(msg)) => ctx.errors.push(msg),
            Ok(()) => {}
        }
        ctx.finish_item();
    }
    Ok(())
}

fn transfer_one(ctx: &mut JobCtx, item: &Planned, dest: &Path, moving: bool) -> Op {
    let mut target = dest.join(&item.name);
    if item.abs == target {
        // Dropped where it already is: moving does nothing, copying makes "name copy".
        if moving {
            ctx.results.push(path_string(&item.abs));
            return Ok(());
        }
        target = dest.join(unique_name(&item.name, item.is_dir, Style::Copy, &|n| exists(&dest.join(n))));
    } else if exists(&target) {
        if item.abs.starts_with(&target) {
            return Err(OpError::Failed(format!("Can’t replace “{}” with an item inside it.", item.name)));
        }
        let conflict = Conflict { source: path_string(&item.abs), target: path_string(&target), is_dir: item.is_dir };
        match ctx.resolve(conflict)? {
            Decision::Skip => return Ok(()),
            Decision::KeepBoth => {
                target = dest.join(unique_name(&item.name, item.is_dir, Style::Numbered, &|n| exists(&dest.join(n))));
            }
            Decision::Replace => {
                let record = trash::trash_one(&target, &ctx.trash_home)?;
                ctx.undo.push(record);
            }
        }
    }
    if moving {
        move_node(ctx, &item.abs, &target, item.bytes)?;
        ctx.undo.push(UndoOp::Move { from: path_string(&item.abs), to: path_string(&target) });
    } else {
        copy_node(ctx, &item.abs, &target)?;
        ctx.undo.push(UndoOp::Created { path: path_string(&target) });
    }
    ctx.results.push(path_string(&target));
    Ok(())
}

// ---- trash, restore, delete ---------------------------------------------------------------------

/// Runs `each` over `paths` as a job: one item at a time, failures collected, cancel honoured.
fn each_item(ctx: &mut JobCtx, paths: &[PathBuf], mut each: impl FnMut(&mut JobCtx, &Path) -> Result<(), String>) -> Op {
    ctx.total = paths.len() as u64;
    for path in paths {
        ctx.check()?;
        ctx.begin(&shown(path));
        if let Err(msg) = each(ctx, path) {
            ctx.errors.push(msg);
        }
        ctx.finish_item();
    }
    Ok(())
}

/// Moves items to the Trash.
pub fn trash_items(ctx: &mut JobCtx, paths: &[PathBuf]) -> Op {
    each_item(ctx, paths, |ctx, path| {
        guard(path)?;
        let record = trash::trash_one(path, &ctx.trash_home)?;
        if let UndoOp::Trashed { trashed, .. } = &record {
            ctx.results.push(trashed.clone());
        }
        ctx.undo.push(record);
        Ok(())
    })
}

/// Puts items in the Trash back where they came from.
pub fn restore_items(ctx: &mut JobCtx, paths: &[PathBuf]) -> Op {
    each_item(ctx, paths, |ctx, path| {
        let restored = trash::restore_one(path)?;
        ctx.results.push(path_string(&restored));
        ctx.undo.push(UndoOp::Created { path: path_string(&restored) });
        Ok(())
    })
}

/// Permanently deletes items (and their Trash records when they are in the Trash).
pub fn delete_items(ctx: &mut JobCtx, paths: &[PathBuf]) -> Op {
    each_item(ctx, paths, |_, path| {
        guard(path)?;
        let info = trash::info_path(path);
        remove_path(path).map_err(|e| format!("Couldn’t delete “{}”: {}", shown(path), plain(&e)))?;
        if let Some(info) = info {
            let _ = fs::remove_file(info);
        }
        Ok(())
    })
}

/// Permanently deletes everything in the home Trash.
pub fn empty_trash(ctx: &mut JobCtx) -> Op {
    let files = ctx.trash_home.join("files");
    let info = ctx.trash_home.join("info");
    let paths: Vec<PathBuf> = match fs::read_dir(&files) {
        Ok(entries) => entries.flatten().map(|e| e.path()).collect(),
        Err(_) => Vec::new(),
    };
    delete_items(ctx, &paths)?;
    if ctx.errors.is_empty() {
        if let Ok(entries) = fs::read_dir(&info) {
            for entry in entries.flatten() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

// ---- quick, synchronous operations --------------------------------------------------------------

/// Renames an item inside its folder and returns the new path.
pub fn rename(path: &Path, new_name: &str) -> Result<String, String> {
    guard(path)?;
    if let Some(problem) = invalid_name(new_name) {
        return Err(problem.into());
    }
    let parent = path.parent().ok_or("That item can’t be renamed.")?;
    let target = parent.join(new_name);
    if target == path {
        return Ok(path_string(path));
    }
    if !exists(path) {
        return Err(format!("Can’t find “{}”.", shown(path)));
    }
    if exists(&target) {
        return Err(format!("An item named “{new_name}” already exists here."));
    }
    fs::rename(path, &target).map_err(|e| format!("Couldn’t rename “{}”: {}", shown(path), plain(&e)))?;
    Ok(path_string(&target))
}

/// Creates a folder named `name` (or "name 2", "name 3", … when taken) and returns its path.
pub fn new_folder(parent: &Path, name: &str) -> Result<String, String> {
    if let Some(problem) = invalid_name(name) {
        return Err(problem.into());
    }
    if !parent.is_dir() {
        return Err("That folder doesn’t exist.".into());
    }
    let mut candidate = unique_name(name, true, Style::Numbered, &|n| exists(&parent.join(n)));
    loop {
        let target = parent.join(&candidate);
        match fs::create_dir(&target) {
            Ok(()) => return Ok(path_string(&target)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                let taken = candidate.clone();
                candidate = unique_name(name, true, Style::Numbered, &|n| n == taken || exists(&parent.join(n)));
            }
            Err(e) => return Err(format!("Couldn’t create the folder: {}", plain(&e))),
        }
    }
}

/// Duplicates items next to themselves as "name copy.ext", "name copy 2.ext", …; returns the new paths.
pub fn duplicate(paths: &[PathBuf], trash_home: PathBuf) -> Result<Vec<String>, String> {
    let mut ctx = JobCtx::detached(super::jobs::Kind::Copy, trash_home);
    let mut made = Vec::new();
    for path in paths {
        let parent = path.parent().ok_or("That item can’t be duplicated.")?;
        let meta = fs::symlink_metadata(path).map_err(|e| format!("Can’t find “{}”: {}", shown(path), plain(&e)))?;
        let name = unique_name(&shown(path), meta.is_dir(), Style::Copy, &|n| exists(&parent.join(n)));
        let target = parent.join(name);
        match copy_node(&mut ctx, path, &target) {
            Ok(()) => made.push(path_string(&target)),
            Err(OpError::Failed(msg)) => return Err(msg),
            Err(OpError::Cancelled) => return Err("Cancelled.".into()),
        }
    }
    Ok(made)
}

/// Applies the inverse of each record, newest first, and returns the records for the other
/// direction (so redo is `apply_undo` again on what this returned).
pub fn apply_undo(ops: &[UndoOp], trash_home: &Path) -> UndoReport {
    let mut ctx = JobCtx::detached(super::jobs::Kind::Move, trash_home.to_path_buf());
    let mut report = UndoReport::default();
    for op in ops.iter().rev() {
        let step: Result<UndoOp, String> = match op {
            UndoOp::Move { from, to } => {
                let (from_p, to_p) = (Path::new(from), Path::new(to));
                if exists(from_p) {
                    Err(format!("An item named “{}” is already in the way.", shown(from_p)))
                } else if !exists(to_p) {
                    Err(format!("“{}” is no longer there.", shown(to_p)))
                } else {
                    match from_p.parent().map(fs::create_dir_all) {
                        Some(Err(e)) => Err(plain(&e)),
                        _ => move_node(&mut ctx, to_p, from_p, 0)
                            .map(|()| UndoOp::Move { from: to.clone(), to: from.clone() })
                            .map_err(|e| match e {
                                OpError::Failed(m) => m,
                                OpError::Cancelled => "Cancelled.".into(),
                            }),
                    }
                }
            }
            UndoOp::Created { path } => trash::trash_one(Path::new(path), trash_home),
            UndoOp::Trashed { trashed, .. } => {
                trash::restore_one(Path::new(trashed)).map(|p| UndoOp::Created { path: path_string(&p) })
            }
        };
        match step {
            Ok(inverse) => report.ops.push(inverse),
            Err(msg) => report.errors.push(msg),
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::jobs::{JobEvent, Kind, State};
    use std::collections::VecDeque;
    use std::os::unix::fs::MetadataExt;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime};

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zazabor-ops-{tag}-{}", std::process::id()));
        let _ = force_remove(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    struct Rig {
        ctx: JobCtx,
        events: Arc<Mutex<Vec<JobEvent>>>,
        asked: Arc<Mutex<Vec<Conflict>>>,
    }

    /// A job context whose conflict answers are scripted and whose events are recorded.
    fn rig(root: &Path, answers: Vec<(Decision, bool)>, cancel_after_bytes: Option<u64>) -> Rig {
        let events = Arc::new(Mutex::new(Vec::new()));
        let asked = Arc::new(Mutex::new(Vec::new()));
        let cancel = Arc::new(AtomicBool::new(false));
        let script = Arc::new(Mutex::new(VecDeque::from(answers)));
        let (ev, flag) = (events.clone(), cancel.clone());
        let emit = Box::new(move |e: &JobEvent| {
            if cancel_after_bytes.is_some_and(|n| e.bytes >= n) {
                flag.store(true, Ordering::SeqCst);
            }
            ev.lock().unwrap().push(e.clone());
        });
        let log = asked.clone();
        let ask = Box::new(move |c: &Conflict| {
            log.lock().unwrap().push(c.clone());
            script.lock().unwrap().pop_front()
        });
        let mut ctx = JobCtx::new(1, Kind::Copy, root.join("Trash"), cancel, emit, ask);
        if cancel_after_bytes.is_some() {
            ctx.throttle = Duration::ZERO;
        }
        Rig { ctx, events, asked }
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut n: Vec<String> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        n.sort();
        n
    }

    #[test]
    fn copies_folders_with_times_permissions_and_links() {
        let root = scratch("copy");
        write(&root.join("src/tree/a.txt"), "alpha");
        write(&root.join("src/tree/sub/b.txt"), "beta");
        fs::set_permissions(root.join("src/tree/a.txt"), fs::Permissions::from_mode(0o640)).unwrap();
        symlink("a.txt", root.join("src/tree/link")).unwrap();
        let old = SystemTime::now() - Duration::from_secs(86_400 * 30);
        fs::File::open(root.join("src/tree/a.txt")).unwrap().set_times(fs::FileTimes::new().set_modified(old)).unwrap();
        fs::create_dir_all(root.join("dest")).unwrap();

        let mut r = rig(&root, vec![], None);
        transfer(&mut r.ctx, &[root.join("src/tree")], &root.join("dest"), false).unwrap();
        assert!(r.ctx.errors.is_empty(), "{:?}", r.ctx.errors);

        let copy = root.join("dest/tree");
        assert_eq!(fs::read_to_string(copy.join("sub/b.txt")).unwrap(), "beta");
        let meta = fs::metadata(copy.join("a.txt")).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o640);
        assert_eq!(meta.modified().unwrap(), old);
        assert!(fs::symlink_metadata(copy.join("link")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_link(copy.join("link")).unwrap(), PathBuf::from("a.txt"));
        assert!(root.join("src/tree/a.txt").exists());
        assert_eq!(r.ctx.undo, vec![UndoOp::Created { path: path_string(&copy) }]);
        assert_eq!(r.ctx.bytes, 9);
        assert_eq!(names(&root.join("dest")), vec!["tree"]);
        let _ = force_remove(&root);
    }

    #[test]
    fn move_on_one_filesystem_is_a_rename() {
        let root = scratch("move");
        write(&root.join("a/file.txt"), "x");
        fs::create_dir_all(root.join("b")).unwrap();
        let inode = fs::metadata(root.join("a/file.txt")).unwrap().ino();
        let mut r = rig(&root, vec![], None);
        transfer(&mut r.ctx, &[root.join("a/file.txt")], &root.join("b"), true).unwrap();
        assert!(!root.join("a/file.txt").exists());
        assert_eq!(fs::metadata(root.join("b/file.txt")).unwrap().ino(), inode);
        assert_eq!(
            r.ctx.undo,
            vec![UndoOp::Move { from: path_string(&root.join("a/file.txt")), to: path_string(&root.join("b/file.txt")) }]
        );
        let _ = force_remove(&root);
    }

    #[test]
    fn move_across_filesystems_verifies_then_removes_the_source() {
        let shm = Path::new("/dev/shm");
        let root = scratch("xdev");
        if !shm.is_dir() || fs::metadata(shm).unwrap().dev() == fs::metadata(&root).unwrap().dev() {
            let _ = force_remove(&root);
            return;
        }
        let from = shm.join(format!("zazabor-xdev-{}", std::process::id()));
        write(&from.join("d/one.txt"), "one");
        write(&from.join("two.txt"), "two");
        fs::create_dir_all(root.join("dest")).unwrap();
        let mut r = rig(&root, vec![], None);
        transfer(&mut r.ctx, &[from.join("d"), from.join("two.txt")], &root.join("dest"), true).unwrap();
        assert!(r.ctx.errors.is_empty(), "{:?}", r.ctx.errors);
        assert_eq!(fs::read_to_string(root.join("dest/d/one.txt")).unwrap(), "one");
        assert_eq!(fs::read_to_string(root.join("dest/two.txt")).unwrap(), "two");
        assert!(!from.join("d").exists() && !from.join("two.txt").exists());
        let _ = force_remove(&from);
        let _ = force_remove(&root);
    }

    fn conflict_setup(tag: &str) -> PathBuf {
        let root = scratch(tag);
        write(&root.join("src/a.txt"), "new a");
        write(&root.join("src/b.txt"), "new b");
        write(&root.join("dest/a.txt"), "old a");
        write(&root.join("dest/b.txt"), "old b");
        root
    }

    #[test]
    fn conflict_skip_leaves_the_target_alone() {
        let root = conflict_setup("skip");
        let mut r = rig(&root, vec![(Decision::Skip, false), (Decision::Skip, false)], None);
        transfer(&mut r.ctx, &[root.join("src/a.txt"), root.join("src/b.txt")], &root.join("dest"), false).unwrap();
        assert_eq!(fs::read_to_string(root.join("dest/a.txt")).unwrap(), "old a");
        assert_eq!(names(&root.join("dest")), vec!["a.txt", "b.txt"]);
        assert_eq!(r.asked.lock().unwrap().len(), 2);
        assert!(r.ctx.undo.is_empty());
        let _ = force_remove(&root);
    }

    #[test]
    fn conflict_replace_sends_the_old_item_to_the_trash() {
        let root = conflict_setup("replace");
        let mut r = rig(&root, vec![(Decision::Replace, false), (Decision::Skip, false)], None);
        transfer(&mut r.ctx, &[root.join("src/a.txt"), root.join("src/b.txt")], &root.join("dest"), false).unwrap();
        assert_eq!(fs::read_to_string(root.join("dest/a.txt")).unwrap(), "new a");
        assert_eq!(fs::read_to_string(root.join("dest/b.txt")).unwrap(), "old b");
        let trashed = fs::read_to_string(root.join("Trash/files/a.txt")).unwrap();
        assert_eq!(trashed, "old a");
        assert!(matches!(r.ctx.undo[0], UndoOp::Trashed { .. }));
        assert!(matches!(r.ctx.undo[1], UndoOp::Created { .. }));
        // Undo puts the old file back and the new one into the Trash.
        let report = apply_undo(&r.ctx.undo, &root.join("Trash"));
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(fs::read_to_string(root.join("dest/a.txt")).unwrap(), "old a");
        let _ = force_remove(&root);
    }

    #[test]
    fn conflict_keep_both_numbers_the_new_item() {
        let root = conflict_setup("keep");
        let mut r = rig(&root, vec![(Decision::KeepBoth, false), (Decision::KeepBoth, false)], None);
        transfer(&mut r.ctx, &[root.join("src/a.txt"), root.join("src/b.txt")], &root.join("dest"), false).unwrap();
        assert_eq!(names(&root.join("dest")), vec!["a 2.txt", "a.txt", "b 2.txt", "b.txt"]);
        assert_eq!(fs::read_to_string(root.join("dest/a 2.txt")).unwrap(), "new a");
        assert_eq!(fs::read_to_string(root.join("dest/a.txt")).unwrap(), "old a");
        let _ = force_remove(&root);
    }

    #[test]
    fn apply_to_all_asks_once() {
        let root = conflict_setup("all");
        let mut r = rig(&root, vec![(Decision::KeepBoth, true)], None);
        transfer(&mut r.ctx, &[root.join("src/a.txt"), root.join("src/b.txt")], &root.join("dest"), false).unwrap();
        assert_eq!(r.asked.lock().unwrap().len(), 1);
        assert_eq!(names(&root.join("dest")).len(), 4);
        let waiting = r.events.lock().unwrap().iter().filter(|e| e.state == State::Waiting).count();
        assert_eq!(waiting, 1);
        let _ = force_remove(&root);
    }

    #[test]
    fn moving_with_replace_can_be_undone() {
        let root = conflict_setup("move-replace");
        let mut r = rig(&root, vec![(Decision::Replace, false)], None);
        transfer(&mut r.ctx, &[root.join("src/a.txt")], &root.join("dest"), true).unwrap();
        assert!(!root.join("src/a.txt").exists());
        let report = apply_undo(&r.ctx.undo, &root.join("Trash"));
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(fs::read_to_string(root.join("src/a.txt")).unwrap(), "new a");
        assert_eq!(fs::read_to_string(root.join("dest/a.txt")).unwrap(), "old a");
        // Redo: apply the returned records again.
        let again = apply_undo(&report.ops, &root.join("Trash"));
        assert!(again.errors.is_empty(), "{:?}", again.errors);
        assert_eq!(fs::read_to_string(root.join("dest/a.txt")).unwrap(), "new a");
        let _ = force_remove(&root);
    }

    #[test]
    fn a_folder_cannot_go_into_itself() {
        let root = scratch("self");
        write(&root.join("f/x.txt"), "x");
        fs::create_dir_all(root.join("f/inner")).unwrap();
        let mut r = rig(&root, vec![], None);
        for target in [root.join("f"), root.join("f/inner")] {
            let err = transfer(&mut r.ctx, &[root.join("f")], &target, false).unwrap_err();
            assert_eq!(err, OpError::Failed("Can’t copy “f” into itself.".into()));
        }
        assert_eq!(names(&root.join("f")), vec!["inner", "x.txt"]);
        let _ = force_remove(&root);
    }

    #[test]
    fn pasting_into_the_same_folder_makes_a_copy_and_a_move_does_nothing() {
        let root = scratch("same");
        write(&root.join("a.txt"), "a");
        let mut r = rig(&root, vec![], None);
        transfer(&mut r.ctx, &[root.join("a.txt")], &root, false).unwrap();
        assert_eq!(names(&root), vec!["a copy.txt", "a.txt"]);
        let mut r = rig(&root, vec![], None);
        transfer(&mut r.ctx, &[root.join("a.txt")], &root, true).unwrap();
        assert_eq!(names(&root), vec!["a copy.txt", "a.txt"]);
        assert!(r.asked.lock().unwrap().is_empty());
        let _ = force_remove(&root);
    }

    #[test]
    fn cancelling_leaves_no_partial_files() {
        let root = scratch("cancel");
        let big = vec![7u8; 6 << 20];
        fs::create_dir_all(root.join("src/dir")).unwrap();
        fs::write(root.join("src/dir/big.bin"), &big).unwrap();
        fs::write(root.join("src/dir/big2.bin"), &big).unwrap();
        fs::write(root.join("src/lone.bin"), &big).unwrap();
        fs::create_dir_all(root.join("dest")).unwrap();
        let mut r = rig(&root, vec![], Some(1 << 20));
        let out = transfer(&mut r.ctx, &[root.join("src/dir"), root.join("src/lone.bin")], &root.join("dest"), false);
        assert_eq!(out, Err(OpError::Cancelled));
        assert_eq!(names(&root.join("dest")), Vec::<String>::new());
        assert_eq!(names(&root.join("src")), vec!["dir", "lone.bin"]);

        // A cancelled single-file copy leaves nothing either.
        let mut r = rig(&root, vec![], Some(1 << 20));
        let out = transfer(&mut r.ctx, &[root.join("src/lone.bin")], &root.join("dest"), false);
        assert_eq!(out, Err(OpError::Cancelled));
        assert_eq!(names(&root.join("dest")), Vec::<String>::new());
        let _ = force_remove(&root);
    }

    #[test]
    fn progress_is_throttled_and_the_final_event_carries_results() {
        let root = scratch("events");
        for i in 0..50 {
            write(&root.join(format!("src/f{i}.txt")), "x");
        }
        fs::create_dir_all(root.join("dest")).unwrap();
        let sources: Vec<PathBuf> = (0..50).map(|i| root.join(format!("src/f{i}.txt"))).collect();
        let mut r = rig(&root, vec![], None);
        let out = transfer(&mut r.ctx, &sources, &root.join("dest"), false);
        r.ctx.finish(out);
        let events = r.events.lock().unwrap();
        assert!(events.len() < 20, "{} events", events.len());
        let last = events.last().unwrap();
        assert_eq!(last.state, State::Done);
        assert_eq!((last.done, last.total), (50, 50));
        assert_eq!(last.results.len(), 50);
        assert_eq!(last.undo.len(), 50);
        let _ = force_remove(&root);
    }

    #[test]
    fn rename_validates_names() {
        let root = scratch("rename");
        write(&root.join("a.txt"), "a");
        write(&root.join("b.txt"), "b");
        assert_eq!(rename(&root.join("a.txt"), "c.txt").unwrap(), path_string(&root.join("c.txt")));
        assert!(root.join("c.txt").exists());
        assert!(rename(&root.join("c.txt"), "b.txt").unwrap_err().contains("already exists"));
        assert!(rename(&root.join("c.txt"), "").is_err());
        assert!(rename(&root.join("c.txt"), "x/y").is_err());
        assert!(rename(Path::new("/"), "x").is_err());
        assert!(rename(&root.join("missing"), "x").is_err());
        assert_eq!(rename(&root.join("c.txt"), "c.txt").unwrap(), path_string(&root.join("c.txt")));
        let _ = force_remove(&root);
    }

    #[test]
    fn new_folders_are_unique() {
        let root = scratch("newfolder");
        let a = new_folder(&root, "untitled folder").unwrap();
        let b = new_folder(&root, "untitled folder").unwrap();
        let c = new_folder(&root, "untitled folder").unwrap();
        assert_eq!(a, path_string(&root.join("untitled folder")));
        assert_eq!(b, path_string(&root.join("untitled folder 2")));
        assert_eq!(c, path_string(&root.join("untitled folder 3")));
        assert!(new_folder(&root, "a/b").is_err());
        let _ = force_remove(&root);
    }

    #[test]
    fn duplicates_are_named_copy() {
        let root = scratch("dup");
        write(&root.join("a.txt"), "a");
        fs::create_dir_all(root.join("d")).unwrap();
        let first = duplicate(&[root.join("a.txt"), root.join("d")], root.join("Trash")).unwrap();
        assert_eq!(first, vec![path_string(&root.join("a copy.txt")), path_string(&root.join("d copy"))]);
        let second = duplicate(&[root.join("a.txt")], root.join("Trash")).unwrap();
        assert_eq!(second, vec![path_string(&root.join("a copy 2.txt"))]);
        assert_eq!(fs::read_to_string(root.join("a copy 2.txt")).unwrap(), "a");
        let _ = force_remove(&root);
    }

    #[test]
    fn trash_restore_delete_and_undo() {
        let root = scratch("trashjob");
        write(&root.join("a.txt"), "a");
        write(&root.join("d/b.txt"), "b");
        let mut r = rig(&root, vec![], None);
        trash_items(&mut r.ctx, &[root.join("a.txt"), root.join("d")]).unwrap();
        assert!(r.ctx.errors.is_empty(), "{:?}", r.ctx.errors);
        assert!(!root.join("a.txt").exists() && !root.join("d").exists());
        assert_eq!(r.ctx.results.len(), 2);

        // Undo brings both back; redo trashes them again.
        let back = apply_undo(&r.ctx.undo, &root.join("Trash"));
        assert!(back.errors.is_empty(), "{:?}", back.errors);
        assert!(root.join("a.txt").exists() && root.join("d/b.txt").exists());
        let again = apply_undo(&back.ops, &root.join("Trash"));
        assert!(again.errors.is_empty(), "{:?}", again.errors);
        assert!(!root.join("a.txt").exists());

        // Restore from the Trash.
        let trashed: Vec<PathBuf> = names(&root.join("Trash/files")).iter().map(|n| root.join("Trash/files").join(n)).collect();
        let mut r2 = rig(&root, vec![], None);
        restore_items(&mut r2.ctx, &trashed).unwrap();
        assert!(root.join("a.txt").exists() && root.join("d").exists());
        assert!(names(&root.join("Trash/files")).is_empty());

        // Permanent delete of a trashed item also removes its record.
        let mut r3 = rig(&root, vec![], None);
        trash_items(&mut r3.ctx, &[root.join("a.txt")]).unwrap();
        let item = root.join("Trash/files/a.txt");
        let info = trash::info_path(&item).unwrap();
        assert!(info.exists());
        delete_items(&mut r3.ctx, &[item.clone()]).unwrap();
        assert!(!item.exists() && !info.exists());
        let _ = force_remove(&root);
    }

    #[test]
    fn empty_trash_removes_files_and_records() {
        let root = scratch("empty");
        write(&root.join("a.txt"), "a");
        write(&root.join("d/b.txt"), "b");
        let mut r = rig(&root, vec![], None);
        trash_items(&mut r.ctx, &[root.join("a.txt"), root.join("d")]).unwrap();
        empty_trash(&mut r.ctx).unwrap();
        assert!(names(&root.join("Trash/files")).is_empty());
        assert!(names(&root.join("Trash/info")).is_empty());
        let _ = force_remove(&root);
    }

    #[test]
    fn dangerous_paths_are_refused() {
        let root = scratch("guard");
        let mut r = rig(&root, vec![], None);
        delete_items(&mut r.ctx, &[PathBuf::from("/")]).unwrap();
        assert_eq!(r.ctx.errors.len(), 1);
        assert!(guard(Path::new("relative/x")).is_err());
        let _ = force_remove(&root);
    }
}
