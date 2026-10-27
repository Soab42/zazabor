/**
 * Motion's timing curves: cubic béziers (solved the way browsers solve CSS's), springs, and the
 * named eases templates use. A Brand Kit's motion feel picks how sharp "out" is and how springy
 * "spring" is. Pure maths, no DOM (tested in tools/motion.test.ts).
 */

export type Feel = "snappy" | "smooth" | "playful";
export const FEELS: readonly Feel[] = ["snappy", "smooth", "playful"];

/** A cubic bézier from (0,0) to (1,1) through (x1,y1) and (x2,y2), as CSS's `cubic-bezier()`. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number) => {
    // Newton first; bisection when the slope is too flat to trust.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-7) return t;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : sy(solve(x)));
}

/**
 * A spring's step response from 0 to 1 over the segment, for damping ratio `zeta` (< 1
 * overshoots) and `bounces` oscillation cycles across it. Ends exactly at 1.
 */
export function spring(zeta: number, bounces: number): (u: number) => number {
  const z = Math.max(0.05, Math.min(1, zeta));
  // ω so the motion has settled to ~0.1% by u = 1.
  const omega = Math.max(4, Math.log(1000) / z, bounces * 2 * Math.PI / Math.sqrt(Math.max(1e-6, 1 - z * z)));
  const wd = omega * Math.sqrt(Math.max(1e-9, 1 - z * z));
  const raw = (u: number) => {
    if (z >= 0.999) return 1 - Math.exp(-omega * u) * (1 + omega * u);
    return 1 - Math.exp(-z * omega * u) * (Math.cos(wd * u) + ((z * omega) / wd) * Math.sin(wd * u));
  };
  const end = raw(1);
  return (u: number) => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    // The last bit of residual motion fades into exactly 1.
    const v = raw(u);
    const tail = Math.max(0, (u - 0.85) / 0.15);
    return v + (1 - end) * tail * tail;
  };
}

const CURVES: Record<Feel, { out: (u: number) => number; spring: (u: number) => number }> = {
  // Expressive ease-out (the design rules' default), quick springs that barely overshoot.
  snappy: { out: bezier(0.16, 1, 0.3, 1), spring: spring(0.82, 1) },
  smooth: { out: bezier(0.22, 1, 0.36, 1), spring: spring(0.9, 1) },
  playful: { out: bezier(0.34, 1.32, 0.64, 1), spring: spring(0.48, 2) },
};

const IN = bezier(0.7, 0, 0.84, 0);
const IN_OUT = bezier(0.65, 0, 0.35, 1);
const BACK = bezier(0.34, 1.56, 0.64, 1);

/**
 * The ease names a template's keyframes use: "out" (entrances), "in" (exits), "inOut" (moves
 * between two places), "linear" (loops only), "spring" and "back" (pops and settles), "hold"
 * (jumps at the next key). Anything else is linear.
 */
export type EaseName = "out" | "in" | "inOut" | "linear" | "spring" | "back" | "hold";

export function ease(name: EaseName | undefined, u: number, feel: Feel = "smooth"): number {
  const x = Math.max(0, Math.min(1, u));
  switch (name) {
    case "hold": return 0;
    case "in": return IN(x);
    case "inOut": return IN_OUT(x);
    case "spring": return CURVES[feel].spring(x);
    case "back": return feel === "snappy" ? CURVES.snappy.out(x) : BACK(x);
    case "linear": return x;
    default: return CURVES[feel].out(x);
  }
}

/** A keyframe: at template time `t` the value is `v`; `e` eases from it to the next. */
export type Key = [t: number, v: number, e?: EaseName];

/** A number, or keyframes for one. */
export type Anim = number | Key[];

/** An animated value at template time `t` (before the first key, the first value; after the last, the last). */
export function valueAt(a: Anim | undefined, t: number, fallback: number, feel: Feel = "smooth"): number {
  if (a === undefined) return fallback;
  if (typeof a === "number") return a;
  if (!a.length) return fallback;
  if (t <= a[0][0]) return a[0][1];
  const last = a[a.length - 1];
  if (t >= last[0]) return last[1];
  let i = 0;
  while (i < a.length - 2 && a[i + 1][0] <= t) i++;
  const [t0, v0, e] = a[i];
  const [t1, v1] = a[i + 1];
  return v0 + (v1 - v0) * ease(e, (t - t0) / Math.max(1e-9, t1 - t0), feel);
}

/** When an animated value starts and stops changing (null for a constant). */
export function animSpan(a: Anim | undefined): [number, number] | null {
  if (a === undefined || typeof a === "number" || a.length < 2) return null;
  return [a[0][0], a[a.length - 1][0]];
}

/**
 * Staggered start of unit `i` of `n` (letters, words, lines, cards): units start `step` apart, in
 * reading order or, with `reverse`, last first (exits).
 */
export function staggerStart(t0: number, i: number, n: number, step: number, reverse = false): number {
  return t0 + (reverse ? n - 1 - i : i) * step;
}
