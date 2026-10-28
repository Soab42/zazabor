import type { Key } from "../ease";
import { FORMAT_VERSION, type Template } from "../format";
import { ALL_SHAPES, showHide } from "./build";
import { at4, button, grain, hookAt0, leave, live, rise, riseLetters, sink, standIn, strict916, words } from "./common-a";
import { GRAPHITE_LIME } from "./looks";
import { darkness, rimLight } from "./signature";

/**
 * Turntable: the product stands on a glossy card that swings in like a door, sits on a lit
 * turntable, then makes one full turn during the hold, with the name, price and a pre-order button.
 */

const EXIT = 5.8;

const CARD = at4({
  "9:16": [0.5, 0.43, 0.56, 0.68],
  "16:9": [0.66, 0.46, 0.5, 0.62],
  "1:1": [0.5, 0.45, 0.4, 0.5],
  "4:5": [0.5, 0.45, 0.46, 0.56],
});
const PRODUCT = at4({
  "9:16": [0.5, 0.43, 0.46, 0.46],
  "16:9": [0.66, 0.46, 0.42, 0.42],
  "1:1": [0.5, 0.45, 0.34, 0.34],
  "4:5": [0.5, 0.45, 0.38, 0.38],
});
const DISC = at4({
  "9:16": [0.5, 0.635, 0.8, 0.17],
  "16:9": [0.66, 0.81, 0.8, 0.17],
  "1:1": [0.5, 0.71, 0.58, 0.12],
  "4:5": [0.5, 0.7, 0.66, 0.14],
});
const CTA = at4({
  "9:16": [0.5, 0.752, 0.4, 0.07],
  "16:9": [0.07, 0.75, 0.34, 0.09, 0],
  "1:1": [0.5, 0.9, 0.32, 0.068],
  "4:5": [0.5, 0.895, 0.34, 0.075],
});

/** In like a door, a full turn in the hold, out edge-on. */
const TURN: Key[] = [[0.2, -88, "out"], [1.15, 0], [2.7, 0, "inOut"], [4.1, 360], [EXIT, 360, "in"], [EXIT + 0.45, 448]];

export const turntable: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "launch-turntable",
  name: "Turntable",
  category: "launch",
  description: "Your product on a glossy card that swings in, sits on a lit turntable and turns once, with its price and a pre-order button.",
  tags: ["launch", "3d", "turntable", "card", "spin", "pre-order", "drop"],
  length: 6.6,
  hold: [2.6, EXIT],
  shapes: ALL_SHAPES,
  look: GRAPHITE_LIME,
  fields: [
    { id: "kicker", kind: "text", label: "Kicker", en: "Drop 07", bn: "ড্রপ ০৭", limit: 20 },
    { id: "title", kind: "text", label: "Product name", en: "Velo Runner", bn: "ভেলো রানার", limit: 28 },
    { id: "price", kind: "text", label: "Price", en: "৳6,490", bn: "৳৬,৪৯০", limit: 14 },
    { id: "cta", kind: "text", label: "Button", en: "Pre-order", bn: "প্রি-অর্ডার", limit: 18 },
    { id: "product", kind: "media", label: "Product photo", en: "", product: true },
  ],
  hits: [{ t: 0.25, sfx: "swoosh" }, { t: 2.75, sfx: "whoosh" }, { t: 1.9, sfx: "pop" }],
  layers: [
    live("bg", "grid", { speed: [[0, 2.2, "out"], [1.4, 0.8]], intensity: 0.9, vignette: 0.5 }),
    live("bokeh", "bokeh", { over: true, colors: ["@primaryDeep", "@secondary", "@primaryDeep"], intensity: 0.5, soft: 0.6, seed: 2 }),
    {
      id: "disc", kind: "ellipse", frame: DISC, fill: { kind: "radial", stops: [[0, "@primary/0.4"], [0.7, "@primary/0.1"], [1, "@primary/0"]] },
      stroke: "@text/0.22", strokeWidth: 0.003, opacity: showHide(0.4, 0.6, EXIT, 0.5), scale: [[0.4, 0.6, "out"], [1.2, 1]],
      sheen: { at: [[2.7, -0.2, "inOut"], [4.1, 1.2]], width: 0.3, strength: 0.35 },
    },
    { id: "floor", kind: "ellipse", frame: DISC, fill: "#000000/0.4", blur: 0.02, scale: [[0.4, 0.3, "out"], [1.2, 0.55]], opacity: showHide(0.5, 0.5, EXIT, 0.4) },
    {
      id: "card", kind: "group", frame: CARD, turnY: TURN, opacity: showHide(0.2, 0.3, EXIT + 0.2, 0.25),
      dy: [[0.2, 0.08, "out"], [1.15, 0]], idle: { dy: -0.012 }, scale: [[1.25, 1, "out"], [1.85, 1.05], [EXIT, 1.05, "in"], [EXIT + 0.4, 0.96]],
      children: [
        {
          id: "card-face", kind: "rect", frame: CARD, radius: "theme", fill: { kind: "linear", angle: 135, stops: [[0, "@primary"], [1, "@accent"]] },
          stroke: "#ffffff/0.35", strokeWidth: 0.003, shadow: { color: "#000000/0.45", blur: 0.06, y: 0.03 },
          sheen: rimLight(1.0, 0.7),
        },
        { id: "card-glow", kind: "ellipse", frame: PRODUCT, fill: { kind: "radial", stops: [[0, "#ffffff/0.35"], [1, "#ffffff/0"]] } },
        { id: "product", kind: "image", slot: "product", frame: PRODUCT, fit: "contain", placeholder: "Add your product photo", shadow: { color: "#000000/0.35", blur: 0.03, y: 0.02 } },
        standIn("stand-in", "sneaker", "product", PRODUCT, { tint: "@bg", tint2: "@accent", shadow: { color: "#000000/0.35", blur: 0.03, y: 0.02 } }),
      ],
    },
    darkness("dark", CARD, 0.2, 1.15),
    words("kicker", "kicker", at4({
      "9:16": [0.5, 0.135, 0.6, 0.05], "16:9": [0.07, 0.27, 0.6, 0.05, 0], "1:1": [0.5, 0.07, 0.6, 0.04], "4:5": [0.5, 0.068, 0.6, 0.05],
    }), { weight: 700, role: "detail", size: 0.036, lines: 1, upper: true, color: "@accent", tracking: 0.3, textAt: { "16:9": { align: "left" } }, animate: riseLetters(0.6), exit: leave(EXIT) }),
    words("title", "title", at4({
      "9:16": [0.5, 0.19, 0.76, 0.1], "16:9": [0.07, 0.43, 0.76, 0.24, 0], "1:1": [0.5, 0.14, 0.86, 0.08], "4:5": [0.5, 0.13, 0.86, 0.09],
    }), {
      font: "heading", size: 0.095, minSize: 0.07, lines: 1, textAt: { "16:9": { size: 0.11, lines: 2, align: "left" }, "1:1": { size: 0.07 }, "4:5": { size: 0.08 } },
      animate: rise(0.8), exit: sink(EXIT),
    }),
    words("price", "price", at4({
      "9:16": [0.5, 0.7, 0.5, 0.07], "16:9": [0.07, 0.61, 0.5, 0.09, 0], "1:1": [0.5, 0.82, 0.4, 0.06], "4:5": [0.5, 0.8, 0.4, 0.065],
    }), {
      font: "heading", size: 0.06, minSize: 0.044, lines: 1, color: "@text", textAt: { "16:9": { size: 0.07, align: "left" }, "1:1": { size: 0.05 } },
      counter: { fromValue: 0, t: [1.5, 2.3] }, animate: { unit: "line", t: 1.5, stagger: 0, duration: 0.5, from: { opacity: 0, scale: 0.8 } }, exit: leave(EXIT),
    }),
    button("cta", "cta", CTA, 1.9, EXIT, { size: 0.034 }),
    grain(),
  ],
}, ["title"]));
