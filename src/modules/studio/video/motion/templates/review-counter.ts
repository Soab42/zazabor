import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Shape } from "../layout";
import { ALL_SHAPES, FULL, pop, showHide } from "./build";
import { at4, each, grain, hookAt0, leave, live, rise, sink, soft, stars, words, type Spec } from "./common-a";
import { ESPRESSO } from "./looks";

/**
 * Customer Counter: "Trusted by", then a huge number counting up from zero to your customer
 * count, a row of faces popping in one after another, stars and the average rating; a little
 * confetti when the count lands.
 */

const EXIT = 6.2;
const COUNT: [number, number] = [0.8, 2.4];
/** A person, drawn in code. */
const PERSON = "M50 20a15 15 0 1 1-0.01 0ZM20 84c4-19 17-28 30-28s26 9 30 28Z";
const FACES_Y: Record<Shape, number> = { "9:16": 0.5, "16:9": 0.67, "1:1": 0.6, "4:5": 0.55 };
const FILLS = [["@primary", "@accent"], ["@secondary", "@primary"], ["@accent", "@secondary"], ["@primary", "@secondary"], ["@accent", "@primary"]];

function face(i: number): Layer {
  const fr = each((s): Spec => [0.5 + ((i - 2) * 0.085) / (s === "16:9" ? 16 / 9 : 1), FACES_Y[s], 0.11, 0.11]);
  const t = 1.2 + i * 0.1;
  return {
    id: `face${i + 1}`, kind: "group", frame: fr, clip: "ellipse", opacity: showHide(t, 0.2, EXIT, 0.3), scale: pop(t, 0.4, 0.5, EXIT, 0.7),
    children: [
      { id: `face${i + 1}-bg`, kind: "ellipse", frame: fr, fill: { kind: "linear", angle: 135, stops: [[0, FILLS[i][0]], [1, FILLS[i][1]]] } },
      { id: `face${i + 1}-person`, kind: "path", d: PERSON, frame: fr, fill: "@onPrimary/0.85" },
    ],
  };
}

export const customerCounter: Template = hookAt0({
  version: FORMAT_VERSION,
  id: "review-counter",
  name: "Customer Counter",
  category: "review",
  description: "\"Trusted by\", then your customer count counting up, a row of faces popping in, and the average rating.",
  tags: ["testimonial", "social proof", "customers", "counter", "trusted", "rating", "numbers"],
  length: 6.8,
  hold: [2.8, EXIT],
  shapes: ALL_SHAPES,
  look: ESPRESSO,
  fields: [
    { id: "kicker", kind: "text", label: "Above the number", en: "Trusted by", bn: "আস্থা রেখেছেন", limit: 22 },
    { id: "count", kind: "text", label: "Number", en: "10,000+", bn: "১০,০০০+", limit: 10 },
    { id: "label", kind: "text", label: "Under the number", en: "happy customers", bn: "খুশি ক্রেতা", limit: 26 },
    { id: "rating", kind: "text", label: "Rating", en: "4.9 average from 2,300 reviews", bn: "২,৩০০ রিভিউতে গড় ৪.৯", limit: 40 },
  ],
  hits: [{ t: 0.2, sfx: "rise" }, { t: 1.2, sfx: "pop" }, { t: COUNT[1], sfx: "ding" }],
  layers: [
    live("bg", "rays", { speed: 0.5, intensity: 0.5, colors: ["@primaryDeep", "@primary", "@secondary", "@deep", "@bg"], vignette: 0.45 }),
    live("motes", "drift", { over: true, speed: 0.6, intensity: 0.5, seed: 9 }),
    words("kicker", "kicker", at4({
      "9:16": [0.5, 0.2, 0.76, 0.08], "16:9": [0.5, 0.17, 1.2, 0.09], "1:1": [0.5, 0.14, 0.86, 0.08], "4:5": [0.5, 0.13, 0.86, 0.09],
    }), { font: "heading", size: 0.07, lines: 1, color: "@text/0.9", exit: sink(EXIT) }),
    words("count", "count", at4({
      "9:16": [0.5, 0.31, 0.76, 0.16], "16:9": [0.5, 0.36, 1.2, 0.22], "1:1": [0.5, 0.3, 0.86, 0.18], "4:5": [0.5, 0.28, 0.86, 0.18],
    }), {
      font: "heading", role: "cta", weight: 800, size: 0.16, minSize: 0.1, lines: 1, color: "@accent", glow: { color: "@accent/0.4", blur: 0.04 },
      textAt: { "16:9": { size: 0.2 } }, counter: { fromValue: 0, t: COUNT }, animate: rise(0.6, 0, 0.6), exit: leave(EXIT),
      scale: [[COUNT[1], 1, "out"], [COUNT[1] + 0.12, 1.06], [COUNT[1] + 0.5, 1]],
    }),
    words("label", "label", at4({
      "9:16": [0.5, 0.41, 0.76, 0.07], "16:9": [0.5, 0.53, 1.0, 0.07], "1:1": [0.5, 0.44, 0.8, 0.07], "4:5": [0.5, 0.4, 0.8, 0.07],
    }), {
      weight: 600, size: 0.05, lines: 1, animate: soft(1.0), exit: leave(EXIT), opacity: [[EXIT, 1, "in"], [EXIT + 0.3, 0]],
      // The signature (§12): a marker swipes across the words once the count has landed.
      marker: { draw: [[COUNT[1] + 0.15, 0, "out"], [COUNT[1] + 0.7, 1]], color: "@primary/0.5" },
    }),
    ...[0, 1, 2, 3, 4].map(face),
    ...stars("star", 5, (s) => [0.5, ({ "9:16": 0.58, "16:9": 0.8, "1:1": 0.74, "4:5": 0.67 } as Record<Shape, number>)[s]], 0.04, 1.8, EXIT),
    words("rating", "rating", at4({
      "9:16": [0.5, 0.625, 0.76, 0.045], "16:9": [0.5, 0.87, 0.8, 0.05], "1:1": [0.5, 0.8, 0.7, 0.045], "4:5": [0.5, 0.72, 0.7, 0.045],
    }), { role: "detail", weight: 500, size: 0.036, lines: 1, color: "@text/0.8", animate: soft(2.2), exit: leave(EXIT) }),
    { id: "confetti", kind: "fx", fx: "confetti", frame: FULL, burst: COUNT[1], amount: 0.6 },
    grain(),
  ],
}, ["kicker"]);
