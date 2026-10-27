import type { Key } from "../ease";
import type { Frame, Responsive, Shape } from "../layout";

/**
 * Helpers for writing templates: frames per shape, common timing patterns and shapes. Every
 * template follows docs/plans/motion-templates.md §4 (entrances 400–700 ms, exits about 60% of
 * that, expressive ease-out by default, springs for pops, staggers 18–35 ms per letter, 60–90 ms
 * per word, 90–160 ms per card).
 */

/** Canvas size of each shape in short sides. */
export const DIMS: Record<Shape, { w: number; h: number }> = {
  "9:16": { w: 1, h: 16 / 9 },
  "16:9": { w: 16 / 9, h: 1 },
  "1:1": { w: 1, h: 1 },
  "4:5": { w: 1, h: 1.25 },
};

export const frame = (x: number, y: number, w: number | "full", h: number | "full", ax = 0.5, ay = 0.5): Frame => ({ x, y, w, h, ax, ay });

/** A frame per shape (the 9:16 one is the base). */
export function per(f: Record<Shape, Frame>): Responsive {
  return { ...f["9:16"], at: { "16:9": f["16:9"], "1:1": f["1:1"], "4:5": f["4:5"] } };
}

/** The whole canvas. */
export const FULL: Responsive = { x: 0.5, y: 0.5, w: "full", h: "full" };

/**
 * A box placed relative to another box (centre `cx`,`cy` as canvas fractions) by an offset in
 * short sides, as a frame for `shape`.
 */
export function offset(shape: Shape, cx: number, cy: number, dx: number, dy: number, w: number, h: number, ax = 0.5, ay = 0.5): Frame {
  const d = DIMS[shape];
  return frame(cx + dx / d.w, cy + dy / d.h, w, h, ax, ay);
}

/** Opacity: in at `t0` over `din`, out at `t1` over `dout`. */
export function showHide(t0: number, din: number, t1: number, dout: number, peak = 1): Key[] {
  return [[t0, 0, "out"], [t0 + din, peak], [t1, peak, "in"], [t1 + dout, 0]];
}

/** A value that moves from `a` to `b` between two times (and back to `c` later, if given). */
export function move(t0: number, a: number, t1: number, b: number, ease: Key[2] = "out", later?: [number, number, number, Key[2]?]): Key[] {
  const keys: Key[] = [[t0, a, ease], [t1, b]];
  if (later) {
    keys[1] = [t1, b];
    keys.push([later[0], b, later[3] ?? "in"], [later[1], later[2]]);
  }
  return keys;
}

/** An n-pointed starburst in a 100 × 100 box. */
export function starburst(points: number, inner = 0.78): string {
  let d = "";
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 50 : 50 * inner;
    d += `${i ? "L" : "M"}${(50 + Math.cos(a) * r).toFixed(2)} ${(50 + Math.sin(a) * r).toFixed(2)}`;
  }
  return `${d}Z`;
}

/** A circle in a 100 × 100 box, starting at the top and going clockwise (for line drawing). */
export const RING = "M50 3A47 47 0 1 1 49.99 3";

/** A diamond inside it. */
export const DIAMOND = "M50 22L78 50L50 78L22 50Z";

/** A frame worked out for each shape. */
export function across(fn: (shape: Shape, d: { w: number; h: number }) => Frame): Responsive {
  return per({ "9:16": fn("9:16", DIMS["9:16"]), "16:9": fn("16:9", DIMS["16:9"]), "1:1": fn("1:1", DIMS["1:1"]), "4:5": fn("4:5", DIMS["4:5"]) });
}

export const ALL_SHAPES: Shape[] = ["9:16", "16:9", "1:1", "4:5"];

/** Scale that pops in on a spring at `t0` (from `from`), and shrinks away at `t1` when given. */
export function pop(t0: number, from = 0.6, din = 0.55, t1?: number, to = 0.92, dout = 0.32): Key[] {
  const keys: Key[] = [[t0, from, "spring"], [t0 + din, 1]];
  if (t1 !== undefined) keys.push([t1, 1, "in"], [t1 + dout, to]);
  return keys;
}
