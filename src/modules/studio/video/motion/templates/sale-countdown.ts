import type { Key } from "../ease";
import { FORMAT_VERSION, type Template } from "../format";
import { ALL_SHAPES, pop, showHide } from "./build";
import { at4, button, grain, hookAt0, leave, live, rise, sink, soft, strict916, words } from "./common-a";
import { VOLT } from "./looks";
import { settleConfetti, slam, slamIn } from "./signature";

/**
 * Flash Countdown: a bolt-lit "Flash sale" chip, the offer, and a big clock ticking down a second
 * at a time on a glass card (with a heartbeat on every tick), a stock bar draining under it, over
 * a floor grid racing toward the camera.
 */

const EXIT = 6.0;
const TICK = 1.3;

const CARD = at4({
  "9:16": [0.5, 0.49, 0.8, 0.2], "16:9": [0.73, 0.45, 0.8, 0.3], "1:1": [0.5, 0.5, 0.8, 0.2], "4:5": [0.5, 0.47, 0.82, 0.21],
});
const CLOCK = at4({
  "9:16": [0.5, 0.49, 0.72, 0.16], "16:9": [0.73, 0.45, 0.72, 0.24], "1:1": [0.5, 0.5, 0.72, 0.16], "4:5": [0.5, 0.47, 0.74, 0.17],
});
const CHIP = at4({
  "9:16": [0.5, 0.15, 0.44, 0.065], "16:9": [0.07, 0.2, 0.36, 0.07, 0], "1:1": [0.5, 0.1, 0.4, 0.06], "4:5": [0.5, 0.09, 0.42, 0.06],
});

/** A small kick on every second the clock ticks. */
const beat: Key[] = [];
for (let t = TICK + 1; t < EXIT; t += 1) beat.push([t, 1.045, "out"], [t + 0.18, 1]);

export const flashCountdown: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "sale-countdown",
  name: "Flash Countdown",
  category: "sale",
  description: "A flash-sale clock ticking down a second at a time on a glass card, with a draining stock bar.",
  tags: ["sale", "flash sale", "countdown", "timer", "urgency", "limited time", "clock"],
  length: 6.6,
  hold: [2.4, EXIT],
  shapes: ALL_SHAPES,
  look: VOLT,
  light: { x: 0.5, y: 1.05 },
  fields: [
    { id: "kicker", kind: "text", label: "Chip", en: "Flash sale", bn: "ফ্ল্যাশ সেল", limit: 18 },
    { id: "headline", kind: "text", label: "Offer", en: "Up to 70% off", bn: "৭০% পর্যন্ত ছাড়", limit: 30 },
    { id: "label", kind: "text", label: "Above the clock", en: "Ends in", bn: "শেষ হবে", limit: 20 },
    { id: "clock", kind: "text", label: "Time left (h:mm:ss or mm:ss)", en: "02:59:59", bn: "০২:৫৯:৫৯", limit: 9 },
    { id: "cta", kind: "text", label: "Button", en: "Shop now", bn: "এখনই কিনুন", limit: 20 },
  ],
  hits: [{ t: 0.2, sfx: "impact" }, { t: 0.9, sfx: "whoosh" }, { t: TICK, sfx: "impact" }, { t: 2.0, sfx: "pop" }],
  layers: [
    live("bg", "grid", { colors: ["@accent", "@primary", "@secondary", "@deep", "@bg"], speed: [[0, 3, "out"], [1.5, 1]], intensity: 0.85, vignette: 0.5 }),
    live("rays", "rays", { over: true, colors: ["@primary", "@accent"], intensity: [[0, 0], [1, 0.55]], speed: 1.2 }),
    {
      id: "chip", kind: "group", frame: CHIP, opacity: showHide(0.2, 0.25, EXIT, 0.3), scale: pop(0.2, 0.5, 0.55, EXIT, 0.85),
      children: [
        { id: "chip-pill", kind: "rect", frame: CHIP, radius: "pill", fill: "@accent", glow: { color: "@accent/0.6", blur: 0.03 } },
        { id: "chip-text", kind: "text", field: "kicker", frame: CHIP, font: "body", weight: 800, role: "detail", size: 0.036, minSize: 0.036, lines: 1, upper: true, tracking: 0.16, color: "@onAccent" },
      ],
    },
    words("headline", "headline", at4({
      "9:16": [0.5, 0.26, 0.76, 0.2], "16:9": [0.07, 0.4, 0.76, 0.26, 0], "1:1": [0.5, 0.22, 0.86, 0.14], "4:5": [0.5, 0.2, 0.86, 0.16],
    }), { font: "heading", size: 0.11, minSize: 0.07, lines: 2, lineHeight: 1.02, textAt: { "16:9": { size: 0.1, align: "left" }, "1:1": { size: 0.08 }, "4:5": { size: 0.085 } }, animate: rise(0.5), exit: sink(EXIT) }),
    words("label", "label", at4({
      "9:16": [0.5, 0.4, 0.6, 0.05], "16:9": [0.73, 0.24, 0.6, 0.06], "1:1": [0.5, 0.36, 0.5, 0.045], "4:5": [0.5, 0.33, 0.5, 0.045],
    }), { weight: 600, role: "detail", size: 0.036, lines: 1, upper: true, tracking: 0.24, color: "@text/0.8", animate: soft(0.9), exit: leave(EXIT) }),
    {
      id: "card", kind: "rect", frame: CARD, radius: "theme", fill: "@deep/0.55", stroke: "@text/0.22", strokeWidth: 0.003,
      shadow: { color: "#000000/0.4", blur: 0.05, y: 0.02, follow: true }, opacity: showHide(0.9, 0.3, EXIT, 0.3), scale: pop(0.9, 0.8, 0.6, EXIT, 0.9),
      sheen: { at: [[1.4, -0.2, "inOut"], [2.2, 1.2]], width: 0.2, strength: 0.35 },
    },
    words("clock", "clock", CLOCK, {
      font: "heading", weight: 800, size: 0.14, minSize: 0.08, lines: 1, tracking: 0.03, clock: { t: TICK }, glow: { color: "@accent/0.45", blur: 0.03 },
      // The signature (§12): the clock slams down onto the card, and confetti fires as it settles.
      textAt: { "16:9": { size: 0.17 } }, opacity: slamIn(TICK, EXIT + 0.3), exit: leave(EXIT), scale: [...slam(TICK), ...beat],
    }),
    settleConfetti("confetti", TICK, 0.7, CARD),
    {
      id: "stock", kind: "fx", fx: "progress", color: "@accent", glow: { color: "@accent/0.6", blur: 0.02 },
      frame: at4({ "9:16": [0.5, 0.59, 0.6, 0.016], "16:9": [0.73, 0.66, 0.6, 0.018], "1:1": [0.5, 0.645, 0.56, 0.014], "4:5": [0.5, 0.6, 0.56, 0.015] }),
      value: [[1.3, 1, "linear"], [EXIT, 0.28]], opacity: showHide(1.2, 0.3, EXIT, 0.3),
    },
    button("cta", "cta", at4({
      "9:16": [0.5, 0.7, 0.44, 0.085], "16:9": [0.07, 0.72, 0.34, 0.1, 0], "1:1": [0.5, 0.8, 0.38, 0.08], "4:5": [0.5, 0.78, 0.4, 0.085],
    }), 2.0, EXIT),
    grain(),
  ],
}, ["headline"]));
