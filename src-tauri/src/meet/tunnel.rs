//! The Cloudflare quick tunnel: `cloudflared tunnel --url http://127.0.0.1:<port>` gives the
//! meeting page a public `https://….trycloudflare.com` address. Only signalling and the page go
//! through it; the audio and video are peer to peer.
//!
//! `cloudflared` is looked for on PATH, in ~/.local/bin and in Zazabor's data folder; failing
//! that it's downloaded from the latest GitHub release, checked against the SHA-256 the release
//! lists, and kept in the data folder. A tunnel that dies is restarted with a growing wait.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Info {
    /// "off", "starting", "on" or "error".
    pub state: String,
    pub url: Option<String>,
    pub error: Option<String>,
}

pub struct Tunnel {
    info: Mutex<Info>,
    want: AtomicBool,
    generation: AtomicU64,
    pid: AtomicU32,
}

const RELEASE_API: &str = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
const MAX_BINARY: u64 = 200 << 20;

#[cfg(target_arch = "aarch64")]
const ASSET: &str = "cloudflared-linux-arm64";
#[cfg(not(target_arch = "aarch64"))]
const ASSET: &str = "cloudflared-linux-amd64";

/// `https://random-words.trycloudflare.com` in a line of cloudflared's output (its own `api.`
/// host, named in error messages, doesn't count).
pub fn parse_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start + 8..];
    let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '.')).unwrap_or(rest.len());
    let host = &rest[..end];
    let name = host.strip_suffix(".trycloudflare.com")?;
    if name.is_empty() || name == "api" || name.contains('.') {
        return None;
    }
    Some(format!("https://{host}"))
}

impl Tunnel {
    pub fn new() -> Arc<Tunnel> {
        Arc::new(Tunnel { info: Mutex::new(Info { state: "off".into(), url: None, error: None }), want: AtomicBool::new(false), generation: AtomicU64::new(0), pid: AtomicU32::new(0) })
    }

    pub fn info(&self) -> Info {
        self.info.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, state: &str, url: Option<String>, error: Option<String>, changed: &Arc<dyn Fn() + Send + Sync>) {
        *self.info.lock().unwrap_or_else(|e| e.into_inner()) = Info { state: state.into(), url, error };
        changed();
    }

    pub fn wanted(&self) -> bool {
        self.want.load(Ordering::SeqCst)
    }

    /// Starts the tunnel in the background (nothing happens if it is already wanted).
    pub fn start(self: &Arc<Self>, port: u16, dir: PathBuf, changed: Arc<dyn Fn() + Send + Sync>) {
        if self.want.swap(true, Ordering::SeqCst) {
            return;
        }
        let mine = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let this = self.clone();
        self.set("starting", None, None, &changed);
        std::thread::spawn(move || this.supervise(mine, port, &dir, &changed));
    }

    pub fn stop(&self) {
        self.want.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        let pid = self.pid.swap(0, Ordering::SeqCst);
        if pid != 0 {
            // SAFETY: signalling the child this module started.
            unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        }
        *self.info.lock().unwrap_or_else(|e| e.into_inner()) = Info { state: "off".into(), url: None, error: None };
    }

    /// Waits until the tunnel is on (its address) or has failed.
    pub fn wait_on(&self, timeout: Duration) -> Result<String, String> {
        let end = Instant::now() + timeout;
        loop {
            let info = self.info();
            match (info.state.as_str(), info.url) {
                ("on", Some(url)) => return Ok(url),
                ("off", _) => return Err("The tunnel is off.".into()),
                ("error", _) if Instant::now() > end => return Err(info.error.unwrap_or_else(|| "The tunnel couldn't start.".into())),
                _ => {}
            }
            if Instant::now() > end {
                return Err(info.error.unwrap_or_else(|| "The tunnel didn't come up in time.".into()));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    fn current(&self, mine: u64) -> bool {
        self.want.load(Ordering::SeqCst) && self.generation.load(Ordering::SeqCst) == mine
    }

    fn supervise(&self, mine: u64, port: u16, dir: &Path, changed: &Arc<dyn Fn() + Send + Sync>) {
        let mut wait = Duration::from_secs(2);
        while self.current(mine) {
            let binary = match ensure_binary(dir) {
                Ok(b) => b,
                Err(e) => {
                    self.set("error", None, Some(e), changed);
                    self.sleep(mine, wait);
                    wait = (wait * 2).min(Duration::from_secs(60));
                    continue;
                }
            };
            if !self.current(mine) {
                break;
            }
            let mut cmd = Command::new(&binary);
            cmd.args(["tunnel", "--no-autoupdate", "--url", &format!("http://127.0.0.1:{port}")]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
            #[cfg(target_os = "linux")]
            {
                use std::os::unix::process::CommandExt;
                // SAFETY: only prctl, which is async-signal-safe, runs between fork and exec.
                // The tunnel dies with Zazabor (this thread lives as long as the tunnel does).
                unsafe {
                    cmd.pre_exec(|| {
                        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                        Ok(())
                    });
                }
            }
            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    self.set("error", None, Some(format!("cloudflared couldn't start: {e}")), changed);
                    self.sleep(mine, wait);
                    wait = (wait * 2).min(Duration::from_secs(60));
                    continue;
                }
            };
            self.pid.store(child.id(), Ordering::SeqCst);
            if !self.current(mine) {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            self.set("starting", None, None, changed);
            let began = Instant::now();
            let mut last_error = String::new();
            if let Some(stderr) = child.stderr.take() {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if let Some(url) = parse_url(&line) {
                        self.set("on", Some(url), None, changed);
                    } else if line.contains("ERR") {
                        last_error = line.chars().take(200).collect();
                    }
                }
            }
            let _ = child.wait();
            if !self.current(mine) {
                break;
            }
            let ran = began.elapsed();
            let msg = if last_error.is_empty() { "The tunnel stopped.".to_string() } else { format!("The tunnel stopped: {last_error}") };
            self.set("error", None, Some(msg), changed);
            if ran > Duration::from_secs(60) {
                wait = Duration::from_secs(2);
            }
            self.sleep(mine, wait);
            wait = (wait * 2).min(Duration::from_secs(60));
            if self.current(mine) {
                self.set("starting", None, None, changed);
            }
        }
    }

    fn sleep(&self, mine: u64, total: Duration) {
        let end = Instant::now() + total;
        while Instant::now() < end && self.current(mine) {
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}

/// PATH, then ~/.local/bin, then the data folder; else download.
pub fn find_binary(dir: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).map(|d| d.join("cloudflared")).collect()).unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local/bin/cloudflared"));
    }
    candidates.push(dir.join("cloudflared"));
    candidates.into_iter().find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.is_file() && std::fs::metadata(p).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

pub fn ensure_binary(dir: &Path) -> Result<PathBuf, String> {
    if let Some(found) = find_binary(dir) {
        return Ok(found);
    }
    let target = dir.join("cloudflared");
    download(&target).map_err(|e| format!("cloudflared isn't installed and couldn't be downloaded: {e}"))?;
    Ok(target)
}

/// The SHA-256 the release lists for `asset`: its `digest` field, else a `name: hex` line of the notes.
pub fn checksum_for(release: &Value, asset: &str) -> Option<[u8; 32]> {
    let hex = release
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find(|x| x.get("name").and_then(Value::as_str) == Some(asset)))
        .and_then(|x| x.get("digest").and_then(Value::as_str))
        .and_then(|d| d.strip_prefix("sha256:"))
        .map(str::to_string)
        .or_else(|| {
            let body = release.get("body").and_then(Value::as_str)?;
            body.lines().find_map(|line| {
                let (name, rest) = line.split_once(':')?;
                (name.trim().trim_matches(|c| c == '*' || c == '`') == asset).then(|| rest.trim().trim_matches('`').to_string())
            })
        })?;
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_connect(Some(Duration::from_secs(20))).timeout_global(Some(Duration::from_secs(600))).max_redirects(5).http_status_as_error(false).build().into()
}

fn download(path: &Path) -> Result<(), String> {
    let response = agent().get(RELEASE_API).header("User-Agent", "Zazabor").header("Accept", "application/vnd.github+json").call().map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    if response.status().as_u16() != 200 {
        return Err(format!("GitHub answered {}", response.status().as_u16()));
    }
    let text = response.into_body().with_config().limit(4 << 20).read_to_string().map_err(|e| e.to_string())?;
    let release: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let want = checksum_for(&release, ASSET).ok_or("the release lists no checksum for cloudflared")?;
    let url = release
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find(|x| x.get("name").and_then(Value::as_str) == Some(ASSET)))
        .and_then(|x| x.get("browser_download_url").and_then(Value::as_str))
        .filter(|u| u.starts_with("https://github.com/cloudflare/cloudflared/"))
        .ok_or("the release has no cloudflared for this computer")?
        .to_string();
    let response = agent().get(&url).header("User-Agent", "Zazabor").call().map_err(|e| format!("couldn't download cloudflared: {e}"))?;
    if response.status().as_u16() != 200 {
        return Err(format!("the download answered {}", response.status().as_u16()));
    }
    let dir = path.parent().ok_or("no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let part = path.with_extension("part");
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut reader = response.into_body().into_with_config().limit(MAX_BINARY).reader();
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("the download stopped: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if hasher.finalize().as_slice() != want {
        let _ = std::fs::remove_file(&part);
        return Err("the download didn't match the published checksum".into());
    }
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    std::fs::rename(&part, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_is_read_from_cloudflareds_output() {
        let banner = "2026-11-21T10:00:01Z INF |  https://quiet-river-shaped-lamp.trycloudflare.com                                     |";
        assert_eq!(parse_url(banner).as_deref(), Some("https://quiet-river-shaped-lamp.trycloudflare.com"));
        let err = "2026-11-21T10:00:00Z ERR failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": dial tcp: lookup";
        assert_eq!(parse_url(err), None);
        assert_eq!(parse_url("INF Requesting new quick Tunnel on trycloudflare.com..."), None);
        assert_eq!(parse_url("https://example.com/x"), None);
    }

    #[test]
    fn the_checksum_comes_from_the_digest_or_the_notes() {
        let hex = "ab".repeat(32);
        let by_digest = serde_json::json!({"assets": [{"name": ASSET, "digest": format!("sha256:{hex}")}]});
        assert_eq!(checksum_for(&by_digest, ASSET), Some([0xab; 32]));
        let by_notes = serde_json::json!({"assets": [], "body": format!("**Checksums**\n{ASSET}: {hex}\ncloudflared-darwin-amd64.tgz: {}", "cd".repeat(32))});
        assert_eq!(checksum_for(&by_notes, ASSET), Some([0xab; 32]));
        assert_eq!(checksum_for(&serde_json::json!({"assets": []}), ASSET), None);
        assert_eq!(checksum_for(&serde_json::json!({"body": format!("{ASSET}: 1234")}), ASSET), None);
    }
}
