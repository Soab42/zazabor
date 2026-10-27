//! Whisper's log-mel spectrogram, as OpenAI computes it: 16 kHz mono, a 400-point Hann window
//! every 160 samples (reflect-padded at the ends), power spectrum, the model's mel filters,
//! log10, clamped to 8 below the loudest value and scaled to about −1…1.

use rayon::prelude::*;

pub const SAMPLE_RATE: usize = 16_000;
pub const N_FFT: usize = 400;
pub const HOP: usize = 160;
/// Frames in one 30-second window.
pub const WINDOW_FRAMES: usize = 3000;

/// `n_mels` rows of `frames` values, row-major, and the frame count. The DFT and the mel
/// filters are matrix products on candle (fast even in a debug build of Zazabor).
pub fn log_mel(pcm: &[f32], filters: &[f32], n_mels: usize) -> (Vec<f32>, usize) {
    use candle_core::{Device, Tensor};
    let bins = N_FFT / 2 + 1;
    assert_eq!(filters.len(), n_mels * bins, "mel filters don't match");
    let pad = N_FFT / 2;
    let n = pcm.len();
    // torch.stft(center=True): reflect padding on both sides.
    let reflect = |i: isize| -> f32 {
        if n < 2 {
            return pcm.first().copied().unwrap_or(0.0);
        }
        let last = n as isize - 1;
        let mut j = i;
        while j < 0 || j > last {
            if j < 0 {
                j = -j;
            }
            if j > last {
                j = 2 * last - j;
            }
        }
        pcm[j as usize]
    };
    // One frame per hop, the last one dropped (as Whisper does).
    let frames = n / HOP;
    if frames == 0 {
        return (Vec::new(), 0);
    }
    let window: Vec<f32> = (0..N_FFT).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / N_FFT as f32).cos()).collect();
    let mut framed = vec![0f32; frames * N_FFT];
    framed.par_chunks_mut(N_FFT).enumerate().for_each(|(f, row)| {
        let start = (f * HOP) as isize - pad as isize;
        for (i, v) in row.iter_mut().enumerate() {
            *v = reflect(start + i as isize) * window[i];
        }
    });
    let mut cos = vec![0f32; N_FFT * bins];
    let mut sin = vec![0f32; N_FFT * bins];
    for i in 0..N_FFT {
        for b in 0..bins {
            let a = -2.0 * std::f64::consts::PI * (b * i % N_FFT) as f64 / N_FFT as f64;
            cos[i * bins + b] = a.cos() as f32;
            sin[i * bins + b] = a.sin() as f32;
        }
    }
    let spectrum = || -> candle_core::Result<Vec<f32>> {
        let dev = Device::Cpu;
        let x = Tensor::from_vec(framed, (frames, N_FFT), &dev)?;
        let re = x.matmul(&Tensor::from_vec(cos, (N_FFT, bins), &dev)?)?;
        let im = x.matmul(&Tensor::from_vec(sin, (N_FFT, bins), &dev)?)?;
        let power = (re.sqr()? + im.sqr()?)?;
        // filters: n_mels × bins → bins × n_mels; result frames × n_mels.
        let f = Tensor::from_slice(filters, (n_mels, bins), &dev)?.t()?.contiguous()?;
        let mel = power.matmul(&f)?.clamp(1e-10f32, f32::MAX)?.log()?.affine(1.0 / std::f64::consts::LN_10, 0.0)?;
        mel.t()?.contiguous()?.flatten_all()?.to_vec1::<f32>()
    };
    let mut spec = spectrum().expect("mel spectrogram on the CPU");
    let top = spec.iter().copied().fold(f32::MIN, f32::max);
    for v in spec.iter_mut() {
        *v = (v.max(top - 8.0) + 4.0) / 4.0;
    }
    (spec, frames)
}

/// The 30-second window starting at `start` frames, padded with the padding value (silence)
/// past the end.
pub fn window(spec: &[f32], frames: usize, n_mels: usize, start: usize) -> Vec<f32> {
    let mut out = vec![0f32; n_mels * WINDOW_FRAMES];
    let floor = spec.iter().copied().fold(f32::MAX, f32::min).min(f32::MAX);
    for m in 0..n_mels {
        for f in 0..WINDOW_FRAMES {
            let src = start + f;
            out[m * WINDOW_FRAMES + f] = if src < frames { spec[m * frames + src] } else if floor.is_finite() { floor } else { -1.5 };
        }
    }
    out
}

/// 48 kHz interleaved stereo S16 (the editor's sound) as 16 kHz mono f32: mixed down, low-passed
/// below 8 kHz and every third sample kept.
pub fn from_editor_pcm(bytes: &[u8]) -> Vec<f32> {
    let mono: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|c| (i16::from_le_bytes([c[0], c[1]]) as f32 + i16::from_le_bytes([c[2], c[3]]) as f32) / 65536.0)
        .collect();
    downsample3(&mono)
}

/// Decimates by 3 after a windowed-sinc low-pass at 7.2 kHz (of 48 kHz).
pub fn downsample3(x: &[f32]) -> Vec<f32> {
    const TAPS: usize = 48;
    let cutoff = 7200.0 / 48000.0;
    let kernel: Vec<f32> = (0..TAPS)
        .map(|i| {
            let m = i as f64 - (TAPS - 1) as f64 / 2.0;
            let sinc = if m == 0.0 { 2.0 * cutoff } else { (2.0 * std::f64::consts::PI * cutoff * m).sin() / (std::f64::consts::PI * m) };
            let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (TAPS - 1) as f64).cos() + 0.08 * (4.0 * std::f64::consts::PI * i as f64 / (TAPS - 1) as f64).cos();
            (sinc * w) as f32
        })
        .collect();
    let sum: f32 = kernel.iter().sum();
    let half = TAPS / 2;
    (0..x.len() / 3)
        .into_par_iter()
        .map(|o| {
            let c = o * 3;
            let mut acc = 0f32;
            for (k, w) in kernel.iter().enumerate() {
                let i = c as isize + k as isize - half as isize;
                if i >= 0 && (i as usize) < x.len() {
                    acc += x[i as usize] * w;
                }
            }
            acc / sum
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tone_lights_its_mel_band() {
        // Two "mel" filters: one on the bins around 1 kHz, one around 5 kHz.
        let bins = N_FFT / 2 + 1;
        let mut filters = vec![0f32; 2 * bins];
        let bin = |hz: f32| (hz / (SAMPLE_RATE as f32 / N_FFT as f32)).round() as usize;
        filters[bin(1000.0)] = 1.0;
        filters[bins + bin(5000.0)] = 1.0;
        let pcm: Vec<f32> = (0..SAMPLE_RATE).map(|i| (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / SAMPLE_RATE as f32).sin() * 0.5).collect();
        let (spec, frames) = log_mel(&pcm, &filters, 2);
        assert_eq!(frames, SAMPLE_RATE / HOP);
        let mid = frames / 2;
        assert!(spec[mid] > spec[frames + mid] + 1.0, "1 kHz band {} vs 5 kHz band {}", spec[mid], spec[frames + mid]);
    }

    #[test]
    fn downsampling_keeps_low_tones_and_drops_high_ones() {
        let tone = |hz: f32| -> Vec<f32> { (0..48_000).map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / 48_000.0).sin()).collect() };
        let rms = |x: &[f32]| (x[1000..x.len() - 1000].iter().map(|v| v * v).sum::<f32>() / (x.len() - 2000) as f32).sqrt();
        let low = downsample3(&tone(440.0));
        let high = downsample3(&tone(12_000.0));
        assert_eq!(low.len(), 16_000);
        assert!(rms(&low) > 0.6, "440 Hz kept: {}", rms(&low));
        assert!(rms(&high) < 0.05, "12 kHz removed: {}", rms(&high));
    }
}
