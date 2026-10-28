import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Responsive, Shape } from "../layout";
import { ALL_SHAPES, across, frame, pop } from "./build";
import { AREA, BATH, BED, F, HOUSE, HOUSE_FILL, backdrop, circle, drawOn, outFade, outWords, popWords, riseWords, settle, txt, vis } from "./common-b";

/**
 * Property Card: a listing. The photo rises in a rounded card and settles; a For sale tag pops on
 * its corner; the price counts up, the address follows and three detail chips (beds, baths, floor
 * area) slide up in turn. Without a photo, a house is drawn on a sunny lot.
 */

const EXIT = 5.8;
const LEN = 6.4;

const PHOTO = F({
  "9:16": [0.47, 0.14, 0.8, 0.5, 0.5, 0], "16:9": [0.03, 0.5, 0.82, 0.86, 0, 0.5], "1:1": [0.5, 0.05, 0.9, 0.5, 0.5, 0], "4:5": [0.5, 0.04, 0.9, 0.6, 0.5, 0],
});
/** The photo card's box per shape: left, top (canvas fractions), width, height (short sides). */
const CARD: Record<Shape, [number, number, number, number]> = {
  "9:16": [0.07, 0.14, 0.8, 0.5], "16:9": [0.03, 0.07, 0.82, 0.86], "1:1": [0.05, 0.05, 0.9, 0.5], "4:5": [0.05, 0.04, 0.9, 0.6],
};
/** A box in the photo card: middle at `x`,`y` (0…1 across and down it), `w`,`h` card widths and heights. */
const inCard = (x: number, y: number, w: number, h: number): Responsive => across((shape, d) => {
  const [l, t, cw, ch] = CARD[shape];
  return frame(l + (x * cw) / d.w, t + (y * ch) / d.h, w * cw, h * ch);
});
/** The text column: its left edge and width per shape, and each line's y. */
const COL: Record<Shape, { x: number; w: number; price: number; address: number; chips: number; cta: number }> = {
  "9:16": { x: 0.07, w: 0.8, price: 0.465, address: 0.51, chips: 0.565, cta: 0.627 },
  "16:9": { x: 0.52, w: 0.79, price: 0.32, address: 0.43, chips: 0.57, cta: 0.75 },
  "1:1": { x: 0.05, w: 0.9, price: 0.615, address: 0.685, chips: 0.775, cta: 0.885 },
  "4:5": { x: 0.05, w: 0.9, price: 0.585, address: 0.64, chips: 0.725, cta: 0.84 },
};
const line = (key: "price" | "address" | "cta", h: number, w = 1) => across((shape) => { const c = COL[shape]; return frame(c.x, c[key], c.w * w, h, 0); });
/** Each chip's width (short sides): the floor area needs the most room. */
const CHIP_W = [0.21, 0.23, 0.3];
const CHIP_GAP = 0.025;
const chipX = (i: number) => CHIP_W.slice(0, i).reduce((a, w) => a + w + CHIP_GAP, 0);
const chip = (i: number, x0 = 0, w = CHIP_W[i], h = 0.07, ax = 0) => across((shape, d) => {
  const c = COL[shape];
  return frame(c.x + (chipX(i) + x0) / d.w, c.chips, w, h, ax);
});

const DETAIL = [BED, BATH, AREA];
function detail(i: number): Layer[] {
  const t = 1.6 + i * 0.15, n = i + 1, out = EXIT + i * 0.05;
  const move = { dy: [[t, 0.05, "out"], [t + 0.5, 0]], opacity: vis(t, 0.3, out, 0.3) } as Pick<Layer, "dy" | "opacity">;
  return [
    { id: `chip${n}`, kind: "rect", frame: chip(i), radius: "pill", fill: "@surface", stroke: "@text/0.14", strokeWidth: 0.002, ...move },
    { id: `chip-icon${n}`, kind: "path", d: DETAIL[i], frame: chip(i, 0.038, 0.034, 0.034, 0.5), stroke: "@accent", strokeWidth: 0.0035, ...move },
    txt(`detail${n}`, ["beds", "baths", "area"][i], chip(i, 0.064, CHIP_W[i] - 0.075, 0.045), {
      role: "detail", font: "heading", weight: 600, size: 0.036, minSize: 0.036, lines: 1, align: "left", ...move,
    }),
  ];
}

/** The drawn stand-in: sky, sun, a lawn, the house with its windows, and a tree. */
const lot: Layer[] = [
  { id: "sky", kind: "rect", ifEmpty: "photo", frame: PHOTO, fill: { kind: "linear", angle: 180, stops: [[0, "#8ec5ff"], [1, "#dcefff"]] } },
  { id: "sun", kind: "path", ifEmpty: "photo", d: circle(40), frame: inCard(0.8, 0.22, 0.16, 0.16 * 1.4), fill: "#ffd166", glow: { color: "#ffd166/0.7", blur: 0.03 }, dy: [[0.4, 0.05, "out"], [2.0, 0]] },
  { id: "lawn", kind: "ellipse", ifEmpty: "photo", frame: inCard(0.5, 1.05, 1.5, 0.5), fill: { kind: "linear", angle: 180, stops: [[0, "#7bc96f"], [1, "#4f9d4a"]] } },
  { id: "house-body", kind: "path", ifEmpty: "photo", d: HOUSE_FILL, frame: inCard(0.46, 0.55, 0.5, 0.62), fill: "#fdf6ec", opacity: vis(0.5, 0.4, 99, 0) },
  { id: "house-windows", kind: "path", ifEmpty: "photo", d: "M28 50h12v10H28zM60 50h12v10H60z", frame: inCard(0.46, 0.55, 0.5, 0.62), fill: "@primary/0.6", opacity: vis(1.0, 0.3, 99, 0) },
  { id: "house-line", kind: "path", ifEmpty: "photo", d: HOUSE, frame: inCard(0.46, 0.55, 0.5, 0.62), stroke: "@primaryDeep", strokeWidth: 0.005, draw: drawOn(0.4, 1.2) },
  { id: "tree", kind: "path", ifEmpty: "photo", d: `${circle(30)}M50 80V96`, frame: inCard(0.16, 0.62, 0.2, 0.36), fill: "#3f8f45", stroke: "#2e6b33", strokeWidth: 0.004, scale: [[0.8, 0, "back"], [1.3, 1]], idle: { rotate: 2 } },
];

/**
 * This template's own look (Sky (light): clean white-blue, a brass accent.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const propertyCardLook: Look = {
  colors: { primary: "#1d4ed8", secondary: "#dbe6f6", accent: "#c49a45", background: "#f4f7fb", text: "#13233a" },
  heading: { family: "Manrope", weight: 800 }, body: { family: "Inter", weight: 500 }, bangla: { family: "Hind Siliguri", weight: 600 },
  radius: 0.35, motion: "smooth", grain: 0.02,
};

export const propertyCard: Template = {
  version: FORMAT_VERSION,
  id: "estate-property",
  name: "Property Card",
  category: "estate",
  description: "A listing: the photo settles in a card, a For sale tag pops, the price counts up and the details slide in.",
  tags: ["real estate", "property", "listing", "for sale", "for rent", "house", "apartment", "price"],
  length: LEN,
  hold: [2.4, EXIT],
  shapes: ALL_SHAPES,
  look: propertyCardLook,
  light: { x: [[0, 0.15], [LEN, 0.4]], y: 0.05 },
  fields: [
    { id: "photo", kind: "media", label: "Photo", en: "" },
    { id: "status", kind: "text", label: "Tag", en: "For sale", bn: "বিক্রয় হবে", limit: 14 },
    { id: "price", kind: "text", label: "Price", en: "Tk 1.25 crore", bn: "৳১.২৫ কোটি", limit: 24 },
    { id: "address", kind: "text", label: "Address", en: "House 12, Road 5, Dhanmondi", bn: "বাড়ি ১২, রোড ৫, ধানমন্ডি", limit: 48 },
    { id: "beds", kind: "text", label: "Bedrooms", en: "3 beds", bn: "৩ বেড", limit: 12 },
    { id: "baths", kind: "text", label: "Bathrooms", en: "2 baths", bn: "২ বাথ", limit: 12 },
    { id: "area", kind: "text", label: "Floor area", en: "1,450 sq ft", bn: "১,৪৫০ বর্গফুট", limit: 14 },
    { id: "cta", kind: "text", label: "Call to action", en: "Book a viewing", bn: "দেখার সময় বুক করুন", limit: 24 },
  ],
  hits: [{ t: 0.05, sfx: "swoosh" }, { t: 1.0, sfx: "pop" }, { t: 1.6, sfx: "click" }, { t: 2.1, sfx: "ding" }],
  layers: [
    ...backdrop("rays", "bokeh", { intensity: 0.75, overIntensity: 0.45, overSoft: 0.6, speed: 0.5 }),
    {
      id: "photo-card", kind: "group", frame: PHOTO, clip: "round",
      dy: [[0.1, 0.12, "out"], [0.9, 0]], opacity: vis(0.1, 0.3, EXIT, 0.4), scale: [[EXIT, 1, "in"], [EXIT + 0.4, 0.95]],
      shadow: { color: "#000000/0.45", blur: 0.05, y: 0.025, follow: true },
      children: [
        ...lot,
        { id: "photo", kind: "image", slot: "photo", ifFilled: "photo", fit: "cover", frame: PHOTO, placeholder: "Property photo", scale: [[0.1, 1.15, "out"], [3.5, 1]], idle: { scale: 0.05 } },
      ],
    },
    {
      id: "tag", kind: "rect", frame: inCard(0.2, 0.11, 0.3, 0.11), radius: "pill", fill: "@accent",
      shadow: { color: "#000000/0.3", blur: 0.015, y: 0.006 }, scale: pop(1.0, 0, 0.45, EXIT, 0.6), opacity: vis(1.0, 0.15, EXIT, 0.3),
    },
    txt("status", "status", inCard(0.2, 0.11, 0.26, 0.075), {
      role: "detail",
      font: "heading", weight: 800, size: 0.036, minSize: 0.036, lines: 1, upper: true, tracking: 0.08, color: "@onAccent",
      animate: { ...popWords(1.08), stagger: 0 }, exit: outFade(EXIT, 0.25),
    }),
    txt("price", "price", line("price", 0.09), {
      role: "cta",
      font: "heading", weight: 800, size: 0.075, minSize: 0.045, lines: 1, align: "left", 
      textAt: { "16:9": { size: 0.085 } }, animate: settle(), exit: outWords(EXIT),
    }),
    txt("address", "address", line("address", 0.06), {
      role: "body",
      size: 0.044, minSize: 0.044, lines: 1, align: "left", color: "@text/0.75", textAt: { "16:9": { size: 0.044 } },
      animate: riseWords(1.25, 0.03, 0.45), exit: outFade(EXIT, 0.25),
    }),
    ...[0, 1, 2].flatMap((i) => detail(i)),
    {
      id: "cta-button", kind: "rect", frame: line("cta", 0.075, 0.6), radius: "pill", fill: "@primary", lightWrap: { amount: 0.5 },
      scale: pop(2.1, 0.7, 0.45, EXIT, 0.9), opacity: vis(2.1, 0.2, EXIT, 0.3),
    },
    txt("cta", "cta", across((shape, d) => { const c = COL[shape]; return frame(c.x + (c.w * 0.3) / d.w, c.cta, c.w * 0.54, 0.045); }), {
      role: "cta",
      font: "heading", weight: 700, size: 0.044, minSize: 0.044, lines: 1, color: "@onPrimary",
      animate: popWords(2.2), exit: outFade(EXIT, 0.25),
    }),
  ],
};
