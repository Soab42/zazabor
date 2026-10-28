import type { Key } from "../ease";
import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Shape } from "../layout";
import { ALL_SHAPES, across, frame } from "./build";
import { outFade, outWords, riseWords, settle, steps, txt } from "./common-b";

/**
 * News Bar: a boxed lower third in the style of a news channel. A "Breaking" tab flips up with a
 * blinking dot, the headline plate wipes out of it, and a ticker strip underneath swaps through
 * three short lines.
 */

const EXIT = 8.8;
/** The headline plate: its left edge and middle (canvas fractions), width and height (short sides). */
const SPOTS: Record<Shape, { x: number; y: number; w: number; h: number }> = {
  "9:16": { x: 0.07, y: 0.655, w: 0.8, h: 0.14 },
  "16:9": { x: 0.05, y: 0.8, w: 1.55, h: 0.1 },
  "1:1": { x: 0.06, y: 0.79, w: 0.88, h: 0.12 },
  "4:5": { x: 0.06, y: 0.8, w: 0.88, h: 0.12 },
};
const TAB = 0.06;
const STRIP = 0.055;
const PAD = 0.025;

/** A box on the tab's row (-1) or the strip's (1): `x0` short sides in from the left, `w` wide (or to the end), `h` tall. */
const at = (row: -1 | 1, x0: number, w: number | null, h: number) => across((shape, d) => {
  const s = SPOTS[shape];
  const y = row < 0 ? s.y - (s.h / 2 + TAB / 2) / d.h : s.y + (s.h / 2 + STRIP / 2) / d.h;
  return frame(s.x + x0 / d.w, y, w ?? s.w - x0, h, 0);
});

/** A box on the plate, `inset` short sides in from both ends, `hk` plate heights tall. */
const onPlate = (inset: number, hk: number) => across((shape, d) => {
  const s = SPOTS[shape];
  return frame(s.x + inset / d.w, s.y, s.w - inset * 2, s.h * hk, 0);
});

const PLATE_REVEAL = { from: "left" as const, v: [[0.3, 0, "inOut"], [0.75, 1], [EXIT + 0.2, 1, "in"], [EXIT + 0.55, 0]] as Key[] };

/** One ticker line, shown from `t0` to `t1`. */
function tick(n: number, t0: number, t1: number): Layer {
  return txt(`tick${n}`, `tick${n}`, at(1, 0.05, null, STRIP * 0.8), {
    role: "detail", size: 0.036, minSize: 0.036, lines: 1, align: "left", color: "@text", time: [t0, t1 + 0.3],
    animate: riseWords(t0, 0.04, 0.4), exit: outWords(t1, 0.25),
  });
}

/**
 * This template's own look (Newsroom: red plate, amber tab, white strip.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const newsBarLook: Look = {
  colors: { primary: "#c1121f", secondary: "#003049", accent: "#fca311", background: "#ffffff", text: "#0b0b0b" },
  heading: { family: "Oswald", weight: 600 }, body: { family: "Inter", weight: 500 }, bangla: { family: "Hind Siliguri", weight: 700 },
  radius: 0.1, motion: "snappy",
};

export const newsBar: Template = {
  version: FORMAT_VERSION,
  id: "lower-news",
  name: "News Bar",
  category: "lower",
  description: "A news-style lower third: a Breaking tab, a boxed headline and a ticker of short lines.",
  tags: ["lower third", "news", "breaking", "headline", "ticker", "boxed", "overlay"],
  length: 9.4,
  hold: [1.2, EXIT],
  shapes: ALL_SHAPES,
  look: newsBarLook,
  overlay: true,
  fields: [
    { id: "label", kind: "text", label: "Tab", en: "Breaking", bn: "ব্রেকিং", limit: 14 },
    { id: "headline", kind: "text", label: "Headline", en: "Night market opens on the riverside", bn: "নদীর পাড়ে চালু হলো রাতের বাজার", limit: 64 },
    { id: "tick1", kind: "text", label: "Ticker 1", en: "Open every evening from 6 pm", bn: "প্রতিদিন সন্ধ্যা ৬টা থেকে খোলা", limit: 60 },
    { id: "tick2", kind: "text", label: "Ticker 2", en: "More than 80 stalls of street food", bn: "৮০টিরও বেশি স্ট্রিট ফুডের দোকান", limit: 60 },
    { id: "tick3", kind: "text", label: "Ticker 3", en: "Free entry for everyone", bn: "সবার জন্য প্রবেশ ফ্রি", limit: 60 },
  ],
  hits: [{ t: 0.4, sfx: "impact" }, { t: 0.25, sfx: "whoosh" }, { t: 3.65, sfx: "click" }, { t: 6.75, sfx: "click" }],
  layers: [
    {
      id: "strip", kind: "rect", frame: at(1, 0, null, STRIP), fill: "@bg/0.92",
      reveal: { from: "left", v: [[0.55, 0, "out"], [1.05, 1], [EXIT + 0.1, 1, "in"], [EXIT + 0.45, 0]] },
    },
    { id: "strip-mark", kind: "rect", frame: at(1, 0, 0.022, STRIP), fill: "@accent", opacity: [[0.6, 0, "out"], [0.8, 1], [EXIT + 0.1, 1], [EXIT + 0.3, 0]] },
    tick(1, 0.85, 3.25),
    tick(2, 3.65, 6.3),
    tick(3, 6.75, EXIT),
    {
      id: "plate-shadow", kind: "rect", frame: onPlate(0, 1), fill: "@primary", shadow: { color: "#000000/0.35", blur: 0.03, y: 0.008 }, reveal: PLATE_REVEAL,
    },
    {
      id: "plate", kind: "group", frame: onPlate(0, 1), clip: "rect", reveal: PLATE_REVEAL,
      children: [
        { id: "plate-live", kind: "background", preset: "mesh", frame: onPlate(0, 1), intensity: 0.9, vignette: 0, grain: 0.02, drift: 0.2, seed: 4 },
        { id: "plate-tint", kind: "rect", frame: onPlate(0, 1), fill: "@primary/0.6" },
      ],
    },
    {
      id: "tab", kind: "rect", frame: at(-1, 0, 0.3, TAB), fill: "@accent", radius: 0.006,
      reveal: { from: "bottom", v: [[0.1, 0, "out"], [0.4, 1], [EXIT + 0.3, 1, "in"], [EXIT + 0.55, 0]] },
    },
    {
      id: "dot", kind: "ellipse", frame: at(-1, 0.03, 0.018, 0.018), fill: "@onAccent",
      // Blinks once a second while the bar is up.
      opacity: steps([[0, 0], [0.4, 1], ...Array.from({ length: Math.floor((EXIT - 0.5) / 0.5) }, (_, i): [number, number] => [1.0 + i * 0.5, i % 2 ? 1 : 0.25]), [EXIT + 0.3, 0]]),
    },
    txt("label", "label", at(-1, 0.055, 0.23, TAB * 0.7), {
      role: "detail",
      font: "heading", weight: 800, size: 0.036, minSize: 0.036, lines: 1, align: "left", upper: true, tracking: 0.08, color: "@onAccent",
      animate: riseWords(0.25, 0.05, 0.4), exit: outFade(EXIT + 0.25, 0.2),
    }),
    txt("headline", "headline", onPlate(PAD, 0.82), {
      role: "body",
      font: "heading", weight: 700, size: 0.046, minSize: 0.044, lines: 2, align: "left", color: "@onPrimary", lineHeight: 1.1,
      textAt: { "16:9": { size: 0.05, lines: 1 } },
      animate: settle(), exit: outWords(EXIT - 0.05, 0.3),
    }),
  ],
};
