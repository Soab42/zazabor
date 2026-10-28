import { FORMAT_VERSION, type Template } from "../format";
import type { Look } from "../brand";
import { ALL_SHAPES } from "./build";
import { F, backdrop, blurWords, drawOn, outFade, outWords, riseChars, settle, txt, vis } from "./common-b";

/**
 * Chapter Title: a coloured panel wipes in with the chapter's number set huge in it; beside it (or
 * under it, in the tall shapes) the word "Chapter" spaces out, a rule draws and the title rises.
 */

const EXIT = 4.6;

const PANEL = F({
  "9:16": [0.5, 0, "full", 0.74, 0.5, 0], "16:9": [0, 0.5, 0.62, "full", 0, 0.5],
  "1:1": [0, 0.5, 0.38, "full", 0, 0.5], "4:5": [0.5, 0, "full", 0.5, 0.5, 0],
});
const NUMBER = F({
  "9:16": [0.5, 0.25, 0.7, 0.36], "16:9": [0.174, 0.5, 0.46, 0.5],
  "1:1": [0.19, 0.5, 0.27, 0.36], "4:5": [0.5, 0.2, 0.7, 0.36],
});
const KICKER = F({
  "9:16": [0.5, 0.445, 0.76, 0.05], "16:9": [0.42, 0.34, 0.9, 0.06, 0], "1:1": [0.45, 0.34, 0.48, 0.05, 0], "4:5": [0.5, 0.5, 0.86, 0.05],
});
const RULE = F({
  "9:16": [0.5, 0.48, 0.22, 0.01], "16:9": [0.42, 0.41, 0.2, 0.01, 0], "1:1": [0.45, 0.4, 0.14, 0.01, 0], "4:5": [0.5, 0.55, 0.2, 0.01],
});
const TITLE = F({
  "9:16": [0.5, 0.56, 0.76, 0.24], "16:9": [0.42, 0.57, 0.9, 0.3, 0], "1:1": [0.45, 0.56, 0.48, 0.28, 0], "4:5": [0.5, 0.69, 0.86, 0.26],
});

/**
 * This template's own look (Ink: charcoal with a signal-orange panel.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const chapterTitleLook: Look = {
  colors: { primary: "#ff5a36", secondary: "#1e2229", accent: "#ffc857", background: "#0f1115", text: "#f5f5f2" },
  heading: { family: "Archivo Black", weight: 400 }, body: { family: "Inter", weight: 500 }, bangla: { family: "Anek Bangla", weight: 700 },
  radius: 0.1, motion: "snappy", grain: 0.03,
};

export const chapterTitle: Template = {
  version: FORMAT_VERSION,
  id: "title-chapter",
  name: "Chapter Title",
  category: "lower",
  description: "A colour panel with a huge chapter number; the title rises beside it after a ruled line.",
  tags: ["title", "chapter", "section", "youtube", "tutorial", "number", "card"],
  length: 5.2,
  hold: [1.8, EXIT],
  shapes: ALL_SHAPES,
  look: chapterTitleLook,
  fields: [
    { id: "number", kind: "text", label: "Number", en: "01", bn: "০১", limit: 4 },
    { id: "kicker", kind: "text", label: "Above the title", en: "Chapter", bn: "অধ্যায়", limit: 20 },
    { id: "title", kind: "text", label: "Title", en: "Where it all began", bn: "যেখান থেকে শুরু", limit: 48, multiline: true },
  ],
  hits: [{ t: 0, sfx: "whoosh" }, { t: 0.65, sfx: "impact" }, { t: 1.0, sfx: "click" }],
  layers: [
    ...backdrop("aurora", "bokeh", { intensity: 0.6, overIntensity: 0.4, overSoft: 0.6 }),
    {
      id: "panel", kind: "rect", frame: PANEL, fill: { kind: "linear", angle: 160, stops: [[0, "@primary"], [1, "@primaryDeep"]] },
      reveal: { from: "left", v: [[0.1, 0, "inOut"], [0.65, 1], [EXIT + 0.15, 1, "in"], [EXIT + 0.55, 0]] },
    },
    { id: "texture", kind: "fx", fx: "stripes", frame: PANEL, color: "@onPrimary", amount: 0.05, opacity: vis(0.4, 0.4, EXIT, 0.4) },
    txt("number", "number", NUMBER, {
      role: "headline",
      font: "heading", weight: 800, size: 0.3, minSize: 0.16, lines: 1, color: "@onPrimary",
      textAt: { "16:9": { size: 0.34 }, "1:1": { size: 0.2 } },
      animate: { ...riseChars(0.45, 0.08, 0.6), from: { opacity: 0, dy: 0.6, scale: 1.25 } }, exit: outFade(EXIT, 0.3),
      idle: { scale: 0.05 },
    }),
    txt("kicker", "kicker", KICKER, {
      role: "detail",
      size: 0.036, minSize: 0.036, lines: 1, upper: true, color: "@primary", weight: 600, textAt: { "16:9": { align: "left" }, "1:1": { align: "left" } },
      tracking: [[0.75, 0.05, "out"], [1.6, 0.32]], animate: blurWords(0.75), exit: outFade(EXIT - 0.05, 0.25),
    }),
    {
      id: "rule", kind: "path", frame: RULE, d: "M0 50H100", stroke: "@accent", strokeWidth: 0.005, cap: "round",
      draw: drawOn(0.95, 1.45, [EXIT - 0.1, EXIT + 0.2]),
    },
    txt("title", "title", TITLE, {
      role: "headline",
      font: "heading", size: 0.085, minSize: 0.07, lines: 3, lineHeight: 1.08, valign: "top",
      textAt: { "16:9": { size: 0.095, align: "left" }, "1:1": { size: 0.07, align: "left" } },
      animate: settle(), exit: outWords(EXIT - 0.05),
    }),
  ],
};
