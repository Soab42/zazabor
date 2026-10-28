import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import { ALL_SHAPES, frame } from "./build";
import { F, backdrop, outFade, outLine, riseWords, rnd, txt, vis } from "./common-b";

/**
 * Thank You: an outro. "Thank you" focuses in letter by letter, large and italic, while confetti in
 * the kit's colours drifts down; rings spread from behind the words, and the sign-off and logo
 * come up underneath.
 */

const EXIT = 5.4;
const LEN = 6.0;
const COLORS = ["@primary", "@accent", "@secondary", "@text/0.5"];

/** A piece of confetti: a small strip falling and turning from a place along the top. */
function piece(i: number): Layer {
  const x = 0.04 + rnd(i, 4) * 0.92, t = 0.3 + rnd(i, 5) * 1.6, fall = 2.6 + rnd(i, 6) * 1.6;
  const w = 0.012 + rnd(i, 7) * 0.014;
  return {
    id: `confetti${i}`, kind: i % 3 ? "rect" : "ellipse", frame: frame(x, -0.04, w, i % 3 ? w * 2.2 : w), radius: 0.002,
    fill: COLORS[i % COLORS.length],
    dy: [[t, 0, "linear"], [t + fall, 2.0]], dx: [[t, 0, "inOut"], [t + fall / 2, (rnd(i, 8) - 0.5) * 0.12, "inOut"], [t + fall, (rnd(i, 9) - 0.5) * 0.2]],
    rotate: [[t, rnd(i, 10) * 180, "linear"], [t + fall, rnd(i, 10) * 180 + (rnd(i, 11) > 0.5 ? 540 : -540)]],
    opacity: [[t, 0, "out"], [t + 0.2, 1], [EXIT, 1, "in"], [EXIT + 0.4, 0]],
  };
}

const WORDS = F({
  "9:16": [0.47, 0.38, 0.8, 0.36], "16:9": [0.5, 0.42, 1.5, 0.34], "1:1": [0.5, 0.4, 0.88, 0.3], "4:5": [0.5, 0.4, 0.88, 0.32],
});

/**
 * This template's own look (Blush (light): pink paper, coral and gold.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const thankYouLook: Look = {
  colors: { primary: "#ff4d6d", secondary: "#ffccd5", accent: "#ffb703", background: "#fff0f3", text: "#3a1020" },
  heading: { family: "Fraunces", weight: 800 }, body: { family: "DM Sans", weight: 500 }, bangla: { family: "Baloo Da 2", weight: 700 },
  radius: 0.8, motion: "playful", grain: 0.02, grade: { warmth: 0.15 },
};

export const thankYou: Template = {
  version: FORMAT_VERSION,
  id: "end-thanks",
  name: "Thank You",
  category: "hook",
  description: "An outro: a big italic thank-you focuses in under falling confetti, with your sign-off and logo.",
  tags: ["outro", "thank you", "end screen", "confetti", "goodbye", "celebrate"],
  length: LEN,
  hold: [2.6, EXIT],
  shapes: ALL_SHAPES,
  look: thankYouLook,
  fields: [
    { id: "logo", kind: "media", label: "Logo", en: "", bind: "logo" },
    { id: "thanks", kind: "text", label: "Thank you", en: "Thank you", bn: "ধন্যবাদ", limit: 24 },
    { id: "line", kind: "text", label: "Sign-off", en: "for watching. See you next time!", bn: "দেখার জন্য। আবার দেখা হবে!", limit: 48 },
  ],
  hits: [{ t: 0.2, sfx: "rise" }, { t: 0.9, sfx: "chime" }, { t: 1.0, sfx: "bubbles" }],
  layers: [
    ...backdrop("bokeh", "drift", { intensity: 0.7, overIntensity: 0.5, soft: 0.3 }),
    ...[0, 1, 2].map((i): Layer => ({
      id: `ring${i}`, kind: "ellipse", frame: F({ "9:16": [0.47, 0.38, 0.6, 0.6], "16:9": [0.5, 0.42, 0.6, 0.6], "1:1": [0.5, 0.4, 0.5, 0.5], "4:5": [0.5, 0.4, 0.55, 0.55] }),
      stroke: i === 1 ? "@accent/0.5" : "@primary/0.4", strokeWidth: 0.004,
      scale: [[0.8 + i * 0.25, 0.4, "out"], [2.4 + i * 0.25, 1.9]], opacity: [[0.8 + i * 0.25, 0.9, "out"], [2.4 + i * 0.25, 0]],
    })),
    ...Array.from({ length: 28 }, (_, i) => piece(i)),
    txt("thanks", "thanks", WORDS, {
      role: "headline",
      font: "heading", weight: 800, italic: true, size: 0.19, minSize: 0.1, lines: 2, lineHeight: 0.98, color: "@primary",
      textAt: { "16:9": { size: 0.22, minSize: 0.1, lines: 1 }, "1:1": { size: 0.15 } },
      shadow: { color: "@primary/0.25", blur: 0.04, y: 0.012 }, sheen: { at: [[1.6, -0.2, "inOut"], [2.5, 1.2]], width: 0.15, angle: 25, strength: 0.6 },
      animate: { unit: "char", t: 0, stagger: 0.04, duration: 0.7, from: { opacity: 0.6, scale: 1.15, blur: 0.03 } }, exit: outLine(EXIT, 0.35), idle: { scale: 0.04 },
    }),
    txt("line", "line", F({
      "9:16": [0.47, 0.54, 0.76, 0.1], "16:9": [0.5, 0.64, 1.2, 0.08], "1:1": [0.5, 0.62, 0.84, 0.08], "4:5": [0.5, 0.62, 0.84, 0.09],
    }), {
      role: "body",
      size: 0.044, minSize: 0.044, lines: 2, color: "@text/0.8", textAt: { "16:9": { lines: 1 } },
      animate: riseWords(1.1, 0.05, 0.5), exit: outFade(EXIT, 0.3),
    }),
    {
      id: "logo", kind: "image", slot: "logo", ifFilled: "logo", fit: "contain",
      frame: F({ "9:16": [0.47, 0.615, 0.18, 0.1], "16:9": [0.5, 0.83, 0.26, 0.12], "1:1": [0.5, 0.82, 0.2, 0.1], "4:5": [0.5, 0.82, 0.2, 0.1] }),
      opacity: vis(1.5, 0.4, EXIT, 0.35), dy: [[1.5, 0.03, "out"], [2.0, 0]],
    },
  ],
};
