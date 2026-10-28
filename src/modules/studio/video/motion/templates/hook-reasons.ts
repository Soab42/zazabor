import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import { ALL_SHAPES } from "./build";
import { F, backdrop, outFade, outWords, popWords, punch, riseWords, slideWords, txt, type Spec, vis } from "./common-b";
import type { Shape } from "../layout";

/**
 * Three Reasons: a reel hook in the style of stories. Three segments at the top fill one by one as
 * each reason lands: its number pops in a badge and the line slides in beside it. The topic sits
 * on a highlighter stroke under the hook.
 */

const EXIT = 5.8;
const AT = [1.3, 2.3, 3.3];

/** Rows: middle y per shape, then badge x, text left x (canvas fractions), badge size and text width (short sides). */
const ROWS: Record<Shape, { y: number[]; badge: number; text: number; size: number; w: number }> = {
  "9:16": { y: [0.44, 0.55, 0.66], badge: 0.14, text: 0.23, size: 0.11, w: 0.62 },
  "16:9": { y: [0.3, 0.5, 0.7], badge: 0.53, text: 0.6, size: 0.13, w: 0.62 },
  "1:1": { y: [0.44, 0.6, 0.76], badge: 0.13, text: 0.21, size: 0.11, w: 0.7 },
  "4:5": { y: [0.42, 0.58, 0.74], badge: 0.13, text: 0.21, size: 0.12, w: 0.7 },
};
const row = (i: number, part: "badge" | "text"): Record<Shape, Spec> => {
  const out = {} as Record<Shape, Spec>;
  for (const s of ALL_SHAPES) {
    const r = ROWS[s];
    out[s] = part === "badge" ? [r.badge, r.y[i], r.size, r.size] : [r.text, r.y[i], r.w, r.size * 0.9, 0];
  }
  return out;
};
/** The story segments: left x of the first (canvas fraction), y, each one's width and the gap (short sides). */
const SEGS: Record<Shape, [number, number, number, number]> = {
  "9:16": [0.08, 0.115, 0.24, 0.03], "16:9": [0.06, 0.69, 0.2, 0.03], "1:1": [0.08, 0.07, 0.26, 0.03], "4:5": [0.08, 0.07, 0.26, 0.03],
};
const seg = (i: number): Record<Shape, Spec> => {
  const out = {} as Record<Shape, Spec>;
  for (const s of ALL_SHAPES) {
    const [x, y, w, gap] = SEGS[s];
    const W = s === "16:9" ? 16 / 9 : 1;
    out[s] = [x + (i * (w + gap)) / W, y, w, 0.008, 0];
  }
  return out;
};

function reason(i: number): Layer[] {
  const t = AT[i];
  const n = i + 1;
  return [
    { id: `track${n}`, kind: "rect", frame: F(seg(i)), radius: "pill", fill: "@text/0.2", opacity: vis(0.2, 0.3, EXIT, 0.3) },
    {
      id: `fill${n}`, kind: "rect", frame: F(seg(i)), radius: "pill", fill: "@accent", opacity: vis(0.2, 0.3, EXIT, 0.3),
      reveal: { from: "left", v: [[t - 0.2, 0, "inOut"], [t + 0.5, 1]] },
    },
    {
      id: `badge${n}`, kind: "ellipse", frame: F(row(i, "badge")), fill: i === 1 ? "@accent" : "@primary",
      shadow: { color: "#000000/0.25", blur: 0.02, y: 0.008 },
      scale: [[t, 0, "spring"], [t + 0.55, 1], [EXIT + i * 0.06, 1, "in"], [EXIT + 0.3 + i * 0.06, 0]],
    },
    txt(`num${n}`, `n${n}`, F(row(i, "badge")), {
      role: "body", font: "heading", weight: 800, size: 0.06, minSize: 0.044, lines: 1, color: i === 1 ? "@onAccent" : "@onPrimary",
      animate: { ...popWords(t + 0.12), stagger: 0 }, exit: outFade(EXIT + i * 0.06, 0.25),
    }),
    txt(`r${n}`, `r${n}`, F(row(i, "text")), {
      role: "body", font: "heading", weight: 600, size: 0.048, minSize: 0.044, lines: 2, align: "left", lineHeight: 1.1,
      textAt: { "16:9": { size: 0.052 } },
      animate: slideWords(t + 0.15, 0.6, 0.05, 0.45), exit: outWords(EXIT + i * 0.06, 0.28),
    }),
  ];
}

/**
 * This template's own look (Electric: violet night, hot pink and yellow.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const threeReasonsLook: Look = {
  colors: { primary: "#ff2e93", secondary: "#3a0ca3", accent: "#ffd60a", background: "#12002b", text: "#ffffff" },
  heading: { family: "Unbounded", weight: 800 }, body: { family: "Plus Jakarta Sans", weight: 600 }, bangla: { family: "Anek Bangla", weight: 700 },
  radius: 0.6, motion: "playful", grain: 0.02,
};

export const threeReasons: Template = {
  version: FORMAT_VERSION,
  id: "hook-reasons",
  name: "Three Reasons",
  category: "hook",
  description: "A story-style hook: three reasons land one by one as the segments at the top fill.",
  tags: ["hook", "reel", "list", "reasons", "top 3", "tips", "story", "numbered"],
  length: 6.4,
  hold: [3.9, EXIT],
  shapes: ALL_SHAPES,
  look: threeReasonsLook,
  fields: [
    { id: "hook", kind: "text", label: "Hook", en: "3 reasons you'll love", bn: "৩টি কারণে ভালো লাগবে", limit: 36 },
    { id: "topic", kind: "text", label: "Topic", en: "our cold brew", bn: "আমাদের কোল্ড ব্রু", limit: 28 },
    { id: "n1", kind: "text", label: "Badge 1", en: "1", bn: "১", limit: 3 },
    { id: "r1", kind: "text", label: "Reason 1", en: "Brewed slow for 18 hours", bn: "১৮ ঘণ্টা ধরে ধীরে তৈরি", limit: 40 },
    { id: "n2", kind: "text", label: "Badge 2", en: "2", bn: "২", limit: 3 },
    { id: "r2", kind: "text", label: "Reason 2", en: "Half the bitterness", bn: "তিক্ততা অর্ধেক", limit: 40 },
    { id: "n3", kind: "text", label: "Badge 3", en: "3", bn: "৩", limit: 3 },
    { id: "r3", kind: "text", label: "Reason 3", en: "Delivered cold to your door", bn: "ঠান্ডা অবস্থায় আপনার দরজায়", limit: 40 },
  ],
  hits: [{ t: 0.15, sfx: "pop" }, { t: AT[0], sfx: "pop" }, { t: AT[1], sfx: "pop" }, { t: AT[2], sfx: "ding" }],
  layers: [
    ...backdrop("mesh", "bokeh", { intensity: 0.75, overIntensity: 0.45, overSoft: 0.5, speed: 1.2 }),
    txt("hook", "hook", F({
      "9:16": [0.47, 0.215, 0.78, 0.18], "16:9": [0.06, 0.36, 0.72, 0.3, 0], "1:1": [0.5, 0.165, 0.86, 0.15], "4:5": [0.5, 0.15, 0.86, 0.17],
    }), {
      role: "headline",
      font: "heading", weight: 800, size: 0.1, minSize: 0.07, lines: 2, lineHeight: 1.02,
      textAt: { "16:9": { size: 0.095, lines: 3, align: "left" }, "1:1": { size: 0.08 }, "4:5": { size: 0.075 } },
      exit: outWords(EXIT - 0.05), scale: punch(),
    }),
    {
      id: "marker", kind: "rect", radius: 0.01, fill: "@accent/0.85", rotate: -1.5,
      frame: F({ "9:16": [0.47, 0.33, 0.6, 0.075], "16:9": [0.06, 0.585, 0.56, 0.085, 0], "1:1": [0.5, 0.262, 0.6, 0.068], "4:5": [0.5, 0.272, 0.6, 0.07] }),
      reveal: { from: "left", v: [[0.6, 0, "inOut"], [1.0, 1], [EXIT, 1, "in"], [EXIT + 0.3, 0]] },
    },
    txt("topic", "topic", F({
      "9:16": [0.47, 0.33, 0.58, 0.065], "16:9": [0.075, 0.585, 0.54, 0.075, 0], "1:1": [0.5, 0.262, 0.58, 0.06], "4:5": [0.5, 0.272, 0.58, 0.062],
    }), {
      role: "body",
      font: "heading", weight: 700, size: 0.05, minSize: 0.044, lines: 1, color: "@onAccent", textAt: { "16:9": { align: "left" } },
      animate: riseWords(0.75, 0.05, 0.45), exit: outFade(EXIT, 0.25),
    }),
    ...reason(0),
    ...reason(1),
    ...reason(2),
  ],
};
