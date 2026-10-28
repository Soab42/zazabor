import type { Key } from "../ease";
import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Responsive, Shape } from "../layout";
import { ALL_SHAPES, across, frame, pop } from "./build";
import { F, backdrop, outFade, outWords, popWords, punch, riseWords, txt, vis } from "./common-b";

/**
 * Delivery: a rider on a scooter speeds in with a hot box on the back, wheels spinning and speed
 * lines streaming, brakes beside the offer and rides off at the end. Generic wording ("your
 * favourite delivery app"): no app names or logos.
 */

const EXIT = 5.4;
const LEN = 6.0;
const ARRIVE = 1.4;
/** The scooter's middle (canvas fractions) and size (short sides) per shape. */
const RIDE: Record<Shape, [number, number, number]> = { "9:16": [0.47, 0.44, 0.46], "16:9": [0.72, 0.56, 0.62], "1:1": [0.5, 0.55, 0.42], "4:5": [0.5, 0.51, 0.46] };
/** A box on the scooter: middle `x`,`y` in its 0…100 drawing, `w`,`h` in the same units. */
const on = (x: number, y: number, w: number, h = w): Responsive => across((shape, d) => {
  const [cx, cy, s] = RIDE[shape];
  return frame(cx + ((x - 50) / 100) * s / d.w, cy + ((y - 50) / 100) * s / d.h, (w / 100) * s, (h / 100) * s);
});
const WHOLE = on(50, 50, 100);

/** Drives in and stops; rides off at the end. */
const drive: { dx: Key[]; dy: Key[] } = {
  dx: [[0.25, -1.3, "out"], [ARRIVE, 0], [EXIT - 0.1, 0, "in"], [EXIT + 0.5, 1.5]],
  dy: [[ARRIVE, 0, "out"], [ARRIVE + 0.12, 0.01], [ARRIVE + 0.35, 0]],
};
/** The wheels turn with the drive (eased the same way, so they stop as it stops). */
const SPIN: Key[] = [[0.25, 0, "out"], [ARRIVE, 900], [EXIT - 0.1, 900, "in"], [EXIT + 0.5, 1800]];

const wheel = (id: string, x: number): Layer => ({
  id, kind: "group", frame: on(x, 74, 26), rotate: SPIN,
  children: [
    { id: `${id}-tyre`, kind: "ellipse", frame: on(x, 74, 26), fill: "#1b1b1f", stroke: "@text/0.8", strokeWidth: 0.004 },
    { id: `${id}-hub`, kind: "path", d: "M50 14V86M14 50H86M25 25L75 75M75 25L25 75", frame: on(x, 74, 18), stroke: "@text/0.6", strokeWidth: 0.003 },
  ],
});

/** A speed line trailing the scooter while it moves. */
const streak = (n: number, y: number, w: number): Layer => ({
  id: `streak${n}`, kind: "path", d: "M0 50H100", frame: on(-12 - w / 2, y, w, 4), stroke: "@text/0.5", strokeWidth: 0.004,
  ...drive, opacity: [[0.25, 0, "out"], [0.4, 0.9], [ARRIVE - 0.3, 0.9, "in"], [ARRIVE, 0], [EXIT - 0.1, 0, "out"], [EXIT + 0.1, 0.9]],
  scale: [[0.25, 1.5, "out"], [ARRIVE, 0.4]],
});

/**
 * This template's own look (Tomato: deep red night, hot red and amber.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const deliveryRideLook: Look = {
  colors: { primary: "#ef233c", secondary: "#8d0801", accent: "#ffb703", background: "#2a0a0a", text: "#fff1e6" },
  heading: { family: "Righteous", weight: 400 }, body: { family: "Poppins", weight: 500 }, bangla: { family: "Baloo Da 2", weight: 700 },
  radius: 0.8, motion: "playful", grain: 0.02, grade: { warmth: 0.2 },
};

export const deliveryRide: Template = {
  version: FORMAT_VERSION,
  id: "food-delivery",
  name: "Delivery",
  category: "food",
  description: "A rider speeds in with a hot box on the back, brakes beside your offer and rides off.",
  tags: ["food", "delivery", "order now", "restaurant", "scooter", "offer", "call to action"],
  length: LEN,
  hold: [2.2, EXIT - 0.2],
  shapes: ALL_SHAPES,
  look: deliveryRideLook,
  light: { x: [[0, 0.2], [LEN, 0.8]], y: 0.1 },
  fields: [
    { id: "hook", kind: "text", label: "Headline", en: "Hungry? We deliver.", bn: "খিদে পেয়েছে? আমরা পৌঁছে দিই।", limit: 36 },
    { id: "line", kind: "text", label: "Where to order", en: "Order on your favourite delivery app", bn: "আপনার প্রিয় ডেলিভারি অ্যাপে অর্ডার করুন", limit: 60 },
    { id: "offer", kind: "text", label: "Offer", en: "Free delivery over Tk 500", bn: "৫০০ টাকার উপরে ফ্রি ডেলিভারি", limit: 44 },
    { id: "cta", kind: "text", label: "Button", en: "Order now", bn: "এখনই অর্ডার করুন", limit: 22 },
  ],
  hits: [{ t: 0.15, sfx: "whoosh" }, { t: ARRIVE, sfx: "impact" }, { t: 1.9, sfx: "ding" }, { t: EXIT - 0.1 - 0.1, sfx: "swoosh" }],
  layers: [
    ...backdrop("grid", "drift", { intensity: 0.75, overIntensity: 0.5, speed: 1.2 }),
    {
      id: "road", kind: "rect", radius: "pill", fill: "@text/0.12",
      frame: F({ "9:16": [0.5, 0.534, "full", 0.012], "16:9": [0.72, 0.775, 1.1, 0.012], "1:1": [0.5, 0.70, "full", 0.012], "4:5": [0.5, 0.645, "full", 0.012] }),
      reveal: { from: "left", v: [[0.1, 0, "inOut"], [0.6, 1], [EXIT, 1, "in"], [EXIT + 0.4, 0]] },
    },
    { id: "shadow", kind: "ellipse", frame: on(50, 88, 90, 8), fill: "#000000/0.3", blur: 0.012, ...drive },
    streak(1, 40, 40),
    streak(2, 56, 60),
    streak(3, 70, 30),
    {
      id: "scooter", kind: "group", frame: WHOLE, ...drive, shadow: { color: "#000000/0.35", blur: 0.02, y: 0.01, follow: true },
      rotate: [[0.25, 0, "out"], [ARRIVE - 0.1, 0, "out"], [ARRIVE + 0.05, -4], [ARRIVE + 0.4, 0], [EXIT - 0.1, 0, "out"], [EXIT + 0.1, 5]],
      children: [
        { id: "box", kind: "rect", frame: on(28, 40, 30, 26), radius: 0.01, fill: "@accent", shadow: { color: "#000000/0.25", blur: 0.01, y: 0.005 } },
        { id: "box-mark", kind: "icon", icon: "heart", frame: on(28, 40, 12), color: "@onAccent", strokeWidth: 2.2 },
        { id: "frame", kind: "path", d: "M20 74h24l10-24h20l6 24M60 50l-6-20h12M30 54h18", frame: WHOLE, stroke: "@text", strokeWidth: 0.012, cap: "round" },
        { id: "rider", kind: "path", d: "M50 50L46 30L58 32M46 30l-4 16", frame: WHOLE, stroke: "@text", strokeWidth: 0.014, cap: "round" },
        { id: "helmet", kind: "ellipse", frame: on(48, 21, 13), fill: "@accent", stroke: "@text", strokeWidth: 0.004 },
        wheel("wheel-back", 20),
        wheel("wheel-front", 80),
      ],
    },
    {
      // A puff as it brakes.
      id: "puff", kind: "ellipse", frame: on(8, 80, 16), fill: "@text/0.3",
      scale: [[ARRIVE - 0.05, 0.2, "out"], [ARRIVE + 0.6, 1.6]], opacity: [[ARRIVE - 0.05, 0], [ARRIVE, 0.8, "out"], [ARRIVE + 0.6, 0]],
    },
    txt("hook", "hook", F({
      "9:16": [0.47, 0.205, 0.78, 0.19], "16:9": [0.05, 0.27, 0.74, 0.26, 0], "1:1": [0.5, 0.13, 0.86, 0.15], "4:5": [0.5, 0.125, 0.86, 0.17],
    }), {
      role: "headline",
      font: "heading", weight: 800, size: 0.095, minSize: 0.07, lines: 2, color: "@text", lineHeight: 1.02,
      textAt: { "9:16": { size: 0.085 }, "16:9": { size: 0.085, align: "left" }, "1:1": { size: 0.075 }, "4:5": { size: 0.075 } },
      exit: outWords(EXIT), scale: punch(),
    }),
    txt("line", "line", F({
      "9:16": [0.47, 0.31, 0.74, 0.09], "16:9": [0.05, 0.48, 0.8, 0.13, 0], "1:1": [0.5, 0.275, 0.8, 0.05], "4:5": [0.5, 0.245, 0.8, 0.06],
    }), {
      role: "body",
      size: 0.044, minSize: 0.044, lines: 2, color: "@text/0.8", textAt: { "16:9": { align: "left" }, "1:1": { lines: 1 } },
      animate: riseWords(0.7, 0.03, 0.45), exit: outFade(EXIT, 0.25),
    }),
    {
      id: "offer-chip", kind: "rect", radius: "pill", fill: "@text/0.14", stroke: "@text/0.35", strokeWidth: 0.002,
      frame: F({ "9:16": [0.47, 0.575, 0.74, 0.07], "16:9": [0.05, 0.63, 0.74, 0.08, 0], "1:1": [0.5, 0.775, 0.74, 0.065], "4:5": [0.5, 0.735, 0.74, 0.065] }),
      scale: pop(1.7, 0.7, 0.45, EXIT, 0.9), opacity: vis(1.7, 0.2, EXIT, 0.3),
    },
    txt("offer", "offer", F({
      "9:16": [0.47, 0.575, 0.68, 0.045], "16:9": [0.075, 0.63, 0.68, 0.05, 0], "1:1": [0.5, 0.775, 0.68, 0.042], "4:5": [0.5, 0.735, 0.68, 0.042],
    }), {
      role: "cta",
      font: "heading", weight: 600, size: 0.044, minSize: 0.044, lines: 1, color: "@text", textAt: { "16:9": { align: "left" } },
      animate: riseWords(1.8, 0.03, 0.4), exit: outFade(EXIT, 0.25),
    }),
    {
      id: "button", kind: "rect", radius: "pill", fill: "@accent", glow: { color: "@accent/0.6", blur: 0.03 },
      frame: F({ "9:16": [0.47, 0.625, 0.44, 0.07], "16:9": [0.05, 0.78, 0.44, 0.1, 0], "1:1": [0.5, 0.885, 0.42, 0.08], "4:5": [0.5, 0.85, 0.42, 0.08] }),
      scale: pop(1.95, 0.6, 0.5, EXIT, 0.9), opacity: vis(1.95, 0.2, EXIT, 0.3),
      sheen: { at: [[2.6, -0.2, "inOut"], [3.3, 1.2], [4.2, -0.2, "inOut"], [4.9, 1.2]], width: 0.25, angle: 20, strength: 0.4 },
    },
    txt("cta", "cta", F({
      "9:16": [0.47, 0.625, 0.38, 0.045], "16:9": [0.075, 0.78, 0.38, 0.06, 0], "1:1": [0.5, 0.885, 0.36, 0.05], "4:5": [0.5, 0.85, 0.36, 0.05],
    }), {
      role: "cta",
      font: "heading", weight: 800, size: 0.044, minSize: 0.044, lines: 1, color: "@onAccent", upper: true, tracking: 0.06,
      textAt: { "16:9": { size: 0.044, align: "left" } }, animate: popWords(2.05), exit: outFade(EXIT, 0.25),
    }),
  ],
};
