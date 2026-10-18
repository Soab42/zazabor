/** Control points (x1, y1, x2, y2) of a CSS-style cubic-bezier curve. */
export type Curve = [number, number, number, number];

/** A CSS-style cubic-bezier timing function: maps time progress (0–1) to eased progress. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton's method converges in a few steps; bisection covers flat spots.
    let t = x;
    for (let i = 0; i < 6; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return sampleY(t);
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= err / slope;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 20; i++) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-6) break;
      if (value < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

/** Zoom steps: a quick start that settles softly, so each notch responds at once without a jolt. */
export const WHEEL_CURVE: Curve = [0.25, 0.8, 0.3, 1];
/** Deliberate moves (fit, 1:1, double-click): accelerate, then decelerate. */
export const easeMove = cubicBezier(0.4, 0, 0.2, 1);

/**
 * A curve that starts at `slope` (eased progress per unit of time progress) and lands like
 * `curve`, so a move retargeted mid-flight carries on at the speed it already had.
 */
export function easeFrom(slope: number, curve: Curve) {
  // The first control point sets the starting slope; keeping it at or below 1 avoids overshoot.
  const x1 = Math.min(0.25, 1 / slope);
  return cubicBezier(x1, slope * x1, curve[2], curve[3]);
}

/** The slope of an easing function at x, measured numerically. */
export function slopeAt(ease: (x: number) => number, x: number) {
  const a = Math.max(0, x - 1e-3);
  const b = Math.min(1, x + 1e-3);
  return (ease(b) - ease(a)) / (b - a);
}
