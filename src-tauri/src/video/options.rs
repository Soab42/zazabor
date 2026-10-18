//! libVLC instance options chosen in Settings (hardware decoding, buffering, picture quality…).
//! libVLC reads them only when an instance is created, so a change is applied by recreating the
//! shared instance the next time nothing is playing or converting (see `instance()` in `mod.rs`).

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use super::frame::lock_ignore_poison;

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaOptions {
    /// Decode on the graphics chip when it can.
    pub hardware_decoding: bool,
    /// Buffering for network streams, in milliseconds.
    pub network_caching: u32,
    /// Reconnect when a web stream drops.
    pub http_reconnect: bool,
    /// "auto", "on" or "off".
    pub deinterlace: String,
    /// "normal" or "faster" (skips a picture clean-up step on busy machines).
    pub skip_loop_filter: String,
    /// Allow decoder shortcuts that are quicker but can glitch the picture.
    pub fast_decode: bool,
    /// "none", "track" or "album".
    pub replay_gain: String,
    /// Decoder threads; 0 lets libVLC choose.
    pub threads: u32,
}

impl Default for MediaOptions {
    fn default() -> Self {
        Self {
            hardware_decoding: true,
            network_caching: 1000,
            http_reconnect: true,
            deinterlace: "auto".into(),
            skip_loop_filter: "normal".into(),
            fast_decode: false,
            replay_gain: "none".into(),
            threads: 0,
        }
    }
}

impl MediaOptions {
    /// The command-line style arguments for `libvlc_new`. Unknown words fall back to the defaults.
    pub fn args(&self) -> Vec<String> {
        let mut args = vec![format!("--avcodec-hw={}", if self.hardware_decoding { "any" } else { "none" })];
        args.push(format!("--network-caching={}", self.network_caching.clamp(100, 60_000)));
        args.push(if self.http_reconnect { "--http-reconnect" } else { "--no-http-reconnect" }.into());
        args.push(format!(
            "--deinterlace={}",
            match self.deinterlace.as_str() {
                "on" => 1,
                "off" => 0,
                _ => -1,
            }
        ));
        if self.skip_loop_filter == "faster" {
            args.push("--avcodec-skiploopfilter=4".into());
        }
        if self.fast_decode {
            args.push("--avcodec-fast".into());
        }
        let gain = match self.replay_gain.as_str() {
            "track" => "track",
            "album" => "album",
            _ => "none",
        };
        args.push(format!("--audio-replay-gain-mode={gain}"));
        if self.threads > 0 {
            args.push(format!("--avcodec-threads={}", self.threads.clamp(1, 16)));
        }
        args
    }
}

#[link(name = "vlc")]
extern "C" {
    /// Drops our reference to an instance (vlc.rs has no declaration for it).
    pub(super) fn libvlc_release(instance: *mut super::vlc::libvlc_instance_t);
}

/// What the UI asked for, and what the running instance was created with.
static WANTED: Mutex<Option<MediaOptions>> = Mutex::new(None);
static APPLIED: Mutex<Option<MediaOptions>> = Mutex::new(None);

pub fn wanted() -> MediaOptions {
    lock_ignore_poison(&WANTED).clone().unwrap_or_default()
}

pub fn mark_applied(options: MediaOptions) {
    *lock_ignore_poison(&APPLIED) = Some(options);
}

/// An instance exists that was made with other options than the wanted ones.
pub fn pending() -> bool {
    lock_ignore_poison(&APPLIED).as_ref().is_some_and(|applied| *applied != wanted())
}

/// Stores the options and recreates the instance now if nothing is using it. Returns whether
/// the running instance already matches (false: it will be recreated once playback is idle).
#[tauri::command]
pub async fn video_set_options(options: MediaOptions) -> Result<bool, String> {
    super::ensure_unlocked()?;
    *lock_ignore_poison(&WANTED) = Some(options);
    if pending() {
        tauri::async_runtime::spawn_blocking(|| super::instance().map(|_| ())).await.map_err(|e| e.to_string())??;
    }
    Ok(!pending())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_request_hardware_decoding_and_auto_deinterlace() {
        let args = MediaOptions::default().args();
        assert!(args.contains(&"--avcodec-hw=any".to_string()));
        assert!(args.contains(&"--deinterlace=-1".to_string()));
        assert!(args.contains(&"--network-caching=1000".to_string()));
        assert!(!args.iter().any(|a| a.starts_with("--avcodec-threads")));
    }

    #[test]
    fn settings_map_to_arguments_and_are_clamped() {
        let options = MediaOptions {
            hardware_decoding: false,
            network_caching: 5,
            http_reconnect: false,
            deinterlace: "on".into(),
            skip_loop_filter: "faster".into(),
            fast_decode: true,
            replay_gain: "album".into(),
            threads: 99,
        };
        let args = options.args();
        for expected in [
            "--avcodec-hw=none",
            "--network-caching=100",
            "--no-http-reconnect",
            "--deinterlace=1",
            "--avcodec-skiploopfilter=4",
            "--avcodec-fast",
            "--audio-replay-gain-mode=album",
            "--avcodec-threads=16",
        ] {
            assert!(args.contains(&expected.to_string()), "missing {expected} in {args:?}");
        }
    }

    #[test]
    fn unknown_words_fall_back() {
        let options = MediaOptions { deinterlace: "??".into(), replay_gain: "x".into(), ..MediaOptions::default() };
        let args = options.args();
        assert!(args.contains(&"--deinterlace=-1".to_string()));
        assert!(args.contains(&"--audio-replay-gain-mode=none".to_string()));
    }

    /// libVLC must accept every option we generate (it returns null for an unknown one).
    #[test]
    #[ignore]
    fn live_libvlc_accepts_the_generated_arguments() {
        use std::ffi::{c_char, c_int, CString};
        let variants = [
            MediaOptions::default(),
            MediaOptions {
                hardware_decoding: false,
                http_reconnect: false,
                deinterlace: "on".into(),
                skip_loop_filter: "faster".into(),
                fast_decode: true,
                replay_gain: "track".into(),
                threads: 4,
                ..MediaOptions::default()
            },
        ];
        for options in variants {
            let mut args = vec!["--quiet".to_string(), "--no-xlib".to_string()];
            args.extend(options.args());
            let c: Vec<CString> = args.iter().map(|a| CString::new(a.as_str()).unwrap()).collect();
            let argv: Vec<*const c_char> = c.iter().map(|a| a.as_ptr()).collect();
            // SAFETY: argv holds NUL-terminated strings that outlive the call; the instance is released.
            unsafe {
                let instance = super::super::vlc::libvlc_new(argv.len() as c_int, argv.as_ptr());
                assert!(!instance.is_null(), "libVLC rejected {args:?}");
                libvlc_release(instance);
            }
        }
    }

    /// Changing the wanted options makes the next `instance()` call (with nothing playing) build a
    /// fresh instance with them. Run alone: it uses the process-wide instance.
    #[test]
    #[ignore]
    fn live_instance_is_recreated_when_options_change() {
        super::super::instance().unwrap();
        assert!(!pending());
        let mut changed = wanted();
        changed.hardware_decoding = !changed.hardware_decoding;
        *lock_ignore_poison(&WANTED) = Some(changed.clone());
        assert!(pending(), "an instance made with other options must be reported as stale");
        super::super::instance().unwrap();
        assert!(!pending(), "the instance should have been recreated with the new options");
        assert_eq!(*lock_ignore_poison(&APPLIED), Some(changed));
    }

    #[test]
    fn partial_json_keeps_defaults() {
        let options: MediaOptions = serde_json::from_str(r#"{"hardwareDecoding":false}"#).unwrap();
        assert!(!options.hardware_decoding);
        assert_eq!(options.network_caching, 1000);
    }
}
