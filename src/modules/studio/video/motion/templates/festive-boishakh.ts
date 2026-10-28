import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import { ALL_SHAPES, frame } from "./build";
import { F, backdrop, circle, dotRing, drawOn, outFade, outWords, petals, riseChars, riseWords, scrim, txt, vis } from "./common-b";

/**
 * Pohela Boishakh: the Bengali New Year in red and white. An alpona medallion draws itself ring by
 * ring and its rings turn slowly against each other; bands of paddy-leaf motifs drift along the top
 * and bottom edges; "শুভ নববর্ষ" and the year (১৪৩৩) gather beneath. Bangla first, with English.
 */

const EXIT = 5.8;
const LEN = 6.5;
const RED = "@primary";
const WHITE = "@text";
const MUSTARD = "@secondary";

const MEDALLION = F({ "9:16": [0.47, 0.29, 0.6, 0.6], "16:9": [0.22, 0.5, 0.68, 0.68], "1:1": [0.5, 0.29, 0.42, 0.42], "4:5": [0.5, 0.28, 0.46, 0.46] });

/** A band of paddy leaves and dots along an edge (in a 240 × 20 box, wider than any canvas). */
const BAND = (() => {
  let d = "";
  for (let i = 0; i < 48; i++) {
    const x = i * 5 + 2.5;
    d += i % 2
      ? `M${x} 10m-1.4 0a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0`
      : `M${x - 2} 16Q${x} 2 ${x + 2} 16Q${x} 12 ${x - 2} 16z`;
  }
  return `${d}M0 19H240`;
})();
const band = (id: string, top: boolean): Layer => ({
  id, kind: "path", d: BAND, view: [240, 20], fill: WHITE + "/0.85", stroke: WHITE + "/0.5", strokeWidth: 0.0015,
  frame: frame(0.5, top ? 0.035 : 0.965, 3.0, 0.25, 0.5, 0.5), rotate: top ? 0 : 180,
  dx: [[0, top ? 0 : -0.25, "linear"], [LEN, top ? -0.25 : 0]], opacity: vis(0.2, 0.8, EXIT, 0.5),
});

/** One ring of the medallion: drawn on at `t`, turning `turn` degrees over the clip. */
const ring = (id: string, d: string, t: number, turn: number, o: Partial<Layer> & { stroke?: string; fill?: string; strokeWidth?: number }): Layer => ({
  id, kind: "path", d, frame: MEDALLION, draw: drawOn(t, t + 1.1), rotate: [[0, 0, "linear"], [LEN, turn]],
  scale: [[t, 0.8, "out"], [t + 1.2, 1], [EXIT, 1, "in"], [EXIT + 0.6, 1.15]], opacity: vis(t, 0.3, EXIT, 0.6), ...o,
} as Layer);

/**
 * This template's own look (Boishakh: red and white with mustard.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const boishakhGreetingLook: Look = {
  colors: { primary: "#c8102e", secondary: "#f2b134", accent: "#f2b134", background: "#8a0b1f", text: "#fff6ea" },
  heading: { family: "Fraunces", weight: 700 }, body: { family: "Hind Siliguri", weight: 500 }, bangla: { family: "Galada", weight: 400 },
  radius: 0.5, motion: "smooth", grain: 0.03, grade: { warmth: 0.2 },
  backdrop: ["#e63946", "#ff7b54", "#a4161a", "#4a0610", "#c8102e", "#7a0a1c"],
};

export const boishakhGreeting: Template = {
  version: FORMAT_VERSION,
  id: "festive-boishakh",
  name: "Pohela Boishakh",
  category: "festive",
  description: "শুভ নববর্ষ in red and white: an alpona medallion draws itself and turns, with paddy-leaf bands along the edges.",
  tags: ["pohela boishakh", "পহেলা বৈশাখ", "bengali new year", "নববর্ষ", "festive", "bangladesh", "alpona", "greeting"],
  length: LEN,
  hold: [2.6, EXIT],
  shapes: ALL_SHAPES,
  look: boishakhGreetingLook,
  fields: [
    { id: "greeting", kind: "text", label: "Greeting", en: "Shubho Noboborsho", bn: "শুভ নববর্ষ", limit: 24 },
    { id: "year", kind: "text", label: "Year", en: "1433", bn: "১৪৩৩", limit: 8 },
    { id: "line", kind: "text", label: "Message", en: "Wishing you a joyful new year", bn: "নতুন বছর কাটুক আনন্দে", limit: 48 },
    { id: "brand", kind: "text", label: "From", en: "From all of us at Lumen & Co.", bn: "লুমেন অ্যান্ড কো.-এর পক্ষ থেকে", limit: 44 },
  ],
  hits: [{ t: 0.2, sfx: "chime" }, { t: 1.3, sfx: "rise" }, { t: 1.9, sfx: "ding" }],
  layers: [
    ...backdrop("mesh", "bokeh", {
      intensity: 0.65, overIntensity: 0.5, speed: 0.8, overSoft: 0.5,
    }),
    scrim("scrim", F({ "9:16": [0.47, 0.62, 1.0, 0.5], "16:9": [0.72, 0.52, 1.0, 0.7], "1:1": [0.5, 0.7, 1.0, 0.45], "4:5": [0.5, 0.67, 1.0, 0.5] }), 0.55, "#3a0008"),
    band("band-top", true),
    band("band-bottom", false),
    { id: "medallion-disc", kind: "ellipse", frame: MEDALLION, fill: { kind: "radial", stops: [[0, "@deep/0.55"], [1, "@deep/0"]] }, opacity: vis(0.1, 0.8, EXIT, 0.6) },
    ring("ring-dots", dotRing(40, 48, 1.1), 0.9, -18, { fill: WHITE }),
    ring("ring-petals", petals(12, 44, 26, 7), 0.7, 24, { stroke: WHITE, strokeWidth: 0.0035 }),
    ring("ring-leaves", petals(24, 26, 16, 3), 0.45, -30, { fill: MUSTARD + "/0.9" }),
    ring("ring-inner", petals(8, 16, 4, 5), 0.2, 40, { stroke: WHITE, strokeWidth: 0.003, fill: RED }),
    ring("ring-core", circle(3.5) + dotRing(8, 10, 1.2), 0, 0, { fill: WHITE }),
    txt("greeting", "greeting", F({
      "9:16": [0.47, 0.53, 0.78, 0.14], "16:9": [0.46, 0.38, 0.9, 0.18, 0], "1:1": [0.5, 0.585, 0.86, 0.12], "4:5": [0.5, 0.56, 0.86, 0.13],
    }), {
      role: "headline",
      font: "heading", weight: 700, size: 0.12, minSize: 0.07, lines: 1, color: WHITE, textAt: { "16:9": { size: 0.11, align: "left" }, "1:1": { size: 0.1 } },
      shadow: { color: "@deep/0.5", blur: 0.02, y: 0.008 },
      animate: riseChars(1.1, 0.045, 0.6), exit: outWords(EXIT),
    }),
    txt("year", "year", F({
      "9:16": [0.47, 0.6, 0.5, 0.07], "16:9": [0.46, 0.52, 0.6, 0.09, 0], "1:1": [0.5, 0.67, 0.5, 0.065], "4:5": [0.5, 0.64, 0.5, 0.07],
    }), {
      role: "body",
      font: "heading", weight: 800, size: 0.06, minSize: 0.044, lines: 1, color: WHITE, shadow: { color: "@deep/0.5", blur: 0.015, y: 0.005 }, textAt: { "16:9": { size: 0.07, align: "left" } },
      tracking: [[0, 0.4, "out"], [1.6, 0.18]], opacity: [[0, 0.6, "out"], [1.0, 1], [EXIT, 1, "in"], [EXIT + 0.4, 0]], exit: outFade(EXIT, 0.3),
    }),
    txt("line", "line", F({
      "9:16": [0.47, 0.67, 0.76, 0.05], "16:9": [0.46, 0.62, 0.86, 0.06, 0], "1:1": [0.5, 0.745, 0.8, 0.045], "4:5": [0.5, 0.715, 0.8, 0.05],
    }), {
      role: "body",
      size: 0.044, minSize: 0.044, lines: 1, color: WHITE + "/0.9", textAt: { "16:9": { align: "left" } },
      animate: riseWords(1.9, 0.06, 0.5), exit: outFade(EXIT, 0.3),
    }),
    txt("brand", "brand", F({
      "9:16": [0.47, 0.73, 0.7, 0.04], "16:9": [0.46, 0.72, 0.86, 0.05, 0], "1:1": [0.5, 0.83, 0.7, 0.04], "4:5": [0.5, 0.8, 0.7, 0.04],
    }), {
      role: "body",
      size: 0.044, minSize: 0.044, lines: 1, color: WHITE + "/0.85", weight: 600, textAt: { "16:9": { align: "left" } },
      animate: riseWords(2.2, 0.05, 0.45), exit: outFade(EXIT, 0.3),
    }),
  ],
};
