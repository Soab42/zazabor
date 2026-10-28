import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Shape } from "../layout";
import { ALL_SHAPES, FULL, across, frame, per, pop, showHide, starburst } from "./build";
import { hookAt0, live, strict916 } from "./common-a";
import { RED_ALERT } from "./looks";

/**
 * Price Drop: a sale. A tag drops in, the old price is struck through, the new price counts down
 * from it and lands, and a spinning % badge pops on the product's corner (in the middle when there
 * is no product).
 */

const EXIT = 5.3;
const BURST = starburst(16, 0.8);

type Spot = Record<Shape, [x: number, y: number, w: number]>;

/** The % badge: a starburst with the discount and "OFF" on it, at `spot` (centre and width per shape). */
function badge(id: string, spot: Spot, size: number, when: { ifEmpty?: string; ifFilled?: string }): Layer {
  // A box across the badge, `dy` badge widths below its centre, `w` badge widths wide.
  const inner = (dy: number, w: number) => across((shape, d) => {
    const [x, y, bw] = spot[shape];
    return frame(x, y + (dy * bw) / d.h, bw * w, bw * 0.3);
  });
  const at = across((shape) => frame(spot[shape][0], spot[shape][1], spot[shape][2], spot[shape][2]));
  return {
    id, kind: "group", frame: at, ...when,
    opacity: showHide(0.75, 0.2, EXIT, 0.3), scale: pop(0.75, 0, 0.7, EXIT, 0.6), rotate: [[0.75, -140, "out"], [1.45, -8]],
    idle: { rotate: 10 },
    children: [
      { id: `${id}-burst`, kind: "path", frame: at, d: BURST, fill: "@accent", shadow: { color: "#000000/0.35", blur: 0.04, y: 0.015 } },
      { id: `${id}-pct`, kind: "text", field: "discount", font: "heading", role: "cta", size: size * 0.3, minSize: Math.max(0.044, size * 0.16), lines: 1, color: "@onAccent", frame: inner(-0.07, 0.72) },
      { id: `${id}-off`, kind: "text", field: "off", font: "body", role: "detail", weight: 800, size: Math.max(0.036, size * 0.11), lines: 1, upper: true, tracking: 0.12, color: "@onAccent", frame: inner(0.17, 0.6) },
    ],
  };
}

const PRODUCT = per({
  "9:16": frame(0.5, 0.555, 0.6, 0.6),
  "16:9": frame(0.72, 0.54, 0.72, 0.72),
  "1:1": frame(0.5, 0.62, 0.38, 0.38),
  "4:5": frame(0.5, 0.58, 0.46, 0.46),
});

const CTA = per({
  "9:16": frame(0.5, 0.745, 0.46, 0.1),
  "16:9": frame(0.07, 0.83, 0.38, 0.1, 0),
  "1:1": frame(0.5, 0.91, 0.32, 0.07),
  "4:5": frame(0.5, 0.92, 0.38, 0.085),
});

const LABEL = per({
  "9:16": frame(0.5, 0.125, 0.5, 0.085),
  "16:9": frame(0.07, 0.2, 0.42, 0.085, 0),
  "1:1": frame(0.5, 0.085, 0.4, 0.07),
  "4:5": frame(0.5, 0.08, 0.44, 0.075),
});

export const priceDrop: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "sale-price",
  name: "Price Drop",
  category: "sale",
  description: "The old price is struck through, the new one counts down and lands, and a % badge pops on.",
  tags: ["sale", "discount", "offer", "price", "badge", "flash sale"],
  length: 6,
  hold: [2.6, EXIT],
  shapes: ALL_SHAPES,
  look: RED_ALERT,
  fields: [
    { id: "label", kind: "text", label: "Tag", en: "Flash sale", bn: "ফ্ল্যাশ সেল", limit: 20 },
    { id: "discount", kind: "text", label: "Discount", en: "50%", bn: "৫০%", limit: 6 },
    { id: "off", kind: "text", label: "Under the discount", en: "Off", bn: "ছাড়", limit: 8 },
    { id: "old", kind: "text", label: "Old price", en: "$129", bn: "৳১২,৯৯৯", limit: 14 },
    { id: "price", kind: "text", label: "New price", en: "$64", bn: "৳৬,৪৯৯", limit: 14 },
    { id: "note", kind: "text", label: "Small print", en: "Ends Sunday · While stocks last", bn: "রবিবার শেষ · স্টক থাকা পর্যন্ত", limit: 50 },
    { id: "cta", kind: "text", label: "Button", en: "Shop now", bn: "এখনই কিনুন", limit: 20 },
    { id: "product", kind: "media", label: "Product photo", en: "", product: true },
  ],
  hits: [{ t: 0.15, sfx: "whoosh" }, { t: 0.75, sfx: "impact" }, { t: 1.2, sfx: "swoosh" }, { t: 2.1, sfx: "ding" }, { t: 2.3, sfx: "pop" }],
  layers: [
    live("bg", "rays", { colors: ["@secondary", "@accent", "@secondary", "@primaryDeep", "@primary"], intensity: [[0, 0.2], [0.8, 0.34]], vignette: 0.5 }),
    { id: "stripes", kind: "fx", fx: "stripes", frame: FULL, color: "@onPrimary", amount: 0.04 },
    live("sparks", "drift", { over: true, colors: ["#ffffff", "@accent", "@onPrimary"], speed: 1.4, intensity: 0.7, seed: 3 }),
    {
      id: "label", kind: "group", frame: LABEL,
      opacity: showHide(0.15, 0.2, EXIT, 0.3), dy: [[0.15, -0.25, "spring"], [0.75, 0]], rotate: [[0.15, -12, "spring"], [0.75, -3]],
      children: [
        { id: "label-pill", kind: "rect", frame: LABEL, radius: "theme", fill: "@accent", shadow: { color: "#000000/0.3", blur: 0.03, y: 0.012 } },
        { id: "label-text", kind: "text", field: "label", font: "body", weight: 800, role: "detail", size: 0.04, minSize: 0.036, lines: 1, upper: true, tracking: 0.14, color: "@onAccent", frame: LABEL,
          textAt: { "1:1": { size: 0.036 } } },
      ],
    },
    {
      id: "old", kind: "text", field: "old", font: "heading", size: 0.075, lines: 1, color: "@onPrimary",
      frame: per({
        "9:16": frame(0.5, 0.215, 0.76, 0.09), "16:9": frame(0.07, 0.37, 0.8, 0.09, 0),
        "1:1": frame(0.5, 0.19, 0.84, 0.07), "4:5": frame(0.5, 0.18, 0.84, 0.08),
      }),
      textAt: { "16:9": { align: "left" }, "1:1": { size: 0.07 } },
      animate: { unit: "line", t: 0.45, stagger: 0, duration: 0.45, from: { opacity: 0, dy: 0.6 } },
      exit: { unit: "line", t: EXIT, stagger: 0, duration: 0.3, from: { opacity: 0 } },
      strike: { draw: [[1.2, 0, "out"], [1.55, 1]], color: "@accent", width: 0.009 },
    },
    {
      id: "price", kind: "text", field: "price", font: "heading", size: 0.2, minSize: 0.11, lines: 1, color: "@onPrimary", lineHeight: 1,
      counter: { from: "old", t: [1.45, 2.1] },
      frame: per({
        "9:16": frame(0.5, 0.31, 0.76, 0.2), "16:9": frame(0.07, 0.56, 0.86, 0.22, 0),
        "1:1": frame(0.5, 0.33, 0.84, 0.15), "4:5": frame(0.5, 0.3, 0.84, 0.17),
      }),
      textAt: { "16:9": { size: 0.19, align: "left" }, "1:1": { size: 0.15 }, "4:5": { size: 0.17 } },
      opacity: showHide(1.4, 0.2, EXIT, 0.3), scale: [[1.4, 0.7, "spring"], [2.0, 1], [2.1, 1, "out"], [2.25, 1.08, "spring"], [2.7, 1], [EXIT, 1, "in"], [EXIT + 0.3, 0.85]],
      glow: { color: "@accent/0.5", blur: 0.05 },
      idle: { scale: 0.03 },
    },
    {
      id: "product", kind: "image", slot: "product", frame: PRODUCT, fit: "contain", placeholder: "Add your product photo",
      shadow: { color: "#000000/0.45", blur: 0.05, y: 0.025 },
      opacity: showHide(0.35, 0.35, EXIT, 0.35), scale: pop(0.35, 0.85, 0.7, EXIT, 0.9), dy: [[0.35, 0.06, "out"], [1.0, 0]], idle: { scale: 0.04 },
    },
    badge("badge", { "9:16": [0.76, 0.43, 0.3], "16:9": [0.88, 0.26, 0.3], "1:1": [0.76, 0.5, 0.22], "4:5": [0.78, 0.44, 0.26] }, 0.3, { ifFilled: "product" }),
    badge("badge-big", { "9:16": [0.5, 0.53, 0.5], "16:9": [0.72, 0.52, 0.56], "1:1": [0.5, 0.62, 0.34], "4:5": [0.5, 0.57, 0.42] }, 0.5, { ifEmpty: "product" }),
    {
      id: "note", kind: "text", field: "note", font: "body", role: "detail", size: 0.036, minSize: 0.036, lines: 2, color: "@onPrimary",
      frame: per({
        "9:16": frame(0.5, 0.69, 0.76, 0.08), "16:9": frame(0.07, 0.71, 0.8, 0.06, 0),
        "1:1": frame(0.5, 0.845, 0.84, 0.05), "4:5": frame(0.5, 0.84, 0.84, 0.06),
      }),
      textAt: { "16:9": { align: "left" }, "1:1": { size: 0.036, lines: 1 } },
      animate: { unit: "word", t: 2.2, stagger: 0.05, duration: 0.45, from: { opacity: 0, dy: 0.4 } },
      exit: { unit: "line", t: EXIT, stagger: 0, duration: 0.3, from: { opacity: 0 } },
    },
    {
      id: "cta", kind: "group", frame: CTA,
      opacity: showHide(2.3, 0.25, EXIT, 0.3), scale: pop(2.3, 0.6, 0.55, EXIT, 0.85), idle: { scale: 0.04 },
      children: [
        { id: "cta-pill", kind: "rect", frame: CTA, radius: "pill", fill: "@onPrimary", shadow: { color: "#000000/0.3", blur: 0.03, y: 0.012 } },
        { id: "cta-text", kind: "text", field: "cta", font: "body", weight: 800, role: "detail", size: 0.04, minSize: 0.036, lines: 1, color: "@primary", frame: CTA,
          textAt: { "1:1": { size: 0.036 } } },
      ],
    },
    { id: "grain", kind: "fx", fx: "grain", frame: FULL, amount: 0.05 },
  ],
}, ["price"]));
