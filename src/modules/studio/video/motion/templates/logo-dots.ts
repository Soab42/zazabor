import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import { ALL_SHAPES, across, offset, pop } from "./build";
import { backdrop, outLine, riseWords, rnd, txt, vis } from "./common-b";
import { BRAND, LOGO_FIELDS, logoBox, taglineLayer } from "./logo-parts";

/**
 * Dot Grid: twenty-five dots fly in from everywhere and lock into a grid, the grid folds into the
 * centre, and the logo appears where it closed. Dots alternate the kit's primary and accent.
 */

const EXIT = 4.9;
const N = 5;
/** The logo's centre and size per shape (as in logoBox). */
const CENTRE = { "9:16": [0.5, 0.4, 0.46], "16:9": [0.5, 0.38, 0.4], "1:1": [0.5, 0.38, 0.4], "4:5": [0.5, 0.39, 0.44] } as const;

function dot(i: number): Layer {
  const col = i % N, row = Math.floor(i / N);
  const gx = (col - (N - 1) / 2) / (N - 1), gy = (row - (N - 1) / 2) / (N - 1);
  // Inner dots arrive first; every dot comes from its own direction.
  const t = 0.1 + Math.hypot(gx, gy) * 0.35 + rnd(i) * 0.12;
  const fromX = (rnd(i, 2) - 0.5) * 1.6, fromY = (rnd(i, 3) - 0.5) * 1.6;
  return {
    id: `dot${i}`, kind: "ellipse", fill: i % 2 ? "@accent" : "@primary",
    frame: across((shape) => {
      const [cx, cy, size] = CENTRE[shape];
      return offset(shape, cx, cy, gx * size * 0.86, gy * size * 0.86, size * 0.1, size * 0.1);
    }),
    dx: [[t, fromX, "out"], [t + 0.6, 0], [1.55, 0, "inOut"], [1.95, -gx * 0.38]],
    dy: [[t, fromY, "out"], [t + 0.6, 0], [1.55, 0, "inOut"], [1.95, -gy * 0.38]],
    scale: [[t, 0.2, "out"], [t + 0.6, 1], [1.55, 1, "in"], [1.95, 0]],
    opacity: [[t, 0, "out"], [t + 0.25, 1]],
  };
}

/**
 * This template's own look (Paper (light): warm off-white, vermilion and blue dots.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const dotLogoLook: Look = {
  colors: { primary: "#e4572e", secondary: "#d9d2c3", accent: "#2e86ab", background: "#f4f1ea", text: "#1d1b18" },
  heading: { family: "Manrope", weight: 800 }, body: { family: "Manrope", weight: 500 }, bangla: { family: "Hind Siliguri", weight: 700 },
  radius: 0.4, motion: "smooth", grain: 0.02, grade: { fade: 0.04 },
};

export const dotLogo: Template = {
  version: FORMAT_VERSION,
  id: "logo-dots",
  name: "Dot Grid",
  category: "logo",
  description: "Dots fly in from everywhere, lock into a grid and fold into your logo.",
  tags: ["logo", "dots", "grid", "particles", "assemble", "intro", "brand"],
  length: 5.6,
  hold: [2.9, EXIT],
  shapes: ALL_SHAPES,
  look: dotLogoLook,
  fields: LOGO_FIELDS,
  hits: [{ t: 0.1, sfx: "rise" }, { t: 1.45, sfx: "swoosh" }, { t: 1.9, sfx: "pop" }],
  layers: [
    ...backdrop("aurora", "drift", { intensity: 0.7, overIntensity: 0.45 }),
    ...Array.from({ length: N * N }, (_, i) => dot(i)),
    {
      id: "flash", kind: "ellipse", frame: logoBox(0.9), fill: { kind: "radial", stops: [[0, "@accent/0.7"], [1, "@accent/0"]] },
      opacity: [[1.85, 0, "out"], [2.0, 1], [2.6, 0]], scale: [[1.85, 0.3, "out"], [2.6, 1.6]],
    },
    {
      id: "logo", kind: "image", slot: "logo", ifFilled: "logo", fit: "contain", frame: logoBox(0.85),
      opacity: vis(1.9, 0.25, EXIT, 0.35), scale: pop(1.9, 0.3, 0.6, EXIT, 0.85),
      sheen: { at: [[2.5, -0.2, "inOut"], [3.3, 1.2]], width: 0.2, angle: 25, strength: 0.45 },
    },
    {
      id: "mark", kind: "rect", ifEmpty: "logo", frame: logoBox(0.5), radius: "theme",
      fill: { kind: "linear", angle: 135, stops: [[0, "@primary"], [1, "@accent"]] }, rotate: [[1.9, -45, "out"], [2.6, 0]],
      opacity: vis(1.9, 0.25, EXIT, 0.35), scale: pop(1.9, 0.3, 0.6, EXIT, 0.85), glow: { color: "@primary/0.5", blur: 0.05 },
      sheen: { at: [[2.5, -0.2, "inOut"], [3.3, 1.2]], width: 0.2, angle: 25, strength: 0.45 },
    },
    txt("brand", "brand", BRAND, {
      role: "headline",
      font: "heading", size: 0.085, minSize: 0.07, lines: 1, textAt: { "16:9": { size: 0.08 }, "1:1": { size: 0.07 } },
      animate: riseWords(2.15, 0.08), exit: outLine(EXIT),
    }),
    taglineLayer(2.5, EXIT),
  ],
};
