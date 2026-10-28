import { FORMAT_VERSION, type Template } from "../format";
import { ALL_SHAPES, pop, showHide } from "./build";
import { at4, button, grain, hookAt0, leave, live, rise, sink, soft, standIn, strict916, words } from "./common-a";
import { BUBBLEGUM } from "./looks";
import { settleConfetti, slam, slamIn } from "./signature";

/**
 * Buy One Get One: the first product slides in, a plus pops, the second drops in on a spring with
 * a "Free" tag swinging on it, over translucent glass shapes.
 */

const EXIT = 5.8;

const P1 = at4({ "9:16": [0.3, 0.45, 0.38, 0.38], "16:9": [0.36, 0.52, 0.5, 0.5], "1:1": [0.34, 0.47, 0.38, 0.38], "4:5": [0.33, 0.45, 0.4, 0.4] });
const P2 = at4({ "9:16": [0.66, 0.45, 0.38, 0.38], "16:9": [0.64, 0.52, 0.5, 0.5], "1:1": [0.66, 0.47, 0.38, 0.38], "4:5": [0.67, 0.45, 0.4, 0.4] });
const PLUS = at4({ "9:16": [0.48, 0.45, 0.08, 0.08], "16:9": [0.5, 0.52, 0.09, 0.09], "1:1": [0.5, 0.47, 0.07, 0.07], "4:5": [0.5, 0.45, 0.075, 0.075] });
const TAG = at4({ "9:16": [0.76, 0.33, 0.22, 0.07], "16:9": [0.74, 0.3, 0.2, 0.075], "1:1": [0.75, 0.3, 0.18, 0.06], "4:5": [0.76, 0.29, 0.2, 0.065] });
const SHADOW = { color: "#000000/0.4", blur: 0.045, y: 0.025, follow: true };

export const buyOneGetOne: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "sale-bogo",
  name: "Buy One Get One",
  category: "sale",
  description: "One product slides in, a plus pops, and the second drops in with a swinging \"Free\" tag.",
  tags: ["sale", "bogo", "buy one get one", "free", "offer", "bundle", "beauty"],
  length: 6.4,
  hold: [2.4, EXIT],
  shapes: ALL_SHAPES,
  look: BUBBLEGUM,
  light: { x: [[0, 0.15], [6.4, 0.85]], y: -0.1 },
  fields: [
    { id: "headline", kind: "text", label: "Headline", en: "Buy 1 Get 1", bn: "১টি কিনলে ১টি ফ্রি", limit: 22 },
    { id: "tag", kind: "text", label: "Tag", en: "Free", bn: "ফ্রি", limit: 8 },
    { id: "sub", kind: "text", label: "Details", en: "On every serum, this week only", bn: "সব সিরামে, শুধু এই সপ্তাহে", limit: 44, multiline: true },
    { id: "cta", kind: "text", label: "Button", en: "Claim the deal", bn: "অফারটি নিন", limit: 20 },
    { id: "product1", kind: "media", label: "The one you buy", en: "", product: true },
    { id: "product2", kind: "media", label: "The free one", en: "", product: true },
  ],
  hits: [{ t: 0.3, sfx: "swoosh" }, { t: 0.95, sfx: "pop" }, { t: 1.25, sfx: "whoosh" }, { t: 1.75, sfx: "ding" }],
  layers: [
    live("bg", "glass", { intensity: 0.7, vignette: 0.15, seed: 21 }),
    live("motes", "drift", { over: true, intensity: 0.55, seed: 2 }),
    { id: "p1", kind: "image", slot: "product1", frame: P1, fit: "contain", placeholder: "Add a product", shadow: SHADOW, opacity: showHide(0.3, 0.3, EXIT, 0.4), dx: [[0.3, -0.5, "out"], [0.95, 0]], rotate: [[0.3, -12, "out"], [1.0, -5]], idle: { rotate: 3 } },
    standIn("art1", "bottle", "product1", P1, { tint: "@primary", shadow: SHADOW, opacity: showHide(0.3, 0.3, EXIT, 0.4), dx: [[0.3, -0.5, "out"], [0.95, 0]], rotate: [[0.3, -12, "out"], [1.0, -5]], idle: { rotate: 3 } }),
    {
      id: "plus", kind: "icon", icon: "plus", color: "@text", strokeWidth: 2.4, frame: PLUS,
      opacity: showHide(0.9, 0.2, EXIT, 0.3), scale: pop(0.9, 0.2, 0.5, EXIT, 0.4), rotate: [[0.9, -90, "out"], [1.4, 0]],
    },
    { id: "p2", kind: "image", slot: "product2", frame: P2, fit: "contain", placeholder: "Add the free one", shadow: SHADOW, opacity: showHide(1.2, 0.2, EXIT, 0.4), dy: [[1.2, -0.45, "spring"], [1.9, 0]], rotate: [[1.2, 14, "out"], [1.9, 5]], idle: { rotate: -3 } },
    standIn("art2", "bottle", "product2", P2, { tint: "@accent", shadow: SHADOW, opacity: showHide(1.2, 0.2, EXIT, 0.4), dy: [[1.2, -0.45, "spring"], [1.9, 0]], rotate: [[1.2, 14, "out"], [1.9, 5]], idle: { rotate: -3 } }),
    {
      // The signature (§12): the "Free" tag slams on, and confetti fires as it settles.
      id: "tag", kind: "group", frame: TAG, opacity: slamIn(1.75, EXIT), scale: slam(1.75, EXIT, 0.6),
      rotate: [[1.7, 40, "spring"], [2.5, 12], [3.4, 6, "inOut"], [4.4, 14, "inOut"], [5.4, 9]],
      children: [
        { id: "tag-fill", kind: "rect", frame: TAG, radius: "pill", fill: "@accent", glow: { color: "@accent/0.6", blur: 0.03 } },
        words("tag-text", "tag", TAG, { font: "heading", weight: 800, role: "detail", size: 0.04, minSize: 0.036, lines: 1, upper: true, tracking: 0.1, color: "@onAccent" }),
      ],
    },
    settleConfetti("confetti", 1.75, 0.6, TAG),
    words("headline", "headline", at4({
      "9:16": [0.5, 0.17, 0.76, 0.14], "16:9": [0.5, 0.14, 1.3, 0.12], "1:1": [0.5, 0.11, 0.86, 0.1], "4:5": [0.5, 0.1, 0.86, 0.1],
    }), { font: "heading", size: 0.1, minSize: 0.07, lines: 2, lineHeight: 1.02, textAt: { "16:9": { lines: 1 }, "1:1": { size: 0.08, lines: 1 }, "4:5": { size: 0.085, lines: 1 } }, animate: rise(0.5), exit: sink(EXIT) }),
    words("sub", "sub", at4({
      "9:16": [0.5, 0.645, 0.76, 0.08], "16:9": [0.5, 0.8, 1.0, 0.07], "1:1": [0.5, 0.76, 0.84, 0.06], "4:5": [0.5, 0.75, 0.84, 0.065],
    }), { role: "detail", size: 0.038, minSize: 0.036, lines: 2, color: "@text/0.85", textAt: { "16:9": { lines: 1 } }, animate: soft(1.9), exit: leave(EXIT) }),
    button("cta", "cta", at4({
      "9:16": [0.5, 0.73, 0.44, 0.08], "16:9": [0.5, 0.905, 0.42, 0.07], "1:1": [0.5, 0.875, 0.34, 0.07], "4:5": [0.5, 0.86, 0.36, 0.075],
    }), 2.2, EXIT),
    grain(),
  ],
}, ["headline"]));
