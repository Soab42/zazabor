import { ease, valueAt, type Anim, type Feel } from "./ease";
import { fieldValue, type Layer, type Template, type TextAnimator, type TextLayer } from "./format";
import { resolve } from "./layout";
import { graphemes, wordsOf } from "./textfit";

/**
 * Export's motion blur, sized to the motion: how far anything travels on screen while the
 * shutter is open decides how many moments are averaged (none past one when it's under a
 * pixel, up to BLUR_MAX for fast moves), and the moments fall at a different place in their
 * slice of the shutter each frame, so the few there are don't step in a fixed pattern. The still
 * layers at the bottom (backgrounds, mostly: the costly part) are drawn once, not per moment.
 */

/** Most moments averaged for one frame. */
export const BLUR_MAX = 4;
/** Travel (pixels across the shutter) each moment past the first covers. */
const PIXELS_PER_MOMENT = 4;

/** How far `a` goes between two times: through a few moments, since keys can turn back. */
function travel(a: Anim | undefined, t0: number, t1: number, fallback: number, feel: Feel): number {
  if (!Array.isArray(a) || a.length < 2 || a[0][0] >= t1 || a[a.length - 1][0] <= t0) return 0;
  let sum = 0;
  let prev = valueAt(a, t0, fallback, feel);
  for (let i = 1; i <= 4; i++) {
    const v = valueAt(a, t0 + ((t1 - t0) * i) / 4, fallback, feel);
    sum += Math.abs(v - prev);
    prev = v;
  }
  return sum;
}

/**
 * The most a text animator's units move (as a fraction of their whole move) in a window of
 * `span` seconds: the steepest stretch of their ease, wherever a unit is in it.
 */
function steepest(name: Parameters<typeof ease>[0], duration: number, span: number, feel: Feel): number {
  const d = Math.max(1e-3, duration);
  const w = Math.min(1, span / d);
  let most = 0;
  for (let i = 0; i <= 24; i++) {
    const u = -w + ((1 + w) * i) / 24;
    const clamp = (x: number) => Math.max(0, Math.min(1, x));
    most = Math.max(most, Math.abs(ease(name, clamp(u + w), feel) - ease(name, clamp(u), feel)));
  }
  return most;
}

/** How many units a text animator moves (letters, words or lines of its text), or null when the text isn't known. */
function unitCount(template: Template, l: TextLayer, a: TextAnimator, values?: Record<string, string>): number | null {
  if (!values) return null;
  const text = l.field ? fieldValue(template, values, l.field) : l.text ?? "";
  const n = a.unit === "char" ? graphemes(text).length : a.unit === "word" ? wordsOf(text).length : Math.max(l.lines ?? 3, text.split("\n").length);
  return Math.max(1, n);
}

/**
 * The most any unit of a text animator moves between t0 and t1, as a fraction of its whole move:
 * each unit's own stretch of the ease when the count is known, else the steepest stretch while
 * any might be moving.
 */
function unitsMove(a: TextAnimator, n: number | null, t0: number, t1: number, feel: Feel, exit: boolean): number {
  const d = Math.max(1e-3, a.duration);
  const name = a.ease ?? (exit ? "in" : "out");
  if (n === null) return t1 > a.t && t0 < a.t + d + 2 ? steepest(name, d, t1 - t0, feel) : 0;
  let most = 0;
  for (let k = 0; k < n; k++) {
    const start = a.t + k * a.stagger;
    if (t1 <= start || t0 >= start + d) continue;
    const u = (x: number) => Math.max(0, Math.min(1, (x - start) / d));
    most = Math.max(most, Math.abs(ease(name, u(t1), feel) - ease(name, u(t0), feel)));
  }
  return most;
}

/**
 * The farthest anything in the template travels on a W×H canvas between template times t0 and
 * t1, in pixels: a layer's own move, turn and growth, plus what the groups it's in do. With the
 * clip's `values`, texts' letters and words count only while they're actually on their way.
 */
export function travelPixels(template: Template, t0: number, t1: number, W: number, H: number, feel: Feel = "smooth", values?: Record<string, string>): number {
  const S = Math.min(W, H);
  const walk = (layers: Layer[], carried: number): number => {
    let most = 0;
    for (const l of layers) {
      if (l.time && (t1 < l.time[0] || t0 >= l.time[1])) continue;
      const box = resolve(l.frame, W, H);
      const r = Math.hypot(box.w, box.h) / 2;
      let px = carried
        + Math.hypot(travel(l.dx, t0, t1, 0, feel), travel(l.dy, t0, t1, 0, feel)) * S
        + travel(l.scale, t0, t1, 1, feel) * r
        + ((travel(l.rotate, t0, t1, 0, feel) * Math.PI) / 180) * r
        + ((travel(l.turnY, t0, t1, 0, feel) * Math.PI) / 180) * (box.w / 2);
      if (l.kind === "text") {
        for (const [a, exit] of [[l.animate, false], [l.exit, true]] as const) {
          if (!a) continue;
          const em = l.size * S;
          const f = a.from;
          const unit = a.unit === "char" ? em : r;
          const reach = Math.hypot(f.dx ?? 0, f.dy ?? 0) * em + Math.abs((f.scale ?? 1) - 1) * unit + ((Math.abs(f.rotate ?? 0) * Math.PI) / 180) * unit;
          if (reach > 0) px += reach * unitsMove(a, unitCount(template, l, a, values), t0, t1, feel, exit);
        }
      }
      most = Math.max(most, px);
      if (l.kind === "group") most = Math.max(most, walk(l.children, px));
    }
    return most;
  };
  return walk(template.layers, 0);
}

const changes = (a: Anim | undefined, t0: number, t1: number) => Array.isArray(a) && a.length > 1 && a[0][0] < t1 && a[a.length - 1][0] > t0;

/** Kinds that draw alike at every moment of a shutter when nothing about their place changes (a live background drifts far too slowly to blur). */
const STILL_KINDS = new Set<Layer["kind"]>(["background", "rect", "ellipse", "image", "icon", "group"]);

function still(l: Layer, t0: number, t1: number): boolean {
  if (!STILL_KINDS.has(l.kind) || l.shadow?.follow) return false;
  if ([l.dx, l.dy, l.scale, l.rotate, l.turnY, l.reveal?.v, l.sheen?.at].some((a) => changes(a, t0, t1))) return false;
  if (l.kind === "image" && l.trace && (changes(l.trace.draw, t0, t1) || changes(l.trace.fill, t0, t1))) return false;
  if (l.kind === "icon" && changes(l.draw, t0, t1)) return false;
  return l.kind !== "group" || l.children.every((c) => still(c, t0, t1));
}

/**
 * How many of the template's bottom layers stay put between template times t0 and t1: export
 * draws those once per frame and only the layers above them for each moment of the blur.
 */
export function stillBelow(template: Template, t0: number, t1: number): number {
  let n = 0;
  while (n < template.layers.length && still(template.layers[n], t0, t1)) n++;
  return n;
}

/** Moments to average for a frame whose fastest thing travels `px` pixels across the shutter. */
export function blurMoments(px: number, most = BLUR_MAX): number {
  if (!(px >= 1)) return 1;
  return Math.max(2, Math.min(most, Math.ceil(px / PIXELS_PER_MOMENT)));
}

/** Where in the shutter (−½…½ of it) each of `n` moments falls: one per equal slice, `jitter` (0…1) into it. */
export function blurOffsets(n: number, jitter: number): number[] {
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => (i + jitter) / n - 0.5);
}

/** A frame's jitter: spread evenly across frames (steps of the golden ratio), the same on every export. */
export const frameJitter = (frame: number): number => (((frame * 0.6180339887498949) % 1) + 1) % 1;
