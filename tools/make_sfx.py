#!/usr/bin/env python3
"""Synthesizes the Video Editor's built-in sound effects (whoosh, pop, ding…).

Every sound is made here from noise, sine waves and envelopes, so they are original and free to
ship. Writes Ogg Vorbis files and sounds.json into src-tauri/resources/sfx (or the folder given).

Usage: python3 tools/make_sfx.py [out_dir]
Needs numpy and GStreamer's gst-launch-1.0 with vorbisenc.
"""

import json
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

SR = 44100
rng = np.random.default_rng(20261027)


def t_of(seconds):
    return np.arange(int(SR * seconds)) / SR


def env(n, attack, release, shape=3.0):
    """An attack-then-decay envelope over n samples (seconds for each part)."""
    a = max(1, int(SR * attack))
    out = np.ones(n)
    out[:a] = np.linspace(0, 1, a) ** 2
    r = n - a
    out[a:] = np.exp(-shape * np.linspace(0, 1, r)) if release else 1
    return out


def one_pole(x, cutoff):
    """A low-pass whose cutoff (Hz) may change per sample."""
    cutoff = np.broadcast_to(cutoff, x.shape)
    k = 1 - np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += k[i] * (x[i] - acc)
        y[i] = acc
    return y


def band(x, low, high):
    """A crude band-pass: low-pass at `high` minus low-pass at `low`."""
    return one_pole(x, high) - one_pole(x, low)


def sweep(f0, f1, seconds, curve=1.0):
    t = t_of(seconds)
    f = f0 + (f1 - f0) * (t / seconds) ** curve
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def bell(freq, seconds, decay=4.0, partials=((1, 1), (2.76, 0.45), (5.4, 0.25), (8.93, 0.12))):
    t = t_of(seconds)
    out = np.zeros_like(t)
    for ratio, amp in partials:
        out += amp * np.sin(2 * np.pi * freq * ratio * t) * np.exp(-decay * ratio ** 0.6 * t)
    return out * env(len(t), 0.002, False)


def whoosh(seconds, lo, hi):
    n = int(SR * seconds)
    noise = rng.standard_normal(n)
    pos = np.linspace(0, 1, n)
    shape = np.sin(np.pi * pos) ** 1.5
    cutoff = lo + (hi - lo) * np.sin(np.pi * pos)
    return one_pole(noise, cutoff) * shape * 2.2


def click(seconds=0.03, tone=2400):
    n = int(SR * seconds)
    t = np.arange(n) / SR
    return (rng.standard_normal(n) * 0.6 + np.sin(2 * np.pi * tone * t)) * np.exp(-t * 180)


def place(total, *parts):
    """Mixes (start seconds, sound) pairs into one buffer."""
    out = np.zeros(int(SR * total))
    for start, s in parts:
        i = int(SR * start)
        out[i:i + len(s)] += s[: max(0, len(out) - i)]
    return out


def sounds():
    yield "whoosh", "Whoosh", whoosh(0.85, 300, 3800)
    yield "swoosh", "Swoosh", whoosh(0.4, 900, 7000)
    pop_t = t_of(0.14)
    yield "pop", "Pop", sweep(700, 160, 0.14, 0.5) * np.exp(-pop_t * 30) * 0.9
    yield "click", "Click", np.concatenate([click(), np.zeros(int(SR * 0.05))])
    yield "ding", "Ding", bell(1320, 1.4) * 0.6
    yield "chime", "Success chime", place(1.5, (0, bell(1318.5, 1.2) * 0.45), (0.14, bell(1975.5, 1.3) * 0.4))
    rise = t_of(2.0)
    riser = (band(rng.standard_normal(len(rise)), 400, 400 + 6000 * (rise / 2.0) ** 2) * 1.6 + sweep(180, 1400, 2.0, 2.0) * 0.25) * (rise / 2.0) ** 2
    yield "rise", "Riser", riser
    boom_t = t_of(1.6)
    boom = sweep(90, 38, 1.6, 0.4) * np.exp(-boom_t * 3.2) + one_pole(rng.standard_normal(len(boom_t)), 900) * np.exp(-boom_t * 25) * 1.5
    yield "impact", "Impact", boom * 0.9
    glitch = np.zeros(int(SR * 0.6))
    for i in range(14):
        start = int(rng.uniform(0, 0.55) * SR)
        length = int(rng.uniform(0.01, 0.05) * SR)
        f = rng.choice([220, 440, 880, 1760, 3520])
        seg = np.sign(np.sin(2 * np.pi * f * np.arange(length) / SR)) * rng.uniform(0.2, 0.5)
        glitch[start:start + length] += seg[: len(glitch) - start]
    yield "glitch", "Glitch", np.round(glitch * 8) / 8
    yield "shutter", "Camera shutter", place(0.3, (0, click(0.04, 1800) * 0.9), (0.09, click(0.05, 1200) * 0.7))
    taps = [(i * 0.16 + rng.uniform(0, 0.05), click(0.025, rng.uniform(1500, 3000)) * rng.uniform(0.4, 0.8)) for i in range(9)]
    yield "typing", "Typing", place(1.6, *taps)
    bubble = lambda f: sweep(f, f * 2.2, 0.09, 0.6) * np.exp(-t_of(0.09) * 25)
    yield "bubbles", "Bubbles", place(0.5, (0, bubble(380) * 0.6), (0.13, bubble(520) * 0.5), (0.27, bubble(450) * 0.55))


def write_ogg(path, samples):
    peak = np.max(np.abs(samples)) or 1.0
    samples = samples / peak * 0.89
    fade = int(SR * 0.004)
    samples[-fade:] *= np.linspace(1, 0, fade)
    pcm = (samples * 32767).astype("<i2").tobytes()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name
    try:
        with wave.open(wav_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm)
        subprocess.run(
            ["gst-launch-1.0", "-q", "filesrc", f"location={wav_path}", "!", "wavparse", "!", "audioconvert", "!",
             "vorbisenc", "quality=0.4", "!", "oggmux", "!", "filesink", f"location={path}"],
            check=True,
        )
    finally:
        os.unlink(wav_path)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "src-tauri", "resources", "sfx")
    os.makedirs(out, exist_ok=True)
    manifest = []
    for sid, title, samples in sounds():
        samples = np.asarray(samples, dtype=np.float64)
        file = f"{sid}.ogg"
        write_ogg(os.path.join(out, file), samples)
        manifest.append({"id": sid, "title": title, "file": file, "seconds": round(len(samples) / SR, 2)})
        print(f"{file}: {len(samples) / SR:.2f} s")
    with open(os.path.join(out, "sounds.json"), "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
