import type { Key } from "../ease";
import { FORMAT_VERSION, type Template } from "../format";
import { ALL_SHAPES, DIAMOND, FULL, RING, frame, per, showHide } from "./build";
import { live, strict916 } from "./common-a";
import { DEEP_TEAL } from "./looks";

/**
 * Line Logo: the logo's outline draws itself in light (an SVG's own paths, or an outline traced
 * from a picture), fills in, and the brand name opens up from wide letter spacing. Without a logo,
 * a ring and diamond emblem draws instead. The logo comes from the Brand Kit until one is chosen.
 */

const EXIT = 4.8;

const LOGO = per({
  "9:16": frame(0.5, 0.4, 0.5, 0.5),
  "16:9": frame(0.5, 0.38, 0.42, 0.42),
  "1:1": frame(0.5, 0.38, 0.42, 0.42),
  "4:5": frame(0.5, 0.39, 0.46, 0.46),
});

const EMBLEM = per({
  "9:16": frame(0.5, 0.4, 0.38, 0.38),
  "16:9": frame(0.5, 0.38, 0.34, 0.34),
  "1:1": frame(0.5, 0.38, 0.34, 0.34),
  "4:5": frame(0.5, 0.39, 0.36, 0.36),
});

const fadeOut = showHide(0, 0.001, EXIT, 0.5);
const shrink: Key[] = [[EXIT, 1, "in"], [EXIT + 0.5, 0.94]];

export const lineLogo: Template = strict916({
  version: FORMAT_VERSION,
  id: "logo-line",
  name: "Line Logo",
  category: "logo",
  description: "Your logo draws itself in light, fills in, and the brand name opens up beneath it.",
  tags: ["logo", "reveal", "intro", "outro", "line art", "brand"],
  length: 5.5,
  hold: [2.8, EXIT],
  shapes: ALL_SHAPES,
  look: DEEP_TEAL,
  fields: [
    { id: "logo", kind: "media", label: "Logo", en: "", bind: "logo" },
    { id: "brand", kind: "text", label: "Brand name", en: "Lumen & Co.", bn: "লুমেন অ্যান্ড কো.", limit: 32 },
    { id: "tagline", kind: "text", label: "Tagline", en: "Made to move", bn: "চলার জন্য তৈরি", limit: 48 },
  ],
  hits: [{ t: 0.2, sfx: "rise" }, { t: 1.45, sfx: "chime" }],
  layers: [
    live("bg", "aurora", { intensity: [[0, 0.3], [1.6, 0.9]], speed: 0.8, seed: 6 }),
    live("motes", "drift", { over: true, intensity: 0.55, speed: 0.7, seed: 4 }),
    {
      id: "halo", kind: "ellipse", frame: per({
        "9:16": frame(0.5, 0.4, 1.1, 1.1), "16:9": frame(0.5, 0.38, 1.0, 1.0),
        "1:1": frame(0.5, 0.38, 0.9, 0.9), "4:5": frame(0.5, 0.39, 1.0, 1.0),
      }),
      fill: { kind: "radial", stops: [[0, "@primary/0.35"], [0.5, "@primary/0.08"], [1, "@primary/0"]] },
      opacity: [[1.2, 0, "out"], [2.2, 1], [EXIT, 1, "in"], [EXIT + 0.5, 0]], scale: [[1.2, 0.6, "out"], [2.4, 1]], idle: { scale: 0.08 },
    },
    {
      id: "logo", kind: "image", slot: "logo", ifFilled: "logo", frame: LOGO, fit: "contain",
      trace: { draw: [[0.2, 0, "inOut"], [1.6, 1]], color: "@primary", width: 0.004, fill: [[1.35, 0, "out"], [2.0, 1]] },
      glow: { color: "@primary/0.8", blur: 0.025 },
      opacity: fadeOut, scale: [[1.35, 0.96, "out"], [2.2, 1], ...shrink],
      sheen: { at: [[2.05, -0.2, "inOut"], [2.85, 1.2]], width: 0.14, angle: 28, strength: 0.55 },
    },
    {
      id: "emblem", kind: "group", ifEmpty: "logo", frame: EMBLEM,
      opacity: fadeOut, scale: [[1.35, 0.96, "out"], [2.2, 1], ...shrink], idle: { rotate: 4 },
      sheen: { at: [[2.05, -0.2, "inOut"], [2.85, 1.2]], width: 0.14, angle: 28, strength: 0.55 },
      children: [
        { id: "ring", kind: "path", frame: EMBLEM, d: RING, stroke: "@primary", strokeWidth: 0.005, draw: [[0.2, 0, "inOut"], [1.3, 1]], glow: { color: "@primary/0.9", blur: 0.02 } },
        { id: "diamond-fill", kind: "path", frame: EMBLEM, d: DIAMOND, fill: { kind: "linear", angle: 135, stops: [[0, "@primary"], [1, "@accent"]] },
          opacity: [[1.25, 0, "out"], [1.8, 1]], scale: [[1.25, 0.6, "spring"], [1.9, 1]] },
        { id: "diamond", kind: "path", frame: EMBLEM, d: DIAMOND, stroke: "@accent", strokeWidth: 0.004, draw: [[0.5, 0, "inOut"], [1.4, 1]], glow: { color: "@accent/0.8", blur: 0.015 } },
      ],
    },
    {
      id: "brand", kind: "text", field: "brand", font: "heading", size: 0.085, minSize: 0.07, lines: 1, color: "@text",
      frame: per({
        "9:16": frame(0.5, 0.6, 0.76, 0.12), "16:9": frame(0.5, 0.71, 1.3, 0.12),
        "1:1": frame(0.5, 0.7, 0.86, 0.1), "4:5": frame(0.5, 0.68, 0.86, 0.11),
      }),
      textAt: { "16:9": { size: 0.08 }, "1:1": { size: 0.07 } },
      tracking: [[1.5, 0.55, "out"], [2.7, 0.06]],
      opacity: showHide(1.5, 0.5, EXIT, 0.4), blur: [[1.5, 0.02, "out"], [2.1, 0]],
    },
    {
      id: "tagline", kind: "text", field: "tagline", font: "body", role: "detail", size: 0.036, minSize: 0.036, lines: 1, color: "@text", upper: true,
      frame: per({
        "9:16": frame(0.5, 0.655, 0.76, 0.06), "16:9": frame(0.5, 0.8, 1.2, 0.06),
        "1:1": frame(0.5, 0.79, 0.84, 0.06), "4:5": frame(0.5, 0.755, 0.84, 0.06),
      }),
      tracking: 0.2, textAt: { "1:1": { size: 0.036 } },
      animate: { unit: "word", t: 2.0, stagger: 0.07, duration: 0.5, from: { opacity: 0, dy: 0.5 } },
      exit: { unit: "line", t: EXIT - 0.1, stagger: 0, duration: 0.3, from: { opacity: 0 } },
    },
    { id: "vignette", kind: "fx", fx: "vignette", frame: FULL, amount: 0.6 },
    { id: "grain", kind: "fx", fx: "grain", frame: FULL, amount: 0.05 },
  ],
});
