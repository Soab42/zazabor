import type { Key } from "../ease";
import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Shape } from "../layout";
import { ALL_SHAPES, showHide } from "./build";
import { at4, each, grain, hookAt0, leave, live, rise, sink, slideIn, standIn, strict916, words } from "./common-a";
import { TRICOLOUR } from "./looks";
import { darkness, rimLight } from "./signature";

/**
 * Colourways: the product in three colours. Each new colour opens out of an iris over the last,
 * the backdrop changes with it, its name slides in, and a ring moves along the swatches below.
 */

const EXIT = 6.6;
/** When colours 2 and 3 arrive. */
const SWITCH = [2.4, 4.5];
const TINTS = ["@primary", "@accent", "@secondary"];

const PRODUCT = at4({
  "9:16": [0.5, 0.42, 0.7, 0.7],
  "16:9": [0.63, 0.5, 0.82, 0.82],
  "1:1": [0.5, 0.47, 0.6, 0.6],
  "4:5": [0.5, 0.45, 0.66, 0.66],
});
const SWATCHES: Record<Shape, [number, number, number]> = {
  "9:16": [0.5, 0.735, 0.06],
  "16:9": [0.17, 0.72, 0.065],
  "1:1": [0.5, 0.9, 0.055],
  "4:5": [0.5, 0.89, 0.058],
};
const GAP = 0.1;
const swatch = (i: number, grow = 1) => each((shape) => {
  const [x, y, s] = SWATCHES[shape];
  return [x + ((i - 1) * GAP) / (shape === "16:9" ? 16 / 9 : 1), y, s * grow, s * grow];
});
const NAME = at4({
  "9:16": [0.5, 0.665, 0.76, 0.07], "16:9": [0.07, 0.56, 0.6, 0.1, 0], "1:1": [0.5, 0.82, 0.7, 0.06], "4:5": [0.5, 0.8, 0.7, 0.065],
});

/** The signature (§12) on the first colour: it rises out of the dark, a rim light sweeps it, then a fast push. */
const FIRST = {
  scale: [[0.3, 0.85, "out"], [1.0, 1], [1.2, 1, "out"], [1.8, 1.05]] as Key[],
  dy: [[0.3, 0.06, "out"], [1.0, 0]] as Key[],
  sheen: rimLight(0.9),
};

function colour(i: number): Layer[] {
  const t = i === 0 ? 0.3 : SWITCH[i - 1];
  const until = i === 2 ? EXIT : SWITCH[i];
  const reveal = i === 0 ? undefined : { from: "circle" as const, v: [[t, 0, "inOut"], [t + 0.6, 1]] as [number, number, "inOut"?][] };
  const time: [number, number] | undefined = i === 2 ? undefined : [0, until + 0.65];
  const shown = i === 0 ? showHide(0.3, 0.4, EXIT, 0.4) : showHide(t, 0.05, EXIT, 0.4);
  return [
    {
      ...live(`wash${i + 1}`, "mesh", { colors: [TINTS[i], TINTS[(i + 1) % 3], "@bg", "@deep", "@bg", TINTS[i]], seed: i * 7, intensity: 0.8 }),
      ...(reveal ? { reveal: { from: "circle" as const, v: [[t - 0.05, 0, "inOut"], [t + 0.7, 1]] as [number, number, "inOut"?][] } } : {}),
      ...(time ? { time } : {}),
    },
    {
      id: `photo${i + 1}`, kind: "image", slot: `photo${i + 1}`, frame: PRODUCT, fit: "contain", placeholder: `Add colour ${i + 1}`,
      shadow: { color: "#000000/0.4", blur: 0.05, y: 0.03 }, opacity: shown, idle: { dy: -0.015 },
      ...(i === 0 ? FIRST : {}), ...(reveal ? { reveal } : {}), ...(time ? { time } : {}),
    },
    standIn(`art${i + 1}`, "sneaker", `photo${i + 1}`, PRODUCT, {
      tint: TINTS[i], tint2: TINTS[(i + 1) % 3], shadow: { color: "#000000/0.4", blur: 0.05, y: 0.03 }, opacity: shown, idle: { dy: -0.015 },
      ...(i === 0 ? FIRST : {}),
      rotate: [[t, i === 0 ? -8 : -14, "out"], [t + 0.8, -4]], ...(reveal ? { reveal } : {}), ...(time ? { time } : {}),
    }),
    words(`name${i + 1}`, `c${i + 1}`, NAME, {
      font: "heading", size: 0.06, minSize: 0.044, lines: 1, textAt: { "16:9": { align: "left" } },
      animate: slideIn(t + 0.15, 0.6), exit: i === 2 ? leave(EXIT) : { unit: "line", t: until, stagger: 0, duration: 0.25, from: { opacity: 0, dx: -0.6 } },
      time: [0, i === 2 ? EXIT + 1 : until + 0.2],
    }),
    {
      id: `swatch${i + 1}`, kind: "ellipse", frame: swatch(i), fill: TINTS[i], stroke: "#ffffff/0.6", strokeWidth: 0.003,
      opacity: showHide(1.0 + i * 0.1, 0.25, EXIT, 0.3), scale: [[1.0 + i * 0.1, 0.3, "spring"], [1.5 + i * 0.1, 1]],
    },
  ];
}

export const colourways: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "launch-colorway",
  name: "Colourways",
  category: "launch",
  description: "Your product in three colours: each opens out of an iris with its name, and a ring moves along the swatches.",
  tags: ["launch", "colours", "colourway", "variants", "switcher", "fashion", "sneaker"],
  length: 7.3,
  hold: [2.2, EXIT],
  shapes: ALL_SHAPES,
  look: TRICOLOUR,
  fields: [
    { id: "title", kind: "text", label: "Heading", en: "Pick your colour", bn: "আপনার রং বেছে নিন", limit: 30 },
    { id: "c1", kind: "text", label: "Colour 1", en: "Ember Red", bn: "এম্বার লাল", limit: 20 },
    { id: "c2", kind: "text", label: "Colour 2", en: "Ocean Teal", bn: "সমুদ্র নীল", limit: 20 },
    { id: "c3", kind: "text", label: "Colour 3", en: "Midnight", bn: "মাঝরাত", limit: 20 },
    { id: "photo1", kind: "media", label: "Photo, colour 1", en: "", product: true },
    { id: "photo2", kind: "media", label: "Photo, colour 2", en: "", product: true },
    { id: "photo3", kind: "media", label: "Photo, colour 3", en: "", product: true },
  ],
  hits: [{ t: 0.3, sfx: "whoosh" }, { t: SWITCH[0], sfx: "swoosh" }, { t: SWITCH[1], sfx: "swoosh" }],
  layers: [
    // Each colour's backdrop, then its product, then the names and swatches over all of them.
    ...[0, 1, 2].map((i) => colour(i)[0]),
    ...[0, 1, 2].flatMap((i) => colour(i).slice(1, 3)),
    { ...darkness("dark", PRODUCT, 0.1, 0.9, 0.5), time: [0, SWITCH[0]] },
    ...[0, 1, 2].flatMap((i) => colour(i).slice(3)),
    live("bokeh", "bokeh", { over: true, intensity: 0.5, soft: 0.7, seed: 6 }),
    {
      id: "ring", kind: "ellipse", frame: swatch(0, 1.55), stroke: "@text", strokeWidth: 0.004,
      dx: [[SWITCH[0], 0, "inOut"], [SWITCH[0] + 0.5, GAP], [SWITCH[1], GAP, "inOut"], [SWITCH[1] + 0.5, GAP * 2]],
      opacity: showHide(1.4, 0.25, EXIT, 0.3), scale: [[1.4, 0.6, "out"], [1.9, 1]],
    },
    words("title", "title", at4({
      "9:16": [0.5, 0.147, 0.76, 0.16], "16:9": [0.07, 0.32, 0.66, 0.2, 0], "1:1": [0.5, 0.09, 0.86, 0.07], "4:5": [0.5, 0.08, 0.86, 0.07],
    }), {
      font: "heading", size: 0.07, minSize: 0.07, lines: 2, lineHeight: 1.05, textAt: { "16:9": { size: 0.09, lines: 2, align: "left" }, "1:1": { size: 0.07, lines: 1 }, "4:5": { lines: 1 } },
      animate: rise(0.5), exit: sink(EXIT),
    }),
    grain(),
  ],
}, ["photo1", "art1", "title"]));
