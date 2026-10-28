import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Shape } from "../layout";
import { ALL_SHAPES, across, frame } from "./build";
import { F, LEAF, STEAM, backdrop, drawOn, outFade, outWords, popWords, pulse, riseWords, settle, slideWords, txt, vis } from "./common-b";

/**
 * Menu Card: a restaurant's menu on a card. The name and a large italic "Menu" set in under a
 * wisp of steam and two garnish sprigs; four dishes slide in with their prices, each over a rule
 * that draws (two columns in 16:9).
 */

const EXIT = 6.0;
const AT = [1.1, 1.3, 1.5, 1.7];

/** Each dish row per shape: the name's left x, the price's right x and the row's y (canvas fractions), and the row's width (short sides). */
const ROWS: Record<Shape, { x: number; r: number; y: number; w: number }[]> = {
  "9:16": [0.36, 0.45, 0.54, 0.63].map((y) => ({ x: 0.13, r: 0.81, y, w: 0.68 })),
  "16:9": [[0.13, 0.48, 0.52], [0.13, 0.48, 0.71], [0.52, 0.87, 0.52], [0.52, 0.87, 0.71]].map(([x, r, y]) => ({ x, r, y, w: (r - x) * 16 / 9 })),
  "1:1": [0.38, 0.51, 0.64, 0.77].map((y) => ({ x: 0.13, r: 0.87, y, w: 0.74 })),
  "4:5": [0.37, 0.48, 0.59, 0.7].map((y) => ({ x: 0.13, r: 0.87, y, w: 0.74 })),
};
const part = (i: number, kind: "name" | "price" | "rule") => across((shape, d) => {
  const r = ROWS[shape][i];
  if (kind === "name") return frame(r.x, r.y, r.w * 0.68, 0.06, 0);
  if (kind === "price") return frame(r.r, r.y, r.w * 0.3, 0.06, 1);
  return frame(r.x, r.y + 0.045 / d.h, r.w, 0.01, 0);
});

function dish(i: number): Layer[] {
  const t = AT[i], n = i + 1, out = EXIT + i * 0.05;
  return [
    {
      id: `rule${n}`, kind: "path", d: "M0 50H100", frame: part(i, "rule"), stroke: "@text/0.18", strokeWidth: 0.0018, cap: "butt",
      draw: drawOn(t, t + 0.6, [out, out + 0.3]),
    },
    txt(`item${n}`, `item${n}`, part(i, "name"), {
      role: "body", font: "heading", weight: 600, size: 0.044, minSize: 0.044, lines: 1, align: "left",
      animate: slideWords(t, -0.5, 0.04, 0.45), exit: outWords(out, 0.25),
    }),
    txt(`price${n}`, `price${n}`, part(i, "price"), {
      role: "cta", font: "heading", weight: 700, size: 0.044, minSize: 0.044, lines: 1, align: "right", color: "@accent",
      animate: popWords(t + 0.2), exit: outFade(out, 0.25),
    }),
  ];
}

const sprig = (id: string, flip: boolean): Layer => ({
  id, kind: "path", d: LEAF, stroke: "@accent/0.8", strokeWidth: 0.003, fill: "@accent/0.12",
  frame: F(flip
    ? { "9:16": [0.7, 0.235, 0.07, 0.07], "16:9": [0.62, 0.27, 0.07, 0.07], "1:1": [0.66, 0.225, 0.07, 0.07], "4:5": [0.66, 0.215, 0.07, 0.07] }
    : { "9:16": [0.24, 0.235, 0.07, 0.07], "16:9": [0.38, 0.27, 0.07, 0.07], "1:1": [0.34, 0.225, 0.07, 0.07], "4:5": [0.34, 0.215, 0.07, 0.07] }),
  rotate: flip ? 90 : 0, draw: drawOn(0.8, 1.5), opacity: vis(0.8, 0.15, EXIT, 0.4), scale: [[0.8, 0.6, "back"], [1.5, 1]],
});

/**
 * This template's own look (Bistro: espresso brown, paprika and mustard.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const menuCardLook: Look = {
  colors: { primary: "#e07a2f", secondary: "#5c3a21", accent: "#f4c95d", background: "#2b1a12", text: "#fff4e8" },
  heading: { family: "Fraunces", weight: 700 }, body: { family: "DM Sans", weight: 500 }, bangla: { family: "Hind Siliguri", weight: 600 },
  radius: 0.4, motion: "smooth", grain: 0.03, grade: { warmth: 0.3 },
  backdrop: ["@primary", "#e9a23b", "@accent"],
};

export const menuCard: Template = {
  version: FORMAT_VERSION,
  id: "food-menu",
  name: "Menu Card",
  category: "food",
  description: "Your menu on a card: the restaurant's name, a large italic Menu and four dishes with prices.",
  tags: ["food", "restaurant", "menu", "prices", "cafe", "dishes", "card"],
  length: 6.6,
  hold: [2.4, EXIT],
  shapes: ALL_SHAPES,
  look: menuCardLook,
  fields: [
    { id: "name", kind: "text", label: "Restaurant", en: "Spice Route Kitchen", bn: "স্পাইস রুট কিচেন", limit: 32 },
    { id: "title", kind: "text", label: "Title", en: "Menu", bn: "মেনু", limit: 16 },
    { id: "item1", kind: "text", label: "Dish 1", en: "Chicken biryani", bn: "চিকেন বিরিয়ানি", limit: 28 },
    { id: "price1", kind: "text", label: "Price 1", en: "Tk 280", bn: "৳২৮০", limit: 10 },
    { id: "item2", kind: "text", label: "Dish 2", en: "Beef tehari", bn: "বিফ তেহারি", limit: 28 },
    { id: "price2", kind: "text", label: "Price 2", en: "Tk 240", bn: "৳২৪০", limit: 10 },
    { id: "item3", kind: "text", label: "Dish 3", en: "Mutton rezala", bn: "মাটন রেজালা", limit: 28 },
    { id: "price3", kind: "text", label: "Price 3", en: "Tk 320", bn: "৳৩২০", limit: 10 },
    { id: "item4", kind: "text", label: "Dish 4", en: "Mango lassi", bn: "ম্যাংগো লাচ্ছি", limit: 28 },
    { id: "price4", kind: "text", label: "Price 4", en: "Tk 120", bn: "৳১২০", limit: 10 },
  ],
  hits: [{ t: 0.05, sfx: "swoosh" }, ...AT.map((t) => ({ t: t + 0.2, sfx: "pop" as const }))],
  layers: [
    ...backdrop("mesh", "drift", { intensity: 0.7, overIntensity: 0.5, speed: 0.8 }),
    {
      id: "card", kind: "rect", radius: "theme", fill: "@bg/0.94", stroke: "@accent/0.3", strokeWidth: 0.002,
      frame: F({ "9:16": [0.47, 0.44, 0.82, 1.2], "16:9": [0.5, 0.5, 1.56, 0.88], "1:1": [0.5, 0.5, 0.9, 0.9], "4:5": [0.5, 0.5, 0.9, 1.14] }),
      shadow: { color: "#000000/0.45", blur: 0.06, y: 0.02 },
      scale: [[0.1, 0.94, "out"], [0.8, 1], [EXIT + 0.2, 1, "in"], [EXIT + 0.55, 0.96]], opacity: vis(0.1, 0.35, EXIT + 0.2, 0.35),
    },
    {
      id: "steam", kind: "path", d: STEAM, stroke: "@text/0.35", strokeWidth: 0.003,
      frame: F({ "9:16": [0.47, 0.13, 0.12, 0.08], "16:9": [0.5, 0.11, 0.12, 0.08], "1:1": [0.5, 0.09, 0.12, 0.08], "4:5": [0.5, 0.085, 0.12, 0.08] }),
      draw: drawOn(0.5, 1.4), opacity: [[0.5, 0, "out"], [0.9, 0.8], ...pulse(1.4, EXIT, 2.2, 0.8, 0.3).slice(1), [EXIT + 0.3, 0]], dy: pulse(0.5, EXIT, 2.2, 0, -0.015),
    },
    txt("name", "name", F({
      "9:16": [0.47, 0.175, 0.7, 0.05], "16:9": [0.5, 0.18, 1.2, 0.055], "1:1": [0.5, 0.155, 0.76, 0.05], "4:5": [0.5, 0.145, 0.76, 0.05],
    }), {
      role: "body",
      size: 0.044, minSize: 0.044, lines: 1, upper: true, tracking: 0.24, color: "@text/0.75", weight: 600,
      animate: riseWords(0.35, 0.06, 0.45), exit: outFade(EXIT, 0.3),
    }),
    txt("title", "title", F({
      "9:16": [0.47, 0.235, 0.4, 0.1], "16:9": [0.5, 0.27, 0.36, 0.12], "1:1": [0.5, 0.225, 0.28, 0.1], "4:5": [0.5, 0.215, 0.28, 0.1],
    }), {
      role: "headline",
      font: "heading", italic: true, weight: 700, size: 0.09, minSize: 0.07, lines: 1, color: "@primary",
      textAt: { "16:9": { size: 0.1 }, "1:1": { size: 0.08 }, "4:5": { size: 0.08 } },
      animate: settle(), exit: outFade(EXIT, 0.3),
    }),
    sprig("sprig-l", false),
    sprig("sprig-r", true),
    ...dish(0),
    ...dish(1),
    ...dish(2),
    ...dish(3),
  ],
};
