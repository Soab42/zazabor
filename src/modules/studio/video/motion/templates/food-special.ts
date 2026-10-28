import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Responsive, Shape } from "../layout";
import { ALL_SHAPES, across, frame, starburst } from "./build";
import { F, LEAF, STEAM, backdrop, outFade, outWords, popWords, pulse, riseWords, settle, txt, vis } from "./common-b";

/**
 * Today's Special: the dish spins in on its plate, steam curls off it, and a starburst badge with
 * the price spins in over its edge and keeps turning slowly. Without a photo, a bowl of curry and
 * rice with coriander is drawn on the plate.
 */

const EXIT = 5.6;
const LEN = 6.2;
/** The plate's middle (canvas fractions) and size (short sides) per shape. */
const PLATE: Record<Shape, [number, number, number]> = { "9:16": [0.47, 0.47, 0.62], "16:9": [0.29, 0.53, 0.8], "1:1": [0.5, 0.56, 0.58], "4:5": [0.5, 0.53, 0.62] };
/** A box on the plate: middle `x`,`y` in plate fractions (-0.5…0.5), `k` plate sizes across. */
const onPlate = (x: number, y: number, k: number, kh = k): Responsive => across((shape, d) => {
  const [cx, cy, s] = PLATE[shape];
  return frame(cx + (x * s) / d.w, cy + (y * s) / d.h, s * k, s * kh);
});
const BADGE = F({ "9:16": [0.72, 0.33, 0.25, 0.25], "16:9": [0.47, 0.26, 0.28, 0.28], "1:1": [0.75, 0.37, 0.22, 0.22], "4:5": [0.76, 0.35, 0.23, 0.23] });
const BADGE_TEXT = F({ "9:16": [0.72, 0.33, 0.17, 0.08], "16:9": [0.47, 0.26, 0.19, 0.09], "1:1": [0.75, 0.37, 0.15, 0.07], "4:5": [0.76, 0.35, 0.16, 0.075] });


const dishStandIn: Layer[] = [
  { id: "curry", kind: "ellipse", ifEmpty: "photo", frame: onPlate(-0.1, 0.04, 0.5), fill: { kind: "radial", stops: [[0, "#e9a23b"], [1, "#b8611f"]] } },
  { id: "curry-shine", kind: "ellipse", ifEmpty: "photo", frame: onPlate(-0.18, -0.06, 0.16, 0.08), fill: "#ffffff/0.25" },
  { id: "rice", kind: "ellipse", ifEmpty: "photo", frame: onPlate(0.17, -0.02, 0.32, 0.3), fill: { kind: "radial", stops: [[0, "#fffaf0"], [1, "#efe3cf"]] } },
  { id: "leaf1", kind: "path", ifEmpty: "photo", d: LEAF, frame: onPlate(0.1, -0.13, 0.1), fill: "#3a9d5d", rotate: 20 },
  { id: "leaf2", kind: "path", ifEmpty: "photo", d: LEAF, frame: onPlate(-0.06, 0.1, 0.09), fill: "#2f8a50", rotate: -70 },
  { id: "leaf3", kind: "path", ifEmpty: "photo", d: LEAF, frame: onPlate(-0.2, 0.0, 0.08), fill: "#43aa66", rotate: 140 },
];

/**
 * This template's own look (Saffron (light): cream, chilli red and turmeric.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const todaysSpecialLook: Look = {
  colors: { primary: "#d1495b", secondary: "#edae49", accent: "#e85d04", background: "#fff4e0", text: "#3b1f0e" },
  heading: { family: "Poppins", weight: 800 }, body: { family: "Poppins", weight: 500 }, bangla: { family: "Baloo Da 2", weight: 700 },
  radius: 0.6, motion: "playful", grain: 0.02, grade: { warmth: 0.25 },
  backdrop: ["#e9a23b", "@primary", "@accent"],
};

export const todaysSpecial: Template = {
  version: FORMAT_VERSION,
  id: "food-special",
  name: "Today's Special",
  category: "food",
  description: "The dish spins in on its plate with steam rising, and a turning starburst badge shows the price.",
  tags: ["food", "restaurant", "special", "dish of the day", "offer", "price", "badge"],
  length: LEN,
  hold: [2.0, EXIT],
  shapes: ALL_SHAPES,
  look: todaysSpecialLook,
  fields: [
    { id: "photo", kind: "media", label: "Dish photo", en: "" },
    { id: "kicker", kind: "text", label: "Kicker", en: "Today's special", bn: "আজকের স্পেশাল", limit: 24 },
    { id: "dish", kind: "text", label: "Dish", en: "Kacchi Biryani", bn: "কাচ্চি বিরিয়ানি", limit: 32 },
    { id: "price", kind: "text", label: "Price", en: "Tk 350", bn: "৳৩৫০", limit: 10 },
    { id: "note", kind: "text", label: "Note", en: "Only until 10 pm tonight", bn: "শুধু আজ রাত ১০টা পর্যন্ত", limit: 40 },
  ],
  hits: [{ t: 0, sfx: "whoosh" }, { t: 1.1, sfx: "impact" }, { t: 1.35, sfx: "pop" }],
  layers: [
    ...backdrop("bokeh", "rays", { intensity: 0.7, overIntensity: 0.4, soft: 0.4 }),
    { id: "glow", kind: "ellipse", frame: onPlate(0, 0, 1.5), fill: { kind: "radial", stops: [[0, "@primary/0.25"], [1, "@primary/0"]] }, opacity: vis(0.3, 0.8, EXIT, 0.4) },
    {
      // The plate spins in as one.
      id: "plate-group", kind: "group", frame: onPlate(0, 0, 1),
      rotate: [[0.1, -120, "out"], [1.1, 0]], scale: [[0.1, 0.5, "out"], [1.1, 1], [EXIT, 1, "in"], [EXIT + 0.4, 0.7]], opacity: vis(0.1, 0.3, EXIT, 0.4),
      children: [
        { id: "plate-shadow", kind: "ellipse", frame: onPlate(0.03, 0.06, 1.02), fill: "#000000/0.35", blur: 0.03 },
        { id: "plate", kind: "ellipse", frame: onPlate(0, 0, 1), fill: { kind: "linear", angle: 135, stops: [[0, "#fdfdfb"], [1, "#dcdad4"]] } },
        { id: "well", kind: "ellipse", frame: onPlate(0, 0, 0.72), fill: "#f1efea", stroke: "#000000/0.06", strokeWidth: 0.003 },
        ...dishStandIn,
        { id: "photo", kind: "image", slot: "photo", ifFilled: "photo", fit: "cover", radius: "pill", frame: onPlate(0, 0, 0.7) },
      ],
    },
    {
      id: "steam", kind: "path", d: STEAM, stroke: "@text/0.5", strokeWidth: 0.004, frame: onPlate(0, -0.55, 0.3, 0.24),
      opacity: [[1.2, 0, "out"], [1.7, 0.7], ...pulse(1.7, EXIT, 1.8, 0.7, 0.2).slice(1), [EXIT + 0.3, 0]], dy: pulse(1.2, EXIT, 1.8, 0, -0.03),
      blur: 0.003,
    },
    {
      id: "badge", kind: "path", d: starburst(18, 0.84), frame: BADGE, fill: "@accent", shadow: { color: "#000000/0.3", blur: 0.03, y: 0.01 },
      scale: [[1.15, 0, "back"], [1.7, 1], [EXIT, 1, "in"], [EXIT + 0.35, 0]], rotate: [[1.15, -180, "out"], [1.9, 0, "linear"], [LEN, 40]],
    },
    txt("price", "price", BADGE_TEXT, {
      role: "cta",
      font: "heading", weight: 800, size: 0.06, minSize: 0.044, lines: 1, color: "@onAccent", rotate: -8,
      animate: { ...popWords(1.35), stagger: 0 }, exit: outFade(EXIT, 0.25),
    }),
    txt("kicker", "kicker", F({
      "9:16": [0.47, 0.165, 0.76, 0.055], "16:9": [0.58, 0.36, 0.7, 0.07, 0], "1:1": [0.5, 0.07, 0.8, 0.05], "4:5": [0.5, 0.065, 0.8, 0.05],
    }), {
      role: "detail",
      size: 0.036, minSize: 0.036, lines: 1, upper: true, tracking: 0.26, color: "@text/0.8", weight: 700, textAt: { "16:9": { align: "left" } },
      animate: riseWords(0.5, 0.06, 0.45), exit: outFade(EXIT, 0.25),
    }),
    txt("dish", "dish", F({
      "9:16": [0.47, 0.22, 0.78, 0.1], "16:9": [0.58, 0.5, 0.7, 0.24, 0], "1:1": [0.5, 0.135, 0.86, 0.08], "4:5": [0.5, 0.125, 0.86, 0.085],
    }), {
      role: "headline",
      font: "heading", weight: 800, size: 0.085, minSize: 0.07, lines: 1, textAt: { "16:9": { size: 0.1, lines: 2, align: "left" }, "1:1": { size: 0.07 } },
      animate: settle(), exit: outWords(EXIT),
    }),
    txt("note", "note", F({
      "9:16": [0.47, 0.68, 0.76, 0.05], "16:9": [0.58, 0.7, 0.7, 0.06, 0], "1:1": [0.5, 0.925, 0.8, 0.045], "4:5": [0.5, 0.91, 0.8, 0.045],
    }), {
      role: "detail",
      size: 0.036, minSize: 0.036, lines: 1, color: "@text/0.75", textAt: { "16:9": { align: "left" } },
      animate: riseWords(1.5, 0.04, 0.45), exit: outFade(EXIT, 0.25),
    }),
  ],
};
