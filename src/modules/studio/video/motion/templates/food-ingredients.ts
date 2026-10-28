import type { Key } from "../ease";
import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Responsive, Shape } from "../layout";
import { ALL_SHAPES, across, frame } from "./build";
import { BOWL, F, LEAF, backdrop, circle, outFade, outWords, popWords, riseWords, scrim, settle, txt, vis } from "./common-b";

/**
 * Ingredients: what goes into the dish. Four ingredients pop up around a bowl one by one, each
 * with its name; then they drop into the bowl in turn and it bounces. Drawn in code: a tomato, a
 * chilli, coriander and a lime.
 */

const EXIT = 5.9;
const LEN = 6.5;
const AT = [0.9, 1.25, 1.6, 1.95];
/** When each ingredient falls into the bowl. */
const DROP = [3.8, 3.95, 4.1, 4.25];

/** Where each ingredient sits per shape (canvas fractions). */
const SPOTS: Record<Shape, [number, number][]> = {
  "9:16": [[0.24, 0.32], [0.7, 0.34], [0.24, 0.47], [0.7, 0.49]],
  "16:9": [[0.46, 0.27], [0.84, 0.27], [0.44, 0.57], [0.86, 0.57]],
  "1:1": [[0.22, 0.29], [0.78, 0.29], [0.22, 0.54], [0.78, 0.54]],
  "4:5": [[0.22, 0.29], [0.78, 0.29], [0.22, 0.52], [0.78, 0.52]],
};
const BOWL_AT: Record<Shape, [number, number, number]> = { "9:16": [0.47, 0.62, 0.6], "16:9": [0.65, 0.66, 0.56], "1:1": [0.5, 0.7, 0.5], "4:5": [0.5, 0.7, 0.54] };
const SIZE = 0.15;
const spot = (i: number, k = SIZE, dy = 0, h = k): Responsive => across((shape, d) => frame(SPOTS[shape][i][0], SPOTS[shape][i][1] + dy / d.h, k, h));
/** A box on the bowl: offset `dx`,`dy` and size `k` (by `kh`) in bowl sizes. */
const bowl = (k = 1, dy = 0, kh = k, dx = 0): Responsive => across((shape, d) => {
  const [x, y, s] = BOWL_AT[shape];
  return frame(x + (dx * s) / d.w, y + (dy * s) / d.h, s * k, s * kh);
});
/** Where each ingredient comes to rest in the bowl's mouth (bowl sizes from its middle). */
const REST: [number, number][] = [[-0.2, -0.07], [0.16, -0.06], [-0.02, -0.09], [0.26, -0.05]];
/** The bowl bounces as the first and the last ingredient land. */
const BOUNCE: Key[] = [[0.3, 0.6, "back"], [0.9, 1], [DROP[0] + 0.4, 1, "out"], [DROP[0] + 0.5, 0.96, "spring"], [DROP[3] + 0.5, 1], [DROP[3] + 0.6, 0.95, "spring"], [DROP[3] + 1.1, 1], [EXIT, 1, "in"], [EXIT + 0.4, 0.7]];

/** Each ingredient's drawing, in its own box. */
const DRAWINGS: ((n: number, f: Responsive) => Layer[])[] = [
  (n, f) => [
    { id: `tomato${n}`, kind: "path", d: circle(40), frame: f, fill: { kind: "radial", stops: [[0, "#ff6b5b"], [1, "#d62828"]] } },
    { id: `tomato-leaf${n}`, kind: "path", d: "M50 14l6 8 10-2-6 8 6 6-10-1-6 7-4-8-10 2 6-8-6-6 10 0z", frame: f, fill: "#2f9e44" },
    { id: `tomato-shine${n}`, kind: "path", d: "M30 40a12 8 -30 1 0 .01 0z", frame: f, fill: "#ffffff/0.35" },
  ],
  (n, f) => [
    { id: `chilli${n}`, kind: "path", d: "M24 30C44 30 64 48 74 78c2 8-6 12-11 5C52 64 40 48 22 42c-7-2-6-12 2-12z", frame: f, fill: { kind: "linear", angle: 45, stops: [[0, "#e03131"], [1, "#a51111"]] } },
    { id: `chilli-stem${n}`, kind: "path", d: "M22 34c-6-4-8-12-3-19", frame: f, stroke: "#2f9e44", strokeWidth: 0.006 },
  ],
  (n, f) => [
    { id: `coriander${n}`, kind: "path", d: LEAF, frame: f, fill: "#40c057", stroke: "#2b8a3e", strokeWidth: 0.003 },
  ],
  (n, f) => [
    { id: `lime${n}`, kind: "path", d: circle(40), frame: f, fill: "#94d82d" },
    { id: `lime-flesh${n}`, kind: "path", d: circle(32), frame: f, fill: "#d8f5a2" },
    { id: `lime-segments${n}`, kind: "path", d: "M50 18V82M18 50H82M27 27L73 73M73 27L27 73", frame: f, stroke: "#94d82d", strokeWidth: 0.004 },
  ],
];

function ingredient(i: number): Layer[] {
  const t = AT[i], n = i + 1, drop = DROP[i];
  return [
    {
      // At its place: springs up, and is lifted away when it drops.
      id: `ingredient${n}`, kind: "group", frame: spot(i),
      scale: [[t, 0, "spring"], [t + 0.6, 1], [drop, 1, "out"], [drop + 0.12, 1.15, "in"], [drop + 0.3, 0]],
      rotate: [[t, -30, "out"], [t + 0.8, 0]], idle: { rotate: i % 2 ? 4 : -4 },
      children: DRAWINGS[i](n, spot(i)),
    },
    txt(`label${n}`, `ing${n}`, spot(i, 0.34, 0.12, 0.06), {
      role: "detail", font: "heading", weight: 700, size: 0.04, minSize: 0.036, lines: 1,
      animate: popWords(t + 0.2), exit: outFade(drop - 0.2, 0.25),
    }),
  ];
}

/** The same ingredient falling into the bowl and staying there, half hidden by its front. */
function falling(i: number): Layer {
  const n = i + 1, drop = DROP[i] + 0.15, f = bowl(0.2, REST[i][1], 0.2, REST[i][0]);
  return {
    id: `falling${n}`, kind: "group", frame: f, time: [drop, 99],
    dy: [[drop, -0.45, "in"], [drop + 0.4, 0]], rotate: [[drop, i % 2 ? -50 : 50, "out"], [drop + 0.6, i % 2 ? 12 : -16]],
    opacity: [[EXIT, 1, "in"], [EXIT + 0.4, 0]],
    children: DRAWINGS[i](n + 10, f),
  };
}

/**
 * This template's own look (Garden (light): fresh greens with a carrot accent.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const ingredientsPopLook: Look = {
  colors: { primary: "#2d6a4f", secondary: "#b7e4c7", accent: "#f77f00", background: "#f1f8e9", text: "#1b3a1f" },
  heading: { family: "Outfit", weight: 800 }, body: { family: "Inter", weight: 500 }, bangla: { family: "Hind Siliguri", weight: 700 },
  radius: 0.6, motion: "playful", grain: 0.02, grade: { warmth: 0.15 },
};

export const ingredientsPop: Template = {
  version: FORMAT_VERSION,
  id: "food-ingredients",
  name: "Ingredients",
  category: "food",
  description: "Four ingredients pop up around a bowl with their names, then drop into it one by one.",
  tags: ["food", "recipe", "ingredients", "fresh", "cooking", "healthy", "salad"],
  length: LEN,
  hold: [2.6, 3.6],
  shapes: ALL_SHAPES,
  look: ingredientsPopLook,
  fields: [
    { id: "title", kind: "text", label: "Title", en: "What goes in", bn: "ভেতরে যা আছে", limit: 28 },
    { id: "dish", kind: "text", label: "Dish", en: "Fresh garden salad", bn: "তাজা গার্ডেন সালাদ", limit: 32 },
    { id: "ing1", kind: "text", label: "Ingredient 1", en: "Tomato", bn: "টমেটো", limit: 18 },
    { id: "ing2", kind: "text", label: "Ingredient 2", en: "Green chilli", bn: "কাঁচা মরিচ", limit: 18 },
    { id: "ing3", kind: "text", label: "Ingredient 3", en: "Coriander", bn: "ধনেপাতা", limit: 18 },
    { id: "ing4", kind: "text", label: "Ingredient 4", en: "Lime", bn: "লেবু", limit: 18 },
  ],
  hits: [...AT.map((t) => ({ t, sfx: "pop" as const })), { t: DROP[0] + 0.4, sfx: "bubbles" }, { t: DROP[3] + 0.5, sfx: "ding" }],
  layers: [
    ...backdrop("waves", "drift", { intensity: 0.45, overIntensity: 0.4, speed: 0.7 }),
    scrim("scrim", F({ "9:16": [0.47, 0.2, 1.0, 0.3], "16:9": [0.2, 0.47, 0.9, 0.6], "1:1": [0.5, 0.11, 1.0, 0.25], "4:5": [0.5, 0.1, 1.0, 0.27] }), 0.6),
    txt("title", "title", F({
      "9:16": [0.47, 0.18, 0.78, 0.09], "16:9": [0.05, 0.4, 0.6, 0.2, 0], "1:1": [0.5, 0.085, 0.86, 0.075], "4:5": [0.5, 0.08, 0.86, 0.08],
    }), {
      role: "headline",
      font: "heading", weight: 800, size: 0.075, minSize: 0.07, lines: 1, textAt: { "16:9": { size: 0.085, lines: 2, align: "left" } },
      animate: settle(), exit: outWords(EXIT),
    }),
    txt("dish", "dish", F({
      "9:16": [0.47, 0.225, 0.78, 0.05], "16:9": [0.05, 0.56, 0.6, 0.06, 0], "1:1": [0.5, 0.155, 0.86, 0.045], "4:5": [0.5, 0.145, 0.86, 0.045],
    }), {
      role: "headline",
      size: 0.07, minSize: 0.07, lines: 1, color: "@text/0.8", italic: true, textAt: { "16:9": { align: "left" } },
      animate: riseWords(0.45, 0.05, 0.45), exit: outFade(EXIT, 0.25),
    }),
    { id: "bowl-shadow", kind: "ellipse", frame: bowl(0.8, 0.38, 0.12), fill: "#000000/0.3", blur: 0.02, opacity: vis(0.3, 0.4, EXIT, 0.4) },
    { id: "bowl-inside", kind: "ellipse", frame: bowl(0.84, -0.04, 0.12), fill: "@primaryDeep", scale: BOUNCE, opacity: vis(0.3, 0.3, EXIT, 0.4) },
    ...AT.flatMap((_, i) => ingredient(i)),
    ...AT.map((_, i) => falling(i)),
    {
      id: "bowl-group", kind: "group", frame: bowl(), scale: BOUNCE, opacity: vis(0.3, 0.3, EXIT, 0.4),
      children: [
        { id: "bowl", kind: "path", d: BOWL, frame: bowl(), fill: { kind: "linear", angle: 90, stops: [[0, "@primary"], [1, "@primaryDeep"]] } },
        { id: "bowl-band", kind: "path", d: "M16 60c20 6 48 6 68 0", frame: bowl(), stroke: "@onPrimary/0.4", strokeWidth: 0.004 },
      ],
    },
  ],
};
