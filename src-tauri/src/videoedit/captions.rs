//! Auto captions for the timeline: each clip's stretch of sound is transcribed (on a background
//! thread, with progress and Cancel), placed at the clip's time on the timeline and broken into
//! caption lines that fit the canvas, each with its words' times for the karaoke highlight.
//! Results are kept per stretch of file, model and language, so asking again is instant.

use super::audio;
use super::whisper::{self, mel, Word};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// A clip's sound on the timeline: `from`–`to` seconds of `path`, starting at `at`, played at
/// `speed`.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub path: String,
    pub from: f64,
    pub to: f64,
    pub at: f64,
    pub speed: f64,
    pub has_audio: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub spans: Vec<Span>,
    pub model: String,
    /// A Whisper language code, or None to detect it.
    pub language: Option<String>,
    /// The longest caption line, in characters.
    pub max_chars: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CueWord {
    /// Seconds from the cue's start.
    pub t: f64,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub words: Vec<CueWord>,
}

#[derive(Serialize, Clone)]
pub struct Captions {
    pub language: String,
    pub cues: Vec<Cue>,
}

#[derive(Serialize)]
pub struct Poll {
    pub progress: f64,
    pub stage: String,
    pub done: bool,
    pub result: Option<Captions>,
    pub error: Option<String>,
}

#[derive(Default)]
struct Job {
    progress: AtomicU64,
    stage: Mutex<String>,
    cancel: AtomicBool,
    result: Mutex<Option<Result<Captions, String>>>,
}

fn jobs() -> &'static Mutex<HashMap<u64, Arc<Job>>> {
    static J: OnceLock<Mutex<HashMap<u64, Arc<Job>>>> = OnceLock::new();
    J.get_or_init(Default::default)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Ends of sentences (Latin, Bangla's dari, CJK).
fn ends_sentence(w: &str) -> bool {
    w.ends_with(['.', '?', '!', '।', '॥', '。', '？', '！'])
}

/// Breaks timed words into caption lines: at most `max_chars` characters and 3.5 s each, a new
/// line after a sentence or a pause, and none shorter than 0.6 s when there's room.
pub fn segment(words: &[Word], max_chars: usize) -> Vec<Cue> {
    const MAX_SECONDS: f64 = 3.5;
    const PAUSE: f64 = 0.6;
    const MIN_SECONDS: f64 = 0.6;
    let max_chars = max_chars.max(8);
    let mut cues: Vec<Vec<&Word>> = Vec::new();
    let mut line: Vec<&Word> = Vec::new();
    let length = |l: &[&Word]| l.iter().map(|w| w.text.chars().count()).sum::<usize>() + l.len().saturating_sub(1);
    for w in words.iter().filter(|w| !w.text.trim().is_empty()) {
        if let Some(last) = line.last() {
            let would = length(&line) + 1 + w.text.chars().count();
            let gap = w.start - last.end;
            let long = w.end - line[0].start > MAX_SECONDS;
            let comma = last.text.ends_with([',', ';', ':', '،']) && length(&line) * 10 >= max_chars * 6;
            if would > max_chars || gap > PAUSE || long || ends_sentence(&last.text) || comma {
                cues.push(std::mem::take(&mut line));
            }
        }
        line.push(w);
    }
    if !line.is_empty() {
        cues.push(line);
    }
    let mut out: Vec<Cue> = cues
        .into_iter()
        .map(|ws| {
            let start = ws[0].start;
            Cue {
                start,
                end: ws[ws.len() - 1].end.max(start + 0.05),
                text: ws.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "),
                words: ws.iter().map(|w| CueWord { t: (w.start - start).max(0.0), text: w.text.clone() }).collect(),
            }
        })
        .collect();
    // Stretch very short lines into the silence after them.
    for i in 0..out.len() {
        let room = out.get(i + 1).map_or(f64::INFINITY, |n| n.start);
        if out[i].end - out[i].start < MIN_SECONDS {
            out[i].end = (out[i].start + MIN_SECONDS).min(room).max(out[i].end);
        }
    }
    out
}

/// Where a span's words land on the timeline.
fn place(words: &[Word], span: &Span) -> Vec<Word> {
    let speed = if span.speed > 0.0 { span.speed } else { 1.0 };
    let length = (span.to - span.from) / speed;
    words
        .iter()
        .filter_map(|w| {
            let s = span.at + w.start / speed;
            let e = span.at + w.end / speed;
            (w.start / speed < length).then(|| Word { start: s, end: e.min(span.at + length), text: w.text.clone() })
        })
        .collect()
}

/// Bumped whenever transcription changes (cached results from before are ignored).
const ENGINE: &str = "whisper-2";

#[derive(Serialize, Deserialize)]
struct Cached {
    language: String,
    words: Vec<(f64, f64, String)>,
}

fn cache_key(span: &Span, model: &str, language: Option<&str>) -> String {
    let meta = std::fs::metadata(&span.path).ok();
    let stamp = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    // The engine's version is in the key, so better decoding never serves an old result.
    let text = format!("{ENGINE}\u{0}{}\u{0}{}\u{0}{stamp}\u{0}{:.3}\u{0}{:.3}\u{0}{model}\u{0}{}", span.path, meta.map_or(0, |m| m.len()), span.from, span.to, language.unwrap_or("auto"));
    format!("{:016x}", xxhash_rust::xxh3::xxh3_64(text.as_bytes()))
}

/// The words of one span (source seconds from `from`), from the cache or Whisper.
fn words_of(span: &Span, req: &Request, model_path: &Path, dirs: &Dirs, progress: &dyn Fn(f64), stage: &dyn Fn(&str), cancel: &AtomicBool) -> Result<(String, Vec<Word>), String> {
    let key = cache_key(span, &req.model, req.language.as_deref());
    let cached_path = dirs.cache.join(format!("{key}.json"));
    if let Some(c) = std::fs::read(&cached_path).ok().and_then(|b| serde_json::from_slice::<Cached>(&b).ok()) {
        progress(1.0);
        return Ok((c.language, c.words.into_iter().map(|(start, end, text)| Word { start, end, text }).collect()));
    }
    stage("Reading the sound…");
    let pcm = audio::pcm(&span.path, &dirs.audio, span.has_audio)?;
    // Interleaved S16: 4 bytes a sample frame.
    let per_second = (audio::RATE * audio::CHANNELS * 2) as f64;
    let align = (audio::CHANNELS * 2) as usize;
    let byte_at = |s: f64| (((s.max(0.0) * per_second) as usize) / align * align).min(pcm.len() / align * align);
    let (from, to) = (byte_at(span.from), byte_at(span.to.max(span.from)));
    let mono = mel::from_editor_pcm(&pcm[from..to]);
    drop(pcm);
    stage("Listening…");
    let clock = std::time::Instant::now();
    let t = whisper::transcribe(model_path, &mono, req.language.as_deref(), progress, cancel)?;
    let heard = mono.len() as f64 / mel::SAMPLE_RATE as f64;
    eprintln!("[video-editor] captions: {heard:.1} s of {} sound in {:.1} s ({:.2}× real time) with {}", t.language, clock.elapsed().as_secs_f64(), heard / clock.elapsed().as_secs_f64().max(0.001), req.model);
    let words: Vec<Word> = t.segments.iter().flat_map(|s| s.words.iter().cloned()).collect();
    let _ = std::fs::create_dir_all(&dirs.cache);
    let cached = Cached { language: t.language.clone(), words: words.iter().map(|w| (w.start, w.end, w.text.clone())).collect() };
    if let Ok(text) = serde_json::to_vec(&cached) {
        let _ = std::fs::write(&cached_path, text);
    }
    Ok((t.language, words))
}

pub struct Dirs {
    pub models: PathBuf,
    pub audio: PathBuf,
    pub cache: PathBuf,
}

fn run(req: Request, dirs: Dirs, job: &Job) -> Result<Captions, String> {
    let spec = super::models::spec(&req.model)?;
    let model_path = super::models::installed(&dirs.models, spec).ok_or("Download the captions model first.")?;
    let set_stage = |s: &str| *lock(&job.stage) = s.to_string();
    set_stage("Loading the model…");
    let n = req.spans.len().max(1) as f64;
    let mut all = Vec::new();
    let mut language = String::new();
    for (i, span) in req.spans.iter().enumerate() {
        let progress = |p: f64| job.progress.store(((i as f64 + p.clamp(0.0, 1.0)) / n).to_bits(), Ordering::Relaxed);
        let (lang, words) = words_of(span, &req, &model_path, &dirs, &progress, &set_stage, &job.cancel)?;
        if language.is_empty() {
            language = lang;
        }
        all.extend(place(&words, span));
    }
    all.sort_by(|a, b| a.start.total_cmp(&b.start));
    Ok(Captions { language, cues: segment(&all, req.max_chars) })
}

pub fn start(req: Request, dirs: Dirs) -> Result<u64, String> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    if req.spans.is_empty() {
        return Err("There's no clip with sound to caption.".into());
    }
    if let Some(l) = req.language.as_deref() {
        if !whisper::LANGUAGES.contains(&l) {
            return Err(format!("Whisper doesn't know the language “{l}”."));
        }
    }
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let job = Arc::new(Job::default());
    lock(jobs()).insert(id, job.clone());
    std::thread::Builder::new()
        .name("captions".into())
        .spawn(move || {
            let result = run(req, dirs, &job);
            *lock(&job.result) = Some(result);
        })
        .map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn poll(id: u64) -> Result<Poll, String> {
    let job = lock(jobs()).get(&id).cloned().ok_or("That captions job is gone.")?;
    let result = lock(&job.result).clone();
    let poll = Poll {
        progress: f64::from_bits(job.progress.load(Ordering::Relaxed)),
        stage: lock(&job.stage).clone(),
        done: result.is_some(),
        error: result.as_ref().and_then(|r| r.as_ref().err().cloned()),
        result: result.and_then(|r| r.ok()),
    };
    if poll.done {
        lock(jobs()).remove(&id);
    }
    Ok(poll)
}

pub fn cancel(id: u64) {
    if let Some(job) = lock(jobs()).get(&id) {
        job.cancel.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(start: f64, end: f64, text: &str) -> Word {
        Word { start, end, text: text.into() }
    }

    #[test]
    fn lines_fit_and_break_at_sentences_and_pauses() {
        let words = vec![
            w(0.0, 0.3, "Hello"), w(0.3, 0.6, "and"), w(0.6, 1.0, "welcome."),
            w(1.1, 1.4, "Today"), w(1.4, 1.7, "we"), w(1.7, 2.1, "make"), w(2.1, 2.4, "a"), w(2.4, 2.9, "video"),
            w(4.0, 4.4, "together"),
        ];
        let cues = segment(&words, 18);
        let texts: Vec<&str> = cues.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(texts, vec!["Hello and welcome.", "Today we make a", "video", "together"]);
        assert!(cues.iter().all(|c| c.text.chars().count() <= 18), "within the width (a sentence end may finish a line)");
        // Words keep their times, relative to their line.
        assert_eq!(cues[1].words[2], CueWord { t: 1.7 - 1.1, text: "make".into() });
        // "video" (0.5 s) is stretched to 0.6 s into the pause before "together".
        assert!((cues[2].end - (2.4 + 0.6)).abs() < 1e-9);
    }

    #[test]
    fn long_runs_break_by_time_and_bangla_dari_ends_a_sentence() {
        let words: Vec<Word> = (0..12).map(|i| w(i as f64 * 0.4, i as f64 * 0.4 + 0.35, "ab")).collect();
        let cues = segment(&words, 80);
        assert!(cues.iter().all(|c| c.end - c.start <= 3.5 + 1e-9));
        assert!(cues.len() >= 2);
        let bn = segment(&[w(0.0, 0.5, "আমি"), w(0.5, 1.0, "ভালো।"), w(1.0, 1.5, "তুমি")], 40);
        assert_eq!(bn.len(), 2);
        assert_eq!(bn[0].text, "আমি ভালো।");
    }

    /// Transcribes a real file with a real model (ZAZABOR_WHISPER_MODEL, ZAZABOR_WHISPER_AUDIO,
    /// optional ZAZABOR_WHISPER_LANG); prints the captions and the speed. Skipped without them.
    #[test]
    #[ignore]
    fn live_transcription() {
        let (Ok(model), Ok(audio)) = (std::env::var("ZAZABOR_WHISPER_MODEL"), std::env::var("ZAZABOR_WHISPER_AUDIO")) else { return };
        let lang = std::env::var("ZAZABOR_WHISPER_LANG").ok();
        let cache = std::env::temp_dir().join("zazabor-live-audio");
        let pcm = super::super::audio::pcm(&audio, &cache, true).unwrap();
        let mono = mel::from_editor_pcm(&pcm);
        let seconds = mono.len() as f64 / mel::SAMPLE_RATE as f64;
        let started = std::time::Instant::now();
        let cancel = AtomicBool::new(false);
        let t = whisper::transcribe(std::path::Path::new(&model), &mono, lang.as_deref(), &|_| {}, &cancel).unwrap();
        let took = started.elapsed().as_secs_f64();
        let words: Vec<Word> = t.segments.iter().flat_map(|s| s.words.iter().cloned()).collect();
        for c in segment(&words, 32).iter().take(400) {
            println!("{:7.2}–{:7.2}  {}", c.start, c.end, c.text);
        }
        println!("language {}, {} segments, {} words; {seconds:.1} s of audio in {took:.1} s ({:.2}× real time)", t.language, t.segments.len(), words.len(), seconds / took);
        assert!(!words.is_empty());
    }

    #[test]
    fn spans_land_at_the_clip_and_follow_its_speed() {
        let span = Span { path: String::new(), from: 10.0, to: 20.0, at: 5.0, speed: 2.0, has_audio: true };
        let placed = place(&[w(2.0, 3.0, "a"), w(9.0, 9.5, "b"), w(30.0, 31.0, "gone")], &span);
        assert_eq!(placed, vec![w(6.0, 6.5, "a"), w(9.5, 9.75, "b")]);
    }
}
