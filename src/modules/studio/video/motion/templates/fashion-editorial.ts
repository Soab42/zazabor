import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import { ALL_SHAPES } from "./build";
import { DRESS, F, backdrop, drawOn, outFade, outLine, outWords, riseWords, settle, txt, vis } from "./common-b";

/**
 * Editorial: a magazine spread. The photo fills one side (the top, in the tall shapes) inside a
 * hairline margin and slowly settles; the masthead side sets a small kicker, a large italic title,
 * a line of copy and "Shop the look". With no photo, a dress on a stand is drawn in its place.
 */

const EXIT = 5.6;

const PHOTO = F({
  "9:16": [0.47, 0.14, 0.8, 0.52, 0.5, 0], "16:9": [0.03, 0.5, 0.82, 0.9, 0, 0.5], "1:1": [0.05, 0.5, 0.46, 0.9, 0, 0.5], "4:5": [0.5, 0.04, 0.9, 0.62, 0.5, 0],
});
/** The text column's left edge and width, then where each line sits. */
const col = (y916: number, y169: number, y11: number, y45: number, h: number, w = 1) => F({
  "9:16": [0.07, y916, 0.8 * w, h, 0], "16:9": [0.54, y169, 0.74 * w, h, 0], "1:1": [0.55, y11, 0.4 * w, h, 0], "4:5": [0.05, y45, 0.9 * w, h, 0],
});

/** The drawn stand-in: a backdrop, an arch, a dress on a hanger and its shadow. */
const standIn: Layer[] = [
  { id: "backdrop", kind: "rect", ifEmpty: "photo", frame: PHOTO, fill: { kind: "linear", angle: 180, stops: [[0, "#e9d8c4"], [1, "#cfa98a"]] } },
  {
    id: "arch", kind: "path", ifEmpty: "photo", d: "M20 100V45a30 30 0 0 1 60 0v55z", fill: "#f3e6d6/0.7",
    frame: F({ "9:16": [0.47, 0.16, 0.42, 0.46, 0.5, 0], "16:9": [0.29, 0.5, 0.48, 0.8], "1:1": [0.28, 0.5, 0.3, 0.8], "4:5": [0.5, 0.07, 0.5, 0.56, 0.5, 0] }),
  },
  {
    id: "dress", kind: "path", ifEmpty: "photo", d: DRESS, fill: "@primary", stroke: "@primaryDeep", strokeWidth: 0.003,
    frame: F({ "9:16": [0.47, 0.162, 0.3, 0.44, 0.5, 0], "16:9": [0.29, 0.5, 0.42, 0.7], "1:1": [0.28, 0.5, 0.26, 0.7], "4:5": [0.5, 0.075, 0.36, 0.5, 0.5, 0] }),
    dy: [[0.3, 0.04, "out"], [1.6, 0]], rotate: [[0.3, -3, "out"], [2.4, 0]], idle: { rotate: 1.5 },
  },
];

/**
 * This template's own look (Cream (light): linen, clay and ink; a high-contrast serif.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const editorialSplitLook: Look = {
  colors: { primary: "#8c5e48", secondary: "#e6d6c3", accent: "#1f1a17", background: "#f3ece2", text: "#1f1a17" },
  heading: { family: "Cormorant Garamond", weight: 600 }, body: { family: "DM Sans", weight: 400 }, bangla: { family: "Tiro Bangla", weight: 400 },
  radius: 0, motion: "smooth", grain: 0.03, grade: { warmth: 0.1, fade: 0.05 },
};

export const editorialSplit: Template = {
  version: FORMAT_VERSION,
  id: "fashion-editorial",
  name: "Editorial",
  category: "fashion",
  description: "A magazine spread: your photo on one side, a kicker, a large italic title and Shop the look on the other.",
  tags: ["fashion", "editorial", "magazine", "split screen", "lookbook", "new season", "clothing"],
  length: 6.2,
  hold: [2.2, EXIT],
  shapes: ALL_SHAPES,
  look: editorialSplitLook,
  fields: [
    { id: "photo", kind: "media", label: "Photo", en: "" },
    { id: "issue", kind: "text", label: "Issue", en: "No. 07", bn: "সংখ্যা ০৭", limit: 14 },
    { id: "kicker", kind: "text", label: "Kicker", en: "New season", bn: "নতুন মৌসুম", limit: 24 },
    { id: "title", kind: "text", label: "Title", en: "The Linen Edit", bn: "লিনেন কালেকশন", limit: 32, multiline: true },
    { id: "line", kind: "text", label: "Copy", en: "Light layers for long, warm days", bn: "গরমের লম্বা দিনের হালকা পোশাক", limit: 60 },
    { id: "cta", kind: "text", label: "Call to action", en: "Shop the look", bn: "লুকটি কিনুন", limit: 22 },
  ],
  hits: [{ t: 0.1, sfx: "shutter" }, { t: 0.7, sfx: "swoosh" }],
  layers: [
    ...backdrop("mesh", "glass", { intensity: 0.6, overIntensity: 0.45, speed: 0.7 }),
    {
      id: "photo-group", kind: "group", frame: PHOTO, clip: "rect",
      reveal: { from: "top", v: [[0.1, 0, "inOut"], [0.9, 1], [EXIT, 1, "in"], [EXIT + 0.5, 0]] },
      children: [
        ...standIn,
        { id: "photo", kind: "image", slot: "photo", ifFilled: "photo", fit: "cover", frame: PHOTO, placeholder: "Your photo", scale: [[0.1, 1.14, "out"], [3.2, 1]], idle: { scale: 0.04 } },
      ],
    },
    {
      id: "margin", kind: "path", d: "M0 0H100V100H0Z", frame: PHOTO, stroke: "@text/0.35", strokeWidth: 0.0015, cap: "butt",
      draw: drawOn(0.6, 1.8), opacity: vis(0.6, 0.15, EXIT, 0.4),
    },
    txt("issue", "issue", col(0.455, 0.12, 0.12, 0.56, 0.04), {
      role: "detail",
      size: 0.036, minSize: 0.036, lines: 1, align: "left", color: "@text/0.6", tracking: 0.12, upper: true,
      animate: riseWords(0.7, 0.04, 0.4), exit: outFade(EXIT, 0.25),
    }),
    txt("kicker", "kicker", col(0.483, 0.27, 0.3, 0.6, 0.045), {
      role: "detail",
      size: 0.036, minSize: 0.036, lines: 1, align: "left", color: "@text/0.75", upper: true, tracking: 0.3, weight: 600,
      animate: riseWords(0.9, 0.05, 0.45), exit: outFade(EXIT, 0.25),
    }),
    txt("title", "title", col(0.535, 0.42, 0.47, 0.69, 0.14), {
      role: "headline",
      font: "heading", italic: true, weight: 500, size: 0.1, minSize: 0.07, lines: 2, align: "left", lineHeight: 1.0, valign: "top",
      textAt: { "16:9": { size: 0.09 }, "1:1": { size: 0.07 }, "4:5": { size: 0.085 } },
      animate: settle(), exit: outLine(EXIT - 0.05, 0.35),
    }),
    txt("line", "line", col(0.6, 0.7, 0.72, 0.815, 0.07), {
      role: "body",
      size: 0.044, minSize: 0.044, lines: 2, align: "left", color: "@text/0.75", lineHeight: 1.25,
      textAt: { "4:5": { lines: 1 } },
      animate: riseWords(1.45, 0.03, 0.45), exit: outWords(EXIT - 0.05, 0.25),
    }),
    txt("cta", "cta", col(0.638, 0.84, 0.86, 0.885, 0.04, 0.7), {
      role: "cta",
      font: "heading", weight: 700, size: 0.044, minSize: 0.044, lines: 1, align: "left", upper: true, tracking: 0.14,
      animate: riseWords(1.75, 0.05, 0.45), exit: outFade(EXIT, 0.25),
    }),
    {
      id: "cta-rule", kind: "path", d: "M0 50H100", stroke: "@text", strokeWidth: 0.003, cap: "butt",
      frame: F({ "9:16": [0.07, 0.652, 0.24, 0.01, 0], "16:9": [0.54, 0.875, 0.26, 0.01, 0], "1:1": [0.55, 0.85, 0.2, 0.01, 0], "4:5": [0.05, 0.91, 0.24, 0.01, 0] }),
      draw: drawOn(1.95, 2.4, [EXIT - 0.1, EXIT + 0.2]),
    },
  ],
};
