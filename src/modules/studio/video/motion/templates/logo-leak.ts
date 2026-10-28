import { FORMAT_VERSION, type Template } from "../format";
import type { Look } from "../brand";
import { ALL_SHAPES, FULL, frame } from "./build";
import { backdrop, outFade, scrim, txt, vis } from "./common-b";
import { BRAND, LOGO_FIELDS, logoBox, taglineLayer } from "./logo-parts";

/**
 * Light Leak: warm film light washes across the frame and, as it passes, the logo comes into
 * focus and the brand name gathers from wide spacing. Grain and a vignette keep it filmic.
 */

const EXIT = 5.0;

/**
 * This template's own look (Film: warm brown-black, amber light.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const leakLogoLook: Look = {
  colors: { primary: "#ff9a3c", secondary: "#4a2414", accent: "#ffd166", background: "#1a0f0a", text: "#fff3e6" },
  heading: { family: "Playfair Display", weight: 600 }, body: { family: "DM Sans", weight: 400 }, bangla: { family: "Tiro Bangla", weight: 400 },
  radius: 0.3, motion: "smooth", grain: 0.03, grade: { warmth: 0.3, fade: 0.06 },
  backdrop: ["#c2571a", "#4a2414", "#ff9a3c", "#0d0705", "#1a0f0a"],
};

export const leakLogo: Template = {
  version: FORMAT_VERSION,
  id: "logo-leak",
  name: "Light Leak",
  category: "logo",
  description: "Warm film light washes across, your logo comes into focus and the name gathers beneath it.",
  tags: ["logo", "light leak", "film", "cinematic", "warm", "intro", "brand"],
  length: 5.8,
  hold: [2.7, EXIT],
  shapes: ALL_SHAPES,
  look: leakLogoLook,
  fields: LOGO_FIELDS,
  hits: [{ t: 0.2, sfx: "rise" }, { t: 1.5, sfx: "chime" }],
  layers: [
    ...backdrop("mesh", "rays", { intensity: 0.55, overIntensity: 0.35, speed: 0.8 }),
    scrim("scrim", BRAND, 0.55),
    { id: "leak", kind: "fx", fx: "leak", frame: FULL, color: "#ff9a3c", color2: "@accent", amount: 0.8, opacity: [[0, 0, "out"], [1.0, 1], [EXIT, 0.8], [EXIT + 0.8, 0]] },
    {
      // A band of light crossing the frame.
      id: "band", kind: "rect", frame: frame(0.5, 0.5, 0.55, 3.2), rotate: 18, blend: "screen", blur: 0.08,
      fill: { kind: "linear", angle: 0, stops: [[0, "#ffb36b/0"], [0.5, "#ffd9a8/0.55"], [1, "#ffb36b/0"]] },
      dx: [[0.1, -1.6, "inOut"], [2.2, 1.6]], opacity: vis(0.1, 0.4, 1.8, 0.4),
    },
    {
      id: "logo", kind: "image", slot: "logo", ifFilled: "logo", fit: "contain", frame: logoBox(0.9),
      opacity: vis(0.6, 0.9, EXIT, 0.6), blur: [[0.6, 0.03, "out"], [1.6, 0]], scale: [[0.6, 1.12, "out"], [1.9, 1], [EXIT, 1, "in"], [EXIT + 0.6, 1.05]],
      sheen: { at: [[1.4, -0.2, "inOut"], [2.3, 1.2]], width: 0.18, angle: 24, strength: 0.5 },
    },
    {
      id: "mark", kind: "icon", icon: "sparkle", ifEmpty: "logo", color: "@accent", strokeWidth: 1.5, frame: logoBox(0.6),
      draw: [[0.6, 0, "inOut"], [1.7, 1]], opacity: vis(0.6, 0.5, EXIT, 0.6), blur: [[0.6, 0.02, "out"], [1.6, 0]],
      glow: { color: "@accent/0.8", blur: 0.03 },
    },
    txt("brand", "brand", BRAND, {
      role: "headline",
      font: "heading", weight: 500, size: 0.08, minSize: 0.07, lines: 1, textAt: { "16:9": { size: 0.075 }, "1:1": { size: 0.07 } },
      tracking: [[1.2, 0.7, "out"], [2.6, 0.12]], opacity: vis(1.2, 0.8, EXIT, 0.5), blur: [[1.2, 0.015, "out"], [2.0, 0]],
      exit: outFade(EXIT, 0.5),
    }),
    taglineLayer(2.2, EXIT),
    { id: "vignette", kind: "fx", fx: "vignette", frame: FULL, amount: 0.75 },
  ],
};
