import { FORMAT_VERSION, type Template } from "../format";
import type { Shape } from "../layout";
import { ALL_SHAPES, across, frame } from "./build";

/**
 * Name Bar: a lower third over video. An accent bar grows, a plate slides out of it, and the name
 * and role rise in behind a mask. No background of its own; it sits in the safe area of each
 * shape (above the captions and buttons in 9:16).
 */

const EXIT = 4.3;

/** Where the bar's left edge, the plate's middle and its size go (canvas fractions, short sides). */
const SPOTS: Record<Shape, { x: number; y: number; w: number; h: number }> = {
  "9:16": { x: 0.08, y: 0.68, w: 0.66, h: 0.15 },
  "16:9": { x: 0.06, y: 0.8, w: 0.82, h: 0.16 },
  "1:1": { x: 0.06, y: 0.82, w: 0.7, h: 0.15 },
  "4:5": { x: 0.06, y: 0.8, w: 0.7, h: 0.15 },
};
const BAR = 0.014;

const bar = across((shape) => {
  const s = SPOTS[shape];
  return frame(s.x, s.y, BAR, s.h, 0);
});
const plate = across((shape, d) => {
  const s = SPOTS[shape];
  return frame(s.x + BAR / d.w, s.y, s.w, s.h, 0);
});
/** A line of text inside the plate: `dy` plate heights from its middle, `h` plate heights tall. */
const line = (dy: number, h: number) => across((shape, d) => {
  const s = SPOTS[shape];
  const pad = s.h * 0.24;
  return frame(s.x + (BAR + pad) / d.w, s.y + (dy * s.h) / d.h, s.w - pad * 2, s.h * h, 0);
});

export const nameBar: Template = {
  version: FORMAT_VERSION,
  id: "lower-name",
  name: "Name Bar",
  category: "lower",
  description: "A clean lower third for over video: an accent bar, then a plate with a name and a role.",
  tags: ["lower third", "name", "title", "interview", "speaker", "overlay"],
  length: 5,
  hold: [1.4, EXIT],
  shapes: ALL_SHAPES,
  overlay: true,
  fields: [
    { id: "name", kind: "text", label: "Name", en: "Maya Rahman", bn: "মায়া রহমান", limit: 32 },
    { id: "role", kind: "text", label: "Role", en: "Founder, Lumen & Co.", bn: "প্রতিষ্ঠাতা, লুমেন অ্যান্ড কো.", limit: 48 },
  ],
  hits: [{ t: 0.25, sfx: "swoosh" }],
  layers: [
    {
      id: "plate", kind: "rect", frame: plate, radius: 0.012, fill: "@bg/0.86",
      shadow: { color: "#000000/0.3", blur: 0.03, y: 0.01 },
      reveal: { from: "left", v: [[0.3, 0, "out"], [0.85, 1], [EXIT + 0.05, 1, "in"], [EXIT + 0.45, 0]] },
    },
    {
      id: "bar", kind: "rect", frame: bar, fill: "@accent", glow: { color: "@accent/0.6", blur: 0.02 },
      reveal: { from: "bottom", v: [[0.1, 0, "out"], [0.5, 1], [EXIT + 0.35, 1, "in"], [EXIT + 0.65, 0]] },
    },
    {
      id: "name", kind: "text", field: "name", font: "heading", size: 0.052, minSize: 0.034, lines: 1, align: "left", color: "@text",
      frame: line(-0.17, 0.42), textAt: { "16:9": { size: 0.05 } },
      animate: { unit: "word", t: 0.55, stagger: 0.07, duration: 0.5, from: { opacity: 0, dy: 1 }, mask: true },
      exit: { unit: "line", t: EXIT, stagger: 0, duration: 0.3, from: { opacity: 0, dy: -0.8 }, mask: true },
    },
    {
      id: "role", kind: "text", field: "role", font: "body", size: 0.032, minSize: 0.022, lines: 1, align: "left", color: "@text/0.72",
      frame: line(0.22, 0.3),
      animate: { unit: "word", t: 0.7, stagger: 0.06, duration: 0.45, from: { opacity: 0, dy: 1 }, mask: true },
      exit: { unit: "line", t: EXIT, stagger: 0, duration: 0.28, from: { opacity: 0, dy: -0.8 }, mask: true },
    },
  ],
};
