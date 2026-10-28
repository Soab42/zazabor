import { FORMAT_VERSION, type Layer, type Template } from "../format";
import { ALL_SHAPES, pop, showHide } from "./build";
import { at4, button, grain, hookAt0, leave, live, rise, sink, standIn, strict916, words } from "./common-a";
import { BLAZE } from "./looks";
import { settleConfetti, slam, slamIn } from "./signature";

/**
 * Limited Stock: two ticker bands cross the frame in opposite directions ("Limited stock • …"),
 * the product sits between them, and the count of what's left ticks down while a stock bar drains.
 */

const EXIT = 5.8;

const PRODUCT = at4({
  "9:16": [0.5, 0.4, 0.5, 0.5], "16:9": [0.7, 0.5, 0.66, 0.66], "1:1": [0.5, 0.45, 0.42, 0.42], "4:5": [0.5, 0.44, 0.48, 0.48],
});

/** A band across the whole frame (wider than it, turned), with a ticker running along it. */
function band(id: string, y: Record<"9:16" | "16:9" | "1:1" | "4:5", number>, angle: number, speed: number, fill: string, ink: string, t: number): Layer {
  const fr = at4({ "9:16": [0.5, y["9:16"], 2.4, 0.085], "16:9": [0.5, y["16:9"], 2.6, 0.085], "1:1": [0.5, y["1:1"], 1.8, 0.075], "4:5": [0.5, y["4:5"], 1.9, 0.08] });
  return {
    id, kind: "group", frame: fr, rotate: angle, reveal: { from: speed > 0 ? "left" : "right", v: [[t, 0, "out"], [t + 0.6, 1]] }, opacity: showHide(t, 0.05, EXIT, 0.3),
    children: [
      { id: `${id}-fill`, kind: "rect", frame: fr, fill, shadow: { color: "#000000/0.35", blur: 0.03, y: 0.012 } },
      { id: `${id}-text`, kind: "text", field: "ticker", frame: fr, font: "heading", weight: 800, size: 0.045, lines: 1, upper: true, color: ink, marquee: { speed, gap: "  ✦  " } },
    ],
  };
}

export const limitedStock: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "sale-stock",
  name: "Limited Stock",
  category: "sale",
  description: "Ticker bands cross the frame while the count of what's left ticks down and the stock bar drains.",
  tags: ["sale", "limited stock", "ticker", "urgency", "scarcity", "few left", "marquee"],
  length: 6.4,
  hold: [2.4, EXIT],
  shapes: ALL_SHAPES,
  look: BLAZE,
  fields: [
    { id: "ticker", kind: "text", label: "Ticker", en: "Limited stock", bn: "সীমিত স্টক", limit: 24 },
    { id: "title", kind: "text", label: "Product name", en: "Pulse Headphones", bn: "পালস হেডফোন", limit: 30 },
    { id: "left", kind: "text", label: "Left in stock", en: "Only 12 left", bn: "মাত্র ১২টি বাকি", limit: 22 },
    { id: "cta", kind: "text", label: "Button", en: "Grab yours", bn: "এখনই নিন", limit: 18 },
    { id: "product", kind: "media", label: "Product photo", en: "", product: true },
  ],
  hits: [{ t: 0.2, sfx: "swoosh" }, { t: 0.45, sfx: "swoosh" }, { t: 0.8, sfx: "whoosh" }, { t: 1.6, sfx: "ding" }],
  layers: [
    live("bg", "mesh", { colors: ["@primaryDeep", "@secondary", "@primary", "@deep", "@bg", "@primaryDeep"], intensity: 0.75, seed: 13 }),
    live("grid", "grid", { over: true, intensity: 0.6, speed: 0.8 }),
    band("band-back", { "9:16": 0.57, "16:9": 0.8, "1:1": 0.7, "4:5": 0.68 }, 7, -0.18, "@accent", "@onAccent", 0.45),
    {
      id: "product", kind: "image", slot: "product", frame: PRODUCT, fit: "contain", placeholder: "Add your product photo",
      shadow: { color: "#000000/0.45", blur: 0.05, y: 0.03, follow: true }, opacity: showHide(0.8, 0.3, EXIT, 0.4), scale: pop(0.8, 0.7, 0.65, EXIT, 0.9),
      rotate: [[0.8, 10, "out"], [1.6, -4]], idle: { rotate: 4, dy: -0.01 }, lightWrap: { color: "@accent", amount: 0.45, width: 0.02 },
    },
    standIn("stand-in", "headphones", "product", PRODUCT, {
      tint: "@text", tint2: "@primary", shadow: { color: "#000000/0.45", blur: 0.05, y: 0.03 }, opacity: showHide(0.8, 0.3, EXIT, 0.4),
      scale: pop(0.8, 0.7, 0.65, EXIT, 0.9), rotate: [[0.8, 10, "out"], [1.6, -4]], idle: { rotate: 4, dy: -0.01 },
    }),
    band("band-front", { "9:16": 0.25, "16:9": 0.16, "1:1": 0.17, "4:5": 0.2 }, -6, 0.16, "@primary", "@onPrimary", 0.2),
    words("title", "title", at4({
      "9:16": [0.5, 0.15, 0.76, 0.06], "16:9": [0.07, 0.36, 0.56, 0.14, 0], "1:1": [0.5, 0.075, 0.8, 0.055], "4:5": [0.5, 0.08, 0.8, 0.06],
    }), { weight: 700, role: "detail", size: 0.042, lines: 1, textAt: { "16:9": { size: 0.06, lines: 2, align: "left" } }, animate: rise(0.6), exit: sink(EXIT) }),
    words("left", "left", at4({
      "9:16": [0.5, 0.635, 0.76, 0.07], "16:9": [0.07, 0.54, 0.6, 0.1, 0], "1:1": [0.5, 0.79, 0.8, 0.06], "4:5": [0.5, 0.77, 0.8, 0.065],
    }), {
      font: "heading", size: 0.06, minSize: 0.044, lines: 1, color: "@text", counter: { fromValue: 50, t: [1.4, 2.4] },
      // The signature (§12): the count slams down, and confetti fires as it settles.
      textAt: { "16:9": { size: 0.07, align: "left" }, "1:1": { size: 0.05 } }, opacity: slamIn(1.4, EXIT + 0.3), scale: slam(1.4), exit: leave(EXIT),
    }),
    settleConfetti("confetti", 1.4, 0.5),
    {
      id: "stock", kind: "fx", fx: "progress", color: "@accent", glow: { color: "@accent/0.6", blur: 0.02 },
      frame: at4({ "9:16": [0.5, 0.672, 0.56, 0.016], "16:9": [0.07, 0.62, 0.5, 0.018, 0], "1:1": [0.5, 0.835, 0.5, 0.014], "4:5": [0.5, 0.815, 0.5, 0.015] }),
      value: [[1.4, 1, "out"], [2.4, 0.24]], opacity: showHide(1.3, 0.3, EXIT, 0.3),
    },
    button("cta", "cta", at4({
      "9:16": [0.5, 0.735, 0.4, 0.075], "16:9": [0.07, 0.74, 0.32, 0.09, 0], "1:1": [0.5, 0.9, 0.32, 0.07], "4:5": [0.5, 0.89, 0.34, 0.075],
    }), 2.0, EXIT, { size: 0.034 }),
    grain(),
  ],
}, ["product", "stand-in"]));
