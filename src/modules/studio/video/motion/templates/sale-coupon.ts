import { FORMAT_VERSION, type Template } from "../format";
import type { Shape } from "../layout";
import { ALL_SHAPES, pop, showHide } from "./build";
import { button, each, grain, hookAt0, live, rise, riseLetters, sink, soft, type Spec, words } from "./common-a";
import { TANGERINE } from "./looks";
import { slam, slamIn } from "./signature";

/**
 * Coupon Code: a ticket with notched edges swings in, its tear line draws itself, the amount and
 * the code appear letter by letter in a box that outlines itself, with a small pop of confetti.
 */

const EXIT = 5.8;
const CODE_AT = 1.5;
const AMOUNT_AT = 1.0;

/** The ticket per shape: centre and width (short sides); it's 0.6 as tall as wide. */
const TICKET: Record<Shape, [number, number, number]> = {
  "9:16": [0.47, 0.44, 0.78], "16:9": [0.5, 0.5, 1.05], "1:1": [0.5, 0.48, 0.82], "4:5": [0.5, 0.47, 0.84],
};
const DIM: Record<Shape, [number, number]> = { "9:16": [1, 16 / 9], "16:9": [16 / 9, 1], "1:1": [1, 1], "4:5": [1, 1.25] };

/** A frame inside the ticket: fx, fy its centre (0…1 across and down the ticket), w and h in ticket widths. */
const inside = (fx: number, fy: number, w: number, h: number, ax = 0.5) => each((shape): Spec => {
  const [cx, cy, tw] = TICKET[shape], [dw, dh] = DIM[shape];
  return [cx + ((fx - 0.5) * tw) / dw + ((ax - 0.5) * w * tw) / dw, cy + ((fy - 0.5) * tw * 0.6) / dh, w * tw, h * tw, ax];
});
const BODY = inside(0.5, 0.5, 1, 0.6);

/** Rounded corners and a half-circle notch in each side, in a 100 × 60 box. */
const TICKET_PATH = "M4 0H96Q100 0 100 4V24A6 6 0 0 0 100 36V56Q100 60 96 60H4Q0 60 0 56V36A6 6 0 0 0 0 24V4Q0 0 4 0Z";
/** The tear line: short dashes down the stub's edge. */
const TEAR = Array.from({ length: 10 }, (_, i) => `M0 ${i * 10 + 2}V${i * 10 + 7}`).join("");

// Laid out for the strict band in 9:16 already: the ticket and the texts on it keep their proportions.
export const couponCode: Template = hookAt0({
  version: FORMAT_VERSION,
  id: "sale-coupon",
  name: "Coupon Code",
  category: "sale",
  description: "A notched ticket swings in, its tear line draws itself, and the code appears letter by letter.",
  tags: ["sale", "coupon", "code", "voucher", "ticket", "discount", "promo code"],
  length: 6.4,
  hold: [2.4, EXIT],
  shapes: ALL_SHAPES,
  look: TANGERINE,
  fields: [
    { id: "headline", kind: "text", label: "Headline", en: "A gift for you", bn: "আপনার জন্য উপহার", limit: 26 },
    { id: "amount", kind: "text", label: "Amount", en: "20% off", bn: "২০% ছাড়", limit: 12 },
    { id: "note", kind: "text", label: "Under the amount", en: "on your first order", bn: "প্রথম অর্ডারে", limit: 30 },
    { id: "code", kind: "text", label: "Code", en: "ZAZA20", bn: "ZAZA20", limit: 12 },
    { id: "valid", kind: "text", label: "On the stub", en: "Valid till 31 Oct", bn: "৩১ অক্টোবর পর্যন্ত", limit: 24 },
    { id: "cta", kind: "text", label: "Button", en: "Use it now", bn: "এখনই ব্যবহার করুন", limit: 22 },
  ],
  hits: [{ t: 0.3, sfx: "swoosh" }, { t: 1.0, sfx: "click" }, { t: CODE_AT, sfx: "typing" }, { t: 2.1, sfx: "pop" }],
  layers: [
    live("bg", "waves", { intensity: 0.75, speed: 0.9, seed: 4 }),
    live("motes", "drift", { over: true, intensity: 0.6, seed: 14 }),
    {
      id: "ticket", kind: "group", frame: BODY, opacity: showHide(0.3, 0.3, EXIT, 0.3), scale: pop(0.3, 0.75, 0.7, EXIT, 0.9),
      rotate: [[0.3, -10, "out"], [1.0, -2.5]], idle: { rotate: 1.5, dy: -0.01 },
      sheen: { at: [[1.1, -0.2, "inOut"], [2.0, 1.2]], width: 0.18, angle: 25, strength: 0.45 },
      children: [
        { id: "ticket-body", kind: "path", d: TICKET_PATH, view: [100, 60], frame: BODY, fill: { kind: "linear", angle: 120, stops: [[0, "@primary"], [1, "@primaryDeep"]] }, shadow: { color: "#000000/0.45", blur: 0.06, y: 0.03 } },
        { id: "ticket-edge", kind: "path", d: TICKET_PATH, view: [100, 60], frame: BODY, stroke: "#ffffff/0.3", strokeWidth: 0.003 },
        { id: "tear", kind: "path", d: TEAR, frame: inside(0.71, 0.5, 0.002, 0.54), stroke: "@onPrimary/0.55", strokeWidth: 0.004, cap: "round", draw: [[0.9, 0, "inOut"], [1.5, 1]] },
        // The signature (§12): the amount slams onto the ticket; the confetti fires as it settles.
        words("amount", "amount", inside(0.36, 0.27, 0.6, 0.18), { font: "heading", size: 0.1, minSize: 0.07, lines: 1, color: "@onPrimary", opacity: slamIn(AMOUNT_AT, EXIT + 0.3), scale: slam(AMOUNT_AT), textAt: { "16:9": { size: 0.12 } } }),
        words("note", "note", inside(0.36, 0.47, 0.6, 0.07), { weight: 500, role: "detail", size: 0.036, minSize: 0.036, lines: 1, color: "@onPrimary/0.8", animate: soft(1.0) }),
        {
          id: "code-box", kind: "path", d: "M50 0H96Q100 0 100 12V88Q100 100 96 100H4Q0 100 0 88V12Q0 0 4 0Z", frame: inside(0.36, 0.74, 0.52, 0.13),
          stroke: "@onPrimary/0.85", strokeWidth: 0.0035, fill: "@onPrimary/0.1", draw: [[1.2, 0, "inOut"], [1.9, 1]], opacity: showHide(1.2, 0.1, EXIT, 0.3),
        },
        words("code", "code", inside(0.36, 0.74, 0.48, 0.11), { font: "heading", weight: 800, size: 0.06, minSize: 0.044, lines: 1, tracking: 0.18, color: "@onPrimary", animate: riseLetters(CODE_AT, 0.07, 0.4) }),
        { id: "stub-icon", kind: "icon", icon: "gift", color: "@onPrimary", strokeWidth: 1.6, frame: inside(0.855, 0.38, 0.13, 0.13), draw: [[1.0, 0, "inOut"], [1.8, 1]] },
        // Clear of the notch in the ticket's edge.
        words("valid", "valid", inside(0.84, 0.8, 0.2, 0.11), { weight: 600, role: "detail", size: 0.036, minSize: 0.036, lines: 2, color: "@onPrimary", animate: soft(1.4) }),
      ],
    },
    { id: "confetti", kind: "fx", fx: "confetti", frame: BODY, burst: AMOUNT_AT + 0.14, amount: 0.6 },
    words("headline", "headline", each((shape): Spec => ({ "9:16": [0.5, 0.17, 0.76, 0.1], "16:9": [0.5, 0.11, 1.2, 0.08], "1:1": [0.5, 0.12, 0.86, 0.08], "4:5": [0.5, 0.12, 0.86, 0.09] } as Record<Shape, Spec>)[shape]), {
      font: "heading", size: 0.08, minSize: 0.07, lines: 1, textAt: { "16:9": { size: 0.07 } }, animate: rise(0.5), exit: sink(EXIT),
    }),
    button("cta", "cta", each((shape): Spec => ({ "9:16": [0.5, 0.62, 0.44, 0.08], "16:9": [0.5, 0.89, 0.32, 0.08], "1:1": [0.5, 0.85, 0.36, 0.075], "4:5": [0.5, 0.82, 0.38, 0.08] } as Record<Shape, Spec>)[shape]), 2.2, EXIT),
    grain(),
  ],
}, ["headline"]);
