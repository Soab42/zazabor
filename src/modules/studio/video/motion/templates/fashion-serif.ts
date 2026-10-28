import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Responsive, Shape } from "../layout";
import { ALL_SHAPES, DIAMOND, across, frame } from "./build";
import { F, backdrop, drawOn, outFade, scrim, txt, vis } from "./common-b";

/**
 * Serif Card: a quiet, expensive title card. A fine double border draws itself around the frame,
 * small diamonds settle at its corners, and the title gathers from wide letter spacing out of a
 * soft blur, in light italic. Slow on purpose: everything eases over a second or more.
 */

const EXIT = 5.4;

const BORDER = F({ "9:16": [0.47, 0.44, 0.8, 1.2], "16:9": [0.5, 0.5, 1.66, 0.88], "1:1": [0.5, 0.5, 0.88, 0.88], "4:5": [0.5, 0.5, 0.88, 1.13] });
const INNER = F({ "9:16": [0.47, 0.44, 0.76, 1.16], "16:9": [0.5, 0.5, 1.62, 0.84], "1:1": [0.5, 0.5, 0.84, 0.84], "4:5": [0.5, 0.5, 0.84, 1.09] });
/** The corners of the border per shape (canvas fractions). */
const CORNERS: Record<Shape, [number, number][]> = {
  "9:16": [[0.07, 0.1], [0.87, 0.1], [0.07, 0.775], [0.87, 0.775]],
  "16:9": [[0.033, 0.06], [0.967, 0.06], [0.033, 0.94], [0.967, 0.94]],
  "1:1": [[0.06, 0.06], [0.94, 0.06], [0.06, 0.94], [0.94, 0.94]],
  "4:5": [[0.06, 0.048], [0.94, 0.048], [0.06, 0.952], [0.94, 0.952]],
};
const corner = (i: number): Responsive => across((shape) => frame(CORNERS[shape][i][0], CORNERS[shape][i][1], 0.04, 0.04));

/**
 * This template's own look (Noir and gold.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const serifCardLook: Look = {
  colors: { primary: "#c9a96e", secondary: "#2a2118", accent: "#c9a96e", background: "#0d0b09", text: "#f7f1e3" },
  heading: { family: "Playfair Display", weight: 400 }, body: { family: "Manrope", weight: 400 }, bangla: { family: "Tiro Bangla", weight: 400 },
  radius: 0, motion: "smooth", grain: 0.03, grade: { warmth: 0.15, fade: 0.06 },
  backdrop: ["#8a6d3b", "#2a2118", "#c9a96e", "#050403", "#0d0b09"],
};

export const serifCard: Template = {
  version: FORMAT_VERSION,
  id: "fashion-serif",
  name: "Serif Card",
  category: "fashion",
  description: "A slow, elegant title card: a fine double border draws in and the title gathers in light italic.",
  tags: ["fashion", "beauty", "elegant", "luxury", "title card", "serif", "minimal", "collection"],
  length: 6.0,
  hold: [2.8, EXIT],
  shapes: ALL_SHAPES,
  look: serifCardLook,
  fields: [
    { id: "kicker", kind: "text", label: "Above the title", en: "The collection", bn: "কালেকশন", limit: 24 },
    { id: "title", kind: "text", label: "Title", en: "Autumn Winter", bn: "শীতের সাজ", limit: 28, multiline: true },
    { id: "line", kind: "text", label: "Below the title", en: "Dhaka · Est. 2019", bn: "ঢাকা · ২০১৯ থেকে", limit: 36 },
  ],
  hits: [{ t: 0.2, sfx: "rise" }, { t: 1.3, sfx: "chime" }],
  layers: [
    ...backdrop("glass", "bokeh", { intensity: 0.45, overIntensity: 0.3, speed: 0.5, overSoft: 0.8 }),
    scrim("scrim", INNER, 0.7),
    { id: "border", kind: "path", d: "M50 0H100V100H0V0Z", frame: BORDER, stroke: "@accent/0.8", strokeWidth: 0.0018, cap: "butt", draw: drawOn(0.1, 1.6), opacity: vis(0.1, 0.15, EXIT, 0.6) },
    { id: "inner", kind: "path", d: "M50 100H0V0H100V100Z", frame: INNER, stroke: "@accent/0.45", strokeWidth: 0.0012, cap: "butt", draw: drawOn(0.4, 1.9), opacity: vis(0.4, 0.15, EXIT, 0.6) },
    ...[0, 1, 2, 3].map((i): Layer => ({
      id: `corner${i + 1}`, kind: "path", d: DIAMOND, frame: corner(i), fill: "@bg", stroke: "@accent", strokeWidth: 0.0018,
      scale: [[1.2 + i * 0.08, 0, "back"], [1.8 + i * 0.08, 1], [EXIT, 1, "in"], [EXIT + 0.5, 0]], rotate: [[1.2 + i * 0.08, -90, "out"], [2.0 + i * 0.08, 0]],
    })),
    txt("kicker", "kicker", F({
      "9:16": [0.47, 0.3, 0.66, 0.045], "16:9": [0.5, 0.3, 1.2, 0.05], "1:1": [0.5, 0.3, 0.7, 0.045], "4:5": [0.5, 0.31, 0.7, 0.045],
    }), {
      role: "detail",
      size: 0.036, minSize: 0.036, lines: 1, upper: true, color: "@text/0.75", weight: 500,
      tracking: [[0.9, 0.6, "out"], [2.4, 0.36]], opacity: vis(0.9, 0.9, EXIT - 0.1, 0.5), exit: outFade(EXIT - 0.1, 0.5),
    }),
    txt("title", "title", F({
      "9:16": [0.47, 0.44, 0.7, 0.3], "16:9": [0.5, 0.5, 1.3, 0.3], "1:1": [0.5, 0.5, 0.74, 0.28], "4:5": [0.5, 0.5, 0.74, 0.3],
    }), {
      role: "headline",
      font: "heading", weight: 300, italic: true, size: 0.11, minSize: 0.07, lines: 2, lineHeight: 1.05,
      textAt: { "16:9": { size: 0.13, lines: 1 }, "1:1": { size: 0.095 } },
      tracking: [[0, 0.3, "out"], [2.4, 0.02]], opacity: [[0, 0.6, "out"], [1.4, 1], [EXIT, 1, "in"], [EXIT + 0.6, 0]], blur: [[0, 0.006, "out"], [1.4, 0]],
      exit: outFade(EXIT, 0.6),
    }),
    {
      id: "rule", kind: "path", d: "M0 50H42M58 50H100M47 50a3 3 0 1 0 6 0a3 3 0 1 0-6 0", stroke: "@accent/0.8", strokeWidth: 0.0016,
      frame: F({ "9:16": [0.47, 0.58, 0.3, 0.03], "16:9": [0.5, 0.68, 0.34, 0.03], "1:1": [0.5, 0.67, 0.3, 0.03], "4:5": [0.5, 0.655, 0.3, 0.03] }),
      draw: drawOn(1.7, 2.6, [EXIT - 0.1, EXIT + 0.4]),
    },
    txt("line", "line", F({
      "9:16": [0.47, 0.62, 0.66, 0.045], "16:9": [0.5, 0.76, 1.2, 0.05], "1:1": [0.5, 0.735, 0.7, 0.045], "4:5": [0.5, 0.715, 0.7, 0.045],
    }), {
      role: "body",
      size: 0.044, minSize: 0.044, lines: 1, color: "@text/0.65", tracking: 0.14, upper: true,
      animate: { unit: "word", t: 2.0, stagger: 0.12, duration: 0.9, from: { opacity: 0, blur: 0.1 } }, exit: outFade(EXIT - 0.1, 0.5),
    }),
  ],
};
