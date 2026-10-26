import { clipEnd, curveAt, propAt, type MediaClip, type Project } from "./model";

/**
 * The sound mix's numbers, as pure functions (preview and export use the same ones): each
 * clip's gain over time (volume keyframes, fades, music ducking under voice-overs), the playback
 * rate of curved clips, and beat marks found in a sound.
 */

/** Gain and rate curves have this many values per second. */
export const CURVE_RATE = 100;
/** Ducking fades in this fast before a voice and out this slowly after it. */
const DUCK_ATTACK = 0.15;
const DUCK_RELEASE = 0.45;
/** Pauses shorter than this inside a voice-over don't bring the music back up. */
const DUCK_GAP = 0.6;

export type Windows = [number, number][];

/** Joins windows that touch or nearly touch, in order. */
export function mergeWindows(windows: Windows, gap = DUCK_GAP): Windows {
  const sorted = windows.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Windows = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * When a voice-over is heard, as timeline windows. `loud(c, t)` says whether clip `c` is
 * sounding at timeline time `t` (from its waveform); without it every voice-over counts whole.
 */
export function voiceWindows(p: Project, loud?: (c: MediaClip, t: number) => boolean): Windows {
  const out: Windows = [];
  for (const track of p.tracks) {
    if (track.muted) continue;
    for (const c of track.clips) {
      if (c.type !== "media" || c.role !== "voice") continue;
      if (!loud) {
        out.push([c.start, clipEnd(c)]);
        continue;
      }
      let open: number | null = null;
      const step = 1 / CURVE_RATE;
      for (let t = c.start; t < clipEnd(c); t += step) {
        if (loud(c, t)) open ??= t;
        else if (open !== null) {
          out.push([open, t]);
          open = null;
        }
      }
      if (open !== null) out.push([open, clipEnd(c)]);
    }
  }
  return mergeWindows(out);
}

/** How far ducking has gone at `t`: 1 inside a voice window, easing in before it and out after. */
export function duckLevel(windows: Windows, t: number): number {
  let level = 0;
  for (const [a, b] of windows) {
    if (t >= a && t <= b) return 1;
    if (t < a && t > a - DUCK_ATTACK) level = Math.max(level, 1 - (a - t) / DUCK_ATTACK);
    if (t > b && t < b + DUCK_RELEASE) level = Math.max(level, 1 - (t - b) / DUCK_RELEASE);
  }
  return level;
}

/** A clip's gain at timeline time `t`: its volume (keyframed or not), fades and ducking. */
export function clipGain(c: MediaClip, t: number, windows: Windows): number {
  const local = t - c.start;
  let g = propAt(c, "volume", local);
  const fi = Math.min(c.fadeIn, c.duration / 2), fo = Math.min(c.fadeOut, c.duration / 2);
  if (fi > 0 && local < fi) g *= Math.max(0, local / fi);
  if (fo > 0 && local > c.duration - fo) g *= Math.max(0, (c.duration - local) / fo);
  if (c.duck && c.role !== "voice") g *= 1 - Math.min(1, c.duck) * duckLevel(windows, t);
  return Math.max(0, g);
}

/** The gain every 1/CURVE_RATE seconds from timeline time `from` to the clip's end (at least 2 values). */
export function gainCurve(c: MediaClip, from: number, windows: Windows): Float32Array {
  const end = clipEnd(c);
  const n = Math.max(2, Math.ceil((end - from) * CURVE_RATE) + 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = clipGain(c, Math.min(end, from + i / CURVE_RATE), windows);
  return out;
}

/** Whether a clip's gain never changes (a plain volume, no fades, nothing ducking it). */
export function steadyGain(c: MediaClip, windows: Windows): boolean {
  return !c.keys?.volume && c.fadeIn <= 0 && c.fadeOut <= 0 && !(c.duck && windows.length);
}

/** A curved clip's playback rate every 1/CURVE_RATE seconds from `from` (null without a curve). */
export function rateCurve(c: MediaClip, from: number): Float32Array | null {
  if (!c.curve) return null;
  const end = clipEnd(c);
  const n = Math.max(2, Math.ceil((end - from) * CURVE_RATE) + 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const local = Math.min(c.duration, from - c.start + i / CURVE_RATE);
    out[i] = Math.max(0.0625, Math.min(16, c.speed * curveAt(c.curve.points, local / Math.max(1e-6, c.duration))));
  }
  return out;
}

/**
 * Beats in a sound from its loudness (`peaks`, `rate` values a second, 0…255): onsets, the tempo
 * that fits them best (70–180 BPM), then an even grid through them, each beat nudged onto its
 * onset. Seconds, in order.
 */
export function detectBeats(peaks: Uint8Array, rate: number): number[] {
  const n = peaks.length;
  if (n < rate * 2) return [];
  // Onset strength: how much louder than the moment before.
  const onset = new Float32Array(n);
  for (let i = 3; i < n; i++) {
    const before = (peaks[i - 1] + peaks[i - 2] + peaks[i - 3]) / 3;
    onset[i] = Math.max(0, peaks[i] - before) / 255;
  }
  const minLag = Math.max(2, Math.floor((rate * 60) / 180));
  const maxLag = Math.ceil((rate * 60) / 70);
  let bestLag = 0, bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < n; i++) sum += onset[i] * onset[i - lag];
    // Prefer tempos near 120 BPM when a half or double tempo scores the same.
    const bpm = (rate * 60) / lag;
    const score = (sum / (n - lag)) * Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (!bestLag || bestScore <= 0) return [];
  let phase = 0, phaseScore = -1;
  for (let ph = 0; ph < bestLag; ph++) {
    let sum = 0;
    for (let i = ph; i < n; i += bestLag) sum += onset[i];
    if (sum > phaseScore) {
      phaseScore = sum;
      phase = ph;
    }
  }
  const reach = Math.max(1, Math.floor(bestLag / 6));
  const beats: number[] = [];
  for (let i = phase; i < n; i += bestLag) {
    let at = i, top = onset[i];
    for (let j = Math.max(0, i - reach); j <= Math.min(n - 1, i + reach); j++) {
      if (onset[j] > top) {
        top = onset[j];
        at = j;
      }
    }
    beats.push(at / rate);
  }
  return beats;
}
