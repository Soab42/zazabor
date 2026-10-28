import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Shape } from "../layout";
import { ALL_SHAPES, across, frame } from "./build";
import { BIRD, F, backdrop, drawOn, outFade, pulse, txt, vis } from "./common-b";

/**
 * Victory Day: dignified and slow. A red sun rises from behind green hills at dawn (a landscape,
 * not the flag, so nothing sits on the flag), light spreads from it, a few birds cross in
 * silence, and "মহান বিজয় দিবস" and a line of remembrance fade up under the date. No springs, no
 * bounces: long eases only. The date and title can be changed for Independence Day (২৬ মার্চ).
 */

const EXIT = 6.4;
const LEN = 7.2;
const RED = "@accent";
const CREAM = "@text";

/** The sun's middle and size per shape, and where the hills start (canvas fractions). */
const SUN_AT: Record<Shape, [number, number, number]> = { "9:16": [0.47, 0.47, 0.4], "16:9": [0.3, 0.52, 0.5], "1:1": [0.5, 0.5, 0.34], "4:5": [0.5, 0.49, 0.36] };
const HILLS: Record<Shape, number> = { "9:16": 0.5, "16:9": 0.6, "1:1": 0.57, "4:5": 0.56 };
const SUN = across((shape) => frame(SUN_AT[shape][0], SUN_AT[shape][1], SUN_AT[shape][2], SUN_AT[shape][2]));
const hill = (dy: number) => across((shape, d) => frame(0.5, HILLS[shape] + dy / d.h, "full", 1.2, 0.5, 0));

/** A bird gliding across, wings tilting slowly. */
function bird(i: number): Layer {
  const t = 1.4 + i * 0.25;
  return {
    id: `bird${i + 1}`, kind: "path", d: BIRD, fill: CREAM + "/0.85",
    frame: across((shape, d) => frame(SUN_AT[shape][0] + (0.12 + i * 0.07) / d.w, SUN_AT[shape][1] - (0.24 - (i % 2) * 0.06 + i * 0.015) / d.h, 0.05 - i * 0.006, 0.025 - i * 0.003)),
    dx: [[t, -0.2, "linear"], [LEN, 0.55 + i * 0.05]], dy: pulse(t, LEN, 9 + i, 0, -0.012), rotate: pulse(t, LEN, 8 + i, -3, 3),
    opacity: [[t, 0, "inOut"], [t + 1.0, 0.85], [EXIT, 0.85, "in"], [EXIT + 0.6, 0]],
  };
}

/**
 * This template's own look (Victory Day: bottle green and red.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const victoryDayLook: Look = {
  colors: { primary: "#006a4e", secondary: "#0b5e43", accent: "#f42a41", background: "#00301f", text: "#fdf6e3" },
  heading: { family: "Playfair Display", weight: 700 }, body: { family: "Hind Siliguri", weight: 500 }, bangla: { family: "Tiro Bangla", weight: 400 },
  radius: 0.3, motion: "smooth", grain: 0.02, grade: { warmth: 0.1 },
  backdrop: ["#ffb3a8", "#f42a41", "#2e9c6a", "#00301f", "#006a4e"],
};

export const victoryDay: Template = {
  version: FORMAT_VERSION,
  id: "festive-victory",
  name: "Victory Day",
  category: "festive",
  description: "Dignified and slow: a red sun rises over green hills at dawn, and মহান বিজয় দিবস fades up under the date.",
  tags: ["victory day", "বিজয় দিবস", "16 december", "independence day", "স্বাধীনতা দিবস", "bangladesh", "national", "festive", "tribute"],
  length: LEN,
  hold: [3.6, EXIT],
  shapes: ALL_SHAPES,
  look: victoryDayLook,
  light: { x: 0.47, y: 0.47 },
  fields: [
    { id: "date", kind: "text", label: "Date", en: "16 December", bn: "১৬ ডিসেম্বর", limit: 20 },
    { id: "title", kind: "text", label: "Title", en: "Victory Day", bn: "মহান বিজয় দিবস", limit: 28 },
    { id: "line", kind: "text", label: "Message", en: "In honour of the heroes who gave everything", bn: "বীর শহীদদের প্রতি গভীর শ্রদ্ধা", limit: 60 },
    { id: "brand", kind: "text", label: "From", en: "Lumen & Co.", bn: "লুমেন অ্যান্ড কো.", limit: 32 },
  ],
  hits: [{ t: 0.3, sfx: "rise" }, { t: 2.0, sfx: "chime" }],
  layers: [
    ...backdrop("rays", "drift", {
      intensity: 0.55, overIntensity: 0.3, speed: 0.5,
    }),
    {
      id: "sun-glow", kind: "ellipse", frame: SUN, fill: { kind: "radial", stops: [[0, RED + "/0.4"], [1, RED + "/0"]] },
      scale: [[0.2, 1.0, "inOut"], [3.0, 2.4]], opacity: vis(0.2, 2.0, EXIT, 0.8), idle: { scale: 0.08 },
    },
    {
      id: "sun", kind: "ellipse", frame: SUN, fill: { kind: "radial", stops: [[0, RED], [1, RED]] },
      dy: [[0, 0.16, "inOut"], [3.0, 0]], opacity: [[0, 0.7, "inOut"], [1.6, 1], [EXIT, 1, "inOut"], [EXIT + 0.8, 0]],
      glow: { color: RED + "/0.35", blur: 0.03 },
    },
    // Two hills in front of the sun, the nearer one drifting a little faster (parallax).
    { id: "hill-far", kind: "path", d: "M0 14C18 2 34 10 52 4S84 4 100 12V100H0z", frame: hill(-0.04), fill: "@secondary", dx: [[0, 0, "linear"], [LEN, -0.01]] },
    { id: "hill-near", kind: "path", d: "M0 18C22 6 46 16 70 6S94 10 100 14V100H0z", frame: hill(0.03), fill: "@deep", dx: [[0, 0, "linear"], [LEN, -0.025]] },
    ...[0, 1, 2, 3].map((i) => bird(i)),
    txt("date", "date", F({
      "9:16": [0.47, 0.18, 0.7, 0.05], "16:9": [0.58, 0.26, 0.7, 0.06, 0], "1:1": [0.5, 0.1, 0.7, 0.05], "4:5": [0.5, 0.1, 0.7, 0.05],
    }), {
      role: "detail", size: 0.038, minSize: 0.036, lines: 1, color: CREAM + "/0.9", upper: true, tracking: 0.16, weight: 600, textAt: { "16:9": { align: "left" } },
      opacity: [[0, 0.6, "inOut"], [1.2, 1]], exit: outFade(EXIT, 0.6),
    }),
    {
      id: "rule", kind: "path", d: "M0 50H100", stroke: CREAM + "/0.5", strokeWidth: 0.0018, cap: "butt",
      frame: F({ "9:16": [0.47, 0.212, 0.16, 0.01], "16:9": [0.58, 0.31, 0.16, 0.01, 0], "1:1": [0.5, 0.135, 0.14, 0.01], "4:5": [0.5, 0.133, 0.14, 0.01] }),
      draw: drawOn(1.0, 2.0, [EXIT, EXIT + 0.6]),
    },
    txt("title", "title", F({
      "9:16": [0.47, 0.26, 0.78, 0.11], "16:9": [0.58, 0.41, 0.7, 0.2, 0], "1:1": [0.5, 0.2, 0.86, 0.1], "4:5": [0.5, 0.195, 0.86, 0.1],
    }), {
      role: "headline", font: "heading", weight: 700, size: 0.1, minSize: 0.07, lines: 1, color: CREAM, textAt: { "16:9": { size: 0.09, lines: 1, align: "left" }, "1:1": { size: 0.085 } },
      shadow: { color: "@deep/0.6", blur: 0.03, y: 0.01, follow: true },
      opacity: vis(1.2, 1.4, EXIT, 0.8), blur: [[1.2, 0.01, "inOut"], [2.4, 0]], dy: [[1.2, 0.02, "inOut"], [2.6, 0]],
    }),
    txt("line", "line", F({
      "9:16": [0.47, 0.62, 0.74, 0.1], "16:9": [0.58, 0.72, 0.7, 0.1, 0], "1:1": [0.5, 0.74, 0.8, 0.09], "4:5": [0.5, 0.72, 0.8, 0.09],
    }), {
      role: "body", size: 0.044, minSize: 0.044, lines: 2, color: CREAM + "/0.9", lineHeight: 1.3, textAt: { "16:9": { align: "left" } },
      animate: { unit: "word", t: 2.2, stagger: 0.06, duration: 0.9, from: { opacity: 0, blur: 0.08 } }, exit: outFade(EXIT, 0.6),
    }),
    txt("brand", "brand", F({
      "9:16": [0.47, 0.71, 0.6, 0.045], "16:9": [0.58, 0.86, 0.6, 0.05, 0], "1:1": [0.5, 0.87, 0.6, 0.045], "4:5": [0.5, 0.86, 0.6, 0.045],
    }), {
      role: "detail", size: 0.036, minSize: 0.036, lines: 1, color: CREAM + "/0.7", upper: true, tracking: 0.12, textAt: { "16:9": { align: "left" } },
      animate: { unit: "word", t: 3.0, stagger: 0.08, duration: 0.8, from: { opacity: 0, dy: 0.3 } }, exit: outFade(EXIT, 0.6),
    }),
  ],
};
