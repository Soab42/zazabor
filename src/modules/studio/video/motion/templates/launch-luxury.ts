import type { Key } from "../ease";
import { FORMAT_VERSION, type Template } from "../format";
import { ALL_SHAPES, FULL, showHide } from "./build";
import { at4, focus, grain, hookAt0, leave, live, soft, standIn, strict916, words } from "./common-a";
import { NOIR_GOLD } from "./looks";
import { darkness, rimLight } from "./signature";

/**
 * Dark Luxury: slow and quiet. Dust drifts in a dark room, a thin gold frame draws itself, the
 * product appears behind a slanted wipe and catches a light sweep, then the house name, the
 * product's name in letters that come into focus, and a hairline rule.
 */

const EXIT = 6.0;

const PRODUCT = at4({
  "9:16": [0.5, 0.42, 0.5, 0.6],
  "16:9": [0.33, 0.52, 0.8, 0.8],
  "1:1": [0.5, 0.42, 0.46, 0.52],
  "4:5": [0.5, 0.41, 0.5, 0.56],
});
const FRAME = at4({
  "9:16": [0.5, 0.44, 0.88, 1.4],
  "16:9": [0.5, 0.5, 1.68, 0.9],
  "1:1": [0.5, 0.5, 0.9, 0.9],
  "4:5": [0.5, 0.5, 0.9, 1.15],
});
const REVEAL = { from: "diagonal" as const, v: [[1.0, 0, "inOut"], [2.0, 1]] as [number, number, "inOut"?][] };
/** The signature (§12): it rises out of the dark, a rim light sweeps it, then a fast push eases into the drift. */
const RISE: Key[] = [[1.0, 0.05, "out"], [2.0, 0]];
const PUSH: Key[] = [[2.25, 1, "out"], [2.85, 1.05], [EXIT, 1.05, "in"], [EXIT + 0.5, 0.99]];

export const darkLuxury: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "launch-luxury",
  name: "Dark Luxury",
  category: "launch",
  description: "Slow and quiet: drifting dust, a gold frame that draws itself, the product behind a slanted wipe and a light sweep.",
  tags: ["launch", "luxury", "premium", "perfume", "jewellery", "gold", "dark", "elegant"],
  length: 7,
  hold: [3.0, EXIT],
  shapes: ALL_SHAPES,
  light: { x: 0.1, y: -0.1 },
  look: NOIR_GOLD,
  fields: [
    { id: "house", kind: "text", label: "Brand", en: "Maison Zaza", bn: "মেজোঁ জাজা", limit: 24 },
    { id: "title", kind: "text", label: "Product name", en: "Nuit Dorée", bn: "সোনালি রাত", limit: 28 },
    { id: "tagline", kind: "text", label: "Details", en: "Eau de parfum · 50 ml", bn: "ও দ্য পারফিউম · ৫০ মিলি", limit: 40 },
    { id: "cta", kind: "text", label: "Call to action", en: "Discover the collection", bn: "কালেকশনটি দেখুন", limit: 30 },
    { id: "product", kind: "media", label: "Product photo", en: "", product: true },
  ],
  hits: [{ t: 0.3, sfx: "rise" }, { t: 1.0, sfx: "swoosh" }, { t: 2.1, sfx: "chime" }],
  layers: [
    live("bg", "rays", { colors: ["@primary", "@accent", "@primary", "#050507", "@deep"], speed: 0.7, intensity: [[0, 0.2], [2.0, 0.5]], vignette: 0.75 }),
    live("dust", "drift", { over: true, colors: ["@accent", "#ffffff", "@accent"], speed: 0.6, intensity: 0.8, seed: 11 }),
    {
      id: "frame", kind: "path", d: "M50 0H100V100H0V0Z", frame: FRAME, stroke: "@accent/0.75", strokeWidth: 0.0022, cap: "square",
      draw: [[0.3, 0, "inOut"], [1.9, 1]], opacity: showHide(0.3, 0.2, EXIT, 0.5),
    },
    {
      id: "pool", kind: "ellipse", frame: PRODUCT, fill: { kind: "radial", stops: [[0, "@accent/0.28"], [1, "@accent/0"]] },
      scale: [[0.8, 0.6, "out"], [2.2, 1.25]], opacity: showHide(0.8, 1.0, EXIT, 0.5),
    },
    {
      id: "product", kind: "image", slot: "product", frame: PRODUCT, fit: "contain", placeholder: "Add your product photo",
      shadow: { color: "#000000/0.6", blur: 0.06, y: 0.03 }, reveal: REVEAL, opacity: showHide(1.0, 0.1, EXIT, 0.5),
      sheen: rimLight(2.0, 0.7), idle: { scale: 0.03 }, dy: RISE, scale: PUSH,
    },
    standIn("stand-in", "bottle", "product", PRODUCT, {
      tint: "@primary", shadow: { color: "#000000/0.6", blur: 0.06, y: 0.03 }, reveal: REVEAL, opacity: showHide(1.0, 0.1, EXIT, 0.5),
      sheen: rimLight(2.0, 0.7), idle: { scale: 0.03 }, dy: RISE, scale: PUSH,
    }),
    darkness("dark", PRODUCT, 1.0, 2.1, 0.8),
    words("house", "house", at4({
      "9:16": [0.5, 0.135, 0.7, 0.05], "16:9": [0.72, 0.3, 0.7, 0.05], "1:1": [0.5, 0.1, 0.6, 0.05], "4:5": [0.5, 0.095, 0.6, 0.05],
    }), { weight: 700, role: "detail", size: 0.04, lines: 1, upper: true, tracking: 0.4, color: "@text", animate: soft(0.5, 0.05, 0.7), exit: leave(EXIT, 0.45) }),
    words("title", "title", at4({
      "9:16": [0.5, 0.65, 0.76, 0.1], "16:9": [0.72, 0.45, 0.8, 0.2], "1:1": [0.5, 0.76, 0.86, 0.08], "4:5": [0.5, 0.72, 0.86, 0.09],
    }), {
      font: "heading", weight: 400, size: 0.09, minSize: 0.07, lines: 1, tracking: 0.04,
      textAt: { "16:9": { size: 0.085, lines: 2 }, "1:1": { size: 0.07 }, "4:5": { size: 0.075 } },
      animate: focus(1.7, 0.04, 0.75), exit: leave(EXIT, 0.45),
    }),
    {
      id: "rule", kind: "rect", fill: "@accent/0.8", frame: at4({
        "9:16": [0.5, 0.695, 0.3, 0.003], "16:9": [0.72, 0.58, 0.3, 0.003], "1:1": [0.5, 0.81, 0.24, 0.003], "4:5": [0.5, 0.775, 0.26, 0.003],
      }),
      reveal: { from: "center", v: [[2.3, 0, "inOut"], [3.0, 1]] }, opacity: showHide(2.3, 0.1, EXIT, 0.4),
    },
    words("tagline", "tagline", at4({
      "9:16": [0.5, 0.725, 0.7, 0.05], "16:9": [0.72, 0.64, 0.7, 0.06], "1:1": [0.5, 0.85, 0.7, 0.045], "4:5": [0.5, 0.82, 0.7, 0.05],
    }), { weight: 400, role: "detail", size: 0.036, minSize: 0.036, lines: 1, color: "@text/0.88", tracking: 0.08, animate: soft(2.5, 0.06, 0.7), exit: leave(EXIT, 0.45) }),
    words("cta", "cta", at4({
      "9:16": [0.5, 0.765, 0.76, 0.04], "16:9": [0.72, 0.74, 0.8, 0.05], "1:1": [0.5, 0.91, 0.8, 0.04], "4:5": [0.5, 0.885, 0.8, 0.045],
    }), { weight: 600, role: "detail", size: 0.036, minSize: 0.036, lines: 1, upper: true, tracking: 0.16, color: "@accent", animate: soft(2.9, 0.06, 0.7), exit: leave(EXIT, 0.45) }),
    { id: "vignette", kind: "fx", fx: "vignette", frame: FULL, amount: 0.9 },
    grain(0.04),
  ],
}, ["title"]));
