/**
 * Where a template's layers go in each shape, and how a template's own timeline maps onto a clip
 * that's longer or shorter than it was designed. Pure (tested in tools/motion.test.ts).
 */

export type Shape = "9:16" | "16:9" | "1:1" | "4:5";
export const SHAPES: readonly Shape[] = ["9:16", "16:9", "1:1", "4:5"];

/**
 * A layer's box. `x`, `y`: where its anchor point sits, as fractions of the canvas's width and
 * height. `w`, `h`: its size as fractions of the canvas's shorter side (so a square stays square
 * in every shape); `w: "full"`/`h: "full"` fill that direction. `ax`, `ay`: the anchor inside the
 * box (0 left/top, 0.5 centre, 1 right/bottom).
 */
export interface Frame {
  x: number;
  y: number;
  w: number | "full";
  h: number | "full";
  ax?: number;
  ay?: number;
}

/** A frame, with changes for some shapes (merged over it). */
export interface Responsive extends Frame {
  at?: Partial<Record<Shape, Partial<Frame>>>;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function shapeOf(width: number, height: number): Shape {
  const r = width / height;
  const best = SHAPES.map((s) => {
    const [a, b] = s.split(":").map(Number);
    return [s, Math.abs(Math.log(r / (a / b)))] as const;
  }).sort((p, q) => p[1] - q[1])[0];
  return best[0];
}

/** The frame for a shape: the base with that shape's changes. */
export function frameFor(r: Responsive, shape: Shape): Frame {
  const o = r.at?.[shape];
  return o ? { x: o.x ?? r.x, y: o.y ?? r.y, w: o.w ?? r.w, h: o.h ?? r.h, ax: o.ax ?? r.ax, ay: o.ay ?? r.ay } : r;
}

/** A frame in pixels on a W×H canvas. */
export function resolve(r: Responsive, W: number, H: number): Box {
  const f = frameFor(r, shapeOf(W, H));
  const S = Math.min(W, H);
  const w = f.w === "full" ? W : f.w * S;
  const h = f.h === "full" ? H : f.h * S;
  const ax = f.ax ?? 0.5, ay = f.ay ?? 0.5;
  return { x: f.x * W - w * ax, y: f.y * H - h * ay, w, h };
}

/**
 * Where text and important pictures may go so the platform's own buttons and captions don't
 * cover them: Reels/TikTok's top and bottom bars in 9:16, a small margin elsewhere.
 */
export function safeArea(W: number, H: number): Box {
  const shape = shapeOf(W, H);
  const m = Math.min(W, H) * 0.05;
  if (shape === "9:16") return { x: W * 0.06, y: H * 0.1, w: W * 0.82, h: H * 0.68 };
  return { x: m, y: m, w: W - 2 * m, h: H - 2 * m };
}

export const inside = (inner: Box, outer: Box, slack = 0.5) =>
  inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;

/**
 * Template time for `local` seconds into a clip `span` seconds long. The entrance (until
 * `hold[0]`) and the exit (from `hold[1]`) keep their timing; the hold between them stretches or
 * shrinks. Shorter than entrance and exit together, everything is scaled.
 */
export function templateTime(local: number, span: number, length: number, hold: [number, number]): number {
  const [h0, h1] = hold;
  const exit = length - h1;
  const t = Math.max(0, Math.min(span, local));
  if (Math.abs(span - length) < 1e-6) return t;
  if (span < h0 + exit + 0.05) return (t / Math.max(1e-6, span)) * length;
  if (t <= h0) return t;
  if (t >= span - exit) return h1 + (t - (span - exit));
  return h0 + ((t - h0) / Math.max(1e-6, span - exit - h0)) * (h1 - h0);
}

/** The reverse of `templateTime`: how far into a `span`-long clip template time `tt` comes. */
export function clipTimeAt(tt: number, span: number, length: number, hold: [number, number]): number {
  const [h0, h1] = hold;
  const exit = length - h1;
  const t = Math.max(0, Math.min(length, tt));
  if (Math.abs(span - length) < 1e-6) return t;
  if (span < h0 + exit + 0.05) return (t / Math.max(1e-6, length)) * span;
  if (t <= h0) return t;
  if (t >= h1) return span - exit + (t - h1);
  return h0 + ((t - h0) / Math.max(1e-6, h1 - h0)) * (span - exit - h0);
}
