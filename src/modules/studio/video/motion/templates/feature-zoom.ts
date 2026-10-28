import { FORMAT_VERSION, type Template } from "../format";
import type { Shape } from "../layout";
import { ALL_SHAPES, pop, showHide } from "./build";
import { at4, each, grain, hookAt0, leave, live, rise, sink, soft, type Spec, standIn, strict916, words } from "./common-a";
import { PAPER } from "./looks";
import { handoff } from "./signature";

/**
 * Detail Zoom: the product, then a loupe opens beside it showing one detail magnified (the same
 * picture, 2.6 times bigger, lined up on that point), with a hairline back to the spot.
 */

const EXIT = 5.8;
const ZOOM = 2.6;
/** The detail, in the product picture's own 0…1 box. */
const DETAIL: [number, number] = [0.62, 0.4];
const DIM: Record<Shape, [number, number]> = { "9:16": [1, 16 / 9], "16:9": [16 / 9, 1], "1:1": [1, 1], "4:5": [1, 1.25] };

/** Per shape: product centre and size, the loupe's offset from the product's centre (short sides) and size. */
const SETUP: Record<Shape, { p: [number, number, number]; loupe: [number, number, number] }> = {
  "9:16": { p: [0.5, 0.5, 0.56], loupe: [0.16, -0.24, 0.34] },
  "16:9": { p: [0.3, 0.52, 0.72], loupe: [0.38, -0.06, 0.42] },
  "1:1": { p: [0.42, 0.53, 0.5], loupe: [0.26, -0.2, 0.3] },
  "4:5": { p: [0.45, 0.5, 0.54], loupe: [0.26, -0.22, 0.32] },
};
const at = (shape: Shape, dx: number, dy: number): [number, number] => {
  const { p: [cx, cy] } = SETUP[shape], [dw, dh] = DIM[shape];
  return [cx + dx / dw, cy + dy / dh];
};
const spot = (shape: Shape): [number, number] => {
  const s = SETUP[shape].p[2];
  return [(DETAIL[0] - 0.5) * s, (DETAIL[1] - 0.5) * s];
};

const PRODUCT = each((shape): Spec => [SETUP[shape].p[0], SETUP[shape].p[1], SETUP[shape].p[2], SETUP[shape].p[2]]);
const LOUPE = each((shape): Spec => {
  const [lx, ly, ls] = SETUP[shape].loupe;
  return [...at(shape, lx, ly), ls, ls];
});
/** The magnified copy: the detail lands on the loupe's centre. */
const ZOOMED = each((shape): Spec => {
  const [lx, ly] = SETUP[shape].loupe, [sx, sy] = spot(shape), s = SETUP[shape].p[2];
  return [...at(shape, lx - sx * ZOOM, ly - sy * ZOOM), s * ZOOM, s * ZOOM];
});
/** A hairline from the detail to the loupe's centre (the loupe covers its far end). */
const LINE = each((shape): Spec => {
  const [lx, ly] = SETUP[shape].loupe, [sx, sy] = spot(shape);
  return [...at(shape, sx, sy), Math.abs(lx - sx), Math.abs(ly - sy), lx > sx ? 0 : 1, ly < sy ? 1 : 0];
});
const DOT = each((shape): Spec => [...at(shape, ...spot(shape)), 0.022, 0.022]);

export const detailZoom: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "feature-zoom",
  name: "Detail Zoom",
  category: "feature",
  description: "A loupe opens beside your product and shows one detail magnified, with a hairline back to the spot.",
  tags: ["feature", "zoom", "detail", "loupe", "magnify", "quality", "close-up"],
  length: 6.4,
  hold: [2.6, EXIT],
  shapes: ALL_SHAPES,
  look: PAPER,
  light: { x: 0.85, y: 0.05 },
  fields: [
    { id: "title", kind: "text", label: "Heading", en: "Every detail matters", bn: "প্রতিটি খুঁটিনাটি গুরুত্বপূর্ণ", limit: 32 },
    { id: "detail", kind: "text", label: "The detail", en: "Sapphire crystal glass", bn: "স্যাফায়ার ক্রিস্টাল গ্লাস", limit: 30 },
    { id: "sub", kind: "text", label: "About it", en: "Scratch-proof and anti-glare", bn: "দাগ পড়ে না, ঝলকও না", limit: 40 },
    { id: "product", kind: "media", label: "Product photo", en: "", product: true },
  ],
  hits: [{ t: 0.3, sfx: "whoosh" }, { t: 1.3, sfx: "click" }, { t: 1.5, sfx: "swoosh" }],
  layers: [
    live("bg", "mesh", { intensity: 0.6, speed: 0.8, vignette: 0.15, seed: 9 }),
    live("motes", "drift", { over: true, intensity: 0.5, seed: 23 }),
    {
      id: "product", kind: "image", slot: "product", frame: PRODUCT, fit: "contain", placeholder: "Add your product photo",
      shadow: { color: "#000000/0.45", blur: 0.05, y: 0.03, follow: true }, opacity: showHide(0.3, 0.3, EXIT, 0.4), scale: pop(0.3, 0.85, 0.7, EXIT, 0.92), idle: { scale: 0.02 },
    },
    standIn("stand-in", "watch", "product", PRODUCT, { tint: "@primary", tint2: "@secondary", shadow: { color: "#000000/0.45", blur: 0.05, y: 0.03, follow: true }, opacity: showHide(0.3, 0.3, EXIT, 0.4), scale: pop(0.3, 0.85, 0.7, EXIT, 0.92), idle: { scale: 0.02 } }),
    { id: "line", kind: "path", d: "M0 100L100 0", frame: LINE, stroke: "@text/0.75", strokeWidth: 0.0025, draw: [[1.2, 0, "inOut"], [1.6, 1]], opacity: showHide(1.2, 0.1, EXIT, 0.3) },
    { id: "dot", kind: "ellipse", frame: DOT, fill: "@accent", stroke: "#ffffff", strokeWidth: 0.003, glow: { color: "@accent/0.8", blur: 0.02 }, opacity: showHide(1.1, 0.15, EXIT, 0.3), scale: pop(1.1, 0.2, 0.45, EXIT, 0.4) },
    {
      id: "loupe", kind: "group", frame: LOUPE, clip: "ellipse", reveal: { from: "circle", v: [[1.45, 0, "out"], [2.05, 1]] },
      children: [
        { id: "loupe-back", kind: "ellipse", frame: LOUPE, fill: { kind: "radial", stops: [[0, "@card"], [1, "@surface"]] } },
        standIn("zoom-art", "watch", "product", ZOOMED, { tint: "@primary", tint2: "@secondary", scale: [[1.45, 0.8, "out"], [2.3, 1]] }),
        { id: "zoom-pic", kind: "image", slot: "product", frame: ZOOMED, fit: "contain", scale: [[1.45, 0.8, "out"], [2.3, 1]] },
        { id: "loupe-glare", kind: "ellipse", frame: LOUPE, fill: { kind: "linear", angle: 135, stops: [[0, "#ffffff/0.22"], [0.45, "#ffffff/0"]] } },
      ],
    },
    {
      id: "loupe-ring", kind: "ellipse", frame: LOUPE, stroke: "@text/0.85", strokeWidth: 0.006, glow: { color: "@accent/0.6", blur: 0.03 },
      opacity: showHide(1.45, 0.2, EXIT, 0.3), scale: pop(1.45, 0.3, 0.6, EXIT, 0.5),
    },
    words("title", "title", at4({
      "9:16": [0.5, 0.14, 0.76, 0.1], "16:9": [0.66, 0.3, 0.52, 0.2, 0], "1:1": [0.5, 0.09, 0.86, 0.07], "4:5": [0.5, 0.085, 0.86, 0.08],
    }), { font: "heading", size: 0.075, minSize: 0.07, lines: 2, textAt: { "16:9": { size: 0.07, align: "left" }, "1:1": { size: 0.07, lines: 1 }, "4:5": { size: 0.07, lines: 1 } }, animate: rise(0.5), exit: sink(EXIT) }),
    words("detail", "detail", at4({
      "9:16": [0.5, 0.7, 0.76, 0.06], "16:9": [0.66, 0.55, 0.52, 0.1, 0], "1:1": [0.5, 0.84, 0.8, 0.06], "4:5": [0.5, 0.83, 0.8, 0.065],
    }), { weight: 700, size: 0.045, minSize: 0.044, lines: 1, color: "@accent", textAt: { "16:9": { lines: 2, align: "left" } }, animate: rise(1.9), exit: leave(EXIT) }),
    words("sub", "sub", at4({
      "9:16": [0.5, 0.745, 0.76, 0.045], "16:9": [0.66, 0.66, 0.52, 0.08, 0], "1:1": [0.5, 0.9, 0.8, 0.045], "4:5": [0.5, 0.885, 0.8, 0.05],
    }), { role: "detail", size: 0.036, minSize: 0.036, lines: 1, color: "@text/0.8", textAt: { "16:9": { lines: 2, align: "left" } }, animate: soft(2.2), exit: leave(EXIT) }),
    // The signature (§12): the loupe just read opens out into the next scene's frame.
    handoff("handoff", LOUPE, EXIT, 10, "@card", "pill"),
    grain(),
  ],
}, ["product", "stand-in"]));
