import { FORMAT_VERSION, type Layer, type Template } from "../format";
import { ICON_CHOICES } from "../icons";
import type { Frame, Shape } from "../layout";
import { ALL_SHAPES, FULL, across, frame, per, showHide } from "./build";
import { hookAt0, live, strict916 } from "./common-a";
import { CLEAR_SKY } from "./looks";

/**
 * Feature Trio: a heading and three feature cards (icon, title, a line about it) that rise in one
 * after another while their icons draw themselves. Cards stand in columns in 16:9 and in rows in
 * the taller shapes.
 */

const EXIT = 7.2;
const CARD_STEP = 0.14;

/** Card `i`'s box and, inside it, where the icon and the two texts go, in `shape`. */
function cardLayout(shape: Shape, d: { w: number; h: number }, i: number) {
  if (shape === "16:9") {
    const x = [0.2, 0.5, 0.8][i], top = 0.27, w = 0.5, h = 0.62;
    const y = (k: number) => top + k / d.h;
    return {
      card: frame(x, top + h / 2 / d.h, w, h),
      circle: frame(x, y(0.15), 0.17, 0.17),
      icon: frame(x, y(0.15), 0.085, 0.085),
      title: frame(x, y(0.33), w - 0.08, 0.08),
      text: frame(x, y(0.45), w - 0.1, 0.12),
    };
  }
  // Rows: the icon on the left, the texts beside it.
  const rows: Record<Exclude<Shape, "16:9">, { ys: number[]; w: number; h: number; left: number }> = {
    "9:16": { ys: [0.355, 0.515, 0.675], w: 0.76, h: 0.255, left: 0.12 },
    "1:1": { ys: [0.34, 0.57, 0.8], w: 0.84, h: 0.205, left: 0.08 },
    "4:5": { ys: [0.32, 0.525, 0.73], w: 0.84, h: 0.235, left: 0.08 },
  };
  const r = rows[shape];
  const y = r.ys[i];
  const inset = r.h * 0.18;
  const circle = r.h * 0.6;
  const textLeft = r.left + (inset * 2 + circle) / d.w;
  const textW = r.w - inset * 3 - circle;
  return {
    card: frame(r.left, y, r.w, r.h, 0),
    circle: frame(r.left + (inset + circle / 2) / d.w, y, circle, circle),
    icon: frame(r.left + (inset + circle / 2) / d.w, y, circle * 0.5, circle * 0.5),
    title: frame(textLeft, y - (r.h * 0.17) / d.h, textW, r.h * 0.34, 0),
    text: frame(textLeft, y + (r.h * 0.2) / d.h, textW, r.h * 0.3, 0),
  };
}

function card(i: number): Layer {
  const at = (part: keyof ReturnType<typeof cardLayout>) => across((shape, d): Frame => cardLayout(shape, d, i)[part]);
  const t = 0.75 + i * CARD_STEP;
  const out = EXIT + i * 0.09;
  return {
    id: `card${i + 1}`, kind: "group", frame: at("card"),
    opacity: showHide(t, 0.3, out, 0.3), dy: [[t, 0.08, "out"], [t + 0.6, 0], [out, 0, "in"], [out + 0.3, -0.04]],
    scale: [[t, 0.94, "out"], [t + 0.6, 1]],
    children: [
      { id: `card${i + 1}-bg`, kind: "rect", frame: at("card"), radius: "theme", fill: "@card", stroke: "@text/0.1", strokeWidth: 0.002,
        shadow: { color: "#000000/0.25", blur: 0.04, y: 0.015 } },
      { id: `card${i + 1}-circle`, kind: "ellipse", frame: at("circle"), fill: "@primary/0.18", scale: [[t + 0.1, 0.4, "spring"], [t + 0.7, 1]] },
      { id: `card${i + 1}-icon`, kind: "icon", field: `icon${i + 1}`, frame: at("icon"), color: "@primary", strokeWidth: 1.9, draw: [[t + 0.2, 0, "inOut"], [t + 0.95, 1]] },
      {
        id: `card${i + 1}-title`, kind: "text", field: `f${i + 1}`, font: "heading", size: 0.05, minSize: 0.044, lines: 1, color: "@text", align: "left",
        frame: at("title"), textAt: { "16:9": { size: 0.045, align: "center" } },
        animate: { unit: "word", t: t + 0.15, stagger: 0.06, duration: 0.45, from: { opacity: 0, dy: 0.5 } },
      },
      {
        id: `card${i + 1}-text`, kind: "text", field: `d${i + 1}`, font: "body", role: "detail", size: 0.036, minSize: 0.036, lines: 2, color: "@text/0.68", align: "left",
        frame: at("text"), textAt: { "16:9": { size: 0.036, align: "center" } },
        animate: { unit: "line", t: t + 0.3, stagger: 0.08, duration: 0.45, from: { opacity: 0, dy: 0.4 } },
      },
    ],
  };
}

export const featureTrio: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "feature-trio",
  name: "Feature Trio",
  category: "feature",
  description: "A heading and three feature cards that rise in one after another as their icons draw on.",
  tags: ["features", "benefits", "cards", "icons", "list", "explainer"],
  length: 8,
  hold: [3.2, EXIT],
  shapes: ALL_SHAPES,
  look: CLEAR_SKY,
  fields: [
    { id: "heading", kind: "text", label: "Heading", en: "Why you'll love it", bn: "কেন আপনার ভালো লাগবে", limit: 40 },
    { id: "icon1", kind: "choice", label: "Icon 1", en: "bolt", options: ICON_CHOICES },
    { id: "f1", kind: "text", label: "Feature 1", en: "Fast charging", bn: "দ্রুত চার্জিং", limit: 26 },
    { id: "d1", kind: "text", label: "About feature 1", en: "Full in 30 minutes", bn: "৩০ মিনিটে ফুল চার্জ", limit: 50 },
    { id: "icon2", kind: "choice", label: "Icon 2", en: "shield", options: ICON_CHOICES },
    { id: "f2", kind: "text", label: "Feature 2", en: "Water resistant", bn: "পানি প্রতিরোধী", limit: 26 },
    { id: "d2", kind: "text", label: "About feature 2", en: "Rain or sweat, no worries", bn: "বৃষ্টি বা ঘামে চিন্তা নেই", limit: 50 },
    { id: "icon3", kind: "choice", label: "Icon 3", en: "battery", options: ICON_CHOICES },
    { id: "f3", kind: "text", label: "Feature 3", en: "All-day battery", bn: "সারাদিনের ব্যাটারি", limit: 26 },
    { id: "d3", kind: "text", label: "About feature 3", en: "Up to 36 hours of play", bn: "৩৬ ঘণ্টা পর্যন্ত চলে", limit: 50 },
  ],
  hits: [{ t: 0.15, sfx: "whoosh" }, { t: 0.75, sfx: "pop" }, { t: 0.75 + CARD_STEP, sfx: "pop" }, { t: 0.75 + CARD_STEP * 2, sfx: "pop" }],
  layers: [
    live("bg", "waves", { intensity: 0.7, vignette: 0.12, speed: 0.8, seed: 1 }),
    live("bokeh", "bokeh", { over: true, intensity: 0.4, soft: 0.8, seed: 12 }),
    {
      id: "heading", kind: "text", field: "heading", font: "heading", size: 0.08, minSize: 0.07, lines: 2, color: "@text",
      frame: per({
        "9:16": frame(0.5, 0.185, 0.76, 0.2), "16:9": frame(0.5, 0.15, 1.5, 0.12),
        "1:1": frame(0.5, 0.12, 0.86, 0.14), "4:5": frame(0.5, 0.115, 0.86, 0.16),
      }),
      textAt: { "16:9": { size: 0.07, lines: 1 }, "1:1": { size: 0.07 } },
      animate: { unit: "word", t: 0.15, stagger: 0.07, duration: 0.55, from: { opacity: 0, dy: 0.8 }, mask: true },
      exit: { unit: "word", t: EXIT, stagger: 0.04, duration: 0.3, from: { opacity: 0, dy: -0.6 }, mask: true },
    },
    {
      id: "rule", kind: "rect", radius: "pill", fill: "@accent",
      frame: per({
        "9:16": frame(0.5, 0.25, 0.12, 0.008), "16:9": frame(0.5, 0.22, 0.12, 0.008),
        "1:1": frame(0.5, 0.2, 0.1, 0.007), "4:5": frame(0.5, 0.19, 0.1, 0.007),
      }),
      reveal: { from: "center", v: [[0.5, 0, "out"], [1.0, 1], [EXIT, 1, "in"], [EXIT + 0.3, 0]] },
    },
    card(0),
    card(1),
    card(2),
    { id: "grain", kind: "fx", fx: "grain", frame: FULL, amount: 0.04 },
  ],
}, ["heading"]));
