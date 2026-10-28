import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Shape } from "../layout";
import { ALL_SHAPES, across, frame, pop } from "./build";
import { CRESCENT, F, LANTERN, STAR5, backdrop, dotRing, outFade, outWords, petals, popWords, pulse, riseWords, rnd, settle, txt, vis } from "./common-b";

/**
 * Eid Offer: a night of deep green and gold. Lanterns drop in on their strings and keep swinging,
 * the crescent rises glowing beside a star, a gold medallion turns slowly behind "ঈদ মোবারক", and
 * the offer, its dates and a Shop now button follow. Bangla first, with English beside it.
 */

const EXIT = 5.8;
const LEN = 6.5;
const GOLD = { kind: "linear" as const, angle: 90, stops: [[0, "@accent"], [1, "@primary"]] as [number, string][] };
const CREAM = "@text";

/** Lanterns per shape: where each hangs from the top edge (canvas fraction), its string's length and its size (short sides). */
const LANTERNS: Record<Shape, [number, number, number][]> = {
  "9:16": [[0.13, 0.18, 0.16], [0.27, 0.32, 0.2], [0.4, 0.12, 0.13]],
  "16:9": [[0.08, 0.08, 0.15], [0.15, 0.2, 0.18], [0.22, 0.04, 0.12]],
  "1:1": [[0.1, 0.06, 0.14], [0.21, 0.16, 0.17], [0.32, 0.02, 0.12]],
  "4:5": [[0.1, 0.08, 0.15], [0.21, 0.2, 0.18], [0.32, 0.04, 0.12]],
};
const MOON = F({ "9:16": [0.68, 0.2, 0.3, 0.3], "16:9": [0.84, 0.24, 0.34, 0.34], "1:1": [0.76, 0.19, 0.28, 0.28], "4:5": [0.76, 0.18, 0.29, 0.29] });

function lantern(i: number): Layer {
  const pick = (shape: Shape) => LANTERNS[shape][i];
  const t = 0.2 + i * 0.18;
  const hook = across((shape) => frame(pick(shape)[0], 0, 0.02, 0.02));
  const body = across((shape, d) => { const [x, len, s] = pick(shape); return frame(x, len / d.h, s * 0.6, s, 0.5, 0); });
  return {
    // Swings from where its string is tied.
    id: `lantern${i + 1}`, kind: "group", frame: hook,
    dy: [[t, -0.5, "out"], [t + 0.9, 0]], opacity: [[t, 0, "out"], [t + 0.3, 1], [EXIT + 0.2, 1, "in"], [EXIT + 0.6, 0]],
    rotate: [[t, 10, "out"], [t + 1.2, -3], ...pulse(t + 1.2, LEN, 3.2 + i * 0.5, -3, 3).slice(1)],
    children: [
      { id: `string${i + 1}`, kind: "path", d: "M50 0V100", frame: across((shape) => { const [x, len] = pick(shape); return frame(x, 0, 0.01, Math.max(0.01, len + 0.01), 0.5, 0); }), stroke: "#c9952f/0.8", strokeWidth: 0.002 },
      { id: `lantern-glow${i + 1}`, kind: "ellipse", frame: across((shape, d) => { const [x, len, s] = pick(shape); return frame(x, (len + s * 0.55) / d.h, s * 0.9, s * 0.9); }), fill: { kind: "radial", stops: [[0, "#ffcf6b/0.55"], [1, "#ffcf6b/0"]] }, opacity: pulse(0, LEN, 1.6 + i * 0.3, 0.7, 1) },
      { id: `lantern-body${i + 1}`, kind: "path", d: LANTERN, view: [60, 100], frame: body, fill: GOLD, stroke: "#8a6420", strokeWidth: 0.002 },
      { id: `lantern-light${i + 1}`, kind: "path", d: "M16 30h28l4 32c0 8-10 14-18 14S12 70 12 62z", view: [60, 100], frame: body, fill: "#fff1c1/0.85", opacity: pulse(0, LEN, 1.6 + i * 0.3, 0.75, 1) },
    ],
  };
}

/** Small stars twinkling at their own pace. */
function star(i: number): Layer {
  const x = 0.08 + rnd(i, 21) * 0.84, y = 0.05 + rnd(i, 22) * 0.3, s = 0.018 + rnd(i, 23) * 0.022;
  return {
    id: `star${i + 1}`, kind: "path", d: STAR5, frame: frame(x, y, s, s), fill: "#fff4dc",
    opacity: [[0.4 + i * 0.1, 0, "out"], [0.9 + i * 0.1, 0.8], ...pulse(0.9 + i * 0.1, LEN, 1.4 + rnd(i, 24), 0.8, 0.25).slice(1)],
    scale: pulse(0, LEN, 1.4 + rnd(i, 24), 1, 0.7), glow: { color: "#fff4dc/0.8", blur: 0.01 },
  };
}

const MEDALLION = F({ "9:16": [0.47, 0.38, 0.78, 0.78], "16:9": [0.5, 0.47, 0.86, 0.86], "1:1": [0.5, 0.47, 0.7, 0.7], "4:5": [0.5, 0.46, 0.74, 0.74] });

/**
 * This template's own look (Eid: deep green and gold.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const eidOfferLook: Look = {
  colors: { primary: "#d4a84b", secondary: "#0b3d2e", accent: "#f7dc8a", background: "#062a20", text: "#fff4dc" },
  heading: { family: "Fraunces", weight: 700 }, body: { family: "Hind Siliguri", weight: 500 }, bangla: { family: "Tiro Bangla", weight: 400 },
  radius: 0.6, motion: "smooth", grain: 0.03, grade: { warmth: 0.2 },
  backdrop: ["#1f7a55", "#d4a84b", "#0f5c43", "#04140f", "#0b3d2e"],
};

export const eidOffer: Template = {
  version: FORMAT_VERSION,
  id: "festive-eid",
  name: "Eid Offer",
  category: "festive",
  description: "Deep green and gold: swinging lanterns, a glowing crescent and your Eid offer under ঈদ মোবারক.",
  tags: ["eid", "eid mubarak", "ঈদ", "festive", "bangladesh", "offer", "sale", "greeting", "ramadan"],
  length: LEN,
  hold: [2.6, EXIT],
  shapes: ALL_SHAPES,
  look: eidOfferLook,
  light: { x: [[0, 0.7], [LEN, 0.75]], y: 0.18 },
  fields: [
    { id: "greeting", kind: "text", label: "Greeting", en: "Eid Mubarak", bn: "ঈদ মোবারক", limit: 24 },
    { id: "offer", kind: "text", label: "Offer", en: "20% off everything this Eid", bn: "ঈদ উপলক্ষে সব পণ্যে ২০% ছাড়", limit: 48 },
    { id: "dates", kind: "text", label: "Dates", en: "Until 10 April", bn: "১০ এপ্রিল পর্যন্ত", limit: 28 },
    { id: "cta", kind: "text", label: "Button", en: "Shop now", bn: "এখনই কিনুন", limit: 20 },
    { id: "logo", kind: "media", label: "Logo", en: "", bind: "logo" },
    { id: "brand", kind: "text", label: "Brand (without a logo)", en: "Lumen & Co.", bn: "লুমেন অ্যান্ড কো.", limit: 32 },
  ],
  hits: [{ t: 0.2, sfx: "chime" }, { t: 1.0, sfx: "rise" }, { t: 1.6, sfx: "ding" }, { t: 2.3, sfx: "pop" }],
  layers: [
    ...backdrop("aurora", "drift", {
      intensity: 0.75, overIntensity: 0.6, speed: 0.7,
    }),
    ...Array.from({ length: 7 }, (_, i) => star(i)),
    {
      id: "medallion", kind: "path", d: petals(16, 46, 30, 6) + dotRing(32, 48, 0.8), frame: MEDALLION, stroke: "#d4a84b/0.3", strokeWidth: 0.0018,
      opacity: vis(0.6, 1.2, EXIT, 0.6), rotate: [[0, -20, "linear"], [LEN, 20]], scale: [[0.6, 0.85, "out"], [2.0, 1]],
    },
    {
      id: "medallion-inner", kind: "path", d: petals(8, 30, 14, 8), frame: MEDALLION, stroke: "#d4a84b/0.22", strokeWidth: 0.0018,
      opacity: vis(0.8, 1.2, EXIT, 0.6), rotate: [[0, 15, "linear"], [LEN, -15]],
    },
    { id: "moon-glow", kind: "ellipse", frame: MOON, fill: { kind: "radial", stops: [[0, "#ffe7a3/0.45"], [1, "#ffe7a3/0"]] }, scale: [[0.5, 1.2, "out"], [2.0, 2.2]], opacity: vis(0.5, 1.0, EXIT, 0.5), idle: { scale: 0.1 } },
    {
      id: "moon", kind: "path", d: CRESCENT, frame: MOON, fill: GOLD, glow: { color: "#ffe7a3/0.6", blur: 0.03 },
      dy: [[0.5, 0.12, "out"], [1.8, 0]], rotate: [[0.5, -25, "out"], [2.0, -10]], opacity: vis(0.5, 0.8, EXIT, 0.5), idle: { dy: -0.01 },
    },
    {
      id: "moon-star", kind: "path", d: STAR5, fill: "#fff4dc", glow: { color: "#fff4dc/0.9", blur: 0.015 },
      frame: F({ "9:16": [0.6, 0.21, 0.06, 0.06], "16:9": [0.77, 0.26, 0.065, 0.065], "1:1": [0.69, 0.2, 0.055, 0.055], "4:5": [0.69, 0.19, 0.057, 0.057] }),
      scale: [[1.4, 0, "back"], [1.9, 1], ...pulse(1.9, LEN, 2.0, 1, 0.8).slice(1)], rotate: [[1.4, -90, "out"], [2.1, 0]],
    },
    ...[0, 1, 2].map((i) => lantern(i)),
    txt("greeting", "greeting", F({
      "9:16": [0.47, 0.38, 0.78, 0.15], "16:9": [0.5, 0.46, 1.3, 0.2], "1:1": [0.5, 0.45, 0.86, 0.15], "4:5": [0.5, 0.44, 0.86, 0.16],
    }), {
      role: "headline",
      font: "heading", weight: 700, size: 0.13, minSize: 0.07, lines: 1, color: GOLD, textAt: { "16:9": { size: 0.16 }, "1:1": { size: 0.115 } },
      shadow: { color: "#000000/0.4", blur: 0.03, y: 0.01, follow: true }, lightWrap: { color: "#ffe7a3", amount: 0.5 },
      animate: settle(), exit: outFade(EXIT, 0.4),
    }),
    txt("offer", "offer", F({
      "9:16": [0.47, 0.46, 0.74, 0.1], "16:9": [0.5, 0.6, 1.1, 0.07], "1:1": [0.5, 0.565, 0.8, 0.065], "4:5": [0.5, 0.55, 0.8, 0.075],
    }), {
      role: "cta",
      font: "heading", weight: 600, size: 0.045, minSize: 0.044, lines: 2, color: CREAM, textAt: { "16:9": { lines: 1 }, "1:1": { lines: 1 } },
      animate: riseWords(1.5, 0.05, 0.5), exit: outWords(EXIT),
    }),
    txt("dates", "dates", F({
      "9:16": [0.47, 0.515, 0.7, 0.045], "16:9": [0.5, 0.67, 0.9, 0.05], "1:1": [0.5, 0.63, 0.7, 0.045], "4:5": [0.5, 0.615, 0.7, 0.045],
    }), {
      role: "detail",
      size: 0.036, minSize: 0.036, lines: 1, color: "#f7dc8a/0.85", upper: true, tracking: 0.16,
      animate: riseWords(1.75, 0.05, 0.45), exit: outFade(EXIT, 0.25),
    }),
    {
      id: "button", kind: "rect", radius: "pill", fill: GOLD, shadow: { color: "#000000/0.35", blur: 0.02, y: 0.008, follow: true },
      frame: F({ "9:16": [0.47, 0.565, 0.44, 0.075], "16:9": [0.5, 0.78, 0.4, 0.09], "1:1": [0.5, 0.73, 0.38, 0.075], "4:5": [0.5, 0.715, 0.38, 0.075] }),
      scale: pop(2.3, 0.6, 0.5, EXIT, 0.9), opacity: vis(2.3, 0.2, EXIT, 0.3),
      sheen: { at: [[2.9, -0.2, "inOut"], [3.7, 1.2], [4.6, -0.2, "inOut"], [5.4, 1.2]], width: 0.22, angle: 20, strength: 0.5 },
    },
    txt("cta", "cta", F({
      "9:16": [0.47, 0.565, 0.38, 0.045], "16:9": [0.5, 0.78, 0.34, 0.055], "1:1": [0.5, 0.73, 0.32, 0.045], "4:5": [0.5, 0.715, 0.32, 0.045],
    }), {
      role: "cta",
      font: "heading", weight: 800, size: 0.044, minSize: 0.044, lines: 1, color: "#3b2a08", animate: popWords(2.4), exit: outFade(EXIT, 0.25),
    }),
    {
      id: "logo", kind: "image", slot: "logo", ifFilled: "logo", fit: "contain",
      frame: F({ "9:16": [0.47, 0.625, 0.2, 0.06], "16:9": [0.5, 0.89, 0.24, 0.08], "1:1": [0.5, 0.86, 0.22, 0.07], "4:5": [0.5, 0.845, 0.22, 0.07] }),
      opacity: vis(2.6, 0.4, EXIT, 0.3),
    },
    txt("brand", "brand", F({
      "9:16": [0.47, 0.625, 0.6, 0.045], "16:9": [0.5, 0.89, 0.8, 0.045], "1:1": [0.5, 0.86, 0.6, 0.04], "4:5": [0.5, 0.845, 0.6, 0.04],
    }), {
      role: "body",
      ifEmpty: "logo", size: 0.044, minSize: 0.044, lines: 1, color: CREAM + "/0.7", upper: true, tracking: 0.2,
      animate: riseWords(2.6, 0.05, 0.45), exit: outFade(EXIT, 0.25),
    }),
  ],
};
