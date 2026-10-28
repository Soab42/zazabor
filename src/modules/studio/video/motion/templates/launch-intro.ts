import type { Key } from "../ease";
import { FORMAT_VERSION, type Template } from "../format";
import { ALL_SHAPES, FULL, RING, pop, showHide } from "./build";
import { at4, focus, grain, hookAt0, leave, live, rise, sink, soft, standIn, strict916, words } from "./common-a";
import { DAYBREAK } from "./looks";
import { rimLight } from "./signature";

/**
 * Introducing: kinetic type. "INTRODUCING" lands letter by letter while its spacing closes up,
 * the product opens out of an iris inside a ring that draws itself, then the name rises and the
 * launch date settles in a chip.
 */

const EXIT = 5.6;

const PRODUCT = at4({
  "9:16": [0.5, 0.49, 0.6, 0.6],
  "16:9": [0.71, 0.5, 0.72, 0.72],
  "1:1": [0.5, 0.5, 0.42, 0.42],
  "4:5": [0.5, 0.49, 0.5, 0.5],
});
const HALO = at4({
  "9:16": [0.5, 0.49, 0.8, 0.8],
  "16:9": [0.71, 0.5, 0.9, 0.9],
  "1:1": [0.5, 0.5, 0.56, 0.56],
  "4:5": [0.5, 0.49, 0.66, 0.66],
});
/** The signature (§12): it rises out of the iris (the dark), a rim light sweeps it, then a fast push eases into the drift. */
const PUSH: Key[] = [[1.0, 1.18, "out"], [1.8, 1], [2.0, 1, "out"], [2.6, 1.05], [EXIT, 1.05, "in"], [EXIT + 0.4, 0.94]];
const RISE: Key[] = [[1.0, 0.06, "out"], [1.9, 0]];
const DATE = at4({
  "9:16": [0.5, 0.75, 0.6, 0.07],
  "16:9": [0.07, 0.77, 0.5, 0.08, 0],
  "1:1": [0.5, 0.895, 0.5, 0.068],
  "4:5": [0.5, 0.9, 0.52, 0.072],
});

export const introducing: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "launch-intro",
  name: "Introducing",
  category: "launch",
  description: "Kinetic type: \"Introducing\" lands letter by letter, the product opens out of an iris, then its name and launch date.",
  tags: ["launch", "introducing", "kinetic type", "reveal", "date", "new"],
  length: 6.5,
  hold: [2.6, EXIT],
  shapes: ALL_SHAPES,
  look: DAYBREAK,
  fields: [
    { id: "kicker", kind: "text", label: "Opening word", en: "Introducing", bn: "পরিচয় করিয়ে দিচ্ছি", limit: 22 },
    { id: "title", kind: "text", label: "Product name", en: "Nova Watch", bn: "নোভা ওয়াচ", limit: 30 },
    { id: "tagline", kind: "text", label: "Tagline", en: "Time, beautifully kept.", bn: "সময়, সুন্দরভাবে।", limit: 60, multiline: true },
    { id: "date", kind: "text", label: "Launch date", en: "Available 1 November", bn: "১ নভেম্বর থেকে পাওয়া যাবে", limit: 32 },
    { id: "product", kind: "media", label: "Product photo", en: "", product: true },
  ],
  hits: [{ t: 0.2, sfx: "typing" }, { t: 1.0, sfx: "whoosh" }, { t: 1.55, sfx: "impact" }, { t: 2.1, sfx: "click" }],
  layers: [
    live("bg", "mesh", { speed: 1, intensity: [[0, 0.55], [1.6, 0.95], [EXIT, 0.85]], vignette: 0.15, seed: 3 }),
    live("motes", "drift", { over: true, intensity: 0.7, seed: 5 }),
    { id: "rays", kind: "fx", fx: "rays", frame: HALO, color: "@primary", amount: 0.7, opacity: showHide(0.9, 0.8, EXIT, 0.5) },
    {
      id: "ring", kind: "path", d: RING, frame: HALO, stroke: "@accent/0.8", strokeWidth: 0.004,
      draw: [[0.7, 0, "inOut"], [1.6, 1]], opacity: showHide(0.7, 0.2, EXIT, 0.4), rotate: [[0.7, -40, "out"], [1.8, 0]], idle: { rotate: 25 },
    },
    {
      id: "product", kind: "image", slot: "product", frame: PRODUCT, fit: "contain", placeholder: "Add your product photo",
      shadow: { color: "#000000/0.45", blur: 0.05, y: 0.02 },
      reveal: { from: "circle", v: [[1.0, 0, "out"], [1.7, 1]] }, scale: PUSH, dy: RISE,
      opacity: showHide(1.0, 0.2, EXIT, 0.4), idle: { scale: 0.04 }, sheen: rimLight(1.85),
    },
    standIn("stand-in", "watch", "product", PRODUCT, {
      tint: "@primary", tint2: "@secondary", shadow: { color: "#000000/0.45", blur: 0.05, y: 0.02 },
      reveal: { from: "circle", v: [[1.0, 0, "out"], [1.7, 1]] }, scale: PUSH, dy: RISE,
      opacity: showHide(1.0, 0.2, EXIT, 0.4), idle: { scale: 0.04 }, sheen: rimLight(1.85),
    }),
    words("kicker", "kicker", at4({
      "9:16": [0.5, 0.107, 0.76, 0.06], "16:9": [0.07, 0.27, 0.8, 0.06, 0], "1:1": [0.5, 0.075, 0.84, 0.05], "4:5": [0.5, 0.075, 0.84, 0.05],
    }), {
      weight: 700, role: "detail", size: 0.042, lines: 1, upper: true, color: "@accent", tracking: [[0.15, 0.9, "out"], [1.2, 0.26]],
      textAt: { "16:9": { align: "left" } }, animate: focus(0.15, 0.035, 0.55), exit: leave(EXIT),
    }),
    words("title", "title", at4({
      "9:16": [0.5, 0.234, 0.76, 0.25], "16:9": [0.07, 0.44, 0.78, 0.26, 0], "1:1": [0.5, 0.165, 0.86, 0.12], "4:5": [0.5, 0.165, 0.86, 0.15],
    }), {
      font: "heading", size: 0.12, minSize: 0.08, lines: 2, lineHeight: 1.02,
      textAt: { "16:9": { size: 0.11, align: "left" }, "1:1": { size: 0.085, lines: 1 }, "4:5": { size: 0.1 } },
      animate: rise(1.45, 0.08, 0.6), exit: sink(EXIT),
      sheen: { at: [[2.1, -0.2, "inOut"], [3.0, 1.2]], width: 0.2, angle: 20, strength: 0.6 },
    }),
    words("tagline", "tagline", at4({
      "9:16": [0.5, 0.69, 0.76, 0.09], "16:9": [0.07, 0.62, 0.74, 0.1, 0], "1:1": [0.5, 0.8, 0.84, 0.07], "4:5": [0.5, 0.79, 0.84, 0.08],
    }), {
      role: "detail", size: 0.042, minSize: 0.036, lines: 2, color: "@text/0.78", textAt: { "16:9": { align: "left" }, "1:1": { size: 0.036 } },
      animate: soft(1.85), exit: leave(EXIT),
    }),
    {
      id: "date", kind: "group", frame: DATE, opacity: showHide(2.1, 0.3, EXIT, 0.3), scale: pop(2.1, 0.8, 0.5, EXIT, 0.9),
      children: [
        { id: "date-pill", kind: "rect", frame: DATE, radius: "pill", fill: "@text/0.08", stroke: "@accent/0.7", strokeWidth: 0.003 },
        words("date-text", "date", DATE, { weight: 600, role: "detail", size: 0.036, minSize: 0.036, lines: 1, color: "@text" }),
      ],
    },
    { id: "flash", kind: "rect", frame: FULL, fill: "@primary", blend: "screen", opacity: [[1.5, 0, "out"], [1.58, 0.35], [1.95, 0]] },
    grain(),
  ],
}, ["kicker"]));
