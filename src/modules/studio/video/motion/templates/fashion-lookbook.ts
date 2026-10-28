import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Responsive, Shape } from "../layout";
import { ALL_SHAPES, across, frame } from "./build";
import { BAG, DRESS, PANTS, SHIRT, backdrop, outFade, outLine, riseWords, settle, txt } from "./common-b";

/**
 * Lookbook: four looks in a grid (a row, in 16:9). Each tile drops in on its own beat, the photo
 * inside settling as it lands; the title sets in wide capitals. Empty tiles show a garment drawn
 * on a tint of the kit (a dress, a tee, a bag, trousers).
 */

const EXIT = 5.6;
const BEATS = [0.35, 0.55, 0.75, 0.95];
const TINTS = ["@primary/0.28", "@accent/0.3", "@secondary", "@surface"];
const GARMENTS = [DRESS, SHIRT, BAG, PANTS];

/** The grid per shape: its left and top (canvas fractions), columns, tile size and gap (short sides). */
const GRID: Record<Shape, { x: number; y: number; cols: number; w: number; h: number; gap: number }> = {
  "9:16": { x: 0.07, y: 0.255, cols: 2, w: 0.385, h: 0.42, gap: 0.03 },
  "16:9": { x: 0.335, y: 0.19, cols: 4, w: 0.26, h: 0.62, gap: 0.03 },
  "1:1": { x: 0.06, y: 0.225, cols: 2, w: 0.425, h: 0.345, gap: 0.03 },
  "4:5": { x: 0.06, y: 0.2, cols: 2, w: 0.425, h: 0.44, gap: 0.03 },
};
const tile = (i: number, k = 1): Responsive => across((shape, d) => {
  const g = GRID[shape];
  const c = i % g.cols, r = Math.floor(i / g.cols);
  return frame(g.x + (c * (g.w + g.gap) + g.w / 2) / d.w, g.y + (r * (g.h + g.gap) + g.h / 2) / d.h, g.w * k, g.h * k);
});

function look(i: number): Layer {
  const t = BEATS[i], n = i + 1, out = EXIT + (3 - i) * 0.06;
  return {
    id: `look${n}`, kind: "group", frame: tile(i), clip: "round",
    scale: [[t, 0.82, "out"], [t + 0.6, 1], [out, 1, "in"], [out + 0.35, 0.9]], opacity: [[t, 0, "out"], [t + 0.3, 1], [out, 1, "in"], [out + 0.35, 0]],
    dy: [[t, 0.08, "out"], [t + 0.6, 0]],
    children: [
      { id: `tint${n}`, kind: "rect", frame: tile(i), fill: TINTS[i] },
      {
        id: `garment${n}`, kind: "path", ifEmpty: `photo${n}`, d: GARMENTS[i], frame: tile(i, 0.62), fill: i === 2 ? "@accent" : "@primary",
        stroke: "@text/0.25", strokeWidth: 0.002, dy: [[t, 0.03, "out"], [t + 0.9, 0]], idle: { dy: -0.01 },
      },
      { id: `photo${n}`, kind: "image", slot: `photo${n}`, ifFilled: `photo${n}`, fit: "cover", frame: tile(i), scale: [[t, 1.18, "out"], [t + 1.4, 1]], idle: { scale: 0.04 } },
    ],
  };
}

/**
 * This template's own look (Monochrome: black, white and a thread of gold.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const lookbookGridLook: Look = {
  colors: { primary: "#f2f2f2", secondary: "#2a2a2a", accent: "#c9a227", background: "#0c0c0c", text: "#f2f2f2" },
  heading: { family: "Bebas Neue", weight: 400 }, body: { family: "Inter", weight: 400 }, bangla: { family: "Anek Bangla", weight: 600 },
  radius: 0.15, motion: "smooth", grain: 0.03, grade: { saturation: 0.85, fade: 0.04 },
};

export const lookbookGrid: Template = {
  version: FORMAT_VERSION,
  id: "fashion-lookbook",
  name: "Lookbook",
  category: "fashion",
  description: "Four looks drop into a grid one after another under a wide-set title.",
  tags: ["fashion", "lookbook", "grid", "collection", "outfits", "collage", "clothing"],
  length: 6.2,
  hold: [2.0, EXIT],
  shapes: ALL_SHAPES,
  look: lookbookGridLook,
  fields: [
    { id: "title", kind: "text", label: "Title", en: "Lookbook", bn: "লুকবুক", limit: 20 },
    { id: "season", kind: "text", label: "Season", en: "Summer 2026", bn: "গ্রীষ্ম ২০২৬", limit: 28 },
    { id: "photo1", kind: "media", label: "Look 1", en: "" },
    { id: "photo2", kind: "media", label: "Look 2", en: "" },
    { id: "photo3", kind: "media", label: "Look 3", en: "" },
    { id: "photo4", kind: "media", label: "Look 4", en: "" },
  ],
  hits: [{ t: BEATS[0], sfx: "shutter" }, { t: BEATS[1], sfx: "shutter" }, { t: BEATS[2], sfx: "shutter" }, { t: BEATS[3], sfx: "shutter" }],
  layers: [
    ...backdrop("bokeh", "glass", { intensity: 0.55, overIntensity: 0.35, speed: 0.7, soft: 0.5 }),
    txt("title", "title", across((shape) => shape === "16:9" ? frame(0.04, 0.42, 0.5, 0.13, 0) : shape === "9:16" ? frame(0.07, 0.172, 0.8, 0.1, 0) : frame(0.06, shape === "1:1" ? 0.1 : 0.085, 0.88, 0.09, 0)), {
      role: "headline",
      font: "heading", weight: 800, size: 0.09, minSize: 0.07, lines: 1, align: "left", upper: true, tracking: 0.06,
      textAt: { "16:9": { size: 0.075 }, "1:1": { size: 0.075 } },
      animate: settle(), exit: outLine(EXIT + 0.1),
    }),
    txt("season", "season", across((shape) => shape === "16:9" ? frame(0.04, 0.53, 0.5, 0.06, 0) : shape === "9:16" ? frame(0.07, 0.225, 0.8, 0.05, 0) : frame(0.06, shape === "1:1" ? 0.168 : 0.148, 0.88, 0.05, 0)), {
      role: "detail",
      italic: true, size: 0.036, minSize: 0.036, lines: 1, align: "left", color: "@text/0.7",
      animate: riseWords(0.4, 0.06, 0.45), exit: outFade(EXIT + 0.1, 0.25),
    }),
    ...BEATS.map((_, i) => look(i)),
  ],
};
