import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import { ALL_SHAPES, pop } from "./build";
import { backdrop, outLine, riseChars, txt, vis } from "./common-b";
import { BRAND, LOGO_FIELDS, logoBox, taglineLayer } from "./logo-parts";

/**
 * Liquid Drop: two drops of the brand's colours roll together and swell into one, ripples run
 * out from it, and the logo surfaces on the drop. The brand name rises letter by letter beneath.
 */

const EXIT = 4.7;

/** A ripple ring leaving the drop at `t`. */
function ripple(i: number, t: number): Layer {
  return {
    id: `ripple${i}`, kind: "ellipse", frame: logoBox(1.25), stroke: "@accent", strokeWidth: 0.004,
    scale: [[t, 0.7, "out"], [t + 1.4, 1.75]], opacity: [[t, 0.7, "out"], [t + 1.4, 0]],
  };
}

/**
 * This template's own look (Aqua: deep sea blue with a bright cyan drop.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const liquidLogoLook: Look = {
  colors: { primary: "#2ec5ff", secondary: "#0b3a5c", accent: "#7cf5d6", background: "#06141f", text: "#eaf6ff" },
  heading: { family: "Outfit", weight: 700 }, body: { family: "Inter", weight: 400 }, bangla: { family: "Anek Bangla", weight: 600 },
  radius: 0.6, motion: "smooth", grain: 0.03,
};

export const liquidLogo: Template = {
  version: FORMAT_VERSION,
  id: "logo-liquid",
  name: "Liquid Drop",
  category: "logo",
  description: "Two drops of your colours roll together and swell into one; your logo surfaces on it.",
  tags: ["logo", "reveal", "intro", "liquid", "drop", "ripple", "brand"],
  length: 5.4,
  hold: [2.6, EXIT],
  shapes: ALL_SHAPES,
  look: liquidLogoLook,
  fields: LOGO_FIELDS,
  hits: [{ t: 0.15, sfx: "bubbles" }, { t: 0.95, sfx: "pop" }, { t: 1.4, sfx: "chime" }],
  layers: [
    ...backdrop("waves", "drift", { intensity: 0.7, overIntensity: 0.5, speed: 0.8 }),
    {
      // The second drop rolls in from the left and is swallowed.
      id: "drop-b", kind: "ellipse", frame: logoBox(0.6), fill: { kind: "radial", stops: [[0, "@accent"], [1, "@accent/0.85"]] },
      dx: [[0.15, -0.55, "inOut"], [0.95, 0]], scale: [[0.15, 0.4, "out"], [0.6, 1], [0.95, 0.7, "in"], [1.1, 0.2]],
      opacity: [[0.15, 0, "out"], [0.35, 1], [1.0, 1], [1.15, 0]],
    },
    {
      id: "drop", kind: "ellipse", frame: logoBox(1.22),
      fill: { kind: "linear", angle: 135, stops: [[0, "@primary"], [1, "@accent"]] },
      shadow: { color: "@primary/0.45", blur: 0.07, y: 0.02 },
      scale: [[0.1, 0, "spring"], [0.85, 0.62], [0.95, 0.62, "spring"], [1.7, 1], [EXIT, 1, "in"], [EXIT + 0.45, 0]],
      dx: [[0.1, 0.25, "inOut"], [0.95, 0]],
      sheen: { at: [[1.6, -0.2, "inOut"], [2.4, 1.2]], width: 0.2, angle: 30, strength: 0.4 },
      idle: { scale: 0.04 },
    },
    ripple(1, 0.95),
    ripple(2, 1.15),
    ripple(3, 1.35),
    {
      id: "logo", kind: "image", slot: "logo", ifFilled: "logo", fit: "contain", frame: logoBox(0.62),
      opacity: vis(1.2, 0.3, EXIT - 0.1, 0.3), scale: pop(1.2, 0.5, 0.6, EXIT - 0.1, 0.6), dy: [[1.2, 0.06, "out"], [1.8, 0]],
    },
    {
      id: "mark", kind: "icon", icon: "droplet", ifEmpty: "logo", color: "@onPrimary", strokeWidth: 1.8, frame: logoBox(0.42),
      draw: [[1.2, 0, "inOut"], [1.9, 1]], opacity: vis(1.2, 0.2, EXIT - 0.1, 0.3), scale: pop(1.2, 0.6, 0.6),
    },
    txt("brand", "brand", BRAND, {
      role: "headline",
      font: "heading", size: 0.085, minSize: 0.07, lines: 1, textAt: { "16:9": { size: 0.08 }, "1:1": { size: 0.07 } },
      animate: riseChars(1.55), exit: outLine(EXIT - 0.05),
    }),
    taglineLayer(2.05, EXIT - 0.1),
  ],
};
