//! Compress to zip and extract zip / tar archives as cancellable jobs.
//!
//! Output is built under a temporary sibling name and renamed at the end, so a cancelled or
//! failed job leaves nothing behind. Extraction refuses entries that would land outside the
//! target folder (absolute paths, `..`, links pointing out of it).

use super::jobs::JobCtx;
use super::names::{unique_name, Style};
use super::ops::{plain, OpError};
use std::cell::Cell;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

type Op<T = ()> = Result<T, OpError>;

const CHUNK: usize = 256 * 1024;

fn fail<T>(msg: String) -> Op<T> {
    Err(OpError::Failed(msg))
}

fn shown(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

static TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A hidden temporary sibling for something being built.
fn temp_sibling(dir: &Path, name: &str) -> PathBuf {
    let n = TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    dir.join(format!(".{name}.{}-{n}.part", std::process::id()))
}

fn unique_in(dir: &Path, name: &str, is_dir: bool) -> String {
    unique_name(name, is_dir, Style::Numbered, &|n| fs::symlink_metadata(dir.join(n)).is_ok())
}

// ---- compress -----------------------------------------------------------------------------------

/// The archive name for these sources: "name.zip" for one, "Archive.zip" for several.
pub fn archive_name(sources: &[PathBuf]) -> String {
    match sources {
        [one] => format!("{}.zip", shown(one)),
        _ => "Archive.zip".to_string(),
    }
}

/// Zips `sources` into a new archive in `dest_dir`; the job's result is the archive's path.
pub fn compress(ctx: &mut JobCtx, sources: &[PathBuf], dest_dir: &Path) -> Op {
    if sources.is_empty() {
        return fail("Nothing to compress.".into());
    }
    if !dest_dir.is_dir() {
        return fail("The destination isn’t a folder.".into());
    }
    // Measure first, so the progress bar means something.
    ctx.total = sources.len() as u64;
    for src in sources {
        for item in WalkDir::new(src).follow_links(false).into_iter().flatten() {
            if item.file_type().is_file() {
                ctx.total_bytes += item.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
        ctx.check()?;
    }
    let name = unique_in(dest_dir, &archive_name(sources), false);
    let tmp = temp_sibling(dest_dir, &name);
    let outcome = write_zip(ctx, sources, &tmp);
    match outcome {
        Ok(()) => {
            let target = dest_dir.join(&name);
            // The name was free a moment ago; `rename` over a late arrival would lose it.
            let target = if fs::symlink_metadata(&target).is_ok() { dest_dir.join(unique_in(dest_dir, &name, false)) } else { target };
            if let Err(e) = fs::rename(&tmp, &target) {
                let _ = fs::remove_file(&tmp);
                return fail(format!("Couldn’t create “{name}”: {}", plain(&e)));
            }
            ctx.results.push(target.to_string_lossy().into_owned());
            Ok(())
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn write_zip(ctx: &mut JobCtx, sources: &[PathBuf], tmp: &Path) -> Op {
    let file = File::create(tmp).map_err(|e| OpError::Failed(format!("Couldn’t create the archive: {}", plain(&e))))?;
    let mut zip = zip::ZipWriter::new(io::BufWriter::new(file));
    for src in sources {
        let parent = src.parent().unwrap_or(Path::new("/"));
        let top = shown(src);
        ctx.begin(&top);
        for item in WalkDir::new(src).follow_links(false).sort_by_file_name() {
            ctx.check()?;
            let item = item.map_err(|e| OpError::Failed(format!("Couldn’t read “{top}”: {e}")))?;
            let rel = item.path().strip_prefix(parent).unwrap_or(item.path());
            let name = rel.to_string_lossy().replace('\\', "/");
            let meta = item.metadata().map_err(|e| OpError::Failed(format!("Couldn’t read “{}”: {e}", shown(item.path()))))?;
            let mode = meta.permissions().mode() & 0o777;
            let opts = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(mode)
                .large_file(meta.len() >= u32::MAX as u64);
            let zerr = |e: zip::result::ZipError| OpError::Failed(format!("Couldn’t add “{}”: {e}", shown(item.path())));
            let ft = item.file_type();
            if ft.is_dir() {
                zip.add_directory(format!("{name}/"), opts).map_err(zerr)?;
            } else if ft.is_symlink() {
                let target = fs::read_link(item.path()).map_err(|e| OpError::Failed(format!("Couldn’t read “{}”: {}", shown(item.path()), plain(&e))))?;
                zip.add_symlink(name, target.to_string_lossy(), opts).map_err(zerr)?;
            } else if ft.is_file() {
                zip.start_file(name, opts).map_err(zerr)?;
                let mut input = File::open(item.path()).map_err(|e| OpError::Failed(format!("Couldn’t read “{}”: {}", shown(item.path()), plain(&e))))?;
                let mut buf = vec![0u8; CHUNK];
                loop {
                    ctx.check()?;
                    let n = input.read(&mut buf).map_err(|e| OpError::Failed(format!("Couldn’t read “{}”: {}", shown(item.path()), plain(&e))))?;
                    if n == 0 {
                        break;
                    }
                    zip.write_all(&buf[..n]).map_err(|e| OpError::Failed(format!("Couldn’t write the archive: {}", plain(&e))))?;
                    ctx.add_bytes(n as u64);
                }
            }
            // Sockets, pipes and devices are left out.
        }
        ctx.finish_item();
    }
    let mut out = zip.finish().map_err(|e| OpError::Failed(format!("Couldn’t finish the archive: {e}")))?;
    out.flush().map_err(|e| OpError::Failed(format!("Couldn’t write the archive: {}", plain(&e))))
}

// ---- extract ------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Format {
    Zip,
    Tar,
    TarGz,
    TarXz,
    TarBz2,
}

/// The archive format a file name says it is, and the name without that suffix.
pub fn detect(name: &str) -> Option<(Format, String)> {
    let lower = name.to_lowercase();
    const SUFFIXES: [(&str, Format); 9] = [
        (".tar.gz", Format::TarGz),
        (".tgz", Format::TarGz),
        (".tar.xz", Format::TarXz),
        (".txz", Format::TarXz),
        (".tar.bz2", Format::TarBz2),
        (".tbz2", Format::TarBz2),
        (".tbz", Format::TarBz2),
        (".tar", Format::Tar),
        (".zip", Format::Zip),
    ];
    for (suffix, format) in SUFFIXES {
        if lower.ends_with(suffix) && name.len() > suffix.len() {
            return Some((format, name[..name.len() - suffix.len()].to_string()));
        }
    }
    None
}

/// An entry path made safe: relative, no `..`, no root. `None` means refuse the archive.
pub fn safe_path(raw: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in raw.components() {
        match part {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(out)
}

/// Whether a link at `entry` (relative to the extraction root) pointing at `target` stays inside.
fn link_stays_inside(entry: &Path, target: &Path) -> bool {
    if target.is_absolute() {
        return false;
    }
    let mut depth = entry.components().count() as i64 - 1;
    for part in target.components() {
        match part {
            Component::Normal(_) => depth += 1,
            Component::ParentDir => depth -= 1,
            Component::CurDir => {}
            _ => return false,
        }
        if depth < 0 {
            return false;
        }
    }
    true
}

fn unsafe_entry(name: &str) -> OpError {
    OpError::Failed(format!("The archive contains an unsafe path (“{name}”), so it wasn’t extracted."))
}

/// Extracts `archive` into a new folder named after it inside `dest_dir`; the result is that folder.
pub fn extract(ctx: &mut JobCtx, archive: &Path, dest_dir: &Path) -> Op {
    let name = shown(archive);
    let Some((format, stem)) = detect(&name) else {
        return fail(format!("“{name}” isn’t a zip or tar archive."));
    };
    if !dest_dir.is_dir() {
        return fail("The destination isn’t a folder.".into());
    }
    let folder = unique_in(dest_dir, &stem, true);
    let tmp = temp_sibling(dest_dir, &folder);
    fs::create_dir(&tmp).map_err(|e| OpError::Failed(format!("Couldn’t create “{folder}”: {}", plain(&e))))?;
    ctx.begin(&name);
    let outcome = match format {
        Format::Zip => extract_zip(ctx, archive, &tmp),
        other => extract_tar(ctx, archive, other, &tmp),
    };
    match outcome {
        Ok(()) => {
            let target = dest_dir.join(unique_in(dest_dir, &folder, true));
            if let Err(e) = fs::rename(&tmp, &target) {
                let _ = fs::remove_dir_all(&tmp);
                return fail(format!("Couldn’t create “{folder}”: {}", plain(&e)));
            }
            ctx.done = ctx.total;
            ctx.results.push(target.to_string_lossy().into_owned());
            Ok(())
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            Err(e)
        }
    }
}

fn write_mode(path: &Path, mode: u32, dir: bool) {
    let floor = if dir { 0o700 } else { 0o600 };
    let _ = fs::set_permissions(path, fs::Permissions::from_mode((mode & 0o777) | floor));
}

fn make_parent(path: &Path) -> Op {
    match path.parent() {
        Some(p) => fs::create_dir_all(p).map_err(|e| OpError::Failed(format!("Couldn’t create a folder: {}", plain(&e)))),
        None => Ok(()),
    }
}

/// Copies an entry's bytes out, reporting progress through `progress` (given the bytes just written).
fn copy_out(ctx: &mut JobCtx, input: &mut dyn Read, path: &Path, mut progress: impl FnMut(&mut JobCtx, u64)) -> Op {
    let mut output = File::create(path).map_err(|e| OpError::Failed(format!("Couldn’t write “{}”: {}", shown(path), plain(&e))))?;
    let mut buf = vec![0u8; CHUNK];
    loop {
        ctx.check()?;
        let n = input.read(&mut buf).map_err(|e| OpError::Failed(format!("Couldn’t read the archive: {}", plain(&e))))?;
        if n == 0 {
            return Ok(());
        }
        output.write_all(&buf[..n]).map_err(|e| OpError::Failed(format!("Couldn’t write “{}”: {}", shown(path), plain(&e))))?;
        progress(ctx, n as u64);
    }
}

fn extract_zip(ctx: &mut JobCtx, archive: &Path, root: &Path) -> Op {
    let file = File::open(archive).map_err(|e| OpError::Failed(format!("Couldn’t open “{}”: {}", shown(archive), plain(&e))))?;
    let mut zip = zip::ZipArchive::new(io::BufReader::new(file))
        .map_err(|e| OpError::Failed(format!("“{}” couldn’t be read: {e}", shown(archive))))?;
    ctx.total = zip.len() as u64;
    // Validate every name before writing anything.
    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i).map_err(|e| OpError::Failed(format!("The archive is damaged: {e}")))?;
        if safe_path(Path::new(entry.name())).is_none() {
            return Err(unsafe_entry(entry.name()));
        }
        ctx.total_bytes += entry.size();
    }
    for i in 0..zip.len() {
        ctx.check()?;
        let mut entry = zip.by_index(i).map_err(|e| OpError::Failed(format!("The archive is damaged: {e}")))?;
        let raw = entry.name().to_string();
        let rel = safe_path(Path::new(&raw)).ok_or_else(|| unsafe_entry(&raw))?;
        if rel.as_os_str().is_empty() {
            continue;
        }
        let path = root.join(&rel);
        let mode = entry.unix_mode().unwrap_or(if entry.is_dir() { 0o755 } else { 0o644 });
        ctx.begin(&raw);
        let is_link = entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000);
        if entry.is_dir() {
            fs::create_dir_all(&path).map_err(|e| OpError::Failed(format!("Couldn’t create “{raw}”: {}", plain(&e))))?;
            write_mode(&path, mode, true);
        } else if is_link {
            let mut target = String::new();
            entry.read_to_string(&mut target).map_err(|e| OpError::Failed(format!("The archive is damaged: {}", plain(&e))))?;
            if !link_stays_inside(&rel, Path::new(&target)) {
                return Err(unsafe_entry(&raw));
            }
            make_parent(&path)?;
            symlink(&target, &path).map_err(|e| OpError::Failed(format!("Couldn’t create “{raw}”: {}", plain(&e))))?;
        } else {
            make_parent(&path)?;
            copy_out(ctx, &mut entry, &path, |ctx, n| ctx.add_bytes(n))?;
            write_mode(&path, mode, false);
        }
        ctx.finish_item();
    }
    Ok(())
}

/// Counts the bytes read from the compressed file, so tar progress is measured against its size.
struct Counting<R> {
    inner: R,
    count: Rc<Cell<u64>>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.count.set(self.count.get() + n as u64);
        Ok(n)
    }
}

fn extract_tar(ctx: &mut JobCtx, archive: &Path, format: Format, root: &Path) -> Op {
    let file = File::open(archive).map_err(|e| OpError::Failed(format!("Couldn’t open “{}”: {}", shown(archive), plain(&e))))?;
    ctx.total_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    let count = Rc::new(Cell::new(0u64));
    let raw = Counting { inner: io::BufReader::new(file), count: count.clone() };
    let reader: Box<dyn Read> = match format {
        Format::TarGz => Box::new(flate2::read::MultiGzDecoder::new(raw)),
        Format::TarBz2 => Box::new(bzip2::read::BzDecoder::new(raw)),
        Format::TarXz => {
            // lzma-rs decodes from a buffered reader into a writer, so unpack the stream first.
            let mut raw = io::BufReader::new(raw);
            let mut plain_tar = Vec::new();
            lzma_rs::xz_decompress(&mut raw, &mut plain_tar).map_err(|e| OpError::Failed(format!("The archive is damaged: {e}")))?;
            ctx.check()?;
            Box::new(io::Cursor::new(plain_tar))
        }
        _ => Box::new(raw),
    };
    let mut tar = tar::Archive::new(reader);
    let entries = tar.entries().map_err(|e| OpError::Failed(format!("The archive is damaged: {}", plain(&e))))?;
    for entry in entries {
        ctx.check()?;
        let mut entry = entry.map_err(|e| OpError::Failed(format!("The archive is damaged: {}", plain(&e))))?;
        let raw_path = entry.path().map_err(|e| OpError::Failed(format!("The archive is damaged: {}", plain(&e))))?.into_owned();
        let label = raw_path.to_string_lossy().into_owned();
        let rel = safe_path(&raw_path).ok_or_else(|| unsafe_entry(&label))?;
        if rel.as_os_str().is_empty() {
            continue;
        }
        let path = root.join(&rel);
        let mode = entry.header().mode().unwrap_or(0o644);
        let kind = entry.header().entry_type();
        ctx.begin(&label);
        if kind.is_dir() {
            fs::create_dir_all(&path).map_err(|e| OpError::Failed(format!("Couldn’t create “{label}”: {}", plain(&e))))?;
            write_mode(&path, mode, true);
        } else if kind.is_symlink() {
            let target = entry.link_name().ok().flatten().map(|t| t.into_owned()).unwrap_or_default();
            if !link_stays_inside(&rel, &target) {
                return Err(unsafe_entry(&label));
            }
            make_parent(&path)?;
            symlink(&target, &path).map_err(|e| OpError::Failed(format!("Couldn’t create “{label}”: {}", plain(&e))))?;
        } else if kind.is_file() || kind.is_contiguous() {
            make_parent(&path)?;
            let counter = count.clone();
            copy_out(ctx, &mut entry, &path, |ctx, _| {
                ctx.bytes = counter.get();
                ctx.tick();
            })?;
            write_mode(&path, mode, false);
        }
        // Hard links, devices and other special entries are skipped.
        ctx.bytes = count.get();
        ctx.finish_item();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::jobs::Kind;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("corepro-archive-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ctx() -> JobCtx {
        JobCtx::detached(Kind::Copy, std::env::temp_dir())
    }

    fn write(path: PathBuf, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn sample(root: &Path) -> PathBuf {
        let src = root.join("Project");
        write(src.join("readme.txt"), "hello");
        write(src.join("sub/deep/data.bin"), &"0123456789".repeat(5000));
        fs::create_dir_all(src.join("empty")).unwrap();
        symlink("readme.txt", src.join("link")).unwrap();
        fs::set_permissions(src.join("readme.txt"), fs::Permissions::from_mode(0o640)).unwrap();
        src
    }

    fn assert_sample(out: &Path) {
        assert_eq!(fs::read_to_string(out.join("readme.txt")).unwrap(), "hello");
        assert_eq!(fs::read_to_string(out.join("sub/deep/data.bin")).unwrap().len(), 50000);
        assert!(out.join("empty").is_dir());
        assert_eq!(fs::read_link(out.join("link")).unwrap(), PathBuf::from("readme.txt"));
        assert_eq!(fs::metadata(out.join("readme.txt")).unwrap().permissions().mode() & 0o777, 0o640);
    }

    #[test]
    fn zip_round_trip_keeps_content_links_and_permissions() {
        let root = temp("zip");
        let src = sample(&root);
        let mut c = ctx();
        compress(&mut c, &[src.clone()], &root).unwrap();
        let zip = root.join("Project.zip");
        assert_eq!(c.results, vec![zip.to_string_lossy().into_owned()]);
        assert!(c.bytes >= 50005);
        let out_dir = root.join("out");
        fs::create_dir(&out_dir).unwrap();
        let mut c = ctx();
        extract(&mut c, &zip, &out_dir).unwrap();
        assert_eq!(c.results, vec![out_dir.join("Project").to_string_lossy().into_owned()]);
        // The folder holds what the archive's top level held: the original "Project" folder.
        assert_sample(&out_dir.join("Project/Project"));
        // No temp leftovers.
        let names: Vec<_> = fs::read_dir(&out_dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["Project"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn names_are_unique_for_archives_and_folders() {
        let root = temp("names");
        write(root.join("a.txt"), "a");
        write(root.join("b.txt"), "b");
        compress(&mut ctx(), &[root.join("a.txt"), root.join("b.txt")], &root).unwrap();
        compress(&mut ctx(), &[root.join("a.txt"), root.join("b.txt")], &root).unwrap();
        compress(&mut ctx(), &[root.join("a.txt")], &root).unwrap();
        assert!(root.join("Archive.zip").is_file() && root.join("Archive 2.zip").is_file() && root.join("a.txt.zip").is_file());
        extract(&mut ctx(), &root.join("Archive.zip"), &root).unwrap();
        extract(&mut ctx(), &root.join("Archive.zip"), &root).unwrap();
        assert!(root.join("Archive/a.txt").is_file() && root.join("Archive 2/b.txt").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_cancelled_compress_leaves_nothing() {
        let root = temp("cancel");
        let src = sample(&root);
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let mut c = JobCtx::new(1, Kind::Copy, std::env::temp_dir(), flag, Box::new(|_| {}), Box::new(|_| None));
        assert_eq!(compress(&mut c, &[src], &root), Err(OpError::Cancelled));
        let names: Vec<_> = fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["Project"]);
        let _ = fs::remove_dir_all(&root);
    }

    fn tar_bytes(entries: &[(&str, &[u8])], raw_names: bool) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            if raw_names {
                // `set_path` would refuse "..", which is what a hostile archive would do.
                let field = &mut header.as_old_mut().name;
                field[..name.len()].copy_from_slice(name.as_bytes());
            } else {
                header.set_path(name).unwrap();
            }
            header.set_cksum();
            builder.append(&header, *data).unwrap();
        }
        builder.into_inner().unwrap()
    }

    #[test]
    fn tar_variants_extract() {
        let root = temp("tar");
        let tar = tar_bytes(&[("dir/one.txt", b"1"), ("two.txt", b"22")], false);
        let plain_path = root.join("plain.tar");
        fs::write(&plain_path, &tar).unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&tar).unwrap();
        fs::write(root.join("pack.tar.gz"), gz.finish().unwrap()).unwrap();
        fs::copy(root.join("pack.tar.gz"), root.join("short.tgz")).unwrap();
        for archive in ["plain.tar", "pack.tar.gz", "short.tgz"] {
            extract(&mut ctx(), &root.join(archive), &root).unwrap();
        }
        assert_eq!(fs::read_to_string(root.join("plain/dir/one.txt")).unwrap(), "1");
        assert_eq!(fs::read_to_string(root.join("pack/two.txt")).unwrap(), "22");
        assert_eq!(fs::read_to_string(root.join("short/two.txt")).unwrap(), "22");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn xz_and_bz2_extract() {
        let root = temp("xzbz");
        let tar = tar_bytes(&[("f.txt", b"data")], false);
        let mut xz = Vec::new();
        lzma_rs::xz_compress(&mut io::Cursor::new(&tar), &mut xz).unwrap();
        fs::write(root.join("a.tar.xz"), xz).unwrap();
        let mut bz = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::default());
        bz.write_all(&tar).unwrap();
        fs::write(root.join("b.tar.bz2"), bz.finish().unwrap()).unwrap();
        extract(&mut ctx(), &root.join("a.tar.xz"), &root).unwrap();
        extract(&mut ctx(), &root.join("b.tar.bz2"), &root).unwrap();
        assert_eq!(fs::read_to_string(root.join("a/f.txt")).unwrap(), "data");
        assert_eq!(fs::read_to_string(root.join("b/f.txt")).unwrap(), "data");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tar_refuses_traversal_and_absolute_entries() {
        for (tag, name) in [("dotdot", "../evil.txt"), ("nested", "a/../../evil.txt"), ("abs", "/tmp/corepro-evil.txt")] {
            let root = temp(&format!("tar-{tag}"));
            let dest = root.join("dest");
            fs::create_dir(&dest).unwrap();
            fs::write(root.join("bad.tar"), tar_bytes(&[("ok.txt", b"fine"), (name, b"x")], true)).unwrap();
            let err = extract(&mut ctx(), &root.join("bad.tar"), &dest).unwrap_err();
            assert!(matches!(&err, OpError::Failed(m) if m.contains("unsafe path")), "{tag}: {err:?}");
            assert!(!root.join("evil.txt").exists());
            assert_eq!(fs::read_dir(&dest).unwrap().count(), 0, "{tag}: nothing is left behind");
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn zip_refuses_traversal() {
        let root = temp("zip-bad");
        let dest = root.join("dest");
        fs::create_dir(&dest).unwrap();
        let mut zip = zip::ZipWriter::new(File::create(root.join("bad.zip")).unwrap());
        zip.start_file("../evil.txt", SimpleFileOptions::default()).unwrap();
        zip.write_all(b"x").unwrap();
        zip.finish().unwrap();
        let err = extract(&mut ctx(), &root.join("bad.zip"), &dest).unwrap_err();
        assert!(matches!(&err, OpError::Failed(m) if m.contains("unsafe path")), "{err:?}");
        assert!(!root.join("evil.txt").exists());
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn links_pointing_out_are_refused() {
        assert!(link_stays_inside(Path::new("a/link"), Path::new("../b")));
        assert!(!link_stays_inside(Path::new("link"), Path::new("../b")));
        assert!(!link_stays_inside(Path::new("a/link"), Path::new("/etc/passwd")));
        assert!(!link_stays_inside(Path::new("a/link"), Path::new("../../x")));
    }

    #[test]
    fn detects_formats_by_name() {
        assert_eq!(detect("a.ZIP"), Some((Format::Zip, "a".into())));
        assert_eq!(detect("x.tar.gz"), Some((Format::TarGz, "x".into())));
        assert_eq!(detect("x.tgz"), Some((Format::TarGz, "x".into())));
        assert_eq!(detect("x.tar.xz"), Some((Format::TarXz, "x".into())));
        assert_eq!(detect("x.tar.bz2"), Some((Format::TarBz2, "x".into())));
        assert_eq!(detect("notes.txt"), None);
        assert_eq!(detect(".zip"), None);
    }
}
