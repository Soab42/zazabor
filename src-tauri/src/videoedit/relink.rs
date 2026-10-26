//! Finding a project's moved files again: each missing file is looked for by name (and size,
//! when the project knows it) under a few folders, the nearest first.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Files looked at per search at most, so a search of a big folder stays quick.
const MAX_ENTRIES: usize = 200_000;
/// How deep a search goes below each folder.
const MAX_DEPTH: usize = 6;

#[derive(Deserialize, Clone, Debug)]
pub struct Wanted {
    pub id: String,
    /// The file name it had.
    pub name: String,
    /// Its size in bytes, if the project recorded it.
    pub bytes: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Found {
    pub id: String,
    pub path: String,
}

/// The best of the files named like a missing one: the same size when the size is known (else
/// none), and among equals the first one found (searches go nearest folder first).
pub fn best_match(candidates: &[(PathBuf, u64)], bytes: Option<u64>) -> Option<PathBuf> {
    match bytes {
        Some(size) => candidates.iter().find(|(_, b)| *b == size).map(|(p, _)| p.clone()),
        None => candidates.first().map(|(p, _)| p.clone()),
    }
}

fn hidden(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

/// Looks for `wanted` under `roots` (in order). Hidden folders are skipped.
pub fn search(roots: &[PathBuf], wanted: &[Wanted]) -> Vec<Found> {
    let names: HashMap<String, Vec<usize>> = wanted.iter().enumerate().fold(HashMap::new(), |mut map, (i, w)| {
        map.entry(w.name.to_lowercase()).or_default().push(i);
        map
    });
    let mut candidates: Vec<Vec<(PathBuf, u64)>> = vec![Vec::new(); wanted.len()];
    let mut seen = 0usize;
    let mut visited: Vec<PathBuf> = Vec::new();
    'roots: for root in roots {
        if !root.is_dir() || visited.iter().any(|v| root.starts_with(v)) {
            continue;
        }
        visited.push(root.clone());
        let walk = walkdir::WalkDir::new(root).max_depth(MAX_DEPTH).follow_links(false).into_iter().filter_entry(|e| e.depth() == 0 || !hidden(e.file_name()));
        for entry in walk.filter_map(|e| e.ok()) {
            seen += 1;
            if seen > MAX_ENTRIES {
                break 'roots;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let Some(indices) = names.get(&entry.file_name().to_string_lossy().to_lowercase()) else { continue };
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            for &i in indices {
                candidates[i].push((entry.path().to_path_buf(), size));
            }
        }
    }
    wanted
        .iter()
        .zip(&candidates)
        .filter_map(|(w, list)| best_match(list, w.bytes).map(|p| Found { id: w.id.clone(), path: p.to_string_lossy().into_owned() }))
        .collect()
}

/// The folders to search for a project's missing files: the project's folder and the one above
/// it, then the nearest existing folder above where each file used to be.
pub fn roots_for(project: Option<&Path>, old_paths: &[String]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        if p.parent().is_some() && !roots.contains(&p) {
            roots.push(p);
        }
    };
    if let Some(folder) = project.and_then(Path::parent) {
        add(folder.to_path_buf());
        if let Some(up) = folder.parent() {
            add(up.to_path_buf());
        }
    }
    for old in old_paths {
        let mut at = Path::new(old).parent();
        while let Some(dir) = at {
            if dir.is_dir() {
                add(dir.to_path_buf());
                break;
            }
            at = dir.parent();
        }
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_known_size_must_match_and_the_nearest_wins() {
        let a = (PathBuf::from("/x/near/clip.mp4"), 100);
        let b = (PathBuf::from("/x/far/clip.mp4"), 200);
        assert_eq!(best_match(&[a.clone(), b.clone()], Some(200)), Some(b.0.clone()));
        assert_eq!(best_match(&[a.clone(), b.clone()], Some(300)), None);
        assert_eq!(best_match(&[a.clone(), b], None), Some(a.0));
        assert_eq!(best_match(&[], None), None);
    }

    #[test]
    fn finds_moved_files_by_name_and_size_and_skips_hidden_folders() {
        let dir = std::env::temp_dir().join(format!("corepro-relink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("moved/deeper")).unwrap();
        std::fs::create_dir_all(dir.join(".trash")).unwrap();
        std::fs::write(dir.join("moved/deeper/Clip.MP4"), b"12345").unwrap();
        std::fs::write(dir.join("moved/song.mp3"), b"123").unwrap();
        std::fs::write(dir.join(".trash/other.mov"), b"1").unwrap();
        // A same-named file of another size is someone else's.
        std::fs::write(dir.join("moved/photo.jpg"), b"1234567").unwrap();
        let wanted = vec![
            Wanted { id: "a".into(), name: "clip.mp4".into(), bytes: Some(5) },
            Wanted { id: "b".into(), name: "song.mp3".into(), bytes: None },
            Wanted { id: "c".into(), name: "other.mov".into(), bytes: None },
            Wanted { id: "d".into(), name: "photo.jpg".into(), bytes: Some(3) },
        ];
        let found = search(&[dir.clone()], &wanted);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0].id, "a");
        assert!(found[0].path.ends_with("moved/deeper/Clip.MP4"));
        assert_eq!(found[1].id, "b");
    }

    #[test]
    fn roots_start_at_the_project_and_climb_to_where_files_were() {
        let tmp = std::env::temp_dir();
        let project = tmp.join("a/b/reel.corevideo");
        let roots = roots_for(Some(&project), &[tmp.join("gone/away/clip.mp4").to_string_lossy().into_owned()]);
        assert_eq!(roots[0], tmp.join("a/b"));
        assert_eq!(roots[1], tmp.join("a"));
        // gone/away doesn't exist: its nearest existing folder is the temp folder.
        assert_eq!(roots[2], tmp);
    }
}
