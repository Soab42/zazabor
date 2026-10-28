import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Shape } from "../layout";
import { ALL_SHAPES, RING, pop, showHide } from "./build";
import { at4, bounce, each, grain, hookAt0, leave, live, rise, sink, soft, type Spec, strict916, words } from "./common-a";
import { LILAC } from "./looks";
import { handoff } from "./signature";

/**
 * Three Steps: numbered circles that draw themselves one after another along a connecting line,
 * each with its title and a line about it. Rows in tall shapes, columns in 16:9.
 */

const EXIT = 6.0;
const STEP = 0.4;

/** Per shape: where each step's circle sits (canvas fractions) and its size. */
const CIRCLES: Record<Shape, { at: [number, number][]; size: number }> = {
  "9:16": { at: [[0.2, 0.32], [0.2, 0.47], [0.2, 0.62]], size: 0.14 },
  "16:9": { at: [[0.24, 0.42], [0.5, 0.42], [0.76, 0.42]], size: 0.16 },
  "1:1": { at: [[0.17, 0.33], [0.17, 0.53], [0.17, 0.73]], size: 0.13 },
  "4:5": { at: [[0.17, 0.32], [0.17, 0.5], [0.17, 0.68]], size: 0.14 },
};
/** Title and description beside the circle (rows) or under it (16:9). */
const TEXT = (i: number, line: 0 | 1) => each((shape): Spec => {
  const [x, y] = CIRCLES[shape].at[i];
  if (shape === "16:9") return line ? [x, 0.69, 0.46, 0.08] : [x, 0.6, 0.46, 0.07];
  const dy = (line ? 0.028 : -0.025) * (shape === "9:16" ? 1 : 1.2);
  return [x + (shape === "9:16" ? 0.13 : 0.11), y + dy, shape === "9:16" ? 0.55 : 0.64, line ? 0.05 : 0.06, 0];
});

function step(i: number): Layer[] {
  const t = 0.8 + i * STEP;
  const circle = each((shape): Spec => [...CIRCLES[shape].at[i], CIRCLES[shape].size, CIRCLES[shape].size]);
  const rows = { "16:9": { align: "center" as const } };
  return [
    { id: `disc${i + 1}`, kind: "ellipse", frame: circle, fill: { kind: "linear", angle: 135, stops: [[0, "@primary"], [1, "@accent"]] }, glow: { color: "@primary/0.55", blur: 0.03 }, opacity: showHide(t, 0.2, EXIT, 0.3), scale: pop(t, 0.4, 0.55, EXIT, 0.6) },
    { id: `ring${i + 1}`, kind: "path", d: RING, frame: each((shape): Spec => [...CIRCLES[shape].at[i], CIRCLES[shape].size * 1.3, CIRCLES[shape].size * 1.3]), stroke: "@text/0.6", strokeWidth: 0.003, draw: [[t - 0.1, 0, "inOut"], [t + 0.6, 1]], opacity: showHide(t - 0.1, 0.1, EXIT, 0.3), rotate: [[t, -90, "out"], [t + 0.8, 0]] },
    words(`n${i + 1}`, `n${i + 1}`, circle, { font: "heading", weight: 800, size: 0.065, minSize: 0.044, lines: 1, color: "@onPrimary", animate: bounce(t + 0.15, 0, 0.45), exit: leave(EXIT) }),
    words(`s${i + 1}`, `s${i + 1}`, TEXT(i, 0), { weight: 700, size: 0.044, minSize: 0.044, lines: 1, align: "left", textAt: rows, animate: rise(t + 0.2), exit: sink(EXIT) }),
    words(`d${i + 1}`, `d${i + 1}`, TEXT(i, 1), { role: "detail", size: 0.036, minSize: 0.036, lines: 2, align: "left", color: "@text/0.75", textAt: rows, animate: soft(t + 0.35), exit: leave(EXIT) }),
  ];
}

export const threeSteps: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "feature-steps",
  name: "Three Steps",
  category: "feature",
  description: "Numbered circles draw themselves one after another along a line, each with a title and a note.",
  tags: ["feature", "steps", "how it works", "process", "onboarding", "numbered", "tutorial"],
  length: 6.6,
  hold: [2.6, EXIT],
  shapes: ALL_SHAPES,
  look: LILAC,
  fields: [
    { id: "headline", kind: "text", label: "Heading", en: "How it works", bn: "যেভাবে কাজ করে", limit: 26 },
    { id: "n1", kind: "text", label: "Step 1 number", en: "1", bn: "১", limit: 2 },
    { id: "s1", kind: "text", label: "Step 1", en: "Choose a plan", bn: "প্ল্যান বেছে নিন", limit: 24 },
    { id: "d1", kind: "text", label: "Step 1 note", en: "Pick what fits your team.", bn: "আপনার টিমের জন্য যেটা মানায়।", limit: 44 },
    { id: "n2", kind: "text", label: "Step 2 number", en: "2", bn: "২", limit: 2 },
    { id: "s2", kind: "text", label: "Step 2", en: "Connect your shop", bn: "দোকান যুক্ত করুন", limit: 24 },
    { id: "d2", kind: "text", label: "Step 2 note", en: "It takes two clicks.", bn: "মাত্র দুই ক্লিকে।", limit: 44 },
    { id: "n3", kind: "text", label: "Step 3 number", en: "3", bn: "৩", limit: 2 },
    { id: "s3", kind: "text", label: "Step 3", en: "Start selling", bn: "বিক্রি শুরু করুন", limit: 24 },
    { id: "d3", kind: "text", label: "Step 3 note", en: "Orders arrive right away.", bn: "অর্ডার আসবে সঙ্গে সঙ্গে।", limit: 44 },
  ],
  hits: [{ t: 0.3, sfx: "whoosh" }, { t: 0.8, sfx: "pop" }, { t: 0.8 + STEP, sfx: "pop" }, { t: 0.8 + STEP * 2, sfx: "pop" }],
  layers: [
    live("bg", "mesh", { intensity: 0.7, speed: 0.7, vignette: 0.12, seed: 17 }),
    live("bokeh", "bokeh", { over: true, intensity: 0.4, soft: 0.6, seed: 19 }),
    {
      // The connecting line: a thin bar that grows along its length (down in rows, across in 16:9).
      id: "link", kind: "rect", fill: "@text/0.3",
      frame: at4({ "9:16": [0.2, 0.47, 0.005, 0.533], "16:9": [0.5, 0.42, 0.924, 0.005], "1:1": [0.17, 0.53, 0.005, 0.4], "4:5": [0.17, 0.5, 0.005, 0.45] }),
      reveal: { from: "center", v: [[0.7, 0, "inOut"], [0.8 + STEP * 2.4, 1]] }, opacity: showHide(0.7, 0.1, EXIT, 0.3),
    },
    ...[0, 1, 2].flatMap(step),
    words("headline", "headline", at4({
      "9:16": [0.5, 0.17, 0.76, 0.09], "16:9": [0.5, 0.17, 1.2, 0.1], "1:1": [0.5, 0.12, 0.86, 0.08], "4:5": [0.5, 0.12, 0.86, 0.09],
    }), { font: "heading", size: 0.08, minSize: 0.07, lines: 1, textAt: { "1:1": { size: 0.07 } }, animate: rise(0.3), exit: sink(EXIT) }),
    // The signature (§12): the last step's disc grows into the next scene's frame.
    handoff("handoff", each((shape): Spec => [...CIRCLES[shape].at[2], CIRCLES[shape].size, CIRCLES[shape].size]), EXIT, 20, "@primary", "pill"),
    grain(),
  ],
}, ["headline"]));
