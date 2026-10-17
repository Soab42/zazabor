import type { Framing } from "./settings";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Ken Burns motion for one slide, interpolated from `from` to `to` over its time on screen.
 *
 * - `fill`: the rects are the visible crop of the image, in normalized image coordinates.
 * - `fit`: the rects place the whole image inside the frame (normalized frame coordinates),
 *   over a blurred backdrop cropped by `backFrom`/`backTo` (normalized image coordinates).
 */
export interface Motion {
  mode: "fill" | "fit";
  from: Rect;
  to: Rect;
  backFrom: Rect;
  backTo: Rect;
}

/** Deterministic PRNG so a slide keeps its motion when the plan is recomputed. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A w×h rect centered near (cx, cy), pushed back inside the unit square. */
function rectAround(cx: number, cy: number, w: number, h: number): Rect {
  return { x: Math.min(1 - w, Math.max(0, cx - w / 2)), y: Math.min(1 - h, Math.max(0, cy - h / 2)), w, h };
}

/** The largest crop of the image with the frame's aspect ratio. */
function coverCrop(ratio: number) {
  return ratio >= 1 ? { w: 1 / ratio, h: 1 } : { w: 1, h: ratio };
}

/** Image aspect over frame aspect beyond which a photo is panned across rather than zoomed. */
const SMART_CROP_LIMIT = 1.4;
/** Panoramas up to this many frames wide are panned across rather than fitted. */
const PANORAMA_LIMIT = 3.2;
/** Photos at least this wide for their height count as landscape. */
const LANDSCAPE_ASPECT = 1.1;

export function planMotion(imageAspect: number, frameAspect: number, framing: Framing, strength: number, seed: number): Motion {
  const random = mulberry32(seed);
  const ratio = imageAspect / frameAspect;
  const s = clamp01(strength);
  const landscape = imageAspect >= LANDSCAPE_ASPECT;
  // Landscape photos always fill the full width, even inside a wide letterbox; only portraits
  // and extreme panoramas are shown whole over a blurred backdrop.
  const fit = framing === "fit" ||
    (framing === "smart" && (ratio > PANORAMA_LIMIT || (!landscape && ratio < 1 / SMART_CROP_LIMIT)));
  if (fit) return planFit(ratio, s, random);

  const base = coverCrop(ratio);
  const elongated = ratio > SMART_CROP_LIMIT || (!landscape && ratio < 1 / SMART_CROP_LIMIT);
  if (elongated) {
    // Pan along the long axis of a panorama (or a tall photo with "fill" framing).
    const travel = clamp01(s * 1.6);
    const horizontal = ratio > 1;
    const slack = horizontal ? 1 - base.w : 1 - base.h;
    // Tall photos tend to have their subject near the top, so mostly tilt up toward it.
    const forward = horizontal ? random() < 0.5 : random() < 0.4;
    const a = slack / 2 - (travel * slack) / 2;
    const b = slack / 2 + (travel * slack) / 2;
    const [p0, p1] = forward ? [a, b] : [b, a];
    const at = (p: number): Rect => (horizontal ? { x: p, y: 0, w: base.w, h: 1 } : { x: 0, y: p, w: 1, h: base.h });
    return { mode: "fill", from: at(p0), to: at(p1), backFrom: at(p0), backTo: at(p1) };
  }

  const zoomIn = random() < 0.6;
  const small = 1 + 0.03 * Math.min(1, s * 4);
  // When the frame already crops a lot of the photo (e.g. 3:2 in a 2.39:1 letterbox), zoom less.
  const alreadyCropped = Math.min(base.w, base.h) < 0.75;
  const big = small + 0.27 * s * (alreadyCropped ? 0.55 : 1);
  const [z0, z1] = zoomIn ? [small, big] : [big, small];
  // Aim near the upper-middle third, where subjects usually are, drifting slightly across it.
  const focusX = 0.5 + (random() - 0.5) * 0.36;
  const focusY = 0.44 + (random() - 0.5) * 0.24;
  const angle = random() * Math.PI * 2;
  const drift = 0.07 * s;
  const from = rectAround(focusX - Math.cos(angle) * drift, focusY - Math.sin(angle) * drift, base.w / z0, base.h / z0);
  const to = rectAround(focusX + Math.cos(angle) * drift, focusY + Math.sin(angle) * drift, base.w / z1, base.h / z1);
  return { mode: "fill", from, to, backFrom: from, backTo: to };
}

function planFit(ratio: number, s: number, random: () => number): Motion {
  // Size the photo to leave a margin of backdrop around it.
  const margin = 0.9;
  const w = ratio >= 1 ? margin : margin * ratio;
  const h = ratio >= 1 ? margin / ratio : margin;
  const push = 1 + 0.07 * s;
  const zoomIn = random() < 0.7;
  const [k0, k1] = zoomIn ? [1, push] : [push, 1];
  const place = (k: number): Rect => ({ x: 0.5 - (w * k) / 2, y: 0.5 - (h * k) / 2, w: w * k, h: h * k });
  const base = coverCrop(ratio);
  const back = (z: number) => rectAround(0.5, 0.5, base.w / z, base.h / z);
  return { mode: "fit", from: place(k0), to: place(k1), backFrom: back(1.08), backTo: back(1.08 + 0.12 * s) };
}

/** Gentle ease: mostly constant speed (as Ken Burns motion should be) with softened ends. */
export function motionEase(u: number) {
  const t = clamp01(u);
  return t + (t * t * (3 - 2 * t) - t) * 0.5;
}

export function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t };
}

/** Letterbox bar height (fraction of the screen, per side) for a 2.39:1 picture. */
export function letterboxBars(screenAspect: number, enabled: boolean) {
  if (!enabled) return 0;
  return Math.max(0, (1 - screenAspect / 2.39) / 2);
}
