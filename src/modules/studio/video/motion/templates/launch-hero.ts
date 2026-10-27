import { FORMAT_VERSION, type Template } from "../format";
import { ALL_SHAPES, FULL, frame, per, pop, showHide } from "./build";

/**
 * Product Hero: a launch shot. The product rises onto a spotlight with a floor shadow, a light
 * sweeps across it, then the kicker, name, tagline and a call to action. Text sits left of the
 * product in 16:9 and above and below it in the taller shapes.
 */

const EXIT = 5.6;

const PRODUCT = per({
  "9:16": frame(0.5, 0.47, 0.66, 0.66),
  "16:9": frame(0.7, 0.52, 0.78, 0.78),
  "1:1": frame(0.5, 0.5, 0.46, 0.46),
  "4:5": frame(0.5, 0.49, 0.52, 0.52),
});

const SPOT = per({
  "9:16": frame(0.5, 0.47, 0.95, 0.95),
  "16:9": frame(0.7, 0.52, 1.05, 1.05),
  "1:1": frame(0.5, 0.5, 0.7, 0.7),
  "4:5": frame(0.5, 0.49, 0.78, 0.78),
});

const FLOOR = per({
  "9:16": frame(0.5, 0.645, 0.5, 0.06),
  "16:9": frame(0.7, 0.9, 0.58, 0.07),
  "1:1": frame(0.5, 0.74, 0.36, 0.05),
  "4:5": frame(0.5, 0.71, 0.4, 0.05),
});

const CTA = per({
  "9:16": frame(0.5, 0.745, 0.44, 0.1),
  "16:9": frame(0.08, 0.8, 0.36, 0.1, 0),
  "1:1": frame(0.5, 0.905, 0.32, 0.075),
  "4:5": frame(0.5, 0.92, 0.36, 0.085),
});

export const productHero: Template = {
  version: FORMAT_VERSION,
  id: "launch-hero",
  name: "Product Hero",
  category: "launch",
  description: "Your product rises onto a spotlight, a light sweeps across it, then its name and a call to action.",
  tags: ["product", "launch", "new", "hero", "light sweep", "cut out"],
  length: 6.5,
  hold: [2.6, EXIT],
  shapes: ALL_SHAPES,
  fields: [
    { id: "kicker", kind: "text", label: "Kicker", en: "New arrival", bn: "নতুন এসেছে", limit: 28 },
    { id: "title", kind: "text", label: "Product name", en: "Aurora Buds Pro", bn: "অরোরা বাডস প্রো", limit: 40 },
    { id: "tagline", kind: "text", label: "Tagline", en: "Studio sound. All-day comfort.", bn: "স্টুডিও সাউন্ড, সারাদিনের আরাম।", limit: 70, multiline: true },
    { id: "cta", kind: "text", label: "Button", en: "Shop now", bn: "এখনই কিনুন", limit: 20 },
    { id: "product", kind: "media", label: "Product photo", en: "", product: true },
  ],
  hits: [{ t: 0.25, sfx: "whoosh" }, { t: 1.25, sfx: "chime" }, { t: 1.75, sfx: "pop" }],
  layers: [
    { id: "bg", kind: "rect", frame: FULL, fill: { kind: "radial", stops: [[0, "@secondary"], [1, "@bg"]] } },
    { id: "blobs", kind: "fx", fx: "blobs", frame: FULL, amount: 0.55, opacity: [[0, 0], [1.2, 1]] },
    {
      id: "spot", kind: "ellipse", frame: SPOT,
      fill: { kind: "radial", stops: [[0, "@primary/0.55"], [0.45, "@primary/0.18"], [1, "@primary/0"]] },
      opacity: showHide(0.15, 0.8, EXIT, 0.6), scale: [[0.15, 0.55, "out"], [1.1, 1]], idle: { scale: 0.06 },
    },
    {
      id: "floor", kind: "ellipse", frame: FLOOR, fill: "#000000/0.42", blur: 0.018,
      opacity: showHide(0.5, 0.6, EXIT, 0.4), scale: [[0.4, 0.5, "out"], [1.1, 1]],
    },
    {
      id: "product", kind: "image", slot: "product", frame: PRODUCT, fit: "contain", placeholder: "Add your product photo",
      shadow: { color: "#000000/0.4", blur: 0.05, y: 0.025 },
      opacity: showHide(0.3, 0.4, EXIT, 0.4), scale: pop(0.3, 0.82, 0.7, EXIT, 0.9, 0.45), dy: [[0.3, 0.08, "out"], [1.0, 0]],
      sheen: { at: [[1.15, -0.2, "inOut"], [2.15, 1.2]], width: 0.16, angle: 24, strength: 0.6 },
      idle: { scale: 0.035, dy: -0.012 },
    },
    {
      // Without a picture: a glass tile with a sparkle, so the template still reads.
      id: "stand-in", kind: "group", frame: PRODUCT, ifEmpty: "product",
      opacity: showHide(0.3, 0.4, EXIT, 0.4), scale: pop(0.3, 0.82, 0.7, EXIT, 0.9, 0.45),
      sheen: { at: [[1.15, -0.2, "inOut"], [2.15, 1.2]], width: 0.16, angle: 24, strength: 0.5 },
      children: [
        {
          id: "tile", kind: "rect", frame: per({
            "9:16": frame(0.5, 0.47, 0.42, 0.42), "16:9": frame(0.7, 0.52, 0.48, 0.48),
            "1:1": frame(0.5, 0.5, 0.3, 0.3), "4:5": frame(0.5, 0.49, 0.34, 0.34),
          }),
          radius: "theme", fill: { kind: "linear", angle: 135, stops: [[0, "@primary"], [1, "@accent"]] },
          shadow: { color: "@primary/0.5", blur: 0.08, y: 0.02 }, rotate: [[0.3, -14, "out"], [1.2, -8]],
        },
        {
          id: "tile-icon", kind: "icon", icon: "sparkle", color: "@onPrimary", strokeWidth: 1.6, frame: per({
            "9:16": frame(0.5, 0.47, 0.2, 0.2), "16:9": frame(0.7, 0.52, 0.22, 0.22),
            "1:1": frame(0.5, 0.5, 0.14, 0.14), "4:5": frame(0.5, 0.49, 0.16, 0.16),
          }),
          draw: [[0.7, 0, "inOut"], [1.5, 1]],
        },
      ],
    },
    {
      id: "kicker", kind: "text", field: "kicker", font: "body", weight: 700, size: 0.034, lines: 1, upper: true,
      color: "@accent", tracking: 0.22,
      frame: per({
        "9:16": frame(0.5, 0.125, 0.76, 0.05), "16:9": frame(0.08, 0.27, 0.8, 0.05, 0),
        "1:1": frame(0.5, 0.075, 0.84, 0.05), "4:5": frame(0.5, 0.075, 0.84, 0.05),
      }),
      textAt: { "16:9": { align: "left" } },
      animate: { unit: "char", t: 0.55, stagger: 0.022, duration: 0.45, from: { opacity: 0, dy: 0.5 } },
      exit: { unit: "line", t: EXIT, stagger: 0, duration: 0.3, from: { opacity: 0, dy: -0.4 } },
    },
    {
      id: "title", kind: "text", field: "title", font: "heading", size: 0.115, minSize: 0.07, lines: 2, color: "@text", lineHeight: 1.05,
      frame: per({
        "9:16": frame(0.5, 0.205, 0.76, 0.24), "16:9": frame(0.08, 0.43, 0.82, 0.26, 0),
        "1:1": frame(0.5, 0.165, 0.86, 0.15), "4:5": frame(0.5, 0.165, 0.86, 0.18),
      }),
      textAt: { "16:9": { size: 0.1, align: "left" }, "1:1": { size: 0.08, lines: 1 }, "4:5": { size: 0.09 } },
      animate: { unit: "word", t: 0.75, stagger: 0.08, duration: 0.6, from: { opacity: 0, dy: 0.9 }, mask: true },
      exit: { unit: "word", t: EXIT, stagger: 0.04, duration: 0.32, from: { opacity: 0, dy: -0.6 }, mask: true },
      sheen: { at: [[1.5, -0.2, "inOut"], [2.4, 1.2]], width: 0.2, angle: 20, strength: 0.7 },
    },
    {
      id: "tagline", kind: "text", field: "tagline", font: "body", size: 0.042, minSize: 0.03, lines: 2, color: "@text/0.78",
      frame: per({
        "9:16": frame(0.5, 0.685, 0.76, 0.1), "16:9": frame(0.08, 0.62, 0.78, 0.1, 0),
        "1:1": frame(0.5, 0.81, 0.84, 0.08), "4:5": frame(0.5, 0.8, 0.84, 0.09),
      }),
      textAt: { "16:9": { align: "left" }, "1:1": { size: 0.036 } },
      animate: { unit: "word", t: 1.2, stagger: 0.06, duration: 0.5, from: { opacity: 0, dy: 0.5, blur: 0.12 } },
      exit: { unit: "line", t: EXIT, stagger: 0, duration: 0.3, from: { opacity: 0 } },
    },
    {
      id: "cta", kind: "group", frame: CTA,
      opacity: showHide(1.7, 0.25, EXIT, 0.3), scale: pop(1.7, 0.6, 0.55, EXIT, 0.85),
      children: [
        { id: "cta-pill", kind: "rect", frame: CTA, radius: "pill", fill: "@primary", glow: { color: "@primary/0.6", blur: 0.04 } },
        { id: "cta-text", kind: "text", field: "cta", font: "body", weight: 700, size: 0.04, minSize: 0.026, lines: 1, color: "@onPrimary", frame: CTA,
          textAt: { "1:1": { size: 0.032 } } },
      ],
    },
    { id: "grain", kind: "fx", fx: "grain", frame: FULL, amount: 0.05 },
  ],
};
