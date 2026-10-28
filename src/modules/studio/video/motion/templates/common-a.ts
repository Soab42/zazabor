import type { Anim, Key } from "../ease";
import type { ArtLayer, BackgroundLayer, BackgroundPreset, GroupLayer, Layer, Paint, RectLayer, Template, TextAnimator, TextLayer } from "../format";
import { frameFor, type Responsive, type Shape } from "../layout";
import { frame, per, pop, showHide, starburst } from "./build";

/**
 * Shorthands for the launch, sale, feature, app and testimonial templates: frames as tuples per
 * shape, the entrances and exits §4 of the plan asks for, and the pieces several of them share
 * (a button, a row of stars, a product stand-in drawn in code). Nothing here draws by itself.
 */

/** x, y as canvas fractions; w, h in short sides; anchor. */
export type Spec = [x: number, y: number, w: number | "full", h: number | "full", ax?: number, ay?: number];

/** A frame per shape from tuples. */
export const at4 = (s: Record<Shape, Spec>): Responsive =>
  per({ "9:16": frame(...s["9:16"]), "16:9": frame(...s["16:9"]), "1:1": frame(...s["1:1"]), "4:5": frame(...s["4:5"]) });

/** One frame worked out per shape from a function. */
export const each = (fn: (shape: Shape) => Spec): Responsive =>
  at4({ "9:16": fn("9:16"), "16:9": fn("16:9"), "1:1": fn("1:1"), "4:5": fn("4:5") });

// ---- text entrances and exits

/** Words rise from behind their baseline. */
export const rise = (t: number, stagger = 0.075, duration = 0.6): TextAnimator =>
  ({ unit: "word", t, stagger, duration, from: { opacity: 0, dy: 0.95 }, mask: true });
/** Letters rise from behind their baseline. */
export const riseLetters = (t: number, stagger = 0.024, duration = 0.5): TextAnimator =>
  ({ unit: "char", t, stagger, duration, from: { opacity: 0, dy: 0.9 }, mask: true });
/** Words come up out of a soft blur. */
export const soft = (t: number, stagger = 0.065, duration = 0.55): TextAnimator =>
  ({ unit: "word", t, stagger, duration, from: { opacity: 0, dy: 0.4, blur: 0.12 } });
/** Letters land from big and blurred, as if focusing. */
export const focus = (t: number, stagger = 0.03, duration = 0.6): TextAnimator =>
  ({ unit: "char", t, stagger, duration, from: { opacity: 0, scale: 1.5, blur: 0.22 } });
/** Words pop on a spring. */
export const bounce = (t: number, stagger = 0.08, duration = 0.5): TextAnimator =>
  ({ unit: "word", t, stagger, duration, from: { opacity: 0, scale: 0.5, dy: 0.25 }, ease: "spring" });
/** The whole line slides in from the side. */
export const slideIn = (t: number, dx = -0.6, duration = 0.5): TextAnimator =>
  ({ unit: "line", t, stagger: 0, duration, from: { opacity: 0, dx } });
/** Lines lift and fade away. */
export const leave = (t: number, duration = 0.3): TextAnimator =>
  ({ unit: "line", t, stagger: 0, duration, from: { opacity: 0, dy: -0.4 } });
/** Words sink behind their baseline, last first. */
export const sink = (t: number, duration = 0.3): TextAnimator =>
  ({ unit: "word", t, stagger: 0.035, duration, from: { opacity: 0, dy: -0.8 }, mask: true, reverse: true });

/** A text layer (body font and the theme's text colour unless given). */
export function words(id: string, field: string, fr: Responsive, o: Partial<TextLayer> & { size: number }): TextLayer {
  return { id, kind: "text", field, frame: fr, font: "body", color: "@text", ...o };
}

// ---- shared pieces

/** A background filling the canvas. */
export const backdrop = (fill: Paint, id = "bg"): RectLayer => ({ id, kind: "rect", frame: { x: 0.5, y: 0.5, w: "full", h: "full" }, fill });

/** A live background filling the canvas (background.ts); `over` ones draw over the layers below. */
export const live = (id: string, preset: BackgroundPreset, o: Partial<BackgroundLayer> = {}): BackgroundLayer =>
  ({ id, kind: "background", preset, frame: { x: 0.5, y: 0.5, w: "full", h: "full" }, ...o });

/** The filmic finish §4 asks for. */
export const grain = (amount = 0.025): Layer => ({ id: "grain", kind: "fx", fx: "grain", frame: { x: 0.5, y: 0.5, w: "full", h: "full" }, amount });

/** A pill button: in on a spring at `t`, out at `exit`. */
export function button(id: string, field: string, fr: Responsive, t: number, exit: number, o: { fill?: Paint; color?: Paint; size?: number; glow?: boolean } = {}): GroupLayer {
  return {
    id, kind: "group", frame: fr, opacity: showHide(t, 0.25, exit, 0.3), scale: pop(t, 0.6, 0.55, exit, 0.85),
    children: [
      { id: `${id}-pill`, kind: "rect", frame: fr, radius: "pill", fill: o.fill ?? "@primary", ...(o.glow === false ? {} : { glow: { color: "@primary/0.55", blur: 0.035 } }) },
      { id: `${id}-text`, kind: "text", field, frame: fr, font: "body", role: "cta", weight: 700, size: Math.max(0.044, o.size ?? 0.044), minSize: 0.044, lines: 1, color: o.color ?? "@onPrimary" },
    ],
  };
}

/** A five-pointed star in a 100 × 100 box. */
export const STAR = starburst(5, 0.45);

/**
 * `n` filled stars in a row inside `fr` (each `size` short sides, `gap` apart), popping one after
 * another from `t`.
 */
export function stars(id: string, n: number, cx: (shape: Shape) => [number, number], size: number, t: number, exit: number, fill: Paint = "@accent"): Layer[] {
  const gap = size * 1.18;
  return Array.from({ length: n }, (_, i): Layer => ({
    id: `${id}${i + 1}`, kind: "path", d: STAR, fill,
    frame: each((shape) => {
      const [x, y] = cx(shape);
      const dims = shape === "16:9" ? 16 / 9 : 1;
      return [x + ((i - (n - 1) / 2) * gap) / dims, y, size, size];
    }),
    opacity: showHide(t + i * 0.09, 0.2, exit, 0.25),
    scale: pop(t + i * 0.09, 0.2, 0.5, exit, 0.6),
    rotate: [[t + i * 0.09, -40, "out"], [t + i * 0.09 + 0.5, 0]],
  }));
}

/** A product drawn in code, shown while the slot `slot` is empty. */
export function standIn(id: string, art: string, slot: string, fr: Responsive, o: Partial<ArtLayer> = {}): ArtLayer {
  return { id, kind: "art", art, frame: fr, ifEmpty: slot, ...o };
}

/** Keys that wobble a value around `base` (an idle sway), from `t0` to `t1`. */
export function sway(t0: number, t1: number, base: number, amount: number, period = 2.4): Key[] {
  const keys: Key[] = [[t0, base, "inOut"]];
  let sign = 1;
  for (let t = t0 + period / 2; t < t1; t += period / 2, sign = -sign) keys.push([t, base + amount * sign, "inOut"]);
  keys.push([t1, base]);
  return keys;
}

// ---- the rule book's whole-template fixes (motion-rulebook.md)

const BAND_TOP = 0.15, BAND_K = 0.74;

/**
 * Fits a 9:16 layout drawn for the old safe area (y 0.1–0.78) into the platforms' strict band
 * (y 0.14–0.65, §4.1): every framed layer's centre moves in proportion, and pictures, devices and
 * shapes shrink with it; text keeps its size. Other shapes are untouched (their frames keep the
 * base; 9:16 gets its own).
 */
export function strict916(t: Template): Template {
  const H = 16 / 9;
  const fit = (l: Layer): Layer => {
    const f = frameFor(l.frame, "9:16");
    let out = l;
    if (f.w !== "full" && f.h !== "full") {
      const ay = f.ay ?? 0.5;
      const cy = f.y - ((ay - 0.5) * f.h) / H;
      const h = l.kind === "text" ? f.h : f.h * BAND_K;
      const w = l.kind === "text" ? f.w : f.w * BAND_K;
      const y = BAND_TOP + (cy - 0.1) * BAND_K + ((ay - 0.5) * h) / H;
      out = { ...l, frame: { ...l.frame, at: { ...l.frame.at, "9:16": { ...f, y, w, h } } } } as Layer;
    }
    return out.kind === "group" ? { ...out, children: out.children.map(fit) } : out;
  };
  return { ...t, layers: t.layers.map(fit) };
}

/** Drops a fade or wipe's start so the value is already at its peak at time 0. */
function fromPeak(a: Anim | undefined): Anim | undefined {
  if (!Array.isArray(a) || a.length < 2) return a;
  const peak = Math.max(...a.map((k) => k[1]));
  const i = a.findIndex((k) => k[1] >= peak - 1e-6);
  return i <= 0 ? a : [[0, a[i][1], a[i][2]] as Key, ...a.slice(i + 1)];
}

/** Starts an entrance move at time 0 instead of later (so nothing sits still before it moves). */
function fromZero(a: Anim | undefined): Anim | undefined {
  if (!Array.isArray(a) || a.length < 2 || a[0][0] <= 0) return a;
  const t0 = a[0][0];
  return [[0, a[0][1], a[0][2]] as Key, [a[1][0] - t0, a[1][1], a[1][2]] as Key, ...a.slice(2)];
}

/**
 * Frame 0 is the hook (§0.1): the named layers (and the groups around them) are already showing
 * at time 0. Moves start at 0 and settle; a text settles from a touch larger instead of fading in.
 */
export function hookAt0(t: Template, ids: string[]): Template {
  const want = new Set(ids);
  const has = (l: Layer): boolean => want.has(l.id) || (l.kind === "group" && l.children.some(has));
  const fix = (l: Layer): Layer => {
    if (!has(l)) return l;
    const o: Layer = { ...l, opacity: fromPeak(l.opacity), scale: fromZero(l.scale), dx: fromZero(l.dx), dy: fromZero(l.dy), rotate: fromZero(l.rotate), turnY: fromZero(l.turnY), blur: fromZero(l.blur) } as Layer;
    if (o.reveal) o.reveal = { ...o.reveal, v: fromPeak(o.reveal.v) ?? 1 };
    for (const k of ["scale", "dx", "dy", "rotate", "turnY", "blur"] as const) if (o[k] === undefined) delete o[k];
    if (o.kind === "text" && want.has(o.id)) o.animate = { unit: "line", t: 0, stagger: 0, duration: 0.7, from: { scale: 1.06, dy: 0.12 } };
    return o.kind === "group" ? { ...o, children: o.children.map(fix) } : o;
  };
  return { ...t, layers: t.layers.map(fix) };
}
