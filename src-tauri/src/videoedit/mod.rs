//! The Video Editor's media side (Studio → Video, docs/plans/video-editor.md). The page owns the
//! project, the timeline and the compositor (WebGL2); this side probes files, serves decoded
//! frames at preview size, thumbnail strips and PCM sound, encodes exports and reads and writes
//! `.corevideo` projects. Bulk data crosses the bridge raw (`tauri::ipc::Response` and request
//! bodies), never as JSON arrays.

mod audio;
mod export;
mod frames;
mod h264;
mod media;
mod project;
mod record;
mod recover;
mod relink;

use std::path::Path;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::Manager;

/// A project file bigger than this isn't one.
const MAX_PROJECT_BYTES: u64 = 64 * 1024 * 1024;

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

/// Streams, size, frame rate and codecs of a clip or a sound.
#[tauri::command]
pub async fn videoedit_probe(path: String) -> Result<media::Probe, String> {
    crate::ensure_unlocked()?;
    blocking(move || media::probe(&path)).await
}

/// The frame showing at `time` (seconds into the file) for the timeline clip `key`, decoded at
/// most `max_width`×`max_height`. `width`/`height` are the probed (shown) size. See
/// `frames::frame` for the header.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn videoedit_frame(key: String, path: String, time: f64, width: u32, height: u32, max_width: u32, max_height: u32, have: Option<f64>) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let bytes = blocking(move || frames::frame(&key, &path, time, (width, height), (max_width, max_height), have)).await?;
    Ok(Response::new(bytes))
}

/// Closes the decoders of clips the page no longer shows (or all of a project's, by prefix).
#[tauri::command]
pub async fn videoedit_release(keys: Vec<String>, prefix: Option<String>) -> Result<(), String> {
    blocking(move || {
        frames::release(&keys, prefix.as_deref());
        Ok(())
    })
    .await
}

/// A thumbnail strip: 4 bytes (one picture's width, u32 LE), then a JPEG of `count` pictures
/// side by side, evenly spread over the clip.
#[tauri::command]
pub async fn videoedit_strip(path: String, width: u32, height: u32, duration: f64, thumb_height: u32, count: u32) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let (jpeg, thumb_width) = blocking(move || frames::strip(&path, (width, height), duration, thumb_height, count)).await?;
    let mut out = thumb_width.to_le_bytes().to_vec();
    out.extend_from_slice(&jpeg);
    Ok(Response::new(out))
}

/// The whole sound of a file as interleaved S16LE, stereo, 48 kHz (empty when it has none).
#[tauri::command]
pub async fn videoedit_audio(app: tauri::AppHandle, path: String, has_audio: bool) -> Result<Response, String> {
    crate::ensure_unlocked()?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("videoedit").join("audio");
    let bytes = blocking(move || audio::pcm(&path, &cache, has_audio)).await?;
    Ok(Response::new(bytes))
}

/// Which encoders this system has, for the export dialog.
#[tauri::command]
pub async fn videoedit_encoders() -> Result<export::Encoders, String> {
    blocking(export::encoders).await
}

#[tauri::command]
pub async fn videoedit_export_begin(spec: export::Spec) -> Result<u32, String> {
    blocking(move || export::begin(spec)).await
}

fn job_and_body(request: &Request<'_>) -> Result<(u32, Vec<u8>), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Nothing was sent.".into());
    };
    let job = request.headers().get("x-job").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).ok_or("Which export?")?;
    Ok((job, bytes.to_vec()))
}

/// The export's whole sound mix (body: S16LE stereo 48 kHz; header `x-job`).
#[tauri::command]
pub async fn videoedit_export_audio(request: Request<'_>) -> Result<(), String> {
    let (job, pcm) = job_and_body(&request)?;
    blocking(move || export::audio(job, &pcm)).await
}

/// The next frame (body: I420 at the output size; header `x-job`); returns frames written.
#[tauri::command]
pub async fn videoedit_export_frame(request: Request<'_>) -> Result<u64, String> {
    let (job, frame) = job_and_body(&request)?;
    blocking(move || export::frame(job, frame)).await
}

#[tauri::command]
pub async fn videoedit_export_finish(job: u32) -> Result<export::Done, String> {
    blocking(move || export::finish(job)).await
}

#[tauri::command]
pub async fn videoedit_export_cancel(job: u32) -> Result<(), String> {
    blocking(move || {
        export::cancel(job);
        Ok(())
    })
    .await
}

/// Writes a project (the page's JSON), with media paths made relative to its folder.
#[tauri::command]
pub async fn videoedit_project_save(path: String, text: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    blocking(move || {
        let mut value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let file = Path::new(&path);
        let folder = file.parent().ok_or("Save where?")?;
        project::to_disk(&mut value, folder);
        let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        crate::fs::text::write_bytes(file, text.as_bytes()).map(|_| ())
    })
    .await
}

/// Reads a project; media paths come back absolute, with `missing` on what can't be found.
#[tauri::command]
pub async fn videoedit_project_open(path: String) -> Result<String, String> {
    crate::ensure_unlocked()?;
    blocking(move || {
        let file = Path::new(&path);
        let bytes = crate::fs::text::read_bytes(file, MAX_PROJECT_BYTES)?;
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "This project file is damaged.".to_string())?;
        project::from_disk(&mut value, file.parent().ok_or("Bad path")?, |p| p.is_file())?;
        serde_json::to_string(&value).map_err(|e| e.to_string())
    })
    .await
}

/// Looks for missing media by name and size: under `folder` when given (the user picked it),
/// else around the project and where the files used to be.
#[tauri::command]
pub async fn videoedit_relink(project: Option<String>, folder: Option<String>, missing: Vec<relink::Wanted>, old_paths: Vec<String>) -> Result<Vec<relink::Found>, String> {
    crate::ensure_unlocked()?;
    blocking(move || {
        let roots = match folder {
            Some(f) => vec![std::path::PathBuf::from(f)],
            None => relink::roots_for(project.as_deref().map(Path::new), &old_paths),
        };
        Ok(relink::search(&roots, &missing))
    })
    .await
}

fn recovery_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("videoedit").join("recovery"))
}

/// Keeps a snapshot of an unsaved project (AutoRecover).
#[tauri::command]
pub async fn videoedit_recovery_save(app: tauri::AppHandle, meta: recover::Snapshot, text: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    let dir = recovery_dir(&app)?;
    blocking(move || recover::save(&dir, meta, &text, std::process::id(), crate::notes::now())).await
}

/// Snapshots left by a CorePro that stopped without saving, newest first.
#[tauri::command]
pub async fn videoedit_recovery_list(app: tauri::AppHandle) -> Result<Vec<recover::Snapshot>, String> {
    crate::ensure_unlocked()?;
    let dir = recovery_dir(&app)?;
    blocking(move || Ok(recover::list(&dir, std::process::id()))).await
}

#[tauri::command]
pub async fn videoedit_recovery_read(app: tauri::AppHandle, id: String) -> Result<String, String> {
    crate::ensure_unlocked()?;
    let dir = recovery_dir(&app)?;
    blocking(move || {
        let text = recover::read(&dir, &id)?;
        // Files may have gone since: mark them, as opening a project does.
        let mut value: serde_json::Value = serde_json::from_str(&text).map_err(|_| "The snapshot is damaged.".to_string())?;
        project::from_disk(&mut value, Path::new("/"), |p| p.is_file())?;
        serde_json::to_string(&value).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn videoedit_recovery_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = recovery_dir(&app)?;
    blocking(move || recover::delete(&dir, &id)).await
}

/// Writes a small text file (captions as .srt).
#[tauri::command]
pub async fn videoedit_write_text(path: String, text: String) -> Result<(), String> {
    crate::ensure_unlocked()?;
    blocking(move || crate::fs::text::write_bytes(Path::new(&path), text.as_bytes()).map(|_| ())).await
}

#[derive(serde::Serialize)]
pub struct Recording {
    id: u64,
    path: String,
}

/// Starts a voice-over: into `folder` (the project's Voice-overs folder) or the app's own.
#[tauri::command]
pub async fn videoedit_record_start(app: tauri::AppHandle, folder: Option<String>) -> Result<Recording, String> {
    crate::ensure_unlocked()?;
    let dir = match folder {
        Some(f) => std::path::PathBuf::from(f),
        None => app.path().app_data_dir().map_err(|e| e.to_string())?.join("videoedit").join("voice-overs"),
    };
    blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = (1..10_000).map(|n| dir.join(format!("Voice-over {n}.wav"))).find(|p| !p.exists()).ok_or("Too many voice-overs here.")?;
        let path = path.to_string_lossy().into_owned();
        let id = record::start(&path)?;
        Ok(Recording { id, path })
    })
    .await
}

/// The microphone's loudest moment since the last call (0…1).
#[tauri::command]
pub async fn videoedit_record_level(id: u64) -> Result<f32, String> {
    record::level(id)
}

#[tauri::command]
pub async fn videoedit_record_stop(id: u64, keep: bool) -> Result<record::Recorded, String> {
    blocking(move || record::stop(id, keep)).await
}

/// Runs against real files: `COREPRO_VIDEOEDIT_SAMPLE=clip.mp4 cargo test videoedit -- --ignored`.
#[cfg(test)]
mod live_tests {
    use super::*;

    fn sample() -> Option<String> {
        std::env::var("COREPRO_VIDEOEDIT_SAMPLE").ok()
    }

    #[test]
    #[ignore]
    fn probes_decodes_and_seeks_a_sample() {
        let Some(path) = sample() else { return };
        let probe = media::probe(&path).unwrap();
        println!("probe: {probe:?}");
        let video = probe.video.clone().unwrap();
        let t0 = std::time::Instant::now();
        let first = frames::frame("live", &path, 0.0, (video.width, video.height), (540, 960), None).unwrap();
        println!("first frame {} bytes in {:?}", first.len(), t0.elapsed());
        // Sequential reads: one frame duration apart.
        let t1 = std::time::Instant::now();
        for i in 1..=90 {
            frames::frame("live", &path, i as f64 / 30.0, (video.width, video.height), (540, 960), None).unwrap();
        }
        println!("90 sequential frames in {:?}", t1.elapsed());
        let t2 = std::time::Instant::now();
        for t in [probe.duration * 0.7, probe.duration * 0.2, probe.duration * 0.5] {
            let bytes = frames::frame("live", &path, t, (video.width, video.height), (540, 960), None).unwrap();
            let pts = f64::from_le_bytes(bytes[8..16].try_into().unwrap());
            assert!((pts - t).abs() < 0.1, "asked {t}, got {pts}");
        }
        println!("3 seeks in {:?}", t2.elapsed());
        let same = frames::frame("live", &path, probe.duration * 0.5, (video.width, video.height), (540, 960), Some(f64::from_le_bytes(frames::frame("live", &path, probe.duration * 0.5, (video.width, video.height), (540, 960), None).unwrap()[8..16].try_into().unwrap()))).unwrap();
        assert_eq!(same.len(), frames::HEADER_BYTES);
        frames::release(&[], Some("live"));
        let t3 = std::time::Instant::now();
        let (jpeg, w) = frames::strip(&path, (video.width, video.height), probe.duration, 96, 20).unwrap();
        println!("strip of 20: {} bytes, {w} px wide each, in {:?}", jpeg.len(), t3.elapsed());
        let t4 = std::time::Instant::now();
        let cache = std::env::temp_dir().join("videoedit-live");
        let pcm = audio::pcm(&path, &cache, probe.audio.is_some()).unwrap();
        println!("pcm: {} bytes ({:.2} s) in {:?}", pcm.len(), pcm.len() as f64 / 192_000.0, t4.elapsed());
        let _ = std::fs::remove_dir_all(&cache);
    }

    #[test]
    #[ignore]
    fn exports_a_short_mp4_and_webm() {
        if sample().is_none() {
            return;
        }
        for format in ["mp4", "webm"] {
            let out = std::env::temp_dir().join(format!("videoedit-live.{format}"));
            let spec = export::Spec { path: out.to_string_lossy().into(), width: 1080, height: 1920, fps: 30, format: format.into(), quality: "standard".into(), audio: true };
            let started = std::time::Instant::now();
            let job = export::begin(spec).unwrap();
            let pcm: Vec<u8> = (0..48_000 * 3).flat_map(|i| {
                let v = ((i as f64 / 48_000.0 * 440.0 * std::f64::consts::TAU).sin() * 8000.0) as i16;
                [v.to_le_bytes(), v.to_le_bytes()].concat()
            }).collect();
            export::audio(job, &pcm).unwrap();
            let (w, h) = (1080usize, 1920usize);
            for n in 0..90 {
                let mut frame = vec![128u8; w * h * 3 / 2];
                for y in 0..h {
                    for x in 0..w {
                        frame[y * w + x] = (((x + n * 8) / 60 + y / 60) % 2 * 160 + 40) as u8;
                    }
                }
                export::frame(job, frame).unwrap();
            }
            let done = export::finish(job).unwrap();
            println!("{format}: {} frames, {} bytes in {:?}", done.frames, done.bytes, started.elapsed());
            let probe = media::probe(&done.path).unwrap();
            println!("{format} probe: {probe:?}");
            let _ = std::fs::remove_file(&done.path);
            assert!((probe.duration - 3.0).abs() < 0.2);
            assert!(probe.video.is_some() && probe.audio.is_some());
        }
    }
}
