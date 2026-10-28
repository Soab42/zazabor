import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Shape } from "../layout";
import { ALL_SHAPES, across, frame, pop } from "./build";
import { F, SHIRT, backdrop, outFade, outWords, popWords, riseWords, settle, txt, vis } from "./common-b";

/**
 * Swatches: one tee, five colours. A ring steps along the swatches and the shirt is washed in each
 * colour from the hem up as the ring lands; the name, price and "available in" line stay put.
 */

const EXIT = 5.6;
/** The shirt's colours: the kit's primary first, then four fixed ones that sit well together. */
const COLOURS = ["@primary", "#c8553d", "#2f6f5e", "#e9c46a", "#1d3557"];
/** When the ring lands on each swatch. */
const PICK = [1.2, 2.0, 2.8, 3.6, 4.4];
const STEP = 0.13;
/** Folds and seams drawn over the shirt. */
const SEAMS = "M34 14c2 7 8 11 16 11s14-4 16-11M30 39v-14M70 39v-14M42 60c4 3 12 3 16 0";
/** The first swatch's middle per shape (canvas fractions). */
const SW: Record<Shape, [number, number]> = { "9:16": [0.21, 0.665], "16:9": [0.58, 0.62], "1:1": [0.24, 0.775], "4:5": [0.24, 0.765] };
const swatch = (i: number, size: number) => across((shape, d) => frame(SW[shape][0] + (i * STEP) / d.w, SW[shape][1], size, size));
const SHIRT_AT = F({ "9:16": [0.47, 0.425, 0.56, 0.56], "16:9": [0.27, 0.52, 0.72, 0.72], "1:1": [0.5, 0.45, 0.5, 0.5], "4:5": [0.5, 0.445, 0.56, 0.56] });

function colourway(i: number): Layer {
  return {
    id: `shirt${i + 1}`, kind: "path", d: SHIRT, frame: SHIRT_AT, fill: COLOURS[i], stroke: "#000000/0.18", strokeWidth: 0.003,
    reveal: i === 0 ? undefined : { from: "bottom", v: [[PICK[i], 0, "inOut"], [PICK[i] + 0.45, 1]], soft: 0.06 },
    opacity: vis(0.3, 0.3, EXIT, 0.35), scale: pop(0.3, 0.85, 0.6, EXIT, 0.9),
  };
}

/**
 * This template's own look (Pastel (light): powder blue and blush.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const swatchPickerLook: Look = {
  colors: { primary: "#6c8ebf", secondary: "#f7d6e0", accent: "#e76f51", background: "#eef2f7", text: "#1e2533" },
  heading: { family: "DM Sans", weight: 700 }, body: { family: "DM Sans", weight: 400 }, bangla: { family: "Hind Siliguri", weight: 600 },
  radius: 0.7, motion: "smooth", grain: 0.02,
};

export const swatchPicker: Template = {
  version: FORMAT_VERSION,
  id: "fashion-swatch",
  name: "Swatches",
  category: "fashion",
  description: "A tee steps through five colours as a ring moves along the swatches under it.",
  tags: ["fashion", "colours", "swatches", "variants", "product", "t-shirt", "clothing"],
  length: 6.2,
  hold: [1.6, EXIT],
  shapes: ALL_SHAPES,
  look: swatchPickerLook,
  fields: [
    { id: "name", kind: "text", label: "Product", en: "Everyday Cotton Tee", bn: "এভরিডে কটন টি-শার্ট", limit: 32 },
    { id: "price", kind: "text", label: "Price", en: "Tk 990", bn: "৳৯৯০", limit: 14 },
    { id: "note", kind: "text", label: "Below the swatches", en: "Available in 5 colours", bn: "৫টি রঙে পাওয়া যাচ্ছে", limit: 36 },
  ],
  hits: PICK.map((t) => ({ t, sfx: "click" })),
  layers: [
    ...backdrop("aurora", "glass", { intensity: 0.6, overIntensity: 0.4 }),
    {
      id: "shadow", kind: "ellipse", fill: { kind: "radial", stops: [[0, "#000000/0.3"], [1, "#000000/0"]] },
      frame: F({ "9:16": [0.47, 0.57, 0.46, 0.06], "16:9": [0.27, 0.88, 0.6, 0.07], "1:1": [0.5, 0.7, 0.42, 0.05], "4:5": [0.5, 0.68, 0.46, 0.05] }),
      opacity: vis(0.4, 0.4, EXIT, 0.35),
    },
    ...COLOURS.map((_, i) => colourway(i)),
    { id: "seams", kind: "path", d: SEAMS, frame: SHIRT_AT, stroke: "#000000/0.2", strokeWidth: 0.003, opacity: vis(0.5, 0.3, EXIT, 0.3), scale: pop(0.3, 0.85, 0.6, EXIT, 0.9) },
    ...COLOURS.map((c, i): Layer => ({
      id: `swatch${i + 1}`, kind: "ellipse", frame: swatch(i, 0.085), fill: c, stroke: "@text/0.2", strokeWidth: 0.002,
      scale: pop(0.75 + i * 0.07, 0, 0.45, EXIT + i * 0.04, 0.5), opacity: vis(0.75 + i * 0.07, 0.15, EXIT + i * 0.04, 0.25),
    })),
    {
      id: "ring", kind: "ellipse", frame: swatch(0, 0.115), stroke: "@text", strokeWidth: 0.005,
      dx: PICK.flatMap((t, i) => i === 0 ? [[t, 0, "inOut"]] as [number, number, "inOut"][] : [[t - 0.35, (i - 1) * STEP, "inOut"], [t, i * STEP, "inOut"]]),
      scale: [[PICK[0] - 0.3, 1.6, "out"], [PICK[0], 1], [EXIT, 1, "in"], [EXIT + 0.3, 1.4]], opacity: vis(PICK[0] - 0.3, 0.25, EXIT, 0.3),
    },
    txt("name", "name", F({
      "9:16": [0.47, 0.175, 0.78, 0.09], "16:9": [0.55, 0.3, 0.74, 0.18, 0], "1:1": [0.5, 0.095, 0.86, 0.07], "4:5": [0.5, 0.095, 0.86, 0.08],
    }), {
      role: "body",
      font: "heading", weight: 700, size: 0.06, minSize: 0.044, lines: 1, textAt: { "16:9": { size: 0.075, lines: 2, align: "left" } },
      animate: settle(), exit: outWords(EXIT),
    }),
    txt("price", "price", F({
      "9:16": [0.47, 0.225, 0.6, 0.06], "16:9": [0.55, 0.45, 0.6, 0.08, 0], "1:1": [0.5, 0.155, 0.6, 0.05], "4:5": [0.5, 0.155, 0.6, 0.055],
    }), {
      role: "cta",
      font: "heading", weight: 800, size: 0.045, minSize: 0.044, lines: 1, color: "@accent", textAt: { "16:9": { size: 0.06, align: "left" } },
      animate: popWords(0.45), exit: outFade(EXIT, 0.25),
    }),
    txt("note", "note", F({
      "9:16": [0.47, 0.725, 0.78, 0.045], "16:9": [0.55, 0.73, 0.74, 0.055, 0], "1:1": [0.5, 0.87, 0.86, 0.045], "4:5": [0.5, 0.855, 0.86, 0.045],
    }), {
      role: "detail",
      size: 0.036, minSize: 0.036, lines: 1, color: "@text/0.7", textAt: { "16:9": { align: "left" } },
      animate: riseWords(1.0, 0.04, 0.45), exit: outFade(EXIT, 0.25),
    }),
  ],
};
