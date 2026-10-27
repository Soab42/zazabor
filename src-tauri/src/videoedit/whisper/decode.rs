//! Turning audio into timed text: the special tokens of whisper.cpp's multilingual models, greedy
//! decoding with OpenAI's timestamp rules, 30-second windows that move on to where the speech
//! stopped, language detection, a silence check, and word times spread over each segment.

use super::mel::{self, WINDOW_FRAMES};
use super::model::{argmax, Whisper};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

/// Whisper's languages, in token order.
pub const LANGUAGES: [&str; 99] = [
    "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it", "id", "hi", "fi", "vi", "he", "uk",
    "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn",
    "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si", "km", "sn",
    "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my",
    "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su",
];

/// Seconds per timestamp step.
const TIME_STEP: f64 = 0.02;
/// The first timestamp may not be later than this (seconds).
const MAX_INITIAL_TIMESTAMP: f64 = 1.0;

/// The special tokens of a multilingual model (n_vocab 51865).
#[derive(Debug, Clone, Copy)]
pub struct Specials {
    pub eot: u32,
    pub sot: u32,
    pub transcribe: u32,
    pub no_speech: u32,
    pub no_timestamps: u32,
    /// `<|0.00|>`; later timestamps follow.
    pub begin: u32,
}

impl Specials {
    pub fn for_vocab(n_vocab: usize) -> Result<Specials, String> {
        if n_vocab < 51865 {
            return Err("This captions model only knows English; Zazabor uses the multilingual ones.".into());
        }
        let dt = (n_vocab - 51765 - 1) as u32 - 98;
        Ok(Specials { eot: 50257, sot: 50258, transcribe: 50358 + dt, no_speech: 50361 + dt, no_timestamps: 50362 + dt, begin: 50363 + dt })
    }

    pub fn language(&self, code: &str) -> Option<u32> {
        LANGUAGES.iter().position(|l| *l == code).map(|i| self.sot + 1 + i as u32)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Word {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub words: Vec<Word>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Transcript {
    pub language: String,
    pub segments: Vec<Segment>,
}

pub struct Tokenizer<'a> {
    pub vocab: &'a [Vec<u8>],
    pub specials: Specials,
}

impl Tokenizer<'_> {
    /// The text of `tokens` (special and timestamp tokens skipped).
    pub fn text(&self, tokens: &[u32]) -> String {
        let mut bytes = Vec::new();
        for &t in tokens {
            if t < self.specials.eot {
                if let Some(w) = self.vocab.get(t as usize) {
                    bytes.extend_from_slice(w);
                }
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

fn log_softmax(logits: &[f32]) -> Vec<f32> {
    let max = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let sum: f32 = logits.iter().map(|v| (v - max).exp()).sum();
    let lse = max + sum.ln();
    logits.iter().map(|v| v - lse).collect()
}

/// OpenAI's rules on what may come next, given the tokens sampled so far in this window.
pub fn apply_timestamp_rules(logits: &mut [f32], sampled: &[u32], sp: &Specials) {
    let begin = sp.begin as usize;
    let neg = f32::NEG_INFINITY;
    logits[sp.no_timestamps as usize] = neg;
    // Special tokens other than the end and timestamps never come in the text.
    for v in logits.iter_mut().take(begin).skip(sp.sot as usize) {
        *v = neg;
    }
    let is_ts = |t: u32| t >= sp.begin;
    let last_ts = sampled.last().is_some_and(|t| is_ts(*t));
    let penultimate_ts = sampled.len() < 2 || is_ts(sampled[sampled.len() - 2]);
    if last_ts {
        if penultimate_ts {
            // A segment just closed: text (or the end) comes next.
            for v in logits.iter_mut().skip(begin) {
                *v = neg;
            }
        } else {
            // A segment's start: a timestamp or the end only.
            for v in logits.iter_mut().take(sp.eot as usize) {
                *v = neg;
            }
        }
    }
    // Timestamps never go backwards.
    if let Some(&latest) = sampled.iter().rev().find(|t| is_ts(**t)) {
        let upto = if last_ts && !penultimate_ts { latest } else { latest + 1 };
        for v in logits.iter_mut().take(upto as usize).skip(begin) {
            *v = neg;
        }
    }
    if sampled.is_empty() {
        // The window starts with a timestamp, and not too late.
        for v in logits.iter_mut().take(begin) {
            *v = neg;
        }
        let last_allowed = begin + (MAX_INITIAL_TIMESTAMP / TIME_STEP) as usize;
        for v in logits.iter_mut().skip(last_allowed + 1) {
            *v = neg;
        }
    }
    // When a timestamp is likelier than any single text token, take a timestamp.
    let lp = log_softmax(logits);
    let ts_max = lp[begin..].iter().copied().fold(f32::NEG_INFINITY, f32::max);
    if ts_max.is_finite() {
        let ts_sum = ts_max + lp[begin..].iter().map(|v| (v - ts_max).exp()).sum::<f32>().ln();
        let text_max = lp[..begin].iter().copied().fold(f32::NEG_INFINITY, f32::max);
        if ts_sum > text_max {
            for v in logits.iter_mut().take(begin) {
                *v = neg;
            }
        }
    }
}

/// The segments in one window's tokens (timestamps relative to the window), and how far the next
/// window starts (seconds from this one's start).
pub fn segments_of(tokens: &[u32], sp: &Specials, tok: &Tokenizer, window_seconds: f64) -> (Vec<(f64, f64, String)>, f64) {
    let is_ts = |t: u32| t >= sp.begin;
    let time = |t: u32| (t - sp.begin) as f64 * TIME_STEP;
    let mut out = Vec::new();
    let single_ending = tokens.len() >= 2 && !is_ts(tokens[tokens.len() - 2]) && is_ts(tokens[tokens.len() - 1]);
    let mut consecutive: Vec<usize> = (1..tokens.len()).filter(|&i| is_ts(tokens[i - 1]) && is_ts(tokens[i])).collect();
    if !consecutive.is_empty() {
        if single_ending {
            consecutive.push(tokens.len());
        }
        let mut last = 0;
        for &cut in &consecutive {
            let slice = &tokens[last..cut];
            if slice.len() >= 2 && is_ts(slice[0]) && is_ts(slice[slice.len() - 1]) {
                let text = tok.text(slice);
                if !text.trim().is_empty() {
                    out.push((time(slice[0]), time(slice[slice.len() - 1]), text));
                }
            }
            last = cut;
        }
        let advance = if single_ending { window_seconds } else { tokens[..last].iter().rev().find(|t| is_ts(**t)).map_or(window_seconds, |t| time(*t)) };
        (out, if advance > 0.0 { advance } else { window_seconds })
    } else {
        let stamps: Vec<u32> = tokens.iter().copied().filter(|t| is_ts(*t)).collect();
        let end = match stamps.last() {
            Some(t) if *t != sp.begin => time(*t),
            _ => window_seconds,
        };
        let start = stamps.first().map_or(0.0, |t| time(*t)).min(end);
        let text = tok.text(tokens);
        if !text.trim().is_empty() {
            out.push((start, end, text));
        }
        (out, window_seconds)
    }
}

/// Words of a segment with times spread by their length (letters weigh more than spaces), the
/// first word at the start and the last ending at the end.
pub fn spread_words(start: f64, end: f64, text: &str) -> Vec<Word> {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }
    let weight = |w: &str| w.chars().count() as f64 + 1.5;
    let total: f64 = words.iter().map(|w| weight(w)).sum();
    let span = (end - start).max(0.0);
    let mut t = start;
    words
        .iter()
        .map(|w| {
            let d = span * weight(w) / total;
            let word = Word { start: t, end: t + d, text: (*w).to_string() };
            t += d;
            word
        })
        .collect()
}

/// One decoding of a 30-second window.
struct Window {
    tokens: Vec<u32>,
    sum_logprob: f64,
    /// The chance there's no speech at all (from the first position).
    no_speech: f32,
    /// It fell into a loop (the repeats were cut off).
    looped: bool,
}

/// Decodes one window: greedily at temperature 0, else sampling from the softened
/// distribution (seeded, so a run is repeatable).
fn decode_window(model: &mut Whisper, audio: &candle_core::Tensor, sp: &Specials, lang_token: u32, temperature: f32, seed: u64, cancel: &AtomicBool) -> Result<Window, String> {
    let err = |e: candle_core::Error| format!("Captions failed: {e}");
    model.reset();
    let prompt = [sp.sot, lang_token, sp.transcribe];
    let mut logits_now = model.decode(&prompt, audio, &[0, prompt.len() - 1]).map_err(err)?;
    let first = logits_now.remove(0);
    let no_speech = log_softmax(&first)[sp.no_speech as usize].exp();
    let mut logits = logits_now.remove(0);
    let mut tokens: Vec<u32> = Vec::new();
    let mut sum_logprob = 0f64;
    let mut looped = false;
    let mut rng = seed.max(1);
    let max_tokens = (model.text_ctx() / 2).min(224);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        apply_timestamp_rules(&mut logits, &tokens, sp);
        let lp = log_softmax(&logits);
        let next = if temperature > 0.0 {
            // xorshift64*, then a draw from softmax(logits / temperature).
            rng ^= rng >> 12;
            rng ^= rng << 25;
            rng ^= rng >> 27;
            let u = (rng.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11) as f64 / (1u64 << 53) as f64;
            sample(&lp, temperature, u) as u32
        } else {
            argmax(&logits) as u32
        };
        sum_logprob += lp[next as usize] as f64;
        if next == sp.eot || tokens.len() >= max_tokens || model.room() <= 1 {
            break;
        }
        tokens.push(next);
        // A loop of the same few tokens is a hallucination: keep one copy and stop.
        if let Some(extra) = repeats(&tokens) {
            tokens.truncate(tokens.len() - extra);
            looped = true;
            break;
        }
        logits = model.decode(&[next], audio, &[0]).map_err(err)?.remove(0);
    }
    Ok(Window { tokens, sum_logprob, no_speech, looped })
}

/// The token a uniform draw `u` (0…1) picks from log-probabilities softened by `temperature`.
fn sample(lp: &[f32], temperature: f32, u: f64) -> usize {
    let max = lp.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let weights: Vec<f64> = lp.iter().map(|v| if v.is_finite() { (((v - max) / temperature) as f64).exp() } else { 0.0 }).collect();
    let total: f64 = weights.iter().sum();
    let mut target = u * total;
    for (i, w) in weights.iter().enumerate() {
        target -= w;
        if target <= 0.0 && *w > 0.0 {
            return i;
        }
    }
    argmax(lp)
}

/// Greedy decoding of whole audio (16 kHz mono). `language` None detects it from the first
/// window with speech. `progress` gets 0…1.
pub fn transcribe(model: &mut Whisper, filters: &[f32], vocab: &[Vec<u8>], pcm: &[f32], language: Option<&str>, progress: &dyn Fn(f64), cancel: &AtomicBool) -> Result<Transcript, String> {
    let sp = Specials::for_vocab(model.hp.n_vocab)?;
    let tok = Tokenizer { vocab, specials: sp };
    let n_mels = model.hp.n_mels;
    // 30 s of silence after the audio, as Whisper pads it, so the last window is whole.
    let mut padded = pcm.to_vec();
    padded.extend(std::iter::repeat_n(0.0, mel::SAMPLE_RATE * 30));
    let (spec, frames) = mel::log_mel(&padded, filters, n_mels);
    let content_frames = pcm.len() / mel::HOP;
    let err = |e: candle_core::Error| format!("Captions failed: {e}");
    let mut language = language.map(str::to_owned);
    let mut segments: Vec<Segment> = Vec::new();
    let mut seek = 0usize;
    let window_seconds = WINDOW_FRAMES as f64 * mel::HOP as f64 / mel::SAMPLE_RATE as f64;
    let profile = std::env::var_os("ZAZABOR_WHISPER_PROFILE").is_some();
    let (mut t_encode, mut t_decode, mut steps) = (0f64, 0f64, 0usize);
    while seek < content_frames {
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled".into());
        }
        progress(seek as f64 / content_frames.max(1) as f64);
        let window = mel::window(&spec, frames, n_mels, seek);
        let offset = seek as f64 * mel::HOP as f64 / mel::SAMPLE_RATE as f64;
        let clock = std::time::Instant::now();
        let audio = model.encode(&window, WINDOW_FRAMES).map_err(err)?;
        t_encode += clock.elapsed().as_secs_f64();
        let clock = std::time::Instant::now();
        // The language, from the first window, once.
        if language.is_none() {
            model.reset();
            let logits = model.decode(&[sp.sot], &audio, &[0]).map_err(err)?.remove(0);
            let best = LANGUAGES.iter().enumerate().max_by(|a, b| {
                let la = logits[(sp.sot + 1 + a.0 as u32) as usize];
                let lb = logits[(sp.sot + 1 + b.0 as u32) as usize];
                la.total_cmp(&lb)
            });
            language = Some(best.map_or("en", |(_, l)| l).to_string());
        }
        let lang = language.as_deref().unwrap_or("en");
        let lang_token = sp.language(lang).ok_or_else(|| format!("Whisper doesn't know the language “{lang}”."))?;
        // Greedy first; a window that falls into a loop is decoded again with a little
        // randomness (OpenAI's temperature fallback), and only if every try loops is the
        // trimmed loop kept.
        let mut attempt = None;
        for (i, temperature) in [0.0f32, 0.4, 0.8].into_iter().enumerate() {
            let seed = 0x9e37_79b9_7f4a_7c15u64 ^ (seek as u64).wrapping_mul(0x2545_f491_4f6c_dd1d) ^ i as u64;
            let w = decode_window(model, &audio, &sp, lang_token, temperature, seed, cancel)?;
            steps += w.tokens.len() + 1;
            let done = !w.looped;
            attempt = Some(w);
            if done {
                break;
            }
        }
        let Window { tokens: sampled, sum_logprob, no_speech, .. } = attempt.expect("one try at least");
        t_decode += clock.elapsed().as_secs_f64();
        let avg_logprob = sum_logprob / (sampled.len() + 1) as f64;
        let remaining = (content_frames - seek) as f64 * mel::HOP as f64 / mel::SAMPLE_RATE as f64;
        let this_window = window_seconds.min(remaining.max(0.0));
        if no_speech > 0.6 && avg_logprob < -1.0 {
            seek += WINDOW_FRAMES;
            continue;
        }
        let (found, advance) = segments_of(&sampled, &sp, &tok, window_seconds);
        for (s, e, text) in found {
            let (s, e) = (offset + s.min(this_window), offset + e.min(this_window));
            if e <= s {
                continue;
            }
            let text = text.trim().to_string();
            if segments.last().is_some_and(|l| l.text == text && (s - l.end).abs() < 1.0) {
                continue;
            }
            segments.push(Segment { start: s, end: e, words: spread_words(s, e, &text), text });
        }
        let step = ((advance.max(TIME_STEP)) * mel::SAMPLE_RATE as f64 / mel::HOP as f64).round() as usize;
        seek += step.clamp(1, WINDOW_FRAMES);
    }
    progress(1.0);
    if profile {
        eprintln!("whisper: encoder {t_encode:.2} s, decoder {t_decode:.2} s for {steps} tokens ({:.1} ms each)", t_decode * 1000.0 / steps.max(1) as f64);
    }
    Ok(Transcript { language: language.unwrap_or_else(|| "en".into()), segments })
}

/// When the last tokens repeat a pattern (one token 12 times, a few tokens 6 times, a phrase 4
/// times), how many tokens the extra copies take.
fn repeats(tokens: &[u32]) -> Option<usize> {
    for period in 1..=24 {
        let times = match period {
            1 => 12,
            2..=3 => 6,
            _ => 4,
        };
        let need = period * times;
        if tokens.len() < need {
            continue;
        }
        let tail = &tokens[tokens.len() - need..];
        if tail.chunks(period).all(|c| c == &tail[..period]) {
            return Some(need - period);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sp() -> Specials {
        Specials::for_vocab(51865).unwrap()
    }

    #[test]
    fn special_tokens_of_the_multilingual_models() {
        let s = sp();
        assert_eq!((s.eot, s.sot, s.transcribe, s.no_timestamps, s.begin), (50257, 50258, 50359, 50363, 50364));
        assert_eq!(s.language("en"), Some(50259));
        assert_eq!(s.language("bn"), Some(50259 + 43));
        assert!(Specials::for_vocab(51864).is_err());
    }

    #[test]
    fn rules_open_with_an_early_timestamp_and_close_segments() {
        let s = sp();
        let n = s.begin as usize + 1501;
        let mut logits = vec![0f32; n];
        apply_timestamp_rules(&mut logits, &[], &s);
        assert!(logits[100].is_infinite(), "text can't come first");
        assert!(logits[s.begin as usize].is_finite());
        assert!(logits[s.begin as usize + 51].is_infinite(), "no later than 1 s");
        // After "<|0.00|> hello <|1.00|>": a timestamp ≥ 1.00 or the end, not text. (The end is
        // made likely, or the "a timestamp is likelier" rule takes it away too, as OpenAI's does.)
        let mut logits = vec![0f32; n];
        logits[s.eot as usize] = 10.0;
        logits[100] = 10.0;
        apply_timestamp_rules(&mut logits, &[s.begin, 100, s.begin + 50], &s);
        assert!(logits[100].is_infinite());
        assert!(logits[s.begin as usize + 49].is_infinite());
        assert!(logits[s.begin as usize + 50].is_finite());
        assert!(logits[s.eot as usize].is_finite());
    }

    #[test]
    fn windows_split_into_segments_and_move_on() {
        let s = sp();
        let vocab: Vec<Vec<u8>> = (0..200).map(|i| format!(" w{i}").into_bytes()).collect();
        let tok = Tokenizer { vocab: &vocab, specials: s };
        let t = |sec: f64| s.begin + (sec / TIME_STEP).round() as u32;
        // Two closed segments ending on a single timestamp: no speech after it, a full window on.
        let tokens = [t(0.0), 1, 2, t(1.5), t(2.0), 3, t(4.0)];
        let (segs, advance) = segments_of(&tokens, &s, &tok, 30.0);
        assert_eq!(segs, vec![(0.0, 1.5, " w1 w2".to_string()), (2.0, 4.0, " w3".to_string())]);
        assert!((advance - 30.0).abs() < 1e-9);
        // An unfinished segment at the end is dropped and the next window starts at its start.
        let (segs, advance) = segments_of(&[t(0.0), 1, t(1.5), t(2.0), 3, 4], &s, &tok, 30.0);
        assert_eq!(segs, vec![(0.0, 1.5, " w1".to_string())]);
        assert!((advance - 1.5).abs() < 1e-9);
        // No closing pair: one segment to the last timestamp, a full window on.
        let (segs, advance) = segments_of(&[t(0.5), 5, 6, t(3.0)], &s, &tok, 30.0);
        assert_eq!(segs, vec![(0.5, 3.0, " w5 w6".to_string())]);
        assert!((advance - 30.0).abs() < 1e-9);
    }

    #[test]
    fn words_share_the_segment_by_length() {
        let w = spread_words(10.0, 13.0, " Hello there, friend");
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].start, 10.0);
        assert!((w[2].end - 13.0).abs() < 1e-9);
        assert!(w[1].end - w[1].start > w[0].end - w[0].start, "longer words take longer");
        assert_eq!(w[1].text, "there,");
    }

    #[test]
    fn sampling_follows_the_odds_and_never_picks_a_ruled_out_token() {
        let lp = log_softmax(&[0.0, 3.0, f32::NEG_INFINITY, 0.0]);
        let picks: Vec<usize> = (0..200).map(|i| sample(&lp, 0.4, (i as f64 + 0.5) / 200.0)).collect();
        assert!(picks.iter().all(|&p| p != 2));
        assert!(picks.iter().filter(|&&p| p == 1).count() > 180, "the likeliest token wins almost always at 0.4");
        let warm: Vec<usize> = (0..200).map(|i| sample(&lp, 3.0, (i as f64 + 0.5) / 200.0)).collect();
        assert!(warm.contains(&0) && warm.contains(&3), "a high temperature spreads the picks");
    }

    #[test]
    fn loops_are_caught() {
        // A three-token loop six times: five copies go.
        assert_eq!(repeats(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 7, 8, 9, 7, 8, 9, 7, 8, 9, 7, 8, 9, 7, 8, 9]), Some(15));
        // "I am busy with my comes," (seven tokens) four times.
        let phrase = [40, 50, 60, 70, 80, 90, 11];
        let looped: Vec<u32> = [1, 2, 3].into_iter().chain(phrase.iter().copied().cycle().take(28)).collect();
        assert_eq!(repeats(&looped), Some(21));
        assert_eq!(repeats(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), None);
    }
}
