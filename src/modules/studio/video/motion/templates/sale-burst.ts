import { FORMAT_VERSION, type Template } from "../format";
import { ALL_SHAPES, FULL, showHide, starburst } from "./build";
import { at4, button, grain, hookAt0, leave, live, rise, sink, soft, strict916, words } from "./common-a";
import { YELLOW_POP } from "./looks";
import { slam, slamIn } from "./signature";

/**
 * Percent Burst: a round badge bursts into a spiky star with a pop of confetti and sparks, its
 * percentage counting up from zero, then the headline and the button. Light pours from the badge.
 */

const EXIT = 5.8;
const POP = 1.0;

const BADGE = at4({
  "9:16": [0.5, 0.44, 0.62, 0.62], "16:9": [0.68, 0.5, 0.72, 0.72], "1:1": [0.5, 0.48, 0.48, 0.48], "4:5": [0.5, 0.46, 0.54, 0.54],
});
const ROUND = starburst(16, 0.985), SPIKY = starburst(16, 0.8);

export const percentBurst: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "sale-burst",
  name: "Percent Burst",
  category: "sale",
  description: "A badge bursts into a star with confetti and sparks while its percentage counts up.",
  tags: ["sale", "discount", "percent", "badge", "confetti", "burst", "offer"],
  length: 6.4,
  hold: [2.4, EXIT],
  shapes: ALL_SHAPES,
  look: YELLOW_POP,
  light: { x: 0.5, y: 0.45 },
  fields: [
    { id: "headline", kind: "text", label: "Headline", en: "Mega sale", bn: "মেগা সেল", limit: 24 },
    { id: "pct", kind: "text", label: "Discount", en: "50%", bn: "৫০%", limit: 5 },
    { id: "off", kind: "text", label: "Under the number", en: "Off", bn: "ছাড়", limit: 8 },
    { id: "sub", kind: "text", label: "Details", en: "On everything, this weekend only", bn: "সবকিছুতে, শুধু এই সপ্তাহান্তে", limit: 48, multiline: true },
    { id: "cta", kind: "text", label: "Button", en: "Shop the sale", bn: "সেলে কিনুন", limit: 20 },
  ],
  hits: [{ t: 0.3, sfx: "rise" }, { t: POP, sfx: "impact" }, { t: POP + 0.05, sfx: "pop" }, { t: 2.1, sfx: "click" }],
  layers: [
    live("bg", "waves", { intensity: 0.75, speed: 1.5, vignette: 0.15, seed: 7 }),
    live("rays", "rays", { over: true, colors: ["@accent", "@primary"], intensity: [[0, 0], [POP, 0.1, "out"], [POP + 0.5, 0.45], [EXIT, 0.35]], speed: 1.3 }),
    {
      id: "badge", kind: "path", d: ROUND, morph: { to: SPIKY, v: [[POP, 0, "spring"], [POP + 0.6, 1]] }, frame: BADGE,
      fill: { kind: "linear", angle: 135, stops: [[0, "@accent"], [1, "@primary"]] }, glow: { color: "@accent/0.55", blur: 0.06 },
      opacity: showHide(0.3, 0.2, EXIT, 0.3), scale: [[0.3, 0, "spring"], [0.9, 0.78], [POP, 0.78, "spring"], [POP + 0.6, 1], [EXIT, 1, "in"], [EXIT + 0.3, 0.6]],
      rotate: [[0.3, -30, "out"], [POP + 0.6, 0]], idle: { rotate: 24 },
    },
    { id: "sparks", kind: "fx", fx: "sparks", frame: BADGE, burst: POP, color: "@accent", color2: "#ffffff", amount: 1.2 },
    words("pct", "pct", at4({
      "9:16": [0.5, 0.423, 0.44, 0.2], "16:9": [0.68, 0.47, 0.5, 0.24], "1:1": [0.5, 0.455, 0.36, 0.16], "4:5": [0.5, 0.44, 0.4, 0.18],
    }), {
      font: "heading", weight: 800, size: 0.17, minSize: 0.09, lines: 1, color: "@onAccent", counter: { fromValue: 0, t: [POP, POP + 0.9] },
      // The signature (§12): the number slams onto the badge; the confetti fires as it settles.
      textAt: { "16:9": { size: 0.19 }, "1:1": { size: 0.13 }, "4:5": { size: 0.145 } }, opacity: slamIn(POP, EXIT + 0.3), scale: slam(POP), exit: leave(EXIT),
    }),
    words("off", "off", at4({
      "9:16": [0.5, 0.515, 0.3, 0.06], "16:9": [0.68, 0.64, 0.3, 0.07], "1:1": [0.5, 0.58, 0.24, 0.05], "4:5": [0.5, 0.556, 0.26, 0.055],
    }), { weight: 800, size: 0.045, lines: 1, upper: true, tracking: 0.2, color: "@onAccent", animate: soft(POP + 0.4), exit: leave(EXIT) }),
    { id: "confetti", kind: "fx", fx: "confetti", frame: FULL, burst: POP + 0.14, amount: 1 },
    words("headline", "headline", at4({
      "9:16": [0.5, 0.15, 0.76, 0.1], "16:9": [0.07, 0.3, 0.6, 0.2, 0], "1:1": [0.5, 0.1, 0.86, 0.08], "4:5": [0.5, 0.09, 0.86, 0.09],
    }), { font: "heading", size: 0.1, minSize: 0.07, lines: 1, textAt: { "16:9": { size: 0.11, lines: 2, align: "left" }, "1:1": { size: 0.075 }, "4:5": { size: 0.08 } }, animate: rise(1.4), exit: sink(EXIT) }),
    words("sub", "sub", at4({
      "9:16": [0.5, 0.66, 0.76, 0.08], "16:9": [0.07, 0.52, 0.56, 0.12, 0], "1:1": [0.5, 0.8, 0.84, 0.06], "4:5": [0.5, 0.79, 0.84, 0.07],
    }), { role: "detail", size: 0.04, minSize: 0.036, lines: 2, color: "@text/0.85", textAt: { "16:9": { align: "left" }, "1:1": { size: 0.036 } }, animate: soft(1.7), exit: leave(EXIT) }),
    button("cta", "cta", at4({
      "9:16": [0.5, 0.73, 0.44, 0.08], "16:9": [0.07, 0.7, 0.32, 0.1, 0], "1:1": [0.5, 0.9, 0.34, 0.07], "4:5": [0.5, 0.895, 0.36, 0.075],
    }), 2.1, EXIT, { fill: "@text", color: "@bg", glow: false }),
    grain(),
  ],
}, ["headline"]));
