import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Shape } from "../layout";
import { ALL_SHAPES, pop, showHide } from "./build";
import { at4, each, grain, hookAt0, leave, live, rise, sink, soft, type Spec, stars, strict916, words } from "./common-a";
import { COBALT } from "./looks";
import { handoff } from "./signature";

/**
 * Stat Counters: three numbers count up from zero on glass cards, each with a picture of what it
 * means: bars that grow, five stars that pop, a ring that fills.
 */

const EXIT = 6.0;
const CARD_STEP = 0.14;

/** Card centres per shape (canvas fractions) and sizes (short sides); rows, or columns in 16:9. */
const CARDS: Record<Shape, { at: [number, number][]; w: number; h: number }> = {
  "9:16": { at: [[0.5, 0.33], [0.5, 0.49], [0.5, 0.65]], w: 0.76, h: 0.24 },
  "16:9": { at: [[0.22, 0.56], [0.5, 0.56], [0.78, 0.56]], w: 0.46, h: 0.58 },
  "1:1": { at: [[0.5, 0.3], [0.5, 0.52], [0.5, 0.74]], w: 0.84, h: 0.19 },
  "4:5": { at: [[0.5, 0.3], [0.5, 0.5], [0.5, 0.7]], w: 0.84, h: 0.21 },
};
const DIM: Record<Shape, [number, number]> = { "9:16": [1, 16 / 9], "16:9": [16 / 9, 1], "1:1": [1, 1], "4:5": [1, 1.25] };
/** A spot on card `i`: offsets in short sides from its centre. */
const onCard = (i: number, dx: number, dy: number, w: number, h: number, ax = 0.5) => (shape: Shape): Spec => {
  const [x, y] = CARDS[shape].at[i], [dw, dh] = DIM[shape];
  return [x + dx / dw, y + dy / dh, w, h, ax];
};
const NUMBER = (i: number) => each((shape) => shape === "16:9" ? onCard(i, 0, 0.08, 0.42, 0.1)(shape) : onCard(i, -CARDS[shape].w / 2 + 0.05, -0.025, 0.42, 0.1, 0)(shape));
const LABEL = (i: number) => each((shape) => shape === "16:9" ? onCard(i, 0, 0.16, 0.42, 0.05)(shape) : onCard(i, -CARDS[shape].w / 2 + 0.05, 0.045, 0.42, 0.045, 0)(shape));
const VISUAL = (i: number, w = 0.22, h = 0.13) => (shape: Shape): Spec => shape === "16:9" ? onCard(i, 0, -0.12, w, h)(shape) : onCard(i, CARDS[shape].w / 2 - 0.05 - w / 2, 0, w, h)(shape);

function stat(i: number): Layer[] {
  const t = 0.6 + i * CARD_STEP;
  const card = each((shape): Spec => [...CARDS[shape].at[i], CARDS[shape].w, CARDS[shape].h]);
  const visual: Layer[] = i === 0
    ? [{ id: "bars", kind: "chart", chart: "bars", values: [32, 48, 41, 66, 80, 100], frame: each(VISUAL(0)), grow: [[t + 0.4, 0, "out"], [t + 1.3, 1]], stagger: 0.1, color: "@primary", color2: "@accent", glow: { color: "@accent/0.4", blur: 0.02 } }]
    : i === 1
      ? stars("star", 5, (shape) => { const [x, y] = VISUAL(1)(shape); return [x as number, y as number]; }, 0.038, t + 0.45, EXIT)
      : [{ id: "ring", kind: "chart", chart: "ring", field: "v3", frame: each(VISUAL(2, 0.13, 0.13)), grow: [[t + 0.4, 0, "out"], [t + 1.4, 1]], color: "@accent", width: 0.016, glow: { color: "@accent/0.5", blur: 0.02 } }];
  return [
    {
      id: `card${i + 1}`, kind: "rect", frame: card, radius: "theme", fill: "@deep/0.5", stroke: "@text/0.16", strokeWidth: 0.0025,
      shadow: { color: "#000000/0.35", blur: 0.04, y: 0.015 }, opacity: showHide(t, 0.3, EXIT, 0.3), scale: pop(t, 0.9, 0.55, EXIT, 0.94), dy: [[t, 0.04, "out"], [t + 0.55, 0]],
    },
    words(`v${i + 1}`, `v${i + 1}`, NUMBER(i), {
      font: "heading", weight: 800, size: 0.075, minSize: 0.07, lines: 1, align: "left", textAt: { "16:9": { align: "center", size: 0.08 } },
      counter: { fromValue: 0, t: [t + 0.3, t + 1.5] }, animate: rise(t + 0.2), exit: sink(EXIT),
    }),
    words(`l${i + 1}`, `l${i + 1}`, LABEL(i), { weight: 500, role: "detail", size: 0.036, minSize: 0.036, lines: 1, align: "left", color: "@text/0.75", textAt: { "16:9": { align: "center" } }, animate: soft(t + 0.4), exit: leave(EXIT) }),
    ...visual,
  ];
}

export const statCounters: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "feature-stats",
  name: "Stat Counters",
  category: "feature",
  description: "Three numbers count up from zero on glass cards, with growing bars, popping stars and a filling ring.",
  tags: ["feature", "stats", "numbers", "counter", "social proof", "chart", "results"],
  length: 6.6,
  hold: [2.6, EXIT],
  shapes: ALL_SHAPES,
  look: COBALT,
  fields: [
    { id: "headline", kind: "text", label: "Heading", en: "Loved by thousands", bn: "হাজারো মানুষের ভালোবাসা", limit: 30 },
    { id: "v1", kind: "text", label: "Number 1", en: "250K+", bn: "২.৫ লাখ+", limit: 10 },
    { id: "l1", kind: "text", label: "Label 1", en: "Downloads", bn: "ডাউনলোড", limit: 22 },
    { id: "v2", kind: "text", label: "Number 2", en: "4.9", bn: "৪.৯", limit: 6 },
    { id: "l2", kind: "text", label: "Label 2", en: "Average rating", bn: "গড় রেটিং", limit: 22 },
    { id: "v3", kind: "text", label: "Number 3 (a percentage)", en: "98%", bn: "৯৮%", limit: 5 },
    { id: "l3", kind: "text", label: "Label 3", en: "Would recommend", bn: "সুপারিশ করবেন", limit: 22 },
  ],
  hits: [{ t: 0.3, sfx: "whoosh" }, { t: 0.9, sfx: "rise" }, { t: 1.5, sfx: "pop" }, { t: 2.3, sfx: "ding" }],
  layers: [
    live("bg", "mesh", { colors: ["@primary", "@secondary", "@accent", "@deep", "@bg", "@deep"], intensity: 0.7, seed: 27 }),
    live("rays", "rays", { over: true, intensity: 0.45, speed: 0.8 }),
    ...[0, 1, 2].flatMap(stat),
    words("headline", "headline", at4({
      "9:16": [0.5, 0.16, 0.76, 0.1], "16:9": [0.5, 0.15, 1.2, 0.1], "1:1": [0.5, 0.11, 0.86, 0.08], "4:5": [0.5, 0.11, 0.86, 0.09],
    }), { font: "heading", size: 0.075, minSize: 0.07, lines: 2, textAt: { "16:9": { lines: 1 }, "1:1": { size: 0.07, lines: 1 }, "4:5": { lines: 1 } }, animate: rise(0.3), exit: sink(EXIT) }),
    // The signature (§12): the last card read grows into the next scene's frame.
    handoff("handoff", each((shape): Spec => [...CARDS[shape].at[2], CARDS[shape].w, CARDS[shape].h]), EXIT, 8, "@deep"),
    grain(),
  ],
}, ["headline"]));
