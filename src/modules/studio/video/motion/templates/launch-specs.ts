import type { Key } from "../ease";
import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Shape } from "../layout";
import { ALL_SHAPES, pop, showHide } from "./build";
import { at4, each, grain, hookAt0, leave, live, rise, sink, soft, standIn, strict916, words } from "./common-a";
import { PORCELAIN } from "./looks";
import { pushIn, rimLight } from "./signature";

/**
 * Spec Call-outs: the product in the middle, and four specs pointed out with leader lines that
 * draw from a dot on the product out to each label, one after another.
 */

const EXIT = 5.8;

/** The product's centre and size per shape. */
const CENTRE: Record<Shape, [number, number, number]> = {
  "9:16": [0.47, 0.45, 0.5],
  "16:9": [0.5, 0.54, 0.5],
  "1:1": [0.5, 0.52, 0.4],
  "4:5": [0.5, 0.5, 0.44],
};
const DIM: Record<Shape, [number, number]> = { "9:16": [1, 16 / 9], "16:9": [16 / 9, 1], "1:1": [1, 1], "4:5": [1, 1.25] };

/** Each call-out: from a point on the product to where its label sits (short sides from the centre). */
const CALLOUTS: Record<Shape, [ax: number, ay: number, ex: number, ey: number][]> = {
  "9:16": [[-0.1, -0.1, -0.4, -0.3], [0.12, -0.05, 0.4, -0.3], [-0.12, 0.1, -0.4, 0.32], [0.1, 0.12, 0.4, 0.32]],
  "16:9": [[-0.12, -0.1, -0.6, -0.24], [0.12, -0.06, 0.6, -0.24], [-0.12, 0.1, -0.6, 0.26], [0.1, 0.12, 0.6, 0.26]],
  "1:1": [[-0.08, -0.08, -0.42, -0.24], [0.1, -0.04, 0.42, -0.24], [-0.1, 0.08, -0.42, 0.24], [0.08, 0.1, 0.42, 0.24]],
  "4:5": [[-0.09, -0.09, -0.42, -0.27], [0.11, -0.05, 0.42, -0.27], [-0.11, 0.09, -0.42, 0.28], [0.09, 0.11, 0.42, 0.28]],
};

const point = (shape: Shape, dx: number, dy: number): [number, number] => {
  const [cx, cy] = CENTRE[shape], [dw, dh] = DIM[shape];
  return [cx + dx / dw, cy + dy / dh];
};

function callout(i: number): Layer[] {
  const t = 1.0 + i * 0.16;
  const c = (shape: Shape) => CALLOUTS[shape][i];
  const left = CALLOUTS["9:16"][i][2] < 0, up = CALLOUTS["9:16"][i][3] < CALLOUTS["9:16"][i][1];
  // In the path's 100 × 100 box: from the dot's corner, out on a slant, then along to the label.
  const ax = left ? 100 : 0, ay = up ? 100 : 0, fx = 100 - ax, fy = 100 - ay;
  const d = `M${ax} ${ay}L${ax + (fx - ax) * 0.3} ${fy}L${fx} ${fy}`;
  return [
    {
      id: `lead${i + 1}`, kind: "path", d, stroke: "@text/0.7", strokeWidth: 0.0028, cap: "round",
      frame: each((shape) => {
        const [x0, y0, x1, y1] = c(shape);
        return [...point(shape, x0, y0), Math.abs(x1 - x0), Math.abs(y1 - y0), left ? 1 : 0, up ? 1 : 0];
      }),
      draw: [[t + 0.1, 0, "inOut"], [t + 0.65, 1]], opacity: showHide(t, 0.1, EXIT, 0.3),
    },
    {
      id: `dot${i + 1}`, kind: "ellipse", fill: "@accent", stroke: "#ffffff/0.9", strokeWidth: 0.003, glow: { color: "@accent/0.8", blur: 0.02 },
      frame: each((shape) => [...point(shape, c(shape)[0], c(shape)[1]), 0.024, 0.024]),
      opacity: showHide(t, 0.15, EXIT, 0.3), scale: pop(t, 0.2, 0.45, EXIT, 0.4),
    },
    words(`spec${i + 1}`, `spec${i + 1}`, each((shape) => {
      const [x0, , x1, y1] = c(shape);
      const w = shape === "16:9" ? 0.42 : Math.abs(x1 - x0) + 0.02;
      return [...point(shape, x1, y1 - 0.006), w, 0.08, left ? 0 : 1, 1];
    }), {
      weight: 700, role: "detail", size: 0.036, minSize: 0.036, lines: 2, align: left ? "left" : "right", valign: "bottom", lineHeight: 1.08,
      textAt: { "16:9": { size: 0.036 } },
      animate: { unit: "word", t: t + 0.45, stagger: 0.06, duration: 0.5, from: { opacity: 0, dx: left ? -0.4 : 0.4 } }, exit: leave(EXIT),
    }),
  ];
}

const PRODUCT = each((shape) => {
  const [x, y, s] = CENTRE[shape];
  return [x, y, s, s];
});

/** The signature (§12): it rises into focus, a rim light sweeps it, then a fast push eases into the drift. */
const PUSH = pushIn(0.3, 0.85, 0.7, 1.25, EXIT, 1.04);
const RISE: Key[] = [[0.3, 0.05, "out"], [1.0, 0]];

export const specCallouts: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "launch-specs",
  name: "Spec Call-outs",
  category: "launch",
  description: "Four specs pointed out on your product with leader lines that draw out to each label.",
  tags: ["launch", "specs", "features", "call-outs", "leader lines", "tech"],
  length: 6.6,
  hold: [2.4, EXIT],
  shapes: ALL_SHAPES,
  look: PORCELAIN,
  fields: [
    { id: "title", kind: "text", label: "Heading", en: "Built different", bn: "অন্যরকম করে তৈরি", limit: 30 },
    { id: "spec1", kind: "text", label: "Spec 1", en: "40 h battery", bn: "৪০ ঘণ্টা ব্যাটারি", limit: 26 },
    { id: "spec2", kind: "text", label: "Spec 2", en: "Noise cancelling", bn: "নয়েজ ক্যান্সেলিং", limit: 26 },
    { id: "spec3", kind: "text", label: "Spec 3", en: "Sweat-proof IP54", bn: "ঘাম-রোধী IP54", limit: 26 },
    { id: "spec4", kind: "text", label: "Spec 4", en: "Full charge in 10 min", bn: "১০ মিনিটে ফুল চার্জ", limit: 26 },
    { id: "footer", kind: "text", label: "Product name", en: "Aurora Buds Pro", bn: "অরোরা বাডস প্রো", limit: 30 },
    { id: "product", kind: "media", label: "Product photo", en: "", product: true },
  ],
  hits: [{ t: 0.3, sfx: "whoosh" }, { t: 1.0, sfx: "click" }, { t: 1.32, sfx: "click" }, { t: 1.64, sfx: "click" }],
  layers: [
    live("bg", "glass", { speed: 0.8, intensity: 0.9, vignette: 0.2, seed: 4 }),
    live("motes", "drift", { over: true, intensity: 0.5, seed: 9 }),
    {
      id: "halo", kind: "ellipse", frame: each((shape) => { const [x, y, s] = CENTRE[shape]; return [x, y, s * 1.5, s * 1.5]; }),
      fill: { kind: "radial", stops: [[0, "@primary/0.4"], [1, "@primary/0"]] }, opacity: showHide(0.2, 0.8, EXIT, 0.5), idle: { scale: 0.08 },
    },
    {
      id: "product", kind: "image", slot: "product", frame: PRODUCT, fit: "contain", placeholder: "Add your product photo",
      shadow: { color: "#000000/0.4", blur: 0.05, y: 0.025 }, opacity: showHide(0.3, 0.35, EXIT, 0.4), dy: RISE,
      scale: PUSH, blur: [[0.3, 0.03, "out"], [0.9, 0]], idle: { scale: 0.03 }, sheen: rimLight(0.95),
    },
    standIn("stand-in", "buds", "product", PRODUCT, {
      tint: "@primary", shadow: { color: "#000000/0.4", blur: 0.05, y: 0.025 }, opacity: showHide(0.3, 0.35, EXIT, 0.4), dy: RISE,
      scale: PUSH, blur: [[0.3, 0.03, "out"], [0.9, 0]], idle: { scale: 0.03 }, sheen: rimLight(0.95),
    }),
    ...[0, 1, 2, 3].flatMap(callout),
    words("title", "title", at4({
      "9:16": [0.5, 0.135, 0.76, 0.08], "16:9": [0.5, 0.12, 1.2, 0.1], "1:1": [0.5, 0.1, 0.86, 0.08], "4:5": [0.5, 0.085, 0.86, 0.08],
    }), { font: "heading", size: 0.075, minSize: 0.07, lines: 1, animate: rise(0.5), exit: sink(EXIT), textAt: { "1:1": { size: 0.07 } } }),
    words("footer", "footer", at4({
      "9:16": [0.5, 0.74, 0.76, 0.06], "16:9": [0.5, 0.9, 1.0, 0.07], "1:1": [0.5, 0.9, 0.8, 0.06], "4:5": [0.5, 0.91, 0.8, 0.06],
    }), { weight: 600, role: "detail", size: 0.036, lines: 1, color: "@text/0.7", upper: true, tracking: 0.18, animate: soft(2.0), exit: leave(EXIT) }),
    grain(),
  ],
}, ["product", "stand-in"]));
