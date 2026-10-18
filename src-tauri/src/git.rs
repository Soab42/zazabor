//! Source control for the editor: the `git` command line run in a repository, so the user's own
//! configuration, hooks, credentials and signing all apply. Discarding an untracked file moves it
//! to the Trash rather than deleting it.

use gio::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Status lists stop here (a huge untracked folder shouldn't flood the panel).
const MAX_FILES: usize = 5000;
/// Network commands (push, pull) give up after this long.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

fn git(root: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root);
    // Never wait for a password prompt nobody can see.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    cmd.stdin(Stdio::null());
    cmd
}

/// Runs git and returns its output, or its error message.
fn run(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = git(root).args(args).output().map_err(|e| format!("Couldn’t run git: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(message(&out.stderr, &out.stdout))
    }
}

/// Runs a network command with a time limit.
fn run_network(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut child = git(root)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn’t run git: {e}"))?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let out = child.wait_with_output().map_err(|e| e.to_string())?;
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            return if status.success() { Ok(text.trim().to_string()) } else { Err(message(&out.stderr, &out.stdout)) };
        }
        if started.elapsed() > NETWORK_TIMEOUT {
            let _ = child.kill();
            return Err("Git took too long to reach the remote and was stopped.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn message(stderr: &[u8], stdout: &[u8]) -> String {
    let text = String::from_utf8_lossy(if stderr.iter().any(|b| !b.is_ascii_whitespace()) { stderr } else { stdout });
    let text = text.trim();
    if text.is_empty() { "Git reported an error.".into() } else { text.to_string() }
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_string()
}

// ---- status -----------------------------------------------------------------------------------

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    /// Relative to the repository root, with "/" separators.
    pub path: String,
    /// Staged change: 'M', 'A', 'D', 'R', 'C', 'T', 'U' (conflict), '?' (untracked) or '.' (none).
    pub index: char,
    /// Change in the working tree, same letters.
    pub work: char,
    /// The old path of a rename.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// The repository's top folder.
    pub root: String,
    /// The branch checked out; empty when detached.
    pub branch: String,
    /// The commit when detached (short hash).
    pub commit: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
    /// More files changed than are listed.
    pub truncated: bool,
}

/// Parses `git status --porcelain=v2 --branch -z`.
fn parse_status(root: String, raw: &[u8]) -> GitStatus {
    let mut status = GitStatus { root, ..Default::default() };
    let mut fields = raw.split(|b| *b == 0).map(|f| String::from_utf8_lossy(f).into_owned());
    while let Some(line) = fields.next() {
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("# ") {
            let (key, value) = rest.split_once(' ').unwrap_or((rest, ""));
            match key {
                "branch.oid" => status.commit = value.chars().take(8).collect(),
                "branch.head" if value != "(detached)" => status.branch = value.to_string(),
                "branch.upstream" => status.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            status.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            status.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if status.files.len() >= MAX_FILES {
            status.truncated = true;
            continue;
        }
        let xy = |s: &str| {
            let mut c = s.chars();
            (c.next().unwrap_or('.'), c.next().unwrap_or('.'))
        };
        let mut parts = line.splitn(2, ' ');
        let kind = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        match kind {
            // 1 XY sub mH mI mW hH hI path
            "1" => {
                let cols: Vec<&str> = rest.splitn(8, ' ').collect();
                if cols.len() == 8 {
                    let (index, work) = xy(cols[0]);
                    status.files.push(GitFile { path: cols[7].to_string(), index, work, from: None });
                }
            }
            // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next field
            "2" => {
                let cols: Vec<&str> = rest.splitn(9, ' ').collect();
                let from = fields.next();
                if cols.len() == 9 {
                    let (index, work) = xy(cols[0]);
                    status.files.push(GitFile { path: cols[8].to_string(), index, work, from });
                }
            }
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            "u" => {
                let cols: Vec<&str> = rest.splitn(10, ' ').collect();
                if cols.len() == 10 {
                    status.files.push(GitFile { path: cols[9].to_string(), index: 'U', work: 'U', from: None });
                }
            }
            "?" => status.files.push(GitFile { path: rest.to_string(), index: '?', work: '?', from: None }),
            _ => {}
        }
    }
    status
}

/// The repository a folder is in and what changed; `None` outside a repository.
fn status(folder: &Path) -> Result<Option<GitStatus>, String> {
    let Ok(top) = run(folder, &["rev-parse", "--show-toplevel"]) else { return Ok(None) };
    let root = text(top);
    let raw = run(Path::new(&root), &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
    Ok(Some(parse_status(root, &raw)))
}

fn has_head(root: &Path) -> bool {
    run(root, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

// ---- commands ---------------------------------------------------------------------------------

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    crate::ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_status(folder: String) -> Result<Option<GitStatus>, String> {
    blocking(move || status(Path::new(&folder))).await
}

/// A file's text at a revision: `HEAD:path` (last commit) or `:path` (staged); `None` when it
/// doesn't exist there (a new file).
#[tauri::command]
pub async fn git_show(root: String, spec: String) -> Result<Option<String>, String> {
    blocking(move || Ok(run(Path::new(&root), &["show", &spec]).ok().map(|b| String::from_utf8_lossy(&b).into_owned()))).await
}

fn with_paths<'a>(base: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    let mut args = base.to_vec();
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    args
}

#[tauri::command]
pub async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || run(Path::new(&root), &with_paths(&["add", "-A"], &paths)).map(|_| ())).await
}

#[tauri::command]
pub async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let root = Path::new(&root);
        // Before the first commit there's no HEAD to reset to.
        let args = if has_head(root) { with_paths(&["reset", "-q", "HEAD"], &paths) } else { with_paths(&["rm", "-q", "-r", "--cached"], &paths) };
        run(root, &args).map(|_| ())
    })
    .await
}

/// Throws away working-tree changes: tracked files go back to their staged/committed state,
/// untracked ones move to the Trash.
#[tauri::command]
pub async fn git_discard(root: String, tracked: Vec<String>, untracked: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let root_path = PathBuf::from(&root);
        if !tracked.is_empty() {
            run(&root_path, &with_paths(&["checkout"], &tracked))?;
        }
        for rel in &untracked {
            let file = gio::File::for_path(root_path.join(rel));
            file.trash(gio::Cancellable::NONE).map_err(|e| format!("Couldn’t move “{rel}” to the Trash: {}", e.message()))?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn git_commit(root: String, message: String, amend: bool) -> Result<(), String> {
    blocking(move || {
        let mut args = vec!["commit", "-q", "-m", message.as_str()];
        if amend {
            args.push("--amend");
        }
        run(Path::new(&root), &args).map(|_| ())
    })
    .await
}

/// Pushes the branch; one without an upstream is pushed to `origin` and tracks it from then on.
#[tauri::command]
pub async fn git_push(root: String) -> Result<String, String> {
    blocking(move || {
        let root = Path::new(&root);
        let tracked = run(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_ok();
        if tracked { run_network(root, &["push"]) } else { run_network(root, &["push", "-u", "origin", "HEAD"]) }
    })
    .await
}

#[tauri::command]
pub async fn git_pull(root: String) -> Result<String, String> {
    blocking(move || run_network(Path::new(&root), &["pull", "--ff-only"])).await
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<Vec<String>, String> {
    blocking(move || {
        let out = run(Path::new(&root), &["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "refs/heads"])?;
        Ok(String::from_utf8_lossy(&out).lines().map(str::to_string).filter(|l| !l.is_empty()).collect())
    })
    .await
}

/// Switches to a branch, creating it from the current commit when `create` is set.
#[tauri::command]
pub async fn git_checkout(root: String, branch: String, create: bool) -> Result<(), String> {
    blocking(move || {
        let args: Vec<&str> = if create { vec!["checkout", "-q", "-b", &branch] } else { vec!["checkout", "-q", &branch] };
        run(Path::new(&root), &args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_init(folder: String) -> Result<(), String> {
    blocking(move || run(Path::new(&folder), &["init", "-q"]).map(|_| ())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("corepro-git-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-q", "-b", "main"]).unwrap();
        run(&dir, &["config", "user.email", "test@example.com"]).unwrap();
        run(&dir, &["config", "user.name", "Test"]).unwrap();
        run(&dir, &["config", "commit.gpgsign", "false"]).unwrap();
        dir
    }

    #[test]
    fn porcelain_v2_is_parsed() {
        let raw = b"# branch.oid 0123456789abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/a b.rs\0\
2 R. N... 100644 100644 100644 aaa bbb R100 new.rs\0old.rs\0\
u UU N... 100644 100644 100644 100644 a b c conflict.txt\0? notes.md\0";
        let s = parse_status("/repo".into(), raw);
        assert_eq!((s.branch.as_str(), s.commit.as_str(), s.upstream.as_deref(), s.ahead, s.behind), ("main", "01234567", Some("origin/main"), 2, 1));
        assert_eq!(s.files, vec![
            GitFile { path: "src/a b.rs".into(), index: '.', work: 'M', from: None },
            GitFile { path: "new.rs".into(), index: 'R', work: '.', from: Some("old.rs".into()) },
            GitFile { path: "conflict.txt".into(), index: 'U', work: 'U', from: None },
            GitFile { path: "notes.md".into(), index: '?', work: '?', from: None },
        ]);
    }

    #[test]
    fn stage_commit_unstage_and_discard_in_a_real_repository() {
        let dir = temp_repo("flow");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        let s = status(&dir).unwrap().unwrap();
        assert_eq!(s.files, vec![GitFile { path: "a.txt".into(), index: '?', work: '?', from: None }]);
        assert_eq!(s.branch, "main");

        // Staging and unstaging before the first commit (no HEAD yet).
        run(&dir, &with_paths(&["add", "-A"], &["a.txt".into()])).unwrap();
        assert_eq!(status(&dir).unwrap().unwrap().files[0].index, 'A');
        run(&dir, &with_paths(&["rm", "-q", "-r", "--cached"], &["a.txt".into()])).unwrap();
        assert_eq!(status(&dir).unwrap().unwrap().files[0].index, '?');

        run(&dir, &["add", "-A"]).unwrap();
        run(&dir, &["commit", "-q", "-m", "first"]).unwrap();
        assert!(status(&dir).unwrap().unwrap().files.is_empty());
        assert!(has_head(&dir));

        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        assert_eq!(status(&dir).unwrap().unwrap().files[0].work, 'M');
        assert_eq!(text(run(&dir, &["show", "HEAD:a.txt"]).unwrap()), "one");
        run(&dir, &with_paths(&["checkout"], &["a.txt".into()])).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_outside_any_repository_has_no_status() {
        let dir = std::env::temp_dir().join(format!("corepro-nogit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // /tmp is not inside a repository on a normal system.
        assert_eq!(status(&dir).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
