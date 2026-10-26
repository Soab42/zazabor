/**
 * Tone maps behind Photo's per-channel adjustment layers (Levels, Curves, Exposure, Posterize,
 * Gradient Map), as plain maths with no imports, so `tools/photo-tone.test.mjs` can check them in
 * Node. The compositing shader works Levels, Curves (from `curveSpline`), Exposure and Posterize
 * out the same way per pixel; only Gradient Map, a straight blend, goes through a lookup table of
 * `LUT_SIZE` entries that the GPU interpolates as `lutSample` does.
 */

/** One channel of Levels, in Photoshop's units: 0–255 points and a midtone gamma (0.1–9.99). */
export interface LevelsChannel {
  inBlack: number;
  inWhite: number;
  gamma: number;
  outBlack: number;
  outWhite: number;
}

export const LEVELS_IDENTITY: LevelsChannel = { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };

/** A curve's points, 0–255 in and out, sorted by input; the first and last stay the ends. */
export type CurvePoints = [number, number][];

export const CURVE_IDENTITY: CurvePoints = [[0, 0], [255, 255]];

export const LUT_SIZE = 1024;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Levels on a value from 0 to 1: input range to 0–1, the gamma, then the output range. */
export function levelsValue(l: LevelsChannel, v: number): number {
  const lo = l.inBlack / 255;
  const hi = l.inWhite / 255;
  let t = hi > lo ? clamp01((v - lo) / (hi - lo)) : v >= lo ? 1 : 0;
  t = Math.pow(t, 1 / Math.max(0.01, l.gamma));
  return clamp01((l.outBlack + (l.outWhite - l.outBlack) * t) / 255);
}

/** A natural cubic spline through a curve's points: knots (0–1) and second derivatives. */
export interface Spline {
  xs: number[];
  ys: number[];
  ms: number[];
}

/**
 * The spline through `points`, as in Photoshop: natural (it may overshoot between points; the
 * result is clamped), flat before the first point and after the last. Points on the same input
 * keep the last one.
 */
export function curveSpline(points: CurvePoints): Spline {
  const pts = [...points].sort((a, b) => a[0] - b[0]).map(([x, y]) => [x / 255, y / 255] as [number, number]);
  const xs: number[] = [], ys: number[] = [];
  for (const [x, y] of pts) {
    if (xs.length && Math.abs(x - xs[xs.length - 1]) < 1e-6) ys[ys.length - 1] = y;
    else (xs.push(x), ys.push(y));
  }
  const n = xs.length;
  // Second derivatives (zero at both ends), by the tridiagonal algorithm.
  const ms = new Array<number>(n).fill(0);
  if (n > 2) {
    const u = new Array<number>(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const sig = (xs[i] - xs[i - 1]) / (xs[i + 1] - xs[i - 1]);
      const p = sig * ms[i - 1] + 2;
      ms[i] = (sig - 1) / p;
      const d = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) - (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]);
      u[i] = ((6 * d) / (xs[i + 1] - xs[i - 1]) - sig * u[i - 1]) / p;
    }
    ms[n - 1] = 0;
    for (let k = n - 2; k >= 0; k--) ms[k] = ms[k] * ms[k + 1] + u[k];
  }
  return { xs, ys, ms };
}

/** A spline's value at `v` (0–1), as the GPU works it out. */
export function splineValue(s: Spline, v: number): number {
  const { xs, ys, ms } = s;
  const n = xs.length;
  if (n === 0) return clamp01(v);
  if (v <= xs[0]) return clamp01(ys[0]);
  if (v >= xs[n - 1]) return clamp01(ys[n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] > v) hi = mid;
    else lo = mid;
  }
  const hgt = xs[hi] - xs[lo];
  const a = (xs[hi] - v) / hgt, b = (v - xs[lo]) / hgt;
  return clamp01(a * ys[lo] + b * ys[hi] + ((a * a * a - a) * ms[lo] + (b * b * b - b) * ms[hi]) * (hgt * hgt) / 6);
}

/** A curve through `points` as a function from 0–1 to 0–1. */
export function curveFunction(points: CurvePoints): (v: number) => number {
  const s = curveSpline(points);
  return (v: number) => splineValue(s, v);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Photoshop's Exposure adjustment: stops and offset in linear light, then a gamma correction. */
export function exposureValue(stops: number, offset: number, gamma: number, v: number): number {
  const lin = Math.max(0, toLinear(clamp01(v)) * Math.pow(2, stops) + offset);
  return clamp01(toGamma(clamp01(Math.pow(lin, 1 / Math.max(0.01, gamma)))));
}

/** Posterize to `levels` steps (2–255). */
export function posterizeValue(levels: number, v: number): number {
  const n = Math.max(2, Math.round(levels));
  return Math.min(n - 1, Math.floor(clamp01(v) * n)) / (n - 1);
}

type Channel = (v: number) => number;

/** A table of `size` entries per channel: red, green and blue maps, alpha 1. */
export function buildLut(r: Channel, g: Channel, b: Channel, size = LUT_SIZE): Float32Array {
  const out = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const v = i / (size - 1);
    out[i * 4] = r(v);
    out[i * 4 + 1] = g(v);
    out[i * 4 + 2] = b(v);
    out[i * 4 + 3] = 1;
  }
  return out;
}

/** A colour table indexed by brightness (Gradient Map): `colors` are 0–1 RGB stops spread evenly. */
export function buildGradientLut(colors: [number, number, number][], size = LUT_SIZE): Float32Array {
  const out = new Float32Array(size * 4);
  const last = colors.length - 1;
  for (let i = 0; i < size; i++) {
    const t = (i / (size - 1)) * last;
    const k = Math.min(last - 1, Math.floor(t));
    const f = last ? t - k : 0;
    const a = colors[Math.max(0, k)], b = colors[Math.min(last, k + 1)];
    for (let c = 0; c < 3; c++) out[i * 4 + c] = a[c] + (b[c] - a[c]) * f;
    out[i * 4 + 3] = 1;
  }
  return out;
}

/** What the shader reads from a table for channel `ch` (0–2) at `v`: linear between entries. */
export function lutSample(lut: Float32Array, ch: number, v: number, size = LUT_SIZE): number {
  const x = clamp01(v) * (size - 1);
  const i = Math.floor(x);
  const j = Math.min(i + 1, size - 1);
  const f = x - i;
  return lut[i * 4 + ch] + (lut[j * 4 + ch] - lut[i * 4 + ch]) * f;
}
