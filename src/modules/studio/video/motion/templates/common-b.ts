import type { Anim, EaseName, Key } from "../ease";
import type { BackgroundLayer, BackgroundPreset, Layer, Paint, PathLayer, TextAnimator, TextLayer } from "../format";
import type { Responsive, Shape } from "../layout";
import { frame, per } from "./build";

/**
 * Shorthands for the second collection of templates (logos, titles, hooks, fashion, food, real
 * estate, festive): frames written as tuples per shape, the text entrances and exits §4 of the
 * plan asks for, and small vector drawings (garments, dishes, a house, motifs) used as stand-ins
 * where a template's picture slot is empty. Nothing here draws by itself.
 */

/** x, y as canvas fractions; w, h in short sides; anchor. */
export type Spec = [x: number, y: number, w: number | "full", h: number | "full", ax?: number, ay?: number];

/** A frame per shape from tuples. */
export const F = (s: Record<Shape, Spec>): Responsive =>
  per({ "9:16": frame(...s["9:16"]), "16:9": frame(...s["16:9"]), "1:1": frame(...s["1:1"]), "4:5": frame(...s["4:5"]) });

/** One frame in every shape. */
export const ALL = (...s: Spec): Responsive => frame(...s);

// ---- text entrances and exits (§4: 400–700 ms in, ~60% of that out, staggers by unit)

/** Words rise from behind their baseline. */
export const riseWords = (t: number, stagger = 0.07, duration = 0.55): TextAnimator =>
  ({ unit: "word", t, stagger, duration, from: { opacity: 0, dy: 0.95 }, mask: true });
/** Letters rise from behind their baseline. */
export const riseChars = (t: number, stagger = 0.026, duration = 0.5): TextAnimator =>
  ({ unit: "char", t, stagger, duration, from: { opacity: 0, dy: 0.9 }, mask: true });
/** Lines rise from behind their baseline. */
export const riseLines = (t: number, stagger = 0.1, duration = 0.6): TextAnimator =>
  ({ unit: "line", t, stagger, duration, from: { opacity: 0, dy: 0.9 }, mask: true });
/** Words come up out of a soft blur. */
export const blurWords = (t: number, stagger = 0.06, duration = 0.55): TextAnimator =>
  ({ unit: "word", t, stagger, duration, from: { opacity: 0, dy: 0.35, blur: 0.14 } });
/** Letters arrive out of a wide blur, as if focusing. */
export const focusChars = (t: number, stagger = 0.03, duration = 0.6): TextAnimator =>
  ({ unit: "char", t, stagger, duration, from: { opacity: 0, scale: 1.4, blur: 0.25 } });
/** Words pop in on a spring. */
export const popWords = (t: number, stagger = 0.085, duration = 0.45): TextAnimator =>
  ({ unit: "word", t, stagger, duration, from: { opacity: 0, scale: 0.45, dy: 0.2 }, ease: "spring" });
/** Words slide in from the side. */
export const slideWords = (t: number, dx = -0.8, stagger = 0.06, duration = 0.5): TextAnimator =>
  ({ unit: "word", t, stagger, duration, from: { opacity: 0, dx } });
/** The line fades and lifts away. */
export const outLine = (t: number, duration = 0.3): TextAnimator =>
  ({ unit: "line", t, stagger: 0, duration, from: { opacity: 0, dy: -0.4 } });
/** Words sink back behind their baseline, last first. */
export const outWords = (t: number, duration = 0.3): TextAnimator =>
  ({ unit: "word", t, stagger: 0.035, duration, from: { opacity: 0, dy: -0.8 }, mask: true, reverse: true });
/**
 * Legible on frame 0 (rule book §0): the words are already there at 60% and settle into place, so
 * the first frame works as the hook and the thumbnail.
 */
export const settle = (t = 0, stagger = 0.06, duration = 0.6): TextAnimator =>
  ({ unit: "word", t, stagger, duration, from: { opacity: 0.6, dy: 0.15, scale: 0.96 } });
/** The hook's punch on the first beat: 1.00 → 1.08 in about 130 ms, then back. */
export const punch = (t = 0): Key[] => [[t, 1, "out"], [t + 0.13, 1.08], [t + 0.6, 1]];
/** Just fades. */
export const outFade = (t: number, duration = 0.3): TextAnimator => ({ unit: "line", t, stagger: 0, duration, from: { opacity: 0 } });

/** A text layer (body font, theme text colour unless given). */
export function txt(id: string, field: string, fr: Responsive, o: Partial<TextLayer> & { size: number }): TextLayer {
  return { id, kind: "text", field, frame: fr, font: "body", color: "@text", ...o };
}

/** The whole canvas filled. */
export const fill = (id: string, paint: Paint, extra: Partial<Layer> = {}): Layer =>
  ({ id, kind: "rect", frame: { x: 0.5, y: 0.5, w: "full", h: "full" }, fill: paint, ...extra } as Layer);

/** Opacity keys: in at t0 (over din), out at t1 (over dout). */
export const vis = (t0: number, din: number, t1: number, dout: number, peak = 1): Key[] => [[t0, 0, "out"], [t0 + din, peak], [t1, peak, "in"], [t1 + dout, 0]];

/** A line drawing on between two times (and off again later, when given). */
export const drawOn = (t0: number, t1: number, off?: [number, number]): Key[] =>
  off ? [[t0, 0, "inOut"], [t1, 1], [off[0], 1, "in"], [off[1], 0]] : [[t0, 0, "inOut"], [t1, 1]];

/** Values that jump between steps (glitches, flickers): `[time, value]` pairs held until the next. */
export const steps = (pairs: [number, number][]): Key[] => pairs.map(([t, v]) => [t, v, "hold" as EaseName]);

/** A pseudo-random number for index `i` (the same every time, so templates look the same everywhere). */
export function rnd(i: number, salt = 1): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** A stroked line-art path layer that draws itself on. */
export function line(id: string, d: string, fr: Responsive, stroke: Paint, draw: Key[] | number, width = 0.005, extra: Partial<PathLayer> = {}): PathLayer {
  return { id, kind: "path", frame: fr, d, stroke, strokeWidth: width, draw, ...extra };
}

// ---- small vector drawings (in a 100 × 100 box unless noted)

/** A dress on a hanger. */
export const DRESS = "M50 6c-4 0-6 3-6 6M44 12c2 2 10 2 12 0M38 22c4-6 20-6 24 0l-4 18 20 52H22l20-52z";
/** A t-shirt. */
export const SHIRT = "M34 14l-22 12 8 18 10-5v51h40V39l10 5 8-18-22-12c-2 7-8 11-16 11s-14-4-16-11z";
/** A handbag. */
export const BAG = "M30 36c0-20 40-20 40 0h-6c0-12-28-12-28 0zM18 36h64l-6 52H24z";
/** Trousers. */
export const PANTS = "M30 8h40l6 84H58L50 34l-8 58H24z";
/** A plate seen from above: rim and well. */
export const PLATE_RIM = "M50 4a46 46 0 1 1-.01 0zM50 18a32 32 0 1 1-.01 0z";
/** A burger. */
export const BURGER_TOP = "M14 50c0-22 18-34 36-34s36 12 36 34z";
export const BURGER_MID = "M10 56h80v8H10z";
export const BURGER_BOTTOM = "M14 70h72c0 10-8 16-18 16H32c-10 0-18-6-18-16z";
/** A bowl. */
export const BOWL = "M8 46h84c0 24-18 40-42 40S8 70 8 46z";
/** A leaf (garnish). */
export const LEAF = "M10 90C10 40 40 10 90 10 90 60 60 90 10 90zM10 90L70 30";
/** A steaming cup's steam. */
export const STEAM = "M35 60c-8-10 8-16 0-26M50 60c-8-10 8-16 0-26M65 60c-8-10 8-16 0-26";
/** A house: body, roof and door. */
export const HOUSE = "M14 46L50 16l36 30M22 40v46h56V40M42 86V62h16v24";
export const HOUSE_FILL = "M22 42L50 19l28 23v44H22z";
/** A map pin. */
export const PIN = "M50 96C50 96 18 60 18 38a32 32 0 0 1 64 0c0 22-32 58-32 58z";
/** A person's head and shoulders (portrait stand-in). */
export const PERSON = "M50 18a16 16 0 1 1-.01 0zM18 92c2-22 16-34 32-34s30 12 32 34z";
/** A crescent moon. */
export const CRESCENT = "M62 8A44 44 0 1 0 92 66 34 34 0 1 1 62 8z";
/** A five-pointed star. */
export const STAR5 = "M50 6l12 30 32 2-25 20 9 32-28-18-28 18 9-32L6 38l32-2z";
/** A hanging lantern (in a 60 × 100 box). */
export const LANTERN = "M30 0v14M18 14h24l6 10H12zM12 24h36l6 40c0 10-12 18-24 18S6 74 6 64zM24 82h12v10H24z";
/** An oil lamp (diya) bowl, in a 100 × 60 box. */
export const DIYA = "M4 20h92c0 22-20 36-46 36S4 42 4 20zM40 20c4-6 16-6 20 0";
/** A flame, in a 40 × 60 box. */
export const FLAME = "M20 2C30 18 38 28 38 40a18 18 0 0 1-36 0C2 28 10 18 20 2z";
/** A chevron pointing up. */
export const CHEVRON = "M20 64L50 34l30 30";
/** A bell. */
export const BELL = "M24 70V46a26 26 0 0 1 52 0v24l8 8H16zM42 86a8 8 0 0 0 16 0";
/** A cursor arrow (in a 60 × 80 box). */
export const CURSOR = "M6 4v62l16-14 12 26 12-6-12-25h22z";
/** A bed, a bath and a floor area (line icons for property details). */
export const BED = "M10 72V34M10 58h80v14M90 72V58M22 58V48c0-4 2-6 6-6h18c4 0 6 2 6 6v10";
export const BATH = "M10 50h80v10a20 20 0 0 1-20 20H30a20 20 0 0 1-20-20zM22 50V26a8 8 0 0 1 16 0M30 80l-4 8M70 80l4 8";
export const AREA = "M12 12h26M12 12v26M88 88H62M88 88V62M12 12l76 76";
/** A phone handset and an envelope (contact rows). */
export const PHONE = "M30 10h12l6 18-9 6a46 46 0 0 0 27 27l6-9 18 6v12a8 8 0 0 1-8 8C46 78 22 54 22 18a8 8 0 0 1 8-8z";
export const MAIL = "M10 24h80v52H10zM10 24l40 30 40-30";
/** A kash flower (the white autumn grass of Bengal): a bending stem with a feathery plume. */
export const KASH = "M50 98C50 70 46 44 34 22M34 22c-8-8-6-18 2-20M34 22c-12-4-16-14-12-20M34 22c-2-10 6-18 14-16M36 34c-10-2-16-10-14-16M38 44c-12 0-18-6-18-12M38 34c4-8 12-10 18-6";
/** A bird in flight, seen from below. */
export const BIRD = "M4 40c14-12 28-12 46 4 18-16 32-16 46-4-14-4-30 0-46 16C34 40 18 36 4 40z";
/** A scooter. */
export const SCOOTER = "M20 74a12 12 0 1 0 .01 0zM80 74a12 12 0 1 0 .01 0zM20 74h22l10-26h22l6 26M58 48l-6-18h12M30 52h16";

/** Petals around a centre: `n` petals of length `r` (alpona and marigold rings). */
export function petals(n: number, r = 44, inner = 14, width = 12): string {
  let d = "";
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const c = Math.cos(a), s = Math.sin(a);
    const px = -s, py = c;
    const x0 = 50 + c * inner, y0 = 50 + s * inner;
    const x1 = 50 + c * r, y1 = 50 + s * r;
    const mx = 50 + c * (inner + r) / 2, my = 50 + s * (inner + r) / 2;
    d += `M${x0.toFixed(2)} ${y0.toFixed(2)}Q${(mx + px * width).toFixed(2)} ${(my + py * width).toFixed(2)} ${x1.toFixed(2)} ${y1.toFixed(2)}`
      + `Q${(mx - px * width).toFixed(2)} ${(my - py * width).toFixed(2)} ${x0.toFixed(2)} ${y0.toFixed(2)}`;
  }
  return d;
}

/** A ring of dots (alpona borders, garlands): `n` small circles on a circle of radius `r`. */
export function dotRing(n: number, r = 46, dot = 2.4): string {
  let d = "";
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = 50 + Math.cos(a) * r, y = 50 + Math.sin(a) * r;
    d += `M${(x + dot).toFixed(2)} ${y.toFixed(2)}a${dot} ${dot} 0 1 0 ${(-2 * dot).toFixed(2)} 0a${dot} ${dot} 0 1 0 ${(2 * dot).toFixed(2)} 0`;
  }
  return d;
}

/** A circle (for line drawing), radius `r` in a 100 × 100 box. */
export const circle = (r: number) => `M50 ${50 - r}A${r} ${r} 0 1 1 49.99 ${50 - r}`;

/** A value that pulses from `lo` up to `hi` and back every `period` seconds between `t0` and `t1` (`phase` shifts it). */
export function pulse(t0: number, t1: number, period: number, lo: number, hi: number, phase = 0): Key[] {
  const keys: Key[] = [[t0, lo, "inOut"]];
  for (let t = t0 + phase; t + period <= t1; t += period) {
    if (t > t0) keys.push([t, lo, "inOut"]);
    keys.push([t + period / 2, hi, "inOut"]);
    keys.push([t + period, lo, "inOut"]);
  }
  return keys;
}

/** A soft dark pool behind text, so it reads at the background's brightest moment. */
export const scrim = (id: string, fr: Responsive, amount = 0.6, color = "@bg"): Layer =>
  ({ id, kind: "ellipse", frame: fr, fill: { kind: "radial", stops: [[0, `${color}/${amount}`], [1, `${color}/0`]] } });

/**
 * Two live backgrounds for depth: a `base` preset filling the frame and an `over` preset drawn
 * over it with transparency, both in the Brand Kit's colours unless given. They brighten up over
 * the entrance and never stand still; the layer over moves faster than the base, for parallax.
 */
export function backdrop(base: BackgroundPreset, over: BackgroundPreset, o: {
  colors?: string[]; overColors?: string[]; intensity?: number; overIntensity?: number; speed?: Anim; overSpeed?: Anim;
  seed?: number; grain?: number; vignette?: number; drift?: number; soft?: number; overSoft?: number;
} = {}): BackgroundLayer[] {
  const full = { x: 0.5, y: 0.5, w: "full" as const, h: "full" as const };
  const i0 = o.intensity ?? 0.85, i1 = o.overIntensity ?? 0.7;
  // The rule book's parallax: the base on 12–20 s cycles, light layers 1.5–2× and particles 2–4× as fast.
  const speed = o.speed ?? 0.8;
  const overSpeed = o.overSpeed ?? (typeof speed === "number" ? speed * (over === "drift" ? 3 : 1.75) : 1.4);
  /** Only the options given (a template stays the same after a save and load). */
  const given = <T extends object>(v: T) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as Partial<T>;
  return [
    {
      id: "bg", kind: "background", preset: base, frame: full, speed, intensity: [[0, i0 * 0.55, "out"], [1.6, i0]], vignette: o.vignette ?? 0.45,
      ...given({ colors: o.colors, seed: o.seed, grain: o.grain, drift: o.drift, soft: o.soft }),
    },
    {
      id: "bg-over", kind: "background", preset: over, frame: full, over: true, speed: overSpeed, seed: (o.seed ?? 0) + 7,
      intensity: [[0, 0, "out"], [1.8, i1]], grain: 0, vignette: 0, ...given({ colors: o.overColors, soft: o.overSoft }),
    },
  ];
}
