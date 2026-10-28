import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Shape } from "../layout";
import { ALL_SHAPES, RING, across, frame, pop } from "./build";
import { F, MAIL, PERSON, PHONE, backdrop, drawOn, outFade, outLine, riseWords, settle, slideWords, txt, vis } from "./common-b";

/**
 * Agent Intro: a property consultant introduces themselves. Their portrait comes up in a circle as
 * a ring draws round it, the name rises letter by letter, then the role and agency, two contact
 * rows (phone, email) and a line of experience on an award ribbon.
 */

const EXIT = 5.8;
const LEN = 6.4;

const PORTRAIT = F({ "9:16": [0.47, 0.265, 0.42, 0.42], "16:9": [0.25, 0.47, 0.56, 0.56], "1:1": [0.5, 0.225, 0.32, 0.32], "4:5": [0.5, 0.215, 0.34, 0.34] });
const RING_AT = F({ "9:16": [0.47, 0.265, 0.48, 0.48], "16:9": [0.25, 0.47, 0.64, 0.64], "1:1": [0.5, 0.225, 0.37, 0.37], "4:5": [0.5, 0.215, 0.39, 0.39] });
/** The text column: middle x (or left edge, in 16:9), width, and each line's y per shape. */
const COL: Record<Shape, { x: number; w: number; ax: number; y: number[] }> = {
  "9:16": { x: 0.47, w: 0.78, ax: 0.5, y: [0.43, 0.483, 0.522, 0.59, 0.645, 0.73] },
  "16:9": { x: 0.5, w: 0.8, ax: 0, y: [0.27, 0.37, 0.43, 0.56, 0.66, 0.8] },
  "1:1": { x: 0.5, w: 0.86, ax: 0.5, y: [0.44, 0.505, 0.565, 0.66, 0.74, 0.87] },
  "4:5": { x: 0.5, w: 0.86, ax: 0.5, y: [0.42, 0.49, 0.54, 0.625, 0.69, 0.815] },
};
const row = (i: number, h: number, w = 1) => across((shape) => { const c = COL[shape]; return frame(c.x, c.y[i], c.w * w, h, c.ax); });
/** A contact row: an icon and the text after it, centred as a pair (left-aligned in 16:9). */
const CONTACT_W = 0.62;
const contact = (i: number, part: "chip" | "icon" | "text") => across((shape, d) => {
  const c = COL[shape], y = c.y[i];
  const left = c.ax === 0 ? c.x : c.x - CONTACT_W / 2 / d.w;
  if (part === "chip") return frame(left, y, CONTACT_W, 0.07, 0);
  if (part === "icon") return frame(left + 0.045 / d.w, y, 0.034, 0.034);
  return frame(left + 0.085 / d.w, y, CONTACT_W - 0.11, 0.045, 0);
});

function contactRow(i: number, icon: string, field: string): Layer[] {
  const t = 1.6 + (i - 3) * 0.18, n = i - 2, out = EXIT + (i - 3) * 0.05;
  return [
    { id: `contact${n}`, kind: "rect", frame: contact(i, "chip"), radius: "pill", fill: "@surface/0.85", stroke: "@text/0.12", strokeWidth: 0.002, dx: [[t, -0.06, "out"], [t + 0.5, 0]], opacity: vis(t, 0.3, out, 0.3) },
    { id: `contact-icon${n}`, kind: "path", d: icon, frame: contact(i, "icon"), stroke: "@accent", strokeWidth: 0.0035, draw: drawOn(t + 0.15, t + 0.7), opacity: vis(t, 0.15, out, 0.3) },
    txt(field, field, contact(i, "text"), {
      role: "detail", font: "heading", weight: 600, size: 0.036, minSize: 0.036, lines: 1, align: "left",
      animate: slideWords(t + 0.1, -0.4, 0.04, 0.45), exit: outFade(out, 0.25),
    }),
  ];
}

/**
 * This template's own look (Navy and gold.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const agentIntroLook: Look = {
  colors: { primary: "#c9a227", secondary: "#13294b", accent: "#c9a227", background: "#0b1d33", text: "#f2f5fa" },
  heading: { family: "DM Serif Display", weight: 400 }, body: { family: "Inter", weight: 500 }, bangla: { family: "Tiro Bangla", weight: 400 },
  radius: 0.3, motion: "smooth", grain: 0.02, grade: { warmth: 0.05, fade: 0.04 },
  backdrop: ["#1e3a5f", "#c9a227", "#2c5282", "#081526", "#0b1d33"],
};

export const agentIntro: Template = {
  version: FORMAT_VERSION,
  id: "estate-agent",
  name: "Agent Intro",
  category: "estate",
  description: "A consultant introduces themselves: portrait in a drawn ring, name, agency, phone and email.",
  tags: ["real estate", "agent", "consultant", "introduction", "contact", "profile", "services"],
  length: LEN,
  hold: [2.4, EXIT],
  shapes: ALL_SHAPES,
  look: agentIntroLook,
  light: { x: [[0, 0.8], [LEN, 0.6]], y: 0.0 },
  fields: [
    { id: "photo", kind: "media", label: "Portrait", en: "" },
    { id: "name", kind: "text", label: "Name", en: "Farhan Ahmed", bn: "ফারহান আহমেদ", limit: 28 },
    { id: "role", kind: "text", label: "Role", en: "Property consultant", bn: "প্রপার্টি কনসালট্যান্ট", limit: 36 },
    { id: "agency", kind: "text", label: "Agency", en: "Lumen Homes", bn: "লুমেন হোমস", limit: 28 },
    { id: "phone", kind: "text", label: "Phone", en: "+880 1711-000000", bn: "+৮৮০ ১৭১১-০০০০০০", limit: 24 },
    { id: "email", kind: "text", label: "Email", en: "farhan@lumenhomes.com", bn: "farhan@lumenhomes.com", limit: 36 },
    { id: "badge", kind: "text", label: "Experience", en: "12 years helping families move", bn: "১২ বছর ধরে পরিবারের পাশে", limit: 40 },
  ],
  hits: [{ t: 0.2, sfx: "rise" }, { t: 0.9, sfx: "chime" }, { t: 1.5, sfx: "swoosh" }, { t: 2.3, sfx: "pop" }],
  layers: [
    ...backdrop("mesh", "rays", { intensity: 0.7, overIntensity: 0.5, speed: 0.5 }),
    {
      id: "halo", kind: "ellipse", frame: RING_AT, fill: { kind: "radial", stops: [[0, "@primary/0.35"], [1, "@primary/0"]] },
      scale: [[0.2, 0.6, "out"], [1.4, 1.5]], opacity: vis(0.2, 0.6, EXIT, 0.4), idle: { scale: 0.08 },
    },
    {
      id: "ring", kind: "path", d: RING, frame: RING_AT, stroke: { kind: "linear", angle: 135, stops: [[0, "@primary"], [1, "@accent"]] }, strokeWidth: 0.006,
      draw: drawOn(0.2, 1.1), rotate: [[0.2, -120, "out"], [1.4, 0]], opacity: vis(0.2, 0.15, EXIT, 0.4), idle: { dy: -0.01 },
    },
    {
      id: "portrait", kind: "group", frame: PORTRAIT, clip: "ellipse",
      scale: [[0.35, 0.7, "out"], [1.0, 1], [EXIT, 1, "in"], [EXIT + 0.4, 0.8]], opacity: vis(0.35, 0.3, EXIT, 0.4), idle: { dy: -0.012 },
      shadow: { color: "#000000/0.4", blur: 0.04, y: 0.02, follow: true },
      children: [
        { id: "portrait-bg", kind: "rect", ifEmpty: "photo", frame: PORTRAIT, fill: { kind: "linear", angle: 160, stops: [[0, "@surface"], [1, "@primary/0.5"]] } },
        { id: "person", kind: "path", ifEmpty: "photo", d: PERSON, frame: PORTRAIT, fill: "@text/0.55", dy: [[0.35, 0.04, "out"], [1.2, 0]] },
        { id: "photo", kind: "image", slot: "photo", ifFilled: "photo", fit: "cover", frame: PORTRAIT, placeholder: "Portrait", scale: [[0.35, 1.15, "out"], [2.5, 1]] },
      ],
    },
    txt("name", "name", row(0, 0.08), {
      role: "body",
      font: "heading", weight: 800, size: 0.068, minSize: 0.044, lines: 1, textAt: { "16:9": { size: 0.08, align: "left" }, "1:1": { size: 0.06 } },
      animate: settle(), exit: outLine(EXIT),
    }),
    txt("role", "role", row(1, 0.05), {
      role: "detail",
      size: 0.036, minSize: 0.036, lines: 1, color: "@text/0.8", textAt: { "16:9": { size: 0.04, align: "left" } },
      animate: riseWords(1.05, 0.05, 0.45), exit: outFade(EXIT, 0.25),
    }),
    txt("agency", "agency", row(2, 0.045), {
      role: "detail",
      size: 0.036, minSize: 0.036, lines: 1, color: "@text/0.7", upper: true, tracking: 0.2, weight: 700, textAt: { "16:9": { align: "left" } },
      animate: riseWords(1.2, 0.05, 0.45), exit: outFade(EXIT, 0.25),
    }),
    ...contactRow(3, PHONE, "phone"),
    ...contactRow(4, MAIL, "email"),
    {
      id: "award", kind: "icon", icon: "award", color: "@accent", strokeWidth: 2,
      frame: across((shape, d) => { const c = COL[shape]; return frame(c.ax === 0 ? c.x + 0.025 / d.w : c.x - 0.33 / d.w, c.y[5], 0.05, 0.05); }),
      scale: pop(2.3, 0, 0.5, EXIT, 0.6), opacity: vis(2.3, 0.15, EXIT, 0.3),
    },
    txt("badge", "badge", across((shape, d) => { const c = COL[shape]; return frame(c.ax === 0 ? c.x + 0.065 / d.w : c.x - 0.29 / d.w, c.y[5], 0.62, 0.05, 0); }), {
      role: "detail",
      italic: true, size: 0.036, minSize: 0.036, lines: 1, align: "left", color: "@text/0.8",
      animate: riseWords(2.4, 0.04, 0.45), exit: outFade(EXIT, 0.25),
    }),
  ],
};
