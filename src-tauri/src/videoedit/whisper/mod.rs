//! Speech to text for auto captions: OpenAI's Whisper run on the CPU in Rust (candle), reading
//! whisper.cpp's official model files (see `models`). Nothing is built from C++ and nothing leaves
//! the computer.

mod decode;
mod ggml;
pub mod mel;
mod model;

pub use decode::{Transcript, Word, LANGUAGES};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, OnceLock};

struct Loaded {
    path: String,
    model: model::Whisper,
    filters: Vec<f32>,
    vocab: Vec<Vec<u8>>,
}

fn loaded() -> &'static Mutex<Option<Loaded>> {
    static L: OnceLock<Mutex<Option<Loaded>>> = OnceLock::new();
    L.get_or_init(Default::default)
}

/// Transcribes 16 kHz mono audio with the model file at `model_path` (kept loaded for the next
/// call). `language` is a Whisper code ("en", "bn"…) or None to detect it.
pub fn transcribe(model_path: &Path, pcm: &[f32], language: Option<&str>, progress: &dyn Fn(f64), cancel: &AtomicBool) -> Result<Transcript, String> {
    let mut guard = loaded().lock().unwrap_or_else(|e| e.into_inner());
    let key = model_path.to_string_lossy().into_owned();
    if guard.as_ref().is_none_or(|l| l.path != key) {
        *guard = None;
        let mut file = ggml::read(model_path)?;
        if file.n_fft != mel::N_FFT / 2 + 1 {
            return Err(format!("This captions model has {} mel filter weights a band, not {}.", file.n_fft, mel::N_FFT / 2 + 1));
        }
        let model = model::Whisper::load(&mut file)?;
        *guard = Some(Loaded { path: key, model, filters: file.mel_filters, vocab: file.vocab });
    }
    let l = guard.as_mut().expect("just loaded");
    if pcm.len() < mel::SAMPLE_RATE / 4 {
        return Ok(Transcript { language: language.unwrap_or("en").into(), segments: Vec::new() });
    }
    decode::transcribe(&mut l.model, &l.filters, &l.vocab, pcm, language, progress, cancel)
}

/// Lets the loaded model go (hundreds of MB).
pub fn unload() {
    *loaded().lock().unwrap_or_else(|e| e.into_inner()) = None;
}
