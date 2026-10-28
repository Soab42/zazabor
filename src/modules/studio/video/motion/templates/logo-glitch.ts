import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import { ALL_SHAPES, DIAMOND, FULL } from "./build";
import { F, backdrop, outFade, steps, txt, vis } from "./common-b";
import { BRAND, LOGO_FIELDS, logoBox, taglineLayer } from "./logo-parts";

/**
 * Glitch Logo: on a dark screen with scan lines, the logo and the brand name stutter in with
 * red and cyan copies jumping out of register, settle, and glitch once more before they go.
 */

const EXIT = 4.4;
const RED = "@primary";
const CYAN = "@accent";
/** Scan lines across the screen. */
const SCAN = Array.from({ length: 60 }, (_, i) => `M0 ${(i * 100 / 60 + 0.8).toFixed(2)}H100`).join("");

/** Sideways jitter for a colour copy: jumps around the entrance and again before the exit. */
const jitter = (k: number) => steps([
  [0, 0], [0.18, 0.035 * k], [0.26, -0.02 * k], [0.34, 0.05 * k], [0.42, -0.012 * k], [0.55, 0.018 * k], [0.7, 0],
  [3.7, 0], [3.76, -0.03 * k], [3.84, 0.02 * k], [3.92, 0], [EXIT, 0], [EXIT + 0.06, 0.04 * k], [EXIT + 0.14, -0.03 * k],
]);
/** Flicker on: once off and on, then steady (fewer than three flashes in any second). */
const flicker = steps([[0, 0], [0.18, 1], [0.42, 0.35], [0.6, 1], [EXIT, 1], [EXIT + 0.15, 0.35], [EXIT + 0.3, 0]]);

/** A torn slice of light that flashes across once (5 frames). */
function slice(i: number, t: number, y: number, w: number): Layer {
  return {
    id: `slice${i}`, kind: "rect", frame: F({
      "9:16": [0.5, y, w, 0.018], "16:9": [0.5, y, w * 1.6, 0.02], "1:1": [0.5, y, w, 0.018], "4:5": [0.5, y, w, 0.018],
    }),
    fill: i % 2 ? `${CYAN}/0.6` : "@text/0.45", blend: "screen",
    opacity: steps([[0, 0], [t, 1], [t + 0.15, 0]]),
    dx: steps([[0, 0], [t, (i % 2 ? -1 : 1) * 0.06], [t + 0.1, (i % 2 ? 1 : -1) * 0.04]]),
  };
}

/** One copy of the brand name. */
function brand(id: string, color: string, k: number, blend?: GlobalCompositeOperation): Layer {
  return txt(id, "brand", BRAND, {
    role: "headline", font: "heading", size: 0.085, minSize: 0.07, lines: 1, color, upper: true, tracking: 0.08,
    textAt: { "16:9": { size: 0.08 }, "1:1": { size: 0.07 } },
    opacity: flicker, dx: k ? jitter(k) : undefined, blend, exit: k ? undefined : outFade(EXIT + 0.15, 0.2),
  });
}

/**
 * This template's own look (Neon: near-black with pink and cyan.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const glitchLogoLook: Look = {
  colors: { primary: "#ff3d81", secondary: "#1a1030", accent: "#05d9e8", background: "#07070c", text: "#ffffff" },
  heading: { family: "Space Grotesk", weight: 700 }, body: { family: "Space Grotesk", weight: 400 }, bangla: { family: "Anek Bangla", weight: 700 },
  radius: 0.1, motion: "snappy", grain: 0.03,
  backdrop: ["#ff3d81", "#05d9e8", "@primary", "#05050a", "#0b0b14"],
};

export const glitchLogo: Template = {
  version: FORMAT_VERSION,
  id: "logo-glitch",
  name: "Glitch Logo",
  category: "logo",
  description: "Your logo and name stutter in on a dark screen, split into red and cyan, then lock in place.",
  tags: ["logo", "glitch", "intro", "tech", "gaming", "rgb split", "brand"],
  length: 4.8,
  hold: [1.2, EXIT],
  shapes: ALL_SHAPES,
  look: glitchLogoLook,
  fields: LOGO_FIELDS,
  hits: [{ t: 0.18, sfx: "glitch" }, { t: 0.6, sfx: "impact" }, { t: 3.76, sfx: "glitch" }],
  layers: [
    ...backdrop("grid", "drift", { intensity: 0.55, overIntensity: 0.4 }),
    { id: "glow", kind: "ellipse", frame: logoBox(2.2), fill: { kind: "radial", stops: [[0, "@primary/0.22"], [1, "@primary/0"]] }, opacity: vis(0.4, 0.6, EXIT, 0.3) },
    { id: "scan", kind: "path", frame: FULL, d: SCAN, stroke: "@text/0.05", strokeWidth: 0.0015 },
    // The logo, with a red and a cyan copy out of register.
    { id: "logo-red", kind: "image", slot: "logo", ifFilled: "logo", fit: "contain", frame: logoBox(0.9), opacity: flicker, dx: jitter(1), blend: "screen" },
    { id: "logo-cyan", kind: "image", slot: "logo", ifFilled: "logo", fit: "contain", frame: logoBox(0.9), opacity: flicker, dx: jitter(-1), blend: "screen" },
    { id: "logo", kind: "image", slot: "logo", ifFilled: "logo", fit: "contain", frame: logoBox(0.9), opacity: flicker },
    // Without a logo: a diamond emblem that glitches the same way.
    { id: "emblem-red", kind: "path", ifEmpty: "logo", d: DIAMOND, frame: logoBox(0.9), stroke: RED, strokeWidth: 0.008, opacity: flicker, dx: jitter(1), blend: "screen" },
    { id: "emblem-cyan", kind: "path", ifEmpty: "logo", d: DIAMOND, frame: logoBox(0.9), stroke: CYAN, strokeWidth: 0.008, opacity: flicker, dx: jitter(-1), blend: "screen" },
    { id: "emblem", kind: "path", ifEmpty: "logo", d: DIAMOND, frame: logoBox(0.9), stroke: "@text", strokeWidth: 0.008, fill: "@primary/0.25", opacity: flicker },
    brand("brand-red", RED, 1, "screen"),
    brand("brand-cyan", CYAN, -1, "screen"),
    brand("brand", "@text", 0),
    taglineLayer(0.85, EXIT, "@text/0.6"),
    slice(1, 0.2, 0.33, 0.7),
    slice(2, 0.62, 0.58, 0.8),
    slice(3, 3.78, 0.42, 0.6),
    { id: "vignette", kind: "fx", fx: "vignette", frame: FULL, amount: 0.7 },
  ],
};
