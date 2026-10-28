import type { Key } from "../ease";
import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Responsive, Shape } from "../layout";
import { ALL_SHAPES, across, frame } from "./build";
import { DIYA, F, FLAME, KASH, backdrop, outFade, outWords, petals, pulse, riseWords, rnd, scrim, settle, txt, vis } from "./common-b";

/**
 * Sharodiya: autumn greetings for the Puja season. A marigold garland swings in across the top,
 * kash flowers sway at the edges, three clay diyas light one after another with flickering flames,
 * and "শারদীয় শুভেচ্ছা" rises warm in the glow. Bangla first, with English.
 */

const EXIT = 5.8;
const LEN = 6.5;
const CREAM = "@text";
const MARIGOLD = "@secondary";

/** The garland: two swags across the top (100 × 30 box, stretched across the canvas). */
const GARLAND = "M0 2Q25 26 50 2Q75 26 100 2";
const GARLAND_H = 0.3;
/** Flowers on the garland: x along it (canvas fraction), and its height there (0…30). */
const FLOWERS: [number, number][] = [[0.0, 2], [0.125, 10.25], [0.25, 14], [0.375, 10.25], [0.5, 2], [0.625, 10.25], [0.75, 14], [0.875, 10.25], [1.0, 2]];
const flower = (i: number): Layer => {
  const [x, h] = FLOWERS[i];
  return {
    id: `marigold${i + 1}`, kind: "path", d: petals(10, 46, 10, 12), fill: i % 2 ? "#ff7b00" : MARIGOLD, stroke: "#b85c00/0.5", strokeWidth: 0.0015,
    frame: across((_, d) => frame(x, ((h / 30) * GARLAND_H) / d.h, i % 2 ? 0.06 : 0.08, i % 2 ? 0.06 : 0.08)),
    rotate: [[0, i * 20, "linear"], [LEN, i * 20 + (i % 2 ? 30 : -30)]],
  };
};

/** The diyas per shape: their middles (canvas fractions) and size (short sides). */
const DIYAS: Record<Shape, { x: number[]; y: number; s: number }> = {
  "9:16": { x: [0.27, 0.47, 0.67], y: 0.69, s: 0.2 },
  "16:9": { x: [0.36, 0.5, 0.64], y: 0.8, s: 0.21 },
  "1:1": { x: [0.3, 0.5, 0.7], y: 0.79, s: 0.2 },
  "4:5": { x: [0.3, 0.5, 0.7], y: 0.77, s: 0.2 },
};
/** A box at diya `i`: offset `dy` and size `k` in diya sizes, `kh` tall. */
const atDiya = (i: number, dy: number, k: number, kh = k, ay = 0.5): Responsive => across((shape, d) => {
  const g = DIYAS[shape];
  return frame(g.x[i], g.y + (dy * g.s) / d.h, g.s * k, g.s * kh, 0.5, ay);
});

/** Flicker: small random changes every tenth of a second or so. */
const flicker = (i: number, lo: number, hi: number): Key[] => {
  const keys: Key[] = [];
  for (let t = 0, k = 0; t <= LEN; t += 0.09 + rnd(k, i + 40) * 0.08, k++) keys.push([t, lo + rnd(k, i + 50) * (hi - lo), "inOut"]);
  return keys;
};

function diya(i: number): Layer[] {
  const t = 1.2 + i * 0.35, n = i + 1;
  return [
    { id: `diya-glow${n}`, kind: "ellipse", frame: atDiya(i, -0.35, 1.6), fill: { kind: "radial", stops: [[0, "#ffb347/0.45"], [1, "#ffb347/0"]] }, opacity: [[t, 0, "out"], [t + 0.6, 1], ...flicker(i, 0.75, 1).filter(([k]) => k > t + 0.6 && k < EXIT), [EXIT + 0.2, 1, "in"], [EXIT + 0.6, 0]] },
    { id: `diya${n}`, kind: "path", d: DIYA, view: [100, 60], frame: atDiya(i, 0, 1, 0.6), fill: { kind: "linear", angle: 90, stops: [[0, "#c8642a"], [1, "#7a3412"]] }, stroke: "#f2b134/0.6", strokeWidth: 0.0025, opacity: vis(0.6 + i * 0.12, 0.4, EXIT, 0.5), dy: [[0.6 + i * 0.12, 0.05, "out"], [1.2 + i * 0.12, 0]] },
    {
      id: `flame${n}`, kind: "path", d: FLAME, view: [40, 60], frame: atDiya(i, -0.28, 0.16, 0.24, 1), fill: { kind: "linear", angle: 90, stops: [[0, "#fff3b0"], [0.5, "#ffb000"], [1, "#ff5e00"]] },
      glow: { color: "#ffb000/0.8", blur: 0.02 }, scale: [[t, 0, "out"], [t + 0.4, 1], ...flicker(i + 3, 0.88, 1.08).filter(([k]) => k > t + 0.4)], rotate: flicker(i + 6, -5, 5),
      opacity: [[t, 0, "out"], [t + 0.2, 1], [EXIT + 0.1, 1, "in"], [EXIT + 0.5, 0]],
    },
  ];
}

/** A kash flower swaying from its root. */
function kash(id: string, x: number, flip: boolean, k: number, phase: number): Layer {
  const root = across((shape) => frame(x, shape === "9:16" ? 0.82 : 1.0, 0.02, 0.02));
  return {
    id, kind: "group", frame: root, rotate: [[0, flip ? 14 : -14, "out"], [1.4, flip ? 4 : -4], ...pulse(1.4, LEN, 4.2 + phase, flip ? 4 : -4, flip ? -2 : 2).slice(1)],
    opacity: vis(0.3 + phase * 0.3, 0.8, EXIT, 0.6),
    children: [
      { id: `${id}-plume`, kind: "path", d: KASH, frame: across((shape) => frame(x, shape === "9:16" ? 0.82 : 1.0, 0.32 * k, 0.5 * k, 0.5, 1)), stroke: CREAM + "/0.8", strokeWidth: 0.0025, draw: [[0.3 + phase * 0.3, 0, "inOut"], [1.6 + phase * 0.3, 1]] },
    ],
  };
}

/**
 * This template's own look (Puja: sindoor red and marigold.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const pujaGreetingLook: Look = {
  colors: { primary: "#d7263d", secondary: "#f6a21a", accent: "#f6b318", background: "#3a0d0d", text: "#fff3dc" },
  heading: { family: "Fraunces", weight: 700 }, body: { family: "Hind Siliguri", weight: 500 }, bangla: { family: "Galada", weight: 400 },
  radius: 0.6, motion: "smooth", grain: 0.03, grade: { warmth: 0.3 },
  backdrop: ["#ff9933", "#f6b318", "#d7263d", "#2a0707", "#5a1414"],
};

export const pujaGreeting: Template = {
  version: FORMAT_VERSION,
  id: "festive-puja",
  name: "Sharodiya",
  category: "festive",
  description: "Autumn greetings for the Puja season: marigolds, swaying kash flowers and three flickering diyas.",
  tags: ["puja", "durga puja", "শারদীয়", "sharodiya", "festive", "bangladesh", "diya", "greeting", "autumn"],
  length: LEN,
  hold: [2.8, EXIT],
  shapes: ALL_SHAPES,
  look: pujaGreetingLook,
  light: { x: 0.5, y: 0.75 },
  fields: [
    { id: "greeting", kind: "text", label: "Greeting", en: "Happy Durga Puja", bn: "শারদীয় শুভেচ্ছা", limit: 28 },
    { id: "line", kind: "text", label: "Message", en: "May every home be filled with light", bn: "আলোয় ভরে উঠুক সবার ঘর", limit: 48 },
    { id: "brand", kind: "text", label: "From", en: "Lumen & Co.", bn: "লুমেন অ্যান্ড কো.", limit: 32 },
  ],
  hits: [{ t: 0.2, sfx: "chime" }, { t: 1.2, sfx: "ding" }, { t: 1.55, sfx: "ding" }, { t: 1.9, sfx: "ding" }],
  layers: [
    ...backdrop("bokeh", "rays", {
      intensity: 0.6, overIntensity: 0.35, speed: 0.7, soft: 0.4,
    }),
    scrim("scrim", F({ "9:16": [0.47, 0.45, 1.0, 0.6], "16:9": [0.5, 0.47, 1.4, 0.6], "1:1": [0.5, 0.45, 1.0, 0.55], "4:5": [0.5, 0.44, 1.0, 0.6] }), 0.6, "#2a0707"),
    kash("kash-left", 0.05, false, 1, 0),
    kash("kash-left2", 0.11, false, 0.75, 0.6),
    kash("kash-right", 0.95, true, 1, 0.3),
    {
      // The garland swings in from above and keeps swaying.
      id: "garland", kind: "group", frame: frame(0.5, 0, "full", 0.02, 0.5, 0.5),
      dy: [[0.1, -0.3, "out"], [1.0, 0]], rotate: [[0.1, 2, "out"], [1.2, 0], ...pulse(1.2, LEN, 3.6, 0, 0.6).slice(1)],
      opacity: vis(0.1, 0.4, EXIT, 0.5),
      children: [
        { id: "garland-string", kind: "path", d: GARLAND, view: [100, 30], frame: frame(0.5, 0, "full", GARLAND_H, 0.5, 0), stroke: "#e07b00", strokeWidth: 0.02 },
        { id: "garland-string2", kind: "path", d: GARLAND, view: [100, 30], frame: frame(0.5, 0, "full", GARLAND_H, 0.5, 0), stroke: MARIGOLD, strokeWidth: 0.01 },
        ...FLOWERS.map((_, i) => flower(i)),
      ],
    },
    ...[0, 1, 2].flatMap((i) => diya(i)),
    txt("greeting", "greeting", F({
      "9:16": [0.47, 0.39, 0.78, 0.22], "16:9": [0.5, 0.4, 1.3, 0.18], "1:1": [0.5, 0.38, 0.86, 0.17], "4:5": [0.5, 0.38, 0.86, 0.18],
    }), {
      role: "headline",
      font: "heading", weight: 700, size: 0.12, minSize: 0.07, lines: 2, lineHeight: 1.05, color: CREAM,
      textAt: { "16:9": { size: 0.14, lines: 1 }, "1:1": { size: 0.1 } },
      shadow: { color: "@deep/0.6", blur: 0.03, y: 0.01, follow: true }, lightWrap: { color: "#ffb347", amount: 0.6 },
      animate: settle(), exit: outWords(EXIT),
    }),
    txt("line", "line", F({
      "9:16": [0.47, 0.525, 0.76, 0.05], "16:9": [0.5, 0.53, 1.0, 0.06], "1:1": [0.5, 0.5, 0.8, 0.05], "4:5": [0.5, 0.495, 0.8, 0.05],
    }), {
      role: "body",
      size: 0.044, minSize: 0.044, lines: 1, color: "#ffd9a0",
      animate: riseWords(1.5, 0.06, 0.5), exit: outFade(EXIT, 0.3),
    }),
    txt("brand", "brand", F({
      "9:16": [0.47, 0.575, 0.6, 0.045], "16:9": [0.5, 0.6, 0.6, 0.045], "1:1": [0.5, 0.565, 0.6, 0.04], "4:5": [0.5, 0.555, 0.6, 0.04],
    }), {
      role: "body",
      size: 0.044, minSize: 0.044, lines: 1, color: CREAM + "/0.7", upper: true, tracking: 0.2,
      animate: riseWords(1.9, 0.06, 0.45), exit: outFade(EXIT, 0.3),
    }),
  ],
};
