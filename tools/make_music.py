#!/usr/bin/env python3
"""Composes and renders Zazabor's soundtracks (the content library's music, content/music).

Every sound here is synthesized from scratch (additive strings and brass, a modelled
piano, FM bells, synthesized drums, convolution reverb), so the tracks are original and
free to ship. Each track is an exact number of bars with its reverb tail wrapped around,
so it loops seamlessly, and its tempo is recorded so slideshows can cut on the beat.

Usage: python3 tools/make_music.py [out_dir] [track ids…]   (then tools/content/publish.sh)
Needs numpy and GStreamer's gst-launch-1.0 with vorbisenc (to write Ogg Vorbis).
"""

import json
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

SR = 44100
rng = np.random.default_rng(20261018)

PITCH = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6,
         "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
QUALITY = {"maj": [0, 4, 7], "min": [0, 3, 7], "maj7": [0, 4, 7, 11], "m7": [0, 3, 7, 10],
           "m9": [0, 3, 7, 10, 14], "maj9": [0, 4, 7, 11, 14], "7": [0, 4, 7, 10], "6": [0, 4, 7, 9],
           "sus2": [0, 2, 7], "sus4": [0, 5, 7], "add9": [0, 4, 7, 14]}


def n(name):
    """'C4' -> 60."""
    return 12 * (int(name[-1]) + 1) + PITCH[name[:-1]]


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def chord(symbol):
    """'Dm' / 'Bbmaj7' / 'D/F#' -> (root pitch class, intervals, bass pitch class)."""
    bass = None
    if "/" in symbol:
        symbol, bass = symbol.split("/")
    root = symbol[:2] if len(symbol) > 1 and symbol[1] in "#b" else symbol[:1]
    quality = symbol[len(root):] or "maj"
    quality = {"m": "min"}.get(quality, quality)
    return PITCH[root], QUALITY[quality], PITCH[bass] if bass else PITCH[root]


def voicing(symbol, low, count=None):
    """Chord tones stacked upward from the first pitch at or above `low`."""
    root, intervals, _ = chord(symbol)
    base = low + ((root - low) % 12)
    notes = sorted(base + i for i in intervals)
    if count:
        while len(notes) < count:
            notes.append(notes[len(notes) - len(intervals)] + 12)
        notes = notes[:count]
    return notes


def bass_note(symbol, low):
    _, _, bass = chord(symbol)
    return low + ((bass - low) % 12)


# ---- signal helpers -----------------------------------------------------------------------

def times(count):
    return np.arange(count) / SR


def envelope(gate, attack=0.005, decay=0.2, sustain=0.7, release=0.3):
    """ADSR for a key held `gate` seconds; returns the envelope including the release."""
    total = int((gate + release * 1.2) * SR) + 1
    t = times(total)
    rise = np.clip(t / max(attack, 1e-4), 0, 1)
    fall = sustain + (1 - sustain) * np.exp(-np.maximum(t - attack, 0) / max(decay, 1e-4))
    env = np.where(t < attack, rise, fall)
    env *= np.where(t > gate, np.exp(-(t - gate) * 5 / max(release, 1e-4)), 1.0)
    return env


def spectral_filter(x, low=None, high=None, order=2):
    """Zero-phase Butterworth-shaped band limits, applied in the frequency domain."""
    count = len(x)
    spectrum = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(count, 1 / SR)
    gain = np.ones_like(freqs)
    if high:
        gain /= np.sqrt(1 + (freqs / high) ** (2 * order))
    if low:
        gain /= np.sqrt(1 + (low / np.maximum(freqs, 1e-3)) ** (2 * order))
    return np.fft.irfft(spectrum * gain, count)


def additive(freq, count, cutoff, harmonics="saw", detune=(0.0,), vibrato=0.0, vib_rate=5.2):
    """Band-limited saw/square built from sines, each harmonic weighted by a low-pass curve.

    `cutoff` may be a number or a per-sample array (a filter envelope)."""
    t = times(count)
    out = np.zeros(count)
    cutoff = np.asarray(cutoff, dtype=float)
    top = float(np.max(cutoff))
    for cents in detune:
        f = freq * 2 ** (cents / 1200)
        # Integrated vibrato phase, scaled per harmonic below.
        wobble = -(f * vibrato / vib_rate) * np.cos(2 * np.pi * vib_rate * t + rng.uniform(0, 6.28)) if vibrato else 0.0
        kmax = int(min(SR / 2 / f - 1, top * 3 / f, 64))
        for k in range(1, max(1, kmax) + 1):
            if harmonics == "square" and k % 2 == 0:
                continue
            weight = (1 / k) / np.sqrt(1 + (k * f / cutoff) ** 4)
            out += weight * np.sin(2 * np.pi * k * (f * t + wobble) + rng.uniform(0, 6.28))
    return out / len(detune)


# ---- instruments --------------------------------------------------------------------------

_piano_cache = {}


def piano(midi, dur, vel=0.7):
    key = (midi, round(dur, 2), round(vel, 2))
    if key in _piano_cache:
        return _piano_cache[key]
    f0 = hz(midi)
    tau0 = float(np.clip(3.4 * (261.6 / f0) ** 0.6, 0.5, 7.0))
    total = int((min(dur, tau0 * 3) + 0.4) * SR)
    t = times(total)
    out = np.zeros(total)
    for k in range(1, 15):
        fk = k * f0 * np.sqrt(1 + 0.00035 * k * k)
        if fk > 15000:
            break
        amp = (1 / k ** 1.15) * (0.35 + 0.65 * vel) ** (0.6 * (k - 1))
        tau = tau0 / (1 + 0.55 * (k - 1))
        decay = 0.72 * np.exp(-t / tau) + 0.28 * np.exp(-t / (tau * 4))
        out += amp * decay * np.sin(2 * np.pi * fk * t + rng.uniform(0, 6.28))
        if k == 1:
            out += 0.45 * amp * decay * np.sin(2 * np.pi * fk * 1.0009 * t)
    hammer = rng.normal(size=int(0.03 * SR)) * np.exp(-times(int(0.03 * SR)) / 0.004)
    out[: len(hammer)] += spectral_filter(hammer, low=800, high=5000) * 0.04
    out *= np.clip(t / 0.002, 0, 1) * np.where(t > dur, np.exp(-(t - dur) / 0.09), 1.0)
    out *= vel * 0.5
    _piano_cache[key] = out
    return out


def strings(midi, dur, cutoff=2400, attack=0.9, release=1.6, voices=(-9, -3.5, 0, 4, 9.5)):
    env = envelope(dur, attack=attack, decay=1.0, sustain=0.9, release=release)
    return additive(hz(midi), len(env), cutoff, detune=voices, vibrato=0.0025) * env * 0.5


def spiccato(midi, dur=0.18, cutoff=2600):
    env = envelope(dur, attack=0.012, decay=0.08, sustain=0.45, release=0.12)
    return additive(hz(midi), len(env), cutoff, detune=(-6, 0, 6)) * env * 0.6


def brass(midi, dur, vel=0.8):
    env = envelope(dur, attack=0.09, decay=0.4, sustain=0.85, release=0.35)
    # The filter opens with loudness, which is what makes a horn "blat".
    cutoff = 350 + 2600 * vel * env
    return additive(hz(midi), len(env), cutoff, detune=(-5, 0, 5), vibrato=0.003) * env * 0.55


def warm_pad(midi, dur, attack=2.2, release=3.0):
    env = envelope(dur, attack=attack, decay=2.0, sustain=0.85, release=release)
    tone = additive(hz(midi), len(env), 900, harmonics="square", detune=(-7, 0, 7))
    breathe = 1 + 0.12 * np.sin(2 * np.pi * 0.17 * times(len(env)) + rng.uniform(0, 6.28))
    return tone * env * breathe * 0.6


def bell(midi, dur=3.0, vel=0.5, ratio=3.5, index=2.2):
    total = int(dur * SR)
    t = times(total)
    f = hz(midi)
    idx = index * np.exp(-t / 0.5) + 0.25
    tone = np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * ratio * t))
    tone += 0.25 * np.sin(2 * np.pi * f * 2 * t) * np.exp(-t / 0.35)
    return tone * np.exp(-t / (dur / 4)) * np.clip(t / 0.0015, 0, 1) * vel * 0.4


def synth_bass(midi, dur, cutoff=700):
    env = envelope(dur, attack=0.004, decay=0.25, sustain=0.6, release=0.08)
    t = times(len(env))
    sub = np.sin(2 * np.pi * hz(midi) * t)
    grit = additive(hz(midi), len(env), cutoff * (0.5 + 0.5 * env))
    return (0.75 * sub + 0.5 * grit) * env * 0.6


def pluck(midi, dur=0.2, cutoff=2600, harmonics="square"):
    env = envelope(dur, attack=0.002, decay=0.12, sustain=0.15, release=0.1)
    return additive(hz(midi), len(env), cutoff * (0.3 + 0.7 * env), harmonics=harmonics) * env * 0.5


def lead(midi, dur):
    env = envelope(dur, attack=0.01, decay=0.3, sustain=0.75, release=0.18)
    return additive(hz(midi), len(env), 3600, detune=(-8, 0, 8), vibrato=0.004) * env * 0.4


def power_stab(symbol, dur=0.32):
    notes = voicing(symbol, n("E3"), 4)
    env = envelope(dur, attack=0.004, decay=0.12, sustain=0.5, release=0.12)
    out = np.zeros(len(env))
    for m in notes:
        out += additive(hz(m), len(env), 3000 * (0.4 + 0.6 * env), detune=(-10, 10))
    return out * env * 0.3



def karplus(midi, dur, brightness=0.5, decay=0.996):
    """Plucked string (Karplus-Strong), computed a whole period at a time."""
    period = max(2, int(round(SR / hz(midi))))
    total = int((dur + 0.25) * SR)
    y = np.zeros(total + period)
    excite = noise(period)
    # Fewer high harmonics in the pluck for a softer string.
    for _ in range(int((1 - brightness) * 6)):
        excite = 0.5 * (excite + np.roll(excite, 1))
    y[:period] = excite - excite.mean()
    last = 0.0
    for start in range(period, total + period, period):
        prev = y[start - period:start]
        shifted = np.concatenate(([last], prev[:-1]))
        last = prev[-1]
        block = decay * 0.5 * (prev + shifted)
        end = min(start + period, len(y))
        y[start:end] = block[: end - start]
    out = y[period:period + total]
    t = times(total)
    out *= np.where(t > dur, np.exp(-(t - dur) / 0.05), 1.0)
    return out * 0.6


def epiano(midi, dur, vel=0.6):
    """FM electric piano: a bell-ish tine over a warm body."""
    total = int((dur + 0.6) * SR)
    t = times(total)
    f = hz(midi)
    index = (1.2 + 2.2 * vel) * np.exp(-t / 0.35)
    body = np.sin(2 * np.pi * f * t + index * np.sin(2 * np.pi * f * t))
    tine = np.sin(2 * np.pi * f * 14 * t) * np.exp(-t / 0.03) * 0.25 * vel
    env = np.exp(-t / (1.6 * (261.6 / f) ** 0.3)) * np.clip(t / 0.003, 0, 1)
    env *= np.where(t > dur, np.exp(-(t - dur) / 0.12), 1.0)
    tremolo = 1 + 0.08 * np.sin(2 * np.pi * 4.5 * t)
    return (body + tine) * env * tremolo * vel * 0.35


def supersaw(symbol, dur, low, cutoff=3200, attack=0.01, release=0.15):
    notes = voicing(symbol, low, 4)
    env = envelope(dur, attack=attack, decay=0.3, sustain=0.8, release=release)
    out = np.zeros(len(env))
    for m in notes:
        out += additive(hz(m), len(env), cutoff, detune=(-18, -9, -3, 3, 9, 18))
    return out * env * 0.22


def upright_bass(midi, dur):
    total = int((dur + 0.2) * SR)
    t = times(total)
    f = hz(midi)
    tone = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t)
    thump = spectral_filter(noise(total), high=900) * np.exp(-t / 0.012) * 0.6
    env = np.exp(-t / 0.55) * np.clip(t / 0.004, 0, 1) * np.where(t > dur, np.exp(-(t - dur) / 0.05), 1.0)
    return (tone + thump) * env * 0.55


def ride():
    total = int(1.6 * SR)
    t = times(total)
    partials = sum(np.sin(2 * np.pi * f * t + rng.uniform(0, 6.28)) for f in (3120, 4240, 5340, 6720, 8130, 9560))
    ping = partials / 6 * np.exp(-t / 0.5)
    wash = spectral_filter(noise(total), low=5000) * np.exp(-t / 0.35) * 0.5
    return (ping * 0.6 + wash) * np.clip(t / 0.001, 0, 1) * 0.3


def brush_swish(length):
    total = int(length * SR)
    t = times(total)
    shape = np.sin(np.pi * np.clip(t / length, 0, 1)) ** 2
    return spectral_filter(noise(total), low=2500, high=9000) * shape * 0.12


def clap():
    total = int(0.3 * SR)
    t = times(total)
    bursts = sum(np.where((t >= d) & (t < d + 0.008), 1.0, 0.0) for d in (0.0, 0.011, 0.022))
    body = spectral_filter(noise(total), low=900, high=4500)
    return body * (bursts * 0.8 + np.exp(-t / 0.09) * np.clip((t - 0.022) / 0.002, 0, 1)) * 0.55


def gated_snare():
    """The big 80s snare: a snare hit into a burst of reverb that cuts off abruptly."""
    total = int(0.42 * SR)
    t = times(total)
    gate = np.where(t < 0.32, 1.0, np.exp(-(t - 0.32) / 0.01))
    room = spectral_filter(noise(total), low=600, high=7000) * gate * 0.45
    out = room
    hit = snare()
    out[: len(hit)] += hit[: len(out)] * 0.9
    return out * 0.85


def vinyl(length):
    total = int(length * SR)
    hiss = spectral_filter(noise(total), low=1500, high=7000) * 0.012
    clicks = np.zeros(total)
    for pos in rng.integers(0, total - 200, size=int(length * 6)):
        clicks[pos:pos + 60] += rng.normal(0, 1, 60) * np.exp(-np.arange(60) / 8) * rng.uniform(0.05, 0.3)
    return hiss + spectral_filter(clicks, low=800)

def noise(count):
    return rng.normal(size=count)


def kick(punch=1.0):
    total = int(0.6 * SR)
    t = times(total)
    freq = 46 + 115 * np.exp(-t / 0.032)
    body = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t / 0.32)
    click = spectral_filter(noise(total), low=1500, high=8000) * np.exp(-t / 0.004) * 0.3 * punch
    return np.tanh(1.6 * (body + click)) * 0.9


def snare():
    total = int(0.45 * SR)
    t = times(total)
    tone = np.sin(2 * np.pi * 186 * t) * np.exp(-t / 0.07) * 0.5
    rattle = spectral_filter(noise(total), low=1200, high=9000) * np.exp(-t / 0.13)
    return (tone + rattle * 0.8) * 0.7


def hat(open_=False):
    total = int((0.35 if open_ else 0.08) * SR)
    t = times(total)
    return spectral_filter(noise(total), low=7000, order=3) * np.exp(-t / (0.11 if open_ else 0.022)) * 0.35


def shaker():
    total = int(0.12 * SR)
    t = times(total)
    shape = np.clip(t / 0.02, 0, 1) * np.exp(-t / 0.035)
    return spectral_filter(noise(total), low=4500, high=12000) * shape * 0.25


def tom(freq=110, decay=0.45):
    total = int(decay * 2.2 * SR)
    t = times(total)
    f = freq * (0.65 + 0.35 * np.exp(-t / 0.06))
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / decay)
    skin = spectral_filter(noise(total), high=1800) * np.exp(-t / 0.03) * 0.4
    return np.tanh(1.3 * (body + skin)) * 0.8


def taiko():
    return tom(72, 0.7) * 1.1


def crash(length=3.0):
    total = int(length * SR)
    t = times(total)
    wash = spectral_filter(noise(total), low=3500, order=2) * np.exp(-t / (length / 4))
    return wash * np.clip(t / 0.003, 0, 1) * 0.35


def riser(length):
    """A reversed cymbal swell ending on the downbeat."""
    return crash(length)[::-1] * 0.9


def boom():
    total = int(2.2 * SR)
    t = times(total)
    f = 30 + 45 * np.exp(-t / 0.15)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.7)
    thud = spectral_filter(noise(total), high=500) * np.exp(-t / 0.12) * 0.5
    return np.tanh(1.8 * (sub + thud)) * 0.9


def reverb_ir(rt60, predelay=0.02, bright=7000, dark=2600):
    length = int(rt60 * 1.15 * SR)
    t = times(length)
    channels = []
    for _ in range(2):
        early = spectral_filter(noise(length) * np.exp(-6.9 * t / (rt60 * 0.35)), high=bright)
        late = spectral_filter(noise(length) * np.exp(-6.9 * t / rt60), high=dark)
        ir = 0.45 * early + late
        ir[: int(predelay * SR)] = 0
        channels.append(ir / np.sqrt(np.sum(ir ** 2)))
    return channels


def convolve(x, ir):
    size = 1 << int(np.ceil(np.log2(len(x) + len(ir))))
    return np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[: len(x)]


# ---- arrangement --------------------------------------------------------------------------

class Song:
    def __init__(self, bpm, bars, rt60=2.8, tail=5.0):
        self.bpm = bpm
        self.bars = bars
        self.beat_len = 60 / bpm
        self.loop = int(round(bars * 4 * self.beat_len * SR))
        self.length = self.loop + int(tail * SR)
        self.dry = np.zeros((2, self.length))
        self.ducked = np.zeros((2, self.length))
        self.send = np.zeros((2, self.length))
        self.kicks = []
        self.rt60 = rt60

    def at(self, beat):
        return int(round(beat * self.beat_len * SR))

    def add(self, signal, beat, gain=1.0, pan=0.0, verb=0.2, duck=False):
        start = self.at(beat)
        if start >= self.length:
            return
        end = min(start + len(signal), self.length)
        seg = signal[: end - start] * gain
        angle = (pan + 1) * np.pi / 4
        left, right = np.cos(angle), np.sin(angle)
        bus = self.ducked if duck else self.dry
        bus[0, start:end] += seg * left
        bus[1, start:end] += seg * right
        if verb:
            self.send[0, start:end] += seg * left * verb
            self.send[1, start:end] += seg * right * verb

    def kick(self, beat, gain=1.0, punch=1.0):
        self.kicks.append(beat)
        self.add(kick(punch), beat, gain, verb=0.05)

    def render(self, duck_depth=0.0):
        mix = self.dry.copy()
        if duck_depth and self.kicks:
            env = np.ones(self.length)
            shape = 1 - duck_depth * np.exp(-times(int(0.5 * SR)) / 0.14)
            for beat in self.kicks:
                start = self.at(beat)
                end = min(start + len(shape), self.length)
                env[start:end] = np.minimum(env[start:end], shape[: end - start])
            mix += self.ducked * env
        else:
            mix += self.ducked
        for ch, ir in enumerate(reverb_ir(self.rt60)):
            mix[ch] += convolve(self.send[ch], ir) * 0.9
        # Wrap the tail around so the loop point is seamless.
        tail = self.length - self.loop
        mix[:, :tail] += mix[:, self.loop:]
        mix = mix[:, : self.loop]
        mix = np.stack([spectral_filter(ch, low=28) for ch in mix])
        # Match loudness across tracks, then softly limit the peaks.
        mix *= 0.16 / np.sqrt(np.mean(mix ** 2))
        mag = np.abs(mix)
        knee = 0.78
        mix = np.where(mag > knee, np.sign(mix) * (knee + (1 - knee) * np.tanh((mag - knee) / (1 - knee))), mix)
        # Leave headroom for the Vorbis encoder, which overshoots slightly.
        return mix * 0.9


def each_bar(chords, bars_per_chord):
    """Yields (bar index, chord symbol)."""
    for i, symbol in enumerate(chords):
        for b in range(bars_per_chord):
            yield i * bars_per_chord + b, symbol


# ---- the tracks ---------------------------------------------------------------------------

def cinematic():
    """First Light — slow, emotional strings and piano in D minor, swelling to a climax."""
    song = Song(bpm=72, bars=32, rt60=3.4)
    chords = ["Dm", "Bb", "F", "C", "Dm", "Bb", "Gm", "A", "Bb", "F", "C", "Dm", "Bb", "F", "Gm", "A"]
    energy = [0.45, 0.7, 1.0, 0.72]
    for i, symbol in enumerate(chords):
        beat = i * 8
        e = energy[i // 4]
        for m in voicing(symbol, n("D3"), 4):
            for pan in (-0.55, 0.55):
                song.add(strings(m, 8.4 * song.beat_len, cutoff=1300 + 1700 * e), beat, 0.085 * e, pan, verb=0.4)
        song.add(strings(bass_note(symbol, n("D2")), 8.2 * song.beat_len, cutoff=700), beat, 0.12 * e, 0, verb=0.25)
        # Piano arpeggio in eighths across the two bars.
        tones = voicing(symbol, n("D4"), 5)
        pattern = [0, 2, 3, 4, 3, 2, 1, 2, 0, 2, 3, 4, 3, 4, 2, 1]
        for k, idx in enumerate(pattern):
            vel = 0.5 + (0.12 if k % 4 == 0 else 0) + 0.15 * (e - 0.5)
            song.add(piano(tones[idx], song.beat_len * 1.4, vel), beat + k * 0.5, 0.55, -0.15 + 0.08 * idx, verb=0.35)
        # Cello ostinato in the middle sections.
        if 4 <= i < 12:
            low = bass_note(symbol, n("D2")) + 12
            for k in range(16):
                accent = [1, 0.5, 0.7, 0.5, 0.9, 0.5, 0.7, 0.5][k % 8]
                song.add(spiccato(low, 0.2, cutoff=1100), beat + k * 0.5, 0.2 * accent * e, -0.3, verb=0.2)
        elif i >= 12:
            low = bass_note(symbol, n("D2")) + 12
            for k in range(4):
                song.add(spiccato(low, 0.5, cutoff=900), beat + k * 2, 0.16, -0.3, verb=0.25)
    # Climax: timpani on chord changes, a riser and a boom into bar 17.
    song.add(riser(2 * 4 * song.beat_len), 64 - 8, 0.8, 0, verb=0.3)
    song.add(boom(), 64, 0.9, 0, verb=0.4)
    song.add(crash(4.0), 64, 0.6, 0.2, verb=0.5)
    for k in range(8):
        song.add(tom(90, 0.5), 62 + k * 0.25, 0.25 + 0.06 * k, 0, verb=0.3)
    for beat in (64, 72, 80, 88, 96):
        song.add(taiko(), beat, 0.8, 0, verb=0.45)
    melody = [  # (note, beat from bar 17, beats)
        ("F5", 0, 3), ("D5", 3, 1), ("C5", 4, 2), ("D5", 6, 2),
        ("C5", 8, 3), ("A4", 11, 1), ("A4", 12, 2), ("C5", 14, 2),
        ("E5", 16, 3), ("D5", 19, 1), ("C5", 20, 2), ("G4", 22, 2),
        ("A4", 24, 4), ("F5", 28, 2), ("E5", 30, 2),
        ("D5", 32, 3), ("F5", 35, 1), ("F5", 36, 2), ("D5", 38, 2),
        ("C5", 40, 3), ("F5", 43, 1), ("A5", 44, 4),
        ("G5", 48, 3), ("F5", 51, 1), ("D5", 52, 2), ("Bb4", 54, 2),
        ("C#5", 56, 4), ("E5", 60, 4),
    ]
    for note, beat, length in melody:
        quiet = beat >= 32
        song.add(strings(n(note), length * song.beat_len, cutoff=3200, attack=0.25, release=0.9, voices=(-6, 0, 6)),
                 64 + beat, 0.17 if not quiet else 0.12, 0.1, verb=0.45)
        song.add(piano(n(note), length * song.beat_len, 0.75), 64 + beat, 0.5 if not quiet else 0.4, 0.2, verb=0.4)
    return song.render()


def action():
    """Overdrive — 128 BPM driving drums, pulsing bass and arpeggios in E minor."""
    song = Song(bpm=128, bars=64, rt60=1.6)
    verse = ["Em", "C", "G", "D"]
    bridge = ["Am", "C", "Em", "D"]
    riff = [("E5", 0, .5), ("E5", .75, .25), ("G5", 1, .5), ("A5", 1.5, .5), ("B5", 2, .75), ("A5", 2.75, .25),
            ("G5", 3, .5), ("E5", 3.5, .5), ("D5", 4, .5), ("E5", 4.5, .5), ("G5", 5, 1), ("E5", 6.5, .5), ("D5", 7, 1)]
    for bar in range(64):
        beat = bar * 4
        section = bar // 16
        breakdown = 32 <= bar < 40
        build = 40 <= bar < 48
        symbol = (bridge if 32 <= bar < 48 else verse)[bar % 4]
        # Drums
        if breakdown:
            if bar % 2 == 0:
                song.kick(beat, 0.9)
            for k in (2.5, 3.0, 3.5):
                song.add(tom(130 - k * 10, 0.3), beat + k, 0.25, 0.3 * (k - 3), verb=0.25)
        elif build:
            if bar >= 44:
                for k in range(4):
                    song.kick(beat + k, 0.85)
            subdivision = 2 if bar < 42 else 4 if bar < 46 else 8
            for k in range(4 * subdivision):
                song.add(snare(), beat + k / subdivision, 0.18 + 0.5 * ((bar - 40) * 4 * subdivision + k) / (8 * 4 * subdivision), 0, verb=0.25)
        else:
            for k in (0, 1.5, 2, 2.75 if section >= 1 else None):
                if k is not None:
                    song.kick(beat + k, 1.0 if k in (0, 2) else 0.7)
            for k in (1, 3):
                song.add(snare(), beat + k, 0.75, 0.05, verb=0.2)
            steps = 4 if section >= 1 else 2
            for k in range(4 * steps):
                accent = 1.0 if k % steps == 0 else 0.55
                song.add(hat(), beat + k / steps, 0.32 * accent, 0.35, verb=0.05)
            if section >= 1:
                song.add(hat(True), beat + 3.5, 0.3, -0.35, verb=0.1)
        # Bass: pulsing eighths, whole notes in the breakdown
        root = bass_note(symbol, n("E1")) + 12
        if breakdown:
            song.add(synth_bass(root, 4 * song.beat_len, cutoff=400), beat, 0.55, 0, verb=0.05)
        else:
            for k in range(8):
                song.add(synth_bass(root + (12 if k in (3, 7) and section >= 1 else 0), 0.42 * song.beat_len), beat + k * 0.5, 0.5, 0, verb=0.02)
        # Arpeggio in sixteenths, opening up through each section
        tones = voicing(symbol, n("E4"), 4)
        cutoff = 900 + 2600 * ((bar % 16) / 16 if section != 3 else 1.0)
        if build:
            cutoff = 700 + 3500 * (bar - 40) / 8
        for k in range(16):
            idx = [0, 1, 2, 3, 2, 1, 2, 3][k % 8]
            song.add(pluck(tones[idx] + (12 if k % 8 == 3 else 0), 0.15, cutoff), beat + k * 0.25, 0.22, -0.4 if k % 2 else 0.4, verb=0.15, duck=True)
        # Pad and stabs (ducked under the kick)
        for m in voicing(symbol, n("B3"), 3):
            song.add(strings(m, 4 * song.beat_len, cutoff=1600, attack=0.3, release=0.6), beat, 0.06, rng.uniform(-0.5, 0.5), verb=0.25, duck=True)
        if section in (1, 3):
            for k in (0, 2.5):
                song.add(power_stab(symbol), beat + k, 0.42, 0, verb=0.15, duck=True)
        # Lead riff
        if section in (1, 3) and not (bar % 2):
            octave = 12 if section == 3 else 0
            for note, offset, length in riff:
                song.add(lead(n(note) + octave, length * song.beat_len * 0.95), beat + offset, 0.28, 0.1, verb=0.2)
    song.add(riser(8 * song.beat_len), 48 * 4 - 8, 0.9, 0, verb=0.2)
    for downbeat in (16, 48):
        song.add(crash(3.0), downbeat * 4, 0.7, 0.3, verb=0.3)
        song.add(boom(), downbeat * 4, 0.9, 0, verb=0.3)
    for k in range(8):  # tom fill back into the top
        song.add(tom(170 - k * 12, 0.25), 63 * 4 + 2 + k * 0.25, 0.45, 0.6 - 0.15 * k, verb=0.2)
    return song.render(duck_depth=0.55)


def adventure():
    """Far Horizons — heroic brass theme over taiko and string ostinato in D major."""
    song = Song(bpm=100, bars=48, rt60=2.6)
    chords = ["D", "A", "Bm", "G", "D", "A", "Bm", "G", "G", "A", "D/F#", "Bm",
              "G", "A", "D", "D", "Bm", "G", "D", "A", "G", "A", "D", "A"]
    energy = [0.5, 0.75, 1.0, 1.0, 0.6, 0.85]
    for i, symbol in enumerate(chords):
        beat = i * 8
        section = i // 4
        e = energy[section]
        tones = voicing(symbol, n("D3"), 4)
        pattern = [0, 2, 3, 2, 1, 2, 3, 2]
        for k in range(16):
            song.add(spiccato(tones[pattern[k % 8]], 0.16, cutoff=1800 + 1400 * e), beat + k * 0.5,
                     0.2 * e * (1.15 if k % 4 == 0 else 1), -0.35 if k % 2 else 0.35, verb=0.25)
        for m in voicing(symbol, n("F#3"), 4):
            song.add(strings(m, 8.3 * song.beat_len, cutoff=1500 + 1200 * e, attack=0.7), beat, 0.06 * e, rng.uniform(-0.6, 0.6), verb=0.35)
        if section >= 1:
            song.add(strings(bass_note(symbol, n("D2")), 8.2 * song.beat_len, cutoff=600, attack=0.2), beat, 0.16 * e, 0, verb=0.2)
            for m in voicing(symbol, n("A3"), 3):
                song.add(brass(m, 7.6 * song.beat_len, 0.5 * e), beat, 0.06 * e, 0.3, verb=0.35)
        # Taiko groove: DUM . . dum DUM . dum dum
        for bar in range(2):
            b = beat + bar * 4
            hits = [(0, 1.0, "taiko"), (1.5, 0.55, "tom"), (2, 0.85, "taiko"), (3, 0.5, "tom"), (3.5, 0.6, "tom")]
            if section == 4:
                hits = [(0, 0.7, "taiko"), (2, 0.5, "taiko")]
            for offset, gain, kind in hits:
                sound = taiko() if kind == "taiko" else tom(140, 0.3)
                song.add(sound, b + offset, gain * (0.55 + 0.4 * e), -0.2 if kind == "tom" else 0, verb=0.35)
    theme = [
        ("D5", 0, 1.5), ("B4", 1.5, .5), ("D5", 2, 1), ("G5", 3, 3), ("F#5", 6, 1), ("E5", 7, 1),
        ("E5", 8, 1.5), ("C#5", 9.5, .5), ("E5", 10, 1), ("A5", 11, 3), ("G5", 14, 1), ("F#5", 15, 1),
        ("F#5", 16, 3), ("E5", 19, 1), ("D5", 20, 2), ("A4", 22, 2),
        ("B4", 24, 4), ("D5", 28, 2), ("F#5", 30, 2),
        ("G5", 32, 3), ("F#5", 35, 1), ("E5", 36, 2), ("D5", 38, 2),
        ("E5", 40, 3), ("A5", 43, 1), ("A5", 44, 2), ("G5", 46, 1), ("F#5", 47, 1),
        ("F#5", 48, 4), ("A5", 52, 4), ("D5", 56, 8),
    ]
    for note, beat, length in theme:
        song.add(brass(n(note), length * song.beat_len * 0.97, 0.95), 64 + beat, 0.3, 0.05, verb=0.4)
        song.add(brass(n(note) - 12, length * song.beat_len * 0.97, 0.7), 64 + beat, 0.16, -0.1, verb=0.4)
    for downbeat in (64, 96, 160):
        song.add(crash(3.5), downbeat, 0.6, 0.25, verb=0.45)
        song.add(boom(), downbeat, 0.85, 0, verb=0.4)
    song.add(riser(4 * song.beat_len), 64 - 4, 0.7, 0, verb=0.3)
    for k in range(16):  # roll into the loop point
        song.add(taiko() if k % 4 == 0 else tom(150, 0.25), 188 + k * 0.25, 0.3 + 0.03 * k, 0, verb=0.3)
    return song.render()


def dreamy():
    """Afterglow — floating pads and glassy bells in F major."""
    song = Song(bpm=76, bars=32, rt60=4.6)
    chords = ["Fmaj7", "Am7", "Dm9", "Bbmaj7", "Fmaj7", "Am7", "Gm9", "C6",
              "Bbmaj7", "Am7", "Dm9", "Bbmaj7", "Gm9", "Am7", "Bbmaj7", "Csus4"]
    walk = rng.integers(0, 5, size=len(chords) * 16)
    for i, symbol in enumerate(chords):
        beat = i * 8
        for m in voicing(symbol, n("C3"), 4):
            song.add(warm_pad(m, 8.6 * song.beat_len), beat, 0.09, rng.uniform(-0.7, 0.7), verb=0.55)
        song.add(np.sin(2 * np.pi * hz(bass_note(symbol, n("F1")) + 12) * times(int(8.4 * song.beat_len * SR))) *
                 envelope(8 * song.beat_len, attack=1.0, decay=2.0, sustain=0.8, release=1.2)[: int(8.4 * song.beat_len * SR)],
                 beat, 0.16, 0, verb=0.1)
        tones = voicing(symbol, n("C5"), 6)
        for k in range(16):
            if i < 2 and k % 2:
                continue
            song.add(bell(tones[walk[i * 16 + k] % len(tones)], 3.0, rng.uniform(0.25, 0.55)), beat + k * 0.5,
                     0.32, -0.6 if k % 2 else 0.6, verb=0.6)
        if 4 <= i < 14:
            for k in range(32):
                song.add(shaker(), beat + k * 0.25, 0.12 * (1.0 if k % 2 else 0.6), 0.4, verb=0.15)
        if 8 <= i < 14:
            for bar in range(2):
                song.add(kick(0.3), beat + bar * 4, 0.3, verb=0.1)
                song.add(kick(0.3), beat + bar * 4 + 0.75, 0.18, verb=0.1)
    return song.render()


def memories():
    """Polaroid Summer — a warm, nostalgic piano piece in G major."""
    song = Song(bpm=84, bars=32, rt60=2.2)
    phrase = ["G", "D/F#", "Em", "C", "G", "Bm", "C", "Cm"]
    melody = [
        [("B4", 0, 1), ("D5", 1, 1), ("G5", 2, 1.5), ("F#5", 3.5, .5)],
        [("E5", 0, 1), ("D5", 1, 1), ("A4", 2, 2)],
        [("G4", 0, .5), ("A4", .5, .5), ("B4", 1, 1.5), ("E5", 2.5, 1.5)],
        [("E5", 0, 1), ("D5", 1, .5), ("C5", 1.5, .5), ("G4", 2, 2)],
        [("B4", 0, 1), ("D5", 1, 1), ("G5", 2, 1), ("B5", 3, 1)],
        [("A5", 0, 1), ("F#5", 1, 1), ("D5", 2, 2)],
        [("E5", 0, 1.5), ("G5", 1.5, .5), ("E5", 2, 1), ("C5", 3, 1)],
        [("Eb5", 0, 2), ("D5", 2, 2)],
    ]
    for bar in range(32):
        beat = bar * 4
        part = bar // 8
        symbol = phrase[bar % 8]
        root = bass_note(symbol, n("G2"))
        upper = voicing(symbol, n("D3"), 4)
        left = [root, upper[0], upper[1], upper[2], upper[3], upper[2], upper[1], upper[0]]
        for k, m in enumerate(left):
            song.add(piano(m, song.beat_len * 1.6, 0.42 + (0.1 if k == 0 else 0)), beat + k * 0.5, 0.6, -0.25, verb=0.3)
        if part >= 1:
            for note, offset, length in melody[bar % 8]:
                song.add(piano(n(note), length * song.beat_len, 0.68), beat + offset, 0.7, 0.2, verb=0.32)
                if part == 2:
                    song.add(bell(n(note) + 12, 1.6, 0.35, ratio=2.0, index=1.2), beat + offset, 0.22, 0.35, verb=0.4)
        if part >= 2:
            for m in voicing(symbol, n("G3"), 3):
                song.add(strings(m, 4.2 * song.beat_len, cutoff=1500, attack=0.6, release=1.2), beat, 0.05, rng.uniform(-0.6, 0.6), verb=0.35)
        if 16 <= bar < 29:
            song.add(kick(0.4), beat, 0.35, verb=0.1)
            song.add(kick(0.4), beat + 2, 0.28, verb=0.1)
            for k in (1, 3):
                song.add(tom(320, 0.08), beat + k, 0.2, 0.15, verb=0.2)
            for k in range(8):
                song.add(shaker(), beat + k * 0.5, 0.16 if k % 2 else 0.09, 0.35, verb=0.1)
    return song.render()



def lofi():
    """Lo-Fi Sunday — dusty, swung beats under mellow electric-piano chords."""
    song = Song(bpm=82, bars=32, rt60=1.8)
    chords = ["Fmaj7", "Em7", "Dm7", "Cmaj7"]
    swing = 0.12
    melody = [("E5", 0, 1.5), ("G5", 1.5, 0.5), ("A5", 2, 1), ("G5", 3, 1), ("E5", 4, 2), ("D5", 6, 1), ("C5", 7, 1),
              ("D5", 8, 1.5), ("E5", 9.5, 0.5), ("G5", 10, 2), ("E5", 12, 1), ("D5", 13, 1), ("C5", 14, 2)]
    for bar in range(32):
        beat = bar * 4
        symbol = chords[bar % 4]
        drums = 4 <= bar < 30
        for offset, vel in ((0, 0.62), (1.75 + swing / 2, 0.48)):
            for m in voicing(symbol, n("E3"), 4):
                song.add(epiano(m, 1.6 * song.beat_len, vel), beat + offset, 0.5, rng.uniform(-0.3, 0.3), verb=0.25, duck=True)
        root = bass_note(symbol, n("C2"))
        song.add(upright_bass(root, 1.8 * song.beat_len) * 1.2, beat, 0.55, 0, verb=0.05)
        song.add(upright_bass(root + 7, 0.8 * song.beat_len) * 1.2, beat + 2.5 + swing, 0.4, 0, verb=0.05)
        if drums:
            song.kick(beat, 0.75, punch=0.4)
            song.kick(beat + 2.5 + swing, 0.55, punch=0.4)
            for k in (1, 3):
                song.add(spectral_filter(snare(), high=4500), beat + k + 0.04, 0.5, 0.05, verb=0.2)
            for k in range(8):
                song.add(spectral_filter(hat(), high=9000), beat + k * 0.5 + (swing if k % 2 else 0), 0.22 if k % 2 else 0.3, 0.35, verb=0.05)
        if 16 <= bar < 28 and bar % 4 == 0:
            for note, offset, length in melody:
                song.add(bell(n(note), 1.8, 0.4, ratio=1.0, index=0.8), beat + offset, 0.3, -0.2, verb=0.35)
    song.add(vinyl(32 * 4 * song.beat_len + 1), 0, 1.0, 0, verb=0)
    mix = song.render(duck_depth=0.3)
    # Roll off the top end for that worn-tape warmth.
    return np.stack([spectral_filter(ch, high=8500) for ch in mix])


def synthwave():
    """Neon Drive — 80s synthwave: gated snares, pulsing octave bass, shimmering arps."""
    song = Song(bpm=100, bars=48, rt60=2.4)
    chords = ["Am", "F", "C", "G"]
    riff = [("E5", 0, 1.5), ("D5", 1.5, 0.5), ("C5", 2, 1), ("D5", 3, 1), ("E5", 4, 3), ("G5", 7, 1),
            ("A5", 8, 1.5), ("G5", 9.5, 0.5), ("E5", 10, 2), ("D5", 12, 1.5), ("C5", 13.5, 0.5), ("D5", 14, 2)]
    for bar in range(48):
        beat = bar * 4
        section = bar // 16
        symbol = chords[bar % 4]
        intro = bar < 4
        for m in voicing(symbol, n("A3"), 4):
            song.add(strings(m, 4.2 * song.beat_len, cutoff=1800, attack=0.5, release=0.9, voices=(-12, -5, 0, 5, 12)), beat, 0.06, rng.uniform(-0.7, 0.7), verb=0.45, duck=True)
        root = bass_note(symbol, n("A1"))
        for k in range(8):
            song.add(synth_bass(root + (12 if k % 2 else 0), 0.45 * song.beat_len, cutoff=900), beat + k * 0.5, 0.42, 0, verb=0.02)
        tones = voicing(symbol, n("A4"), 4)
        for k in range(16):
            song.add(pluck(tones[[0, 1, 2, 3, 2, 1, 2, 3][k % 8]], 0.14, 2200, harmonics="saw"), beat + k * 0.25, 0.14, 0.5 if k % 2 else -0.5, verb=0.35, duck=True)
        if not intro:
            for k in range(4):
                song.kick(beat + k, 0.9)
            for k in (1, 3):
                song.add(gated_snare(), beat + k, 0.65, 0, verb=0.15)
            for k in range(16):
                song.add(hat(), beat + k * 0.25, 0.16 if k % 2 else 0.24, 0.3, verb=0.05)
        if section >= 1 and bar % 4 == 0 and not (32 <= bar < 36):
            for note, offset, length in riff:
                song.add(lead(n(note), length * song.beat_len), beat + offset, 0.3, -0.1, verb=0.45)
    for downbeat in (16, 32):
        song.add(crash(3.0), downbeat * 4, 0.55, 0.3, verb=0.4)
    return song.render(duck_depth=0.4)


def acoustic():
    """Good Days — a sunny ukulele strum with claps and a whistled tune."""
    song = Song(bpm=112, bars=32, rt60=1.4)
    chords = ["G", "D", "Em", "C"]
    strum = [(0, 1, 0.9), (1, 1, 0.6), (1.5, -1, 0.5), (2.5, -1, 0.55), (3, 1, 0.7), (3.5, -1, 0.5)]
    tune = [("B5", 0, 1), ("D6", 1, 1), ("B5", 2, 0.5), ("A5", 2.5, 0.5), ("G5", 3, 1), ("A5", 4, 1.5), ("F#5", 5.5, 0.5),
            ("D5", 6, 2), ("E5", 8, 1), ("G5", 9, 1), ("B5", 10, 1), ("A5", 11, 1), ("G5", 12, 3)]
    for bar in range(32):
        beat = bar * 4
        symbol = chords[bar % 4]
        notes = voicing(symbol, n("G4"), 4)
        for offset, direction, vel in strum:
            order = notes if direction > 0 else notes[::-1]
            for i, m in enumerate(order):
                song.add(karplus(m, 0.9 * song.beat_len, brightness=0.55 + 0.2 * vel), beat + offset + i * 0.012 / song.beat_len, 0.32 * vel, -0.25 + 0.15 * i, verb=0.2)
        song.add(upright_bass(bass_note(symbol, n("G1")) + 12, 1.6 * song.beat_len), beat, 0.5, 0, verb=0.05)
        song.add(upright_bass(bass_note(symbol, n("G1")) + 19, 1.6 * song.beat_len), beat + 2, 0.4, 0, verb=0.05)
        if bar >= 4:
            song.add(kick(0.5), beat, 0.45, verb=0.05)
            song.add(kick(0.5), beat + 2, 0.35, verb=0.05)
            for k in (1, 3):
                song.add(clap(), beat + k, 0.5, 0.1, verb=0.2)
            for k in range(8):
                song.add(shaker(), beat + k * 0.5, 0.2 if k % 2 else 0.12, 0.4, verb=0.05)
        if bar >= 8 and bar % 4 == 0:
            for note, offset, length in tune:
                env = envelope(length * song.beat_len * 0.9, attack=0.04, decay=0.2, sustain=0.8, release=0.1)
                t = times(len(env))
                whistle = np.sin(2 * np.pi * hz(n(note)) * t + 0.4 * np.sin(2 * np.pi * 5.5 * t)) * env
                song.add(whistle, beat + offset, 0.14, 0.2, verb=0.35)
                if bar >= 16:
                    song.add(bell(n(note), 1.2, 0.35, ratio=2.0, index=1.0), beat + offset, 0.16, -0.3, verb=0.3)
    return song.render()


def house():
    """Club Lights — a four-on-the-floor house groove with a breakdown and a drop."""
    song = Song(bpm=124, bars=64, rt60=1.6)
    chords = ["Fm", "Db", "Ab", "Eb"]
    for bar in range(64):
        beat = bar * 4
        symbol = chords[bar % 4]
        breakdown = 32 <= bar < 40
        build = 40 <= bar < 48
        if not breakdown:
            for k in range(4):
                song.kick(beat + k, 1.0)
            for k in (1, 3):
                song.add(clap(), beat + k, 0.55, 0.05, verb=0.2)
            for k in range(4):
                song.add(hat(True), beat + k + 0.5, 0.26, -0.3, verb=0.1)
            if bar >= 8:
                for k in range(16):
                    song.add(hat(), beat + k * 0.25, 0.12 if k % 2 else 0.08, 0.35, verb=0.03)
        root = bass_note(symbol, n("F1")) + 12
        if not breakdown:
            for k in range(4):
                song.add(synth_bass(root, 0.42 * song.beat_len, cutoff=700), beat + k + 0.5, 0.55, 0, verb=0.02)
        cutoff = 1200 if breakdown else 600 + 3200 * (bar - 40) / 8 if build else 3400
        for k in (0, 1.5, 3):
            if bar >= 4 or k == 0:
                song.add(supersaw(symbol, 0.7 * song.beat_len, n("C4"), cutoff=cutoff), beat + k, 0.42, rng.uniform(-0.2, 0.2), verb=0.3, duck=True)
        if breakdown:
            # Keep the floor alive without drums: lush pads and a pulsing arpeggio.
            for m in voicing(symbol, n("F3"), 4):
                song.add(strings(m, 4.2 * song.beat_len, cutoff=2000, attack=0.4), beat, 0.24, rng.uniform(-0.6, 0.6), verb=0.5)
            tones = voicing(symbol, n("F4"), 4)
            for k in range(8):
                song.add(pluck(tones[[0, 1, 2, 3, 2, 1, 2, 3][k]], 0.2, 1800), beat + k * 0.5, 0.34, -0.4 if k % 2 else 0.4, verb=0.4)
    song.add(riser(8 * song.beat_len), 48 * 4 - 8, 0.85, 0, verb=0.3)
    for downbeat in (16, 48):
        song.add(crash(3.0), downbeat * 4, 0.6, 0.3, verb=0.3)
        song.add(boom(), downbeat * 4, 0.8, 0, verb=0.3)
    return song.render(duck_depth=0.6)


def jazz():
    """Café Noir — a swinging piano trio: walking bass, ride cymbal and brushes."""
    song = Song(bpm=120, bars=32, rt60=1.3)
    chords = ["Cm7", "F7", "Bbmaj7", "Gm7", "Cm7", "F7", "Bbmaj7", "Bbmaj7"]
    swing = 2 / 3
    head = [("D5", 0, 1), ("Eb5", 1, 0.66), ("F5", 1.66, 1.34), ("G5", 4, 1), ("A5", 5, 0.66), ("C6", 5.66, 1.34),
            ("Bb5", 8, 2), ("A5", 10, 0.66), ("F5", 10.66, 1.34), ("G5", 12, 3)]
    for bar in range(32):
        beat = bar * 4
        symbol = chords[bar % 8]
        root, intervals, _ = chord(symbol)
        tones = [n("C2") + ((root - n("C2")) % 12) + i for i in intervals]
        nxt_root, _, _ = chord(chords[(bar + 1) % 8])
        target = n("C2") + ((nxt_root - n("C2")) % 12)
        walk = [tones[0], tones[1] if len(tones) > 1 else tones[0] + 4, tones[2], target - 1 if (bar % 2) else target + 1]
        for k, m in enumerate(walk):
            song.add(upright_bass(m + 12, 0.9 * song.beat_len), beat + k, 0.6, -0.1, verb=0.08)
        # Ride: ding, ding-a, ding, ding-a (swung)
        for k in range(4):
            song.add(ride(), beat + k, 0.45 if k % 2 == 0 else 0.38, 0.4, verb=0.15)
            if k % 2:
                song.add(ride(), beat + k + swing, 0.26, 0.4, verb=0.15)
        for k in (1, 3):
            song.add(hat() * 0.8, beat + k, 0.25, 0.3, verb=0.05)
        song.add(brush_swish(4 * song.beat_len), beat, 0.9, -0.2, verb=0.1)
        # Piano comping on the offbeats, shell voicings.
        shell = voicing(symbol, n("E3"), 4)[:4]
        for offset in ((1 + swing, 3) if bar % 2 else (0 + swing, 2 + swing)):
            for m in shell:
                song.add(piano(m, 0.5 * song.beat_len, 0.5), beat + offset, 0.38, 0.2, verb=0.2)
        if 8 <= bar < 24 and bar % 4 == 0:
            for note, offset, length in head:
                t = times(int(length * song.beat_len * SR))
                vibes = bell(n(note), length * song.beat_len + 0.8, 0.5, ratio=4.0, index=0.6)
                vibes *= 1 + 0.25 * np.sin(2 * np.pi * 5.0 * times(len(vibes)))
                song.add(vibes, beat + offset, 0.32, -0.25, verb=0.3)
    return song.render()

TRACKS = [  # (id, title, vibe, bpm, composer)
    ("cinematic", "First Light", "Cinematic", 72, cinematic),
    ("action", "Overdrive", "Energetic", 128, action),
    ("adventure", "Far Horizons", "Epic", 100, adventure),
    ("dreamy", "Afterglow", "Ambient", 76, dreamy),
    ("memories", "Polaroid Summer", "Nostalgic", 84, memories),
    ("lofi", "Lo-Fi Sunday", "Chill", 82, lofi),
    ("synthwave", "Neon Drive", "Retro 80s", 100, synthwave),
    ("acoustic", "Good Days", "Happy", 112, acoustic),
    ("house", "Club Lights", "Party", 124, house),
    ("jazz", "Café Noir", "Jazz", 120, jazz),
]


def write_ogg(stereo, path):
    pcm = (np.clip(stereo.T, -1, 1) * 32767).astype("<i2")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name
    with wave.open(wav_path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    try:
        subprocess.run(["gst-launch-1.0", "-q", "filesrc", f"location={wav_path}", "!", "wavparse", "!",
                        "audioconvert", "!", "vorbisenc", "quality=0.45", "!", "oggmux", "!",
                        "filesink", f"location={path}"], check=True)
    finally:
        os.unlink(wav_path)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "content", "music")
    only = set(sys.argv[2:])
    os.makedirs(out_dir, exist_ok=True)
    manifest = []
    previous = {}
    manifest_path = os.path.join(out_dir, "tracks.json")
    if os.path.exists(manifest_path):
        previous = {t["id"]: t for t in json.load(open(manifest_path))}
    for track_id, title, vibe, bpm, compose in TRACKS:
        if only and track_id not in only:
            if track_id in previous:
                manifest.append({**previous[track_id], "title": title, "vibe": vibe})
            continue
        print(f"rendering {track_id}…", flush=True)
        audio = compose()
        file_name = f"{track_id}.ogg"
        write_ogg(audio, os.path.join(out_dir, file_name))
        manifest.append({"id": track_id, "title": title, "vibe": vibe, "file": file_name, "bpm": bpm,
                         "seconds": round(audio.shape[1] / SR, 3)})
    manifest.sort(key=lambda t: [x[0] for x in TRACKS].index(t["id"]))
    with open(os.path.join(out_dir, "tracks.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("done", flush=True)


if __name__ == "__main__":
    main()
