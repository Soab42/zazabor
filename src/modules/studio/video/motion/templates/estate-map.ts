import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Responsive, Shape } from "../layout";
import { ALL_SHAPES, across, frame, pop } from "./build";
import { F, PIN, backdrop, circle, drawOn, outFade, outWords, popWords, riseWords, rnd, settle, txt, vis } from "./common-b";

/**
 * Map Pin: a stylised city map draws itself (streets, avenues, a river, a park) while the camera
 * drifts and pushes in; a pin drops on the place with a spring and ripples spread from it; the
 * address card slides up beneath. The map is drawn in code, so it is no real place.
 */

const EXIT = 5.8;
const LEN = 6.4;
const DROP = 1.5;
/** Where the pin stands per shape (canvas fractions); the map is centred on it. */
const PIN_AT: Record<Shape, [number, number]> = { "9:16": [0.47, 0.33], "16:9": [0.69, 0.42], "1:1": [0.5, 0.33], "4:5": [0.5, 0.34] };
const MAP = 2.6;
const mapBox: Responsive = across((shape) => frame(PIN_AT[shape][0], PIN_AT[shape][1], MAP, MAP));
const atPin = (dy: number, w: number, h = w, ay = 0.5): Responsive => across((shape, d) => frame(PIN_AT[shape][0], PIN_AT[shape][1] + dy / d.h, w, h, 0.5, ay));

/** Streets: a loose grid with a little wobble, drawn in waves out from the middle. */
function streets(): Layer[] {
  const out: Layer[] = [];
  for (let k = 0; k < 14; k++) {
    const p = 4 + k * 7 + (rnd(k, 3) - 0.5) * 2;
    const t = 0.15 + Math.abs(p - 50) / 50 * 0.9;
    out.push({ id: `street-v${k}`, kind: "path", d: `M${p.toFixed(1)} 0L${(p + (rnd(k, 4) - 0.5) * 4).toFixed(1)} 100`, frame: mapBox, stroke: "@text/0.3", strokeWidth: 0.004, draw: drawOn(t, t + 0.9) });
    out.push({ id: `street-h${k}`, kind: "path", d: `M0 ${p.toFixed(1)}L100 ${(p + (rnd(k, 5) - 0.5) * 4).toFixed(1)}`, frame: mapBox, stroke: "@text/0.3", strokeWidth: 0.004, draw: drawOn(t + 0.1, t + 1.0) });
  }
  return out;
}

/**
 * This template's own look (Slate: blue-grey night, a blue pin and amber.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const mapPinLook: Look = {
  colors: { primary: "#3b82f6", secondary: "#1f2937", accent: "#f59e0b", background: "#111827", text: "#f3f4f6" },
  heading: { family: "Plus Jakarta Sans", weight: 800 }, body: { family: "Inter", weight: 500 }, bangla: { family: "Anek Bangla", weight: 600 },
  radius: 0.3, motion: "smooth", grain: 0.02,
};

export const mapPin: Template = {
  version: FORMAT_VERSION,
  id: "estate-map",
  name: "Map Pin",
  category: "estate",
  description: "A stylised map draws itself, a pin drops on your place with ripples, and the address card slides up.",
  tags: ["real estate", "location", "map", "pin", "address", "directions", "store", "services"],
  length: LEN,
  hold: [2.6, EXIT],
  shapes: ALL_SHAPES,
  look: mapPinLook,
  fields: [
    { id: "place", kind: "text", label: "Place", en: "Lumen Residences", bn: "লুমেন রেসিডেন্স", limit: 32 },
    { id: "address", kind: "text", label: "Address", en: "Road 11, Gulshan 2, Dhaka", bn: "রোড ১১, গুলশান ২, ঢাকা", limit: 48 },
    { id: "note", kind: "text", label: "Note", en: "5 minutes from the lake", bn: "লেক থেকে মাত্র ৫ মিনিট", limit: 40 },
    { id: "cta", kind: "text", label: "Button", en: "Get directions", bn: "পথ দেখুন", limit: 22 },
  ],
  hits: [{ t: 0.05, sfx: "swoosh" }, { t: DROP + 0.35, sfx: "impact" }, { t: DROP + 0.4, sfx: "pop" }, { t: 2.1, sfx: "swoosh" }],
  layers: [
    ...backdrop("grid", "rays", { intensity: 0.45, overIntensity: 0.4, speed: 0.5 }),
    {
      // The map, drifting and pushing in slowly for the whole clip.
      id: "map", kind: "group", frame: mapBox,
      rotate: [[0, -14, "out"], [2.2, -8, "linear"], [LEN, -5]], scale: [[0, 1.35, "out"], [2.2, 1.04, "linear"], [LEN, 1.12]],
      opacity: [[0, 0, "out"], [0.5, 1], [EXIT + 0.2, 1, "in"], [EXIT + 0.6, 0]],
      children: [
        { id: "park", kind: "path", d: "M24 30c8-6 18-4 20 4s-2 16-12 16-16-14-8-20z", frame: mapBox, fill: "@accent/0.3", opacity: vis(0.9, 0.5, 99, 0) },
        { id: "river", kind: "path", d: "M0 74C18 66 30 84 50 76S78 60 100 68", frame: mapBox, stroke: "@primary/0.6", strokeWidth: 0.05, cap: "butt", draw: drawOn(0.2, 1.4) },
        ...streets(),
        { id: "avenue1", kind: "path", d: "M0 30L100 62", frame: mapBox, stroke: "@text/0.55", strokeWidth: 0.012, draw: drawOn(0.4, 1.3) },
        { id: "avenue2", kind: "path", d: "M38 0L58 100", frame: mapBox, stroke: "@text/0.55", strokeWidth: 0.012, draw: drawOn(0.55, 1.45) },
      ],
    },
    {
      id: "plot-glow", kind: "ellipse", frame: atPin(0, 0.3), fill: { kind: "radial", stops: [[0, "@accent/0.5"], [1, "@accent/0"]] },
      opacity: vis(DROP + 0.3, 0.4, EXIT, 0.4), scale: [[DROP + 0.3, 0.3, "out"], [DROP + 1.0, 1]], idle: { scale: 0.15 },
    },
    ...[0, 1, 2].map((i): Layer => ({
      id: `ripple${i + 1}`, kind: "ellipse", frame: atPin(0, 0.12, 0.05), stroke: "@accent", strokeWidth: 0.004,
      scale: [[DROP + 0.4 + i * 0.35, 0.3, "out"], [DROP + 1.6 + i * 0.35, 3.2]], opacity: [[DROP + 0.4 + i * 0.35, 0.9, "out"], [DROP + 1.6 + i * 0.35, 0]],
    })),
    { id: "pin-shadow", kind: "ellipse", frame: atPin(0, 0.09, 0.03), fill: "#000000/0.4", blur: 0.006, scale: [[DROP - 0.2, 0.2, "out"], [DROP + 0.35, 1]], opacity: vis(DROP - 0.2, 0.3, EXIT, 0.3) },
    {
      id: "pin", kind: "group", frame: atPin(0, 0.16, 0.17, 1),
      dy: [[DROP, -0.5, "in"], [DROP + 0.35, 0, "spring"], [DROP + 0.9, 0]], scale: [[DROP + 0.33, 1, "out"], [DROP + 0.4, 0.85, "spring"], [DROP + 0.9, 1], [EXIT, 1, "in"], [EXIT + 0.35, 0]],
      opacity: [[DROP - 0.01, 0], [DROP, 1]], idle: { dy: -0.006 },
      children: [
        { id: "pin-body", kind: "path", d: PIN, frame: atPin(0, 0.16, 0.17, 1), fill: { kind: "linear", angle: 135, stops: [[0, "@accent"], [1, "@primary"]] }, shadow: { color: "#000000/0.35", blur: 0.02, y: 0.01 } },
        { id: "pin-dot", kind: "path", d: circle(14), frame: atPin(-0.105, 0.16, 0.17), fill: "@bg" },
      ],
    },
    {
      id: "card", kind: "rect", radius: "theme", fill: "@bg/0.9", stroke: "@text/0.12", strokeWidth: 0.002, lightWrap: { color: "@accent", amount: 0.4 },
      frame: F({ "9:16": [0.47, 0.6, 0.82, 0.32], "16:9": [0.04, 0.53, 0.86, 0.62, 0], "1:1": [0.5, 0.74, 0.86, 0.36], "4:5": [0.5, 0.73, 0.86, 0.42] }),
      shadow: { color: "#000000/0.4", blur: 0.05, y: 0.02 }, dy: [[0, 0.03, "out"], [0.6, 0]], opacity: [[0, 0.7, "out"], [0.5, 1], [EXIT, 1, "in"], [EXIT + 0.35, 0]],
    },
    txt("place", "place", F({
      "9:16": [0.12, 0.545, 0.7, 0.07, 0], "16:9": [0.065, 0.38, 0.78, 0.09, 0], "1:1": [0.11, 0.645, 0.78, 0.065, 0], "4:5": [0.11, 0.645, 0.78, 0.07, 0],
    }), {
      role: "body",
      font: "heading", weight: 800, size: 0.052, minSize: 0.044, lines: 1, align: "left", textAt: { "16:9": { size: 0.06 } },
      animate: settle(), exit: outWords(EXIT - 0.05),
    }),
    txt("address", "address", F({
      "9:16": [0.12, 0.58, 0.7, 0.045, 0], "16:9": [0.065, 0.47, 0.78, 0.055, 0], "1:1": [0.11, 0.705, 0.78, 0.045, 0], "4:5": [0.11, 0.695, 0.78, 0.045, 0],
    }), {
      role: "body",
      size: 0.044, minSize: 0.044, lines: 1, align: "left", color: "@text/0.75",
      animate: riseWords(2.35, 0.03, 0.45), exit: outFade(EXIT - 0.05, 0.25),
    }),
    txt("note", "note", F({
      "9:16": [0.12, 0.607, 0.7, 0.042, 0], "16:9": [0.065, 0.545, 0.78, 0.05, 0], "1:1": [0.11, 0.755, 0.78, 0.042, 0], "4:5": [0.11, 0.735, 0.78, 0.042, 0],
    }), {
      role: "detail",
      italic: true, size: 0.036, minSize: 0.036, lines: 1, align: "left", color: "@text/0.75",
      animate: riseWords(2.5, 0.03, 0.45), exit: outFade(EXIT - 0.05, 0.25),
    }),
    {
      id: "button", kind: "rect", radius: "pill", fill: "@primary",
      frame: F({ "9:16": [0.12, 0.635, 0.38, 0.06, 0], "16:9": [0.065, 0.67, 0.42, 0.09, 0], "1:1": [0.11, 0.85, 0.38, 0.07, 0], "4:5": [0.11, 0.83, 0.38, 0.075, 0] }),
      scale: pop(2.7, 0.7, 0.45, EXIT, 0.9), opacity: vis(2.7, 0.2, EXIT, 0.3),
    },
    txt("cta", "cta", F({
      "9:16": [0.12, 0.635, 0.38, 0.04, 0], "16:9": [0.065, 0.67, 0.42, 0.055, 0], "1:1": [0.11, 0.85, 0.38, 0.045, 0], "4:5": [0.11, 0.83, 0.38, 0.045, 0],
    }), {
      role: "cta",
      font: "heading", weight: 700, size: 0.044, minSize: 0.044, lines: 1, color: "@onPrimary",
      animate: popWords(2.8), exit: outFade(EXIT, 0.25),
    }),
  ],
};
