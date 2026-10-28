import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Shape } from "../layout";
import { ALL_SHAPES, showHide } from "./build";
import { at4, each, grain, hookAt0, live, sink, soft, stars, words, type Spec } from "./common-a";
import { LINEN } from "./looks";

/**
 * Review Carousel: three reviews slide through one after another as a single plane (push, with a
 * little blur), each held long enough to read, with stars and dots that follow along.
 */

const STAY = 3.3;
const AT = [0.5, 4.0, 7.5];
const EXIT = 10.8;
const DIM: Record<Shape, number> = { "9:16": 1, "16:9": 16 / 9, "1:1": 1, "4:5": 1 };

/** Per shape: card centre y and size, and the rows inside it (stars, quote, name, role) as ys. */
const LAYOUT: Record<Shape, { card: [number, number, number]; rows: [number, number, number, number]; q: [number, number]; w: number }> = {
  "9:16": { card: [0.47, 0.8, 0.88], rows: [0.31, 0.45, 0.6, 0.637], q: [0.66, 0.3], w: 0.66 },
  "16:9": { card: [0.55, 1.3, 0.66], rows: [0.33, 0.5, 0.68, 0.74], q: [1.1, 0.2], w: 1.0 },
  "1:1": { card: [0.52, 0.84, 0.66], rows: [0.28, 0.47, 0.65, 0.7], q: [0.72, 0.24], w: 0.72 },
  "4:5": { card: [0.5, 0.84, 0.76], rows: [0.28, 0.45, 0.63, 0.67], q: [0.72, 0.26], w: 0.72 },
};

function card(i: number): Layer {
  const t = AT[i], out = i === 2 ? EXIT : t + STAY;
  const fr = each((s): Spec => [0.5, LAYOUT[s].card[0], LAYOUT[s].card[1], LAYOUT[s].card[2]]);
  const slide = i === 2 ? [[t, 2.2, "out"], [t + 0.55, 0]] : [[t, 2.2, "out"], [t + 0.55, 0], [out, 0, "in"], [out + 0.45, -2.2]];
  return {
    id: `card${i + 1}`, kind: "group", frame: fr, opacity: i === 2 ? showHide(t, 0.25, EXIT, 0.35) : showHide(t, 0.25, out + 0.15, 0.3),
    dx: slide as [number, number, "out" | "in"][], blur: i === 2 ? [[t, 0.012, "out"], [t + 0.5, 0]] : [[t, 0.012, "out"], [t + 0.5, 0], [out, 0, "in"], [out + 0.45, 0.012]],
    children: [
      { id: `card${i + 1}-bg`, kind: "rect", frame: fr, radius: "theme", fill: "@card/0.92", stroke: "@text/0.14", strokeWidth: 0.002, shadow: { color: "#000000/0.35", blur: 0.05, y: 0.02 } },
      ...stars(`c${i + 1}star`, 5, (s) => [0.5, LAYOUT[s].rows[0]], 0.04, t + 0.35, out + 0.1),
      words(`q${i + 1}`, `q${i + 1}`, each((s): Spec => [0.5, LAYOUT[s].rows[1], LAYOUT[s].q[0], LAYOUT[s].q[1]]), {
        size: 0.05, lines: 4, lineHeight: 1.28, animate: soft(t + 0.3, 0.05, 0.5),
        // The signature (§12): a marker swipes across the first line once the review has landed.
        marker: { draw: [[t + 1.05, 0, "out"], [t + 1.6, 1]], color: "@accent/0.4", lines: 1 },
      }),
      words(`n${i + 1}`, `n${i + 1}`, each((s): Spec => [0.5, LAYOUT[s].rows[2], LAYOUT[s].w, 0.05]), { weight: 700, size: 0.044, lines: 1 }),
      words(`r${i + 1}`, `r${i + 1}`, each((s): Spec => [0.5, LAYOUT[s].rows[3], LAYOUT[s].w, 0.045]), { role: "detail", size: 0.036, lines: 1, color: "@text/0.7" }),
    ],
  };
}

const DOTS = (i: number) => each((s): Spec => [0.5 + ((i - 1) * 0.05) / DIM[s], ({ "9:16": 0.745, "16:9": 0.92, "1:1": 0.92, "4:5": 0.92 } as Record<Shape, number>)[s], 0.018, 0.018]);

export const reviewCarousel: Template = hookAt0({
  version: FORMAT_VERSION,
  id: "review-carousel",
  name: "Review Carousel",
  category: "review",
  description: "Three reviews slide through one after another, each held long enough to read, with stars and dots.",
  tags: ["testimonial", "reviews", "carousel", "customers", "stars", "social proof", "slides"],
  length: 11.4,
  hold: [4.6, 7.4],
  shapes: ALL_SHAPES,
  look: LINEN,
  fields: [
    { id: "headline", kind: "text", label: "Heading", en: "What customers say", bn: "ক্রেতারা যা বলছেন", limit: 26 },
    { id: "q1", kind: "text", label: "Review 1", en: "Arrived the next day, packed with care.", bn: "পরদিনই পেয়েছি, যত্ন করে প্যাক করা।", limit: 70, multiline: true },
    { id: "n1", kind: "text", label: "Name 1", en: "Nusrat J.", bn: "নুসরাত জে.", limit: 24 },
    { id: "r1", kind: "text", label: "About 1", en: "Chattogram", bn: "চট্টগ্রাম", limit: 28 },
    { id: "q2", kind: "text", label: "Review 2", en: "Better than the photos. I ordered two more.", bn: "ছবির চেয়েও ভালো। আরও দুটো অর্ডার দিলাম।", limit: 70, multiline: true },
    { id: "n2", kind: "text", label: "Name 2", en: "Arif H.", bn: "আরিফ এইচ.", limit: 24 },
    { id: "r2", kind: "text", label: "About 2", en: "Sylhet", bn: "সিলেট", limit: 28 },
    { id: "q3", kind: "text", label: "Review 3", en: "Support answered in minutes. Five stars.", bn: "সাপোর্ট মিনিটেই উত্তর দিল। পাঁচ তারা।", limit: 70, multiline: true },
    { id: "n3", kind: "text", label: "Name 3", en: "Tania R.", bn: "তানিয়া আর.", limit: 24 },
    { id: "r3", kind: "text", label: "About 3", en: "Dhaka", bn: "ঢাকা", limit: 28 },
  ],
  hits: [{ t: AT[0], sfx: "swoosh" }, { t: AT[1], sfx: "swoosh" }, { t: AT[2], sfx: "swoosh" }],
  layers: [
    live("bg", "mesh", { speed: 0.5, intensity: 0.6, vignette: 0.12, seed: 81 }),
    live("bokeh", "bokeh", { over: true, speed: 0.6, intensity: 0.4, soft: 0.7, seed: 4 }),
    ...[0, 1, 2].map(card),
    ...[0, 1, 2].map((i): Layer => ({ id: `dot${i + 1}`, kind: "ellipse", frame: DOTS(i), fill: "@text/0.3", opacity: showHide(0.6, 0.3, EXIT, 0.3) })),
    {
      id: "dot-on", kind: "ellipse", frame: DOTS(0), fill: "@accent", scale: 1.25, opacity: showHide(0.6, 0.3, EXIT, 0.3),
      dx: [[AT[1], 0, "inOut"], [AT[1] + 0.45, 0.05], [AT[2], 0.05, "inOut"], [AT[2] + 0.45, 0.1]],
    },
    words("headline", "headline", at4({
      "9:16": [0.5, 0.18, 0.76, 0.09], "16:9": [0.5, 0.14, 1.3, 0.1], "1:1": [0.5, 0.11, 0.86, 0.08], "4:5": [0.5, 0.1, 0.86, 0.09],
    }), { font: "heading", size: 0.075, lines: 1, exit: sink(EXIT) }),
    grain(),
  ],
}, ["headline"]);
