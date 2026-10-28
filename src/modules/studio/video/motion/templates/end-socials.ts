import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Shape } from "../layout";
import { ICON_CHOICES } from "../icons";
import { ALL_SHAPES, across, frame, pop } from "./build";
import { F, backdrop, outFade, riseWords, scrim, settle, slideWords, txt, vis } from "./common-b";

/**
 * Follow Card: an end screen. The logo drops into a ring, the brand name rises, and three
 * handle rows slide in from alternating sides, each icon drawing itself. Generic icons only:
 * the user picks which (camera, globe, music…) for each of their accounts.
 */

const EXIT = 5.6;
const AT = [1.4, 1.75, 2.1];
/** The rows: middle x and the first row's y (canvas fractions), the gap between rows and their width (short sides). */
const ROWS: Record<Shape, { x: number; y: number; gap: number; w: number }> = {
  "9:16": { x: 0.47, y: 0.53, gap: 0.115, w: 0.74 },
  "16:9": { x: 0.67, y: 0.32, gap: 0.18, w: 0.82 },
  "1:1": { x: 0.5, y: 0.6, gap: 0.12, w: 0.7 },
  "4:5": { x: 0.5, y: 0.56, gap: 0.125, w: 0.72 },
};
/** A box in row `i`: `x0` short sides in from the row's left, `w` wide (or to the row's end, less padding). */
const inRow = (i: number, x0: number, w: number | null, h: number, ax = 0.5) => across((shape, d) => {
  const r = ROWS[shape];
  return frame(r.x + (x0 - r.w / 2) / d.w, r.y + (i * r.gap) / d.h, w ?? r.w - x0 - 0.04, h, ax);
});
const rowBox = (i: number) => across((shape, d) => {
  const r = ROWS[shape];
  return frame(r.x, r.y + (i * r.gap) / d.h, r.w, 0.095);
});

function handle(i: number): Layer[] {
  const t = AT[i], n = i + 1, side = i % 2 ? 0.7 : -0.7;
  return [
    {
      id: `row${n}`, kind: "rect", frame: rowBox(i), radius: "pill", fill: "@surface", stroke: "@text/0.12", strokeWidth: 0.002,
      dx: [[t, side * 0.4, "out"], [t + 0.5, 0], [EXIT + i * 0.05, 0, "in"], [EXIT + 0.35 + i * 0.05, -side * 0.3]],
      opacity: vis(t, 0.3, EXIT + i * 0.05, 0.3),
    },
    { id: `dot${n}`, kind: "ellipse", frame: inRow(i, 0.06, 0.07, 0.07), fill: i === 1 ? "@accent" : "@primary", scale: pop(t + 0.2, 0.3, 0.45, EXIT + i * 0.05, 0.5), opacity: vis(t + 0.2, 0.15, EXIT + i * 0.05, 0.25) },
    {
      id: `icon${n}`, kind: "icon", field: `icon${n}`, frame: inRow(i, 0.06, 0.04, 0.04), color: i === 1 ? "@onAccent" : "@onPrimary", strokeWidth: 2,
      draw: [[t + 0.3, 0, "inOut"], [t + 0.9, 1]], opacity: vis(t + 0.3, 0.15, EXIT + i * 0.05, 0.25),
    },
    txt(`handle${n}`, `handle${n}`, inRow(i, 0.12, null, 0.05, 0), {
      role: "body", font: "heading", weight: 600, size: 0.044, minSize: 0.044, lines: 1, align: "left",
      animate: slideWords(t + 0.25, side * 0.5, 0.04, 0.45), exit: outFade(EXIT + i * 0.05, 0.25),
    }),
  ];
}

/**
 * This template's own look (Ocean: deep teal-navy, bright cyan.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const followCardLook: Look = {
  colors: { primary: "#00b4d8", secondary: "#023e8a", accent: "#90e0ef", background: "#0b1f2a", text: "#e8fbff" },
  heading: { family: "Outfit", weight: 700 }, body: { family: "Inter", weight: 500 }, bangla: { family: "Anek Bangla", weight: 600 },
  radius: 0.8, motion: "smooth", grain: 0.02,
};

export const followCard: Template = {
  version: FORMAT_VERSION,
  id: "end-socials",
  name: "Follow Card",
  category: "hook",
  description: "An end screen: your logo, a follow line and three of your handles, each with an icon you choose.",
  tags: ["end screen", "end card", "follow", "socials", "handles", "outro", "contact"],
  length: 6.2,
  hold: [2.8, EXIT],
  shapes: ALL_SHAPES,
  look: followCardLook,
  fields: [
    { id: "logo", kind: "media", label: "Logo", en: "", bind: "logo" },
    { id: "title", kind: "text", label: "Headline", en: "Follow for more", bn: "আরও পেতে ফলো করুন", limit: 32 },
    { id: "brand", kind: "text", label: "Brand", en: "Lumen & Co.", bn: "লুমেন অ্যান্ড কো.", limit: 32 },
    { id: "icon1", kind: "choice", label: "Icon 1", en: "camera", options: ICON_CHOICES },
    { id: "handle1", kind: "text", label: "Handle 1", en: "@lumen.co", bn: "@lumen.co", limit: 28 },
    { id: "icon2", kind: "choice", label: "Icon 2", en: "music", options: ICON_CHOICES },
    { id: "handle2", kind: "text", label: "Handle 2", en: "@lumenandco", bn: "@lumenandco", limit: 28 },
    { id: "icon3", kind: "choice", label: "Icon 3", en: "globe", options: ICON_CHOICES },
    { id: "handle3", kind: "text", label: "Handle 3", en: "lumen.co", bn: "lumen.co", limit: 28 },
  ],
  hits: [{ t: 0.2, sfx: "pop" }, { t: AT[0] - 0.1, sfx: "swoosh" }, { t: AT[1] - 0.1, sfx: "swoosh" }, { t: AT[2] - 0.1, sfx: "swoosh" }],
  layers: [
    ...backdrop("glass", "drift", { intensity: 0.5, overIntensity: 0.35 }),
    scrim("scrim", F({ "9:16": [0.47, 0.3, 1.0, 0.6], "16:9": [0.24, 0.48, 0.9, 0.8], "1:1": [0.5, 0.27, 1.0, 0.5], "4:5": [0.5, 0.27, 1.0, 0.55] })),
    {
      id: "ring", kind: "path", d: "M50 3A47 47 0 1 1 49.99 3", stroke: "@accent", strokeWidth: 0.006, cap: "round",
      frame: F({ "9:16": [0.47, 0.235, 0.26, 0.26], "16:9": [0.24, 0.36, 0.3, 0.3], "1:1": [0.5, 0.2, 0.22, 0.22], "4:5": [0.5, 0.205, 0.24, 0.24] }),
      draw: [[0.15, 0, "inOut"], [0.9, 1]], opacity: vis(0.15, 0.15, EXIT, 0.35), rotate: [[0.15, -90, "out"], [1.2, 0]],
    },
    {
      id: "logo", kind: "image", slot: "logo", ifFilled: "logo", fit: "contain",
      frame: F({ "9:16": [0.47, 0.235, 0.17, 0.17], "16:9": [0.24, 0.36, 0.2, 0.2], "1:1": [0.5, 0.2, 0.14, 0.14], "4:5": [0.5, 0.205, 0.16, 0.16] }),
      dy: [[0.3, -0.25, "spring"], [1.0, 0]], opacity: vis(0.3, 0.2, EXIT, 0.35), scale: [[EXIT, 1, "in"], [EXIT + 0.35, 0.7]],
    },
    {
      id: "mark", kind: "icon", icon: "heart", ifEmpty: "logo", color: "@primary", strokeWidth: 2,
      frame: F({ "9:16": [0.47, 0.235, 0.12, 0.12], "16:9": [0.24, 0.36, 0.14, 0.14], "1:1": [0.5, 0.2, 0.1, 0.1], "4:5": [0.5, 0.205, 0.11, 0.11] }),
      dy: [[0.3, -0.25, "spring"], [1.0, 0]], opacity: vis(0.3, 0.2, EXIT, 0.35),
    },
    txt("title", "title", F({
      "9:16": [0.47, 0.35, 0.78, 0.09], "16:9": [0.24, 0.6, 0.76, 0.1], "1:1": [0.5, 0.33, 0.86, 0.08], "4:5": [0.5, 0.33, 0.86, 0.085],
    }), {
      role: "headline",
      font: "heading", weight: 800, size: 0.075, minSize: 0.07, lines: 1, textAt: { "1:1": { size: 0.07 } },
      animate: settle(), exit: outFade(EXIT, 0.3),
    }),
    txt("brand", "brand", F({
      "9:16": [0.47, 0.405, 0.78, 0.05], "16:9": [0.24, 0.69, 0.76, 0.055], "1:1": [0.5, 0.405, 0.86, 0.045], "4:5": [0.5, 0.4, 0.86, 0.05],
    }), {
      role: "body",
      size: 0.044, minSize: 0.044, lines: 1, color: "@text/0.6", upper: true, tracking: 0.18,
      animate: riseWords(0.95, 0.05, 0.45), exit: outFade(EXIT, 0.3),
    }),
    ...handle(0),
    ...handle(1),
    ...handle(2),
  ],
};

