import { FORMAT_VERSION, type Template } from "../format";
import type { Look } from "../brand";
import { ALL_SHAPES } from "./build";
import { F, backdrop, drawOn, outWords, riseWords, txt, vis } from "./common-b";
import { LOGO_FIELDS, logoBox, taglineLayer } from "./logo-parts";

/**
 * Minimal Logo: quiet and exact. A hairline draws across, the logo settles above it and the name
 * rises from behind the line; at the end the line draws back and everything sinks away.
 */

const EXIT = 4.6;

const RULE = F({
  "9:16": [0.5, 0.555, 0.5, 0.01], "16:9": [0.5, 0.63, 0.5, 0.01], "1:1": [0.5, 0.625, 0.42, 0.01], "4:5": [0.5, 0.6, 0.46, 0.01],
});
const NAME = F({
  "9:16": [0.5, 0.6, 0.76, 0.1], "16:9": [0.5, 0.71, 1.2, 0.1], "1:1": [0.5, 0.7, 0.86, 0.09], "4:5": [0.5, 0.675, 0.86, 0.1],
});

/**
 * This template's own look (Mono (light): white, black and one brass accent.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const minimalLogoLook: Look = {
  colors: { primary: "#111111", secondary: "#e8e8e8", accent: "#c8a96a", background: "#fafafa", text: "#111111" },
  heading: { family: "Sora", weight: 600 }, body: { family: "Inter", weight: 400 }, bangla: { family: "Hind Siliguri", weight: 600 },
  radius: 0.2, motion: "smooth", grain: 0.02, grade: { saturation: 0.9 },
};

export const minimalLogo: Template = {
  version: FORMAT_VERSION,
  id: "logo-minimal",
  name: "Minimal Logo",
  category: "logo",
  description: "A hairline draws across, your logo settles above it and the name rises from behind the line.",
  tags: ["logo", "minimal", "clean", "simple", "intro", "outro", "brand"],
  length: 5.2,
  hold: [2.2, EXIT],
  shapes: ALL_SHAPES,
  look: minimalLogoLook,
  fields: LOGO_FIELDS,
  hits: [{ t: 0.05, sfx: "swoosh" }, { t: 0.9, sfx: "click" }],
  layers: [
    ...backdrop("mesh", "drift", { intensity: 0.5, overIntensity: 0.35, speed: 0.6, vignette: 0.3 }),
    {
      id: "rule", kind: "path", frame: RULE, d: "M0 50H100", view: [100, 100], stroke: "@text/0.5", strokeWidth: 0.0025, cap: "butt",
      draw: drawOn(0.15, 0.85, [EXIT, EXIT + 0.4]),
    },
    {
      id: "logo", kind: "image", slot: "logo", ifFilled: "logo", fit: "contain", frame: logoBox(0.7),
      opacity: vis(0.7, 0.5, EXIT, 0.35), dy: [[0.7, 0.03, "out"], [1.4, 0]], scale: [[0.7, 0.94, "out"], [1.4, 1]],
    },
    {
      id: "mark", kind: "ellipse", ifEmpty: "logo", frame: logoBox(0.32), stroke: "@text", strokeWidth: 0.006,
      opacity: vis(0.7, 0.5, EXIT, 0.35), scale: [[0.7, 0.85, "out"], [1.4, 1]],
    },
    {
      id: "mark-dot", kind: "ellipse", ifEmpty: "logo", frame: logoBox(0.09), fill: "@primary",
      opacity: vis(1.0, 0.3, EXIT, 0.35), scale: [[1.0, 0, "spring"], [1.5, 1]],
    },
    txt("brand", "brand", NAME, {
      role: "headline",
      font: "heading", weight: 600, size: 0.07, minSize: 0.07, lines: 1, tracking: 0.04,
      textAt: { "16:9": { size: 0.07 }, "1:1": { size: 0.07 } },
      animate: riseWords(0.95, 0.07, 0.6), exit: outWords(EXIT - 0.05),
    }),
    taglineLayer(1.4, EXIT - 0.1, "@text/0.55"),
  ],
};
