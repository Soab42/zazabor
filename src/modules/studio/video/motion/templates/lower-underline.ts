import { FORMAT_VERSION, type Template } from "../format";
import type { Look } from "../brand";
import { ALL_SHAPES } from "./build";
import { F, drawOn, outWords, settle, txt } from "./common-b";

/**
 * Underline: the lightest lower third. No plate: the name slides in word by word in white over
 * the video, a brush-like underline draws beneath it in the accent colour, and the role follows.
 */

const EXIT = 4.2;
const SHADOW = { color: "#000000/0.55", blur: 0.02, y: 0.004 };

const NAME = F({
  "9:16": [0.08, 0.655, 0.74, 0.08, 0], "16:9": [0.06, 0.755, 1.0, 0.1, 0], "1:1": [0.06, 0.775, 0.7, 0.09, 0], "4:5": [0.06, 0.795, 0.7, 0.09, 0],
});
const UNDERLINE = F({
  "9:16": [0.08, 0.7, 0.34, 0.04, 0], "16:9": [0.06, 0.82, 0.4, 0.04, 0], "1:1": [0.06, 0.835, 0.34, 0.04, 0], "4:5": [0.06, 0.845, 0.34, 0.04, 0],
});
const ROLE = F({
  "9:16": [0.08, 0.73, 0.74, 0.045, 0], "16:9": [0.06, 0.875, 1.0, 0.06, 0], "1:1": [0.06, 0.885, 0.7, 0.05, 0], "4:5": [0.06, 0.885, 0.7, 0.05, 0],
});

/**
 * This template's own look (Serif name over video, a marigold stroke.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const underlineBarLook: Look = {
  colors: { primary: "#ffd166", secondary: "#2b2d42", accent: "#ffd166", background: "#111111", text: "#ffffff" },
  heading: { family: "DM Serif Display", weight: 400 }, body: { family: "Inter", weight: 500 }, bangla: { family: "Tiro Bangla", weight: 400 },
  radius: 0.3, motion: "smooth",
};

export const underlineBar: Template = {
  version: FORMAT_VERSION,
  id: "lower-underline",
  name: "Underline",
  category: "lower",
  description: "No plate, just type: the name slides in over your video and a brushed underline draws beneath it.",
  tags: ["lower third", "name", "minimal", "underline", "interview", "vlog", "overlay"],
  length: 4.8,
  hold: [1.2, EXIT],
  shapes: ALL_SHAPES,
  look: underlineBarLook,
  overlay: true,
  fields: [
    { id: "name", kind: "text", label: "Name", en: "Nadia Karim", bn: "নাদিয়া করিম", limit: 32 },
    { id: "role", kind: "text", label: "Role", en: "Chef & food writer", bn: "রাঁধুনি ও খাদ্য লেখক", limit: 48 },
  ],
  hits: [{ t: 0.05, sfx: "swoosh" }, { t: 0.45, sfx: "swoosh" }],
  layers: [
    txt("name", "name", NAME, {
      role: "body",
      font: "heading", weight: 700, size: 0.06, minSize: 0.044, lines: 1, align: "left", color: "#ffffff", shadow: SHADOW,
      textAt: { "16:9": { size: 0.064 } }, animate: settle(), exit: outWords(EXIT),
    }),
    {
      id: "underline", kind: "path", frame: UNDERLINE, d: "M3 60C24 46 52 40 97 48M14 74C40 62 66 60 88 64", view: [100, 100],
      stroke: "@accent", strokeWidth: 0.008, cap: "round", shadow: SHADOW, draw: drawOn(0.5, 1.0, [EXIT - 0.05, EXIT + 0.3]),
    },
    {
      id: "sparks", kind: "fx", fx: "sparks", burst: 0.95, color: "@accent", color2: "#ffffff", amount: 0.5,
      frame: F({ "9:16": [0.4, 0.7, 0.14, 0.14], "16:9": [0.27, 0.82, 0.16, 0.16], "1:1": [0.37, 0.835, 0.14, 0.14], "4:5": [0.37, 0.845, 0.14, 0.14] }),
    },
    txt("role", "role", ROLE, {
      role: "detail",
      size: 0.036, minSize: 0.036, lines: 1, align: "left", color: "#ffffff/0.9", shadow: SHADOW,
      animate: { unit: "word", t: 0.75, stagger: 0.05, duration: 0.45, from: { opacity: 0, dy: 0.6 } }, exit: outWords(EXIT + 0.05, 0.25),
    }),
  ],
};
