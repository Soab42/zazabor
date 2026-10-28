import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Shape } from "../layout";
import { ALL_SHAPES, showHide } from "./build";
import { at4, each, grain, hookAt0, leave, live, rise, sink, soft, type Spec, strict916, words } from "./common-a";
import { GLACIER } from "./looks";
import { glassCard, zoomThrough } from "./signature";

/**
 * Notifications: a phone's lock screen, and three notifications drop onto it one after another on
 * a spring (a new order, the payment, the delivery), each with its own chime.
 */

const EXIT = 6.0;
const STEP = 0.55;
const DIM: Record<Shape, [number, number]> = { "9:16": [1, 16 / 9], "16:9": [16 / 9, 1], "1:1": [1, 1], "4:5": [1, 1.25] };
const PHONE = at4({ "9:16": [0.5, 0.536, 0.57, 1.19], "16:9": [0.72, 0.5, 0.4, 0.86], "1:1": [0.5, 0.55, 0.32, 0.68], "4:5": [0.5, 0.52, 0.36, 0.76] });
/** Banners: centre x, the three centre ys, width and height (short sides). */
const BANNERS: Record<Shape, { x: number; ys: number[]; w: number; h: number }> = {
  "9:16": { x: 0.5, ys: [0.42, 0.56, 0.7], w: 0.72, h: 0.13 },
  "16:9": { x: 0.62, ys: [0.36, 0.5, 0.64], w: 0.66, h: 0.13 },
  "1:1": { x: 0.5, ys: [0.36, 0.5, 0.64], w: 0.7, h: 0.12 },
  "4:5": { x: 0.5, ys: [0.36, 0.49, 0.62], w: 0.72, h: 0.125 },
};
const ICONS = ["bell", "check", "truck"];
const BG = live("bg", "mesh", { intensity: 0.6, vignette: 0.12, seed: 51 });
/** The glass card behind the phone (the signature's, §12). */
const PANE = at4({ "9:16": [0.5, 0.64, 0.92, 0.42], "16:9": [0.72, 0.62, 0.7, 0.4], "1:1": [0.5, 0.66, 0.66, 0.34], "4:5": [0.5, 0.63, 0.7, 0.38] });

function banner(i: number): Layer {
  const t = 1.0 + i * STEP;
  const fr = each((s): Spec => [BANNERS[s].x, BANNERS[s].ys[i], BANNERS[s].w, BANNERS[s].h]);
  /** A spot in the banner: dx from its left edge (short sides), dy from its middle. */
  const spot = (dx: number, dy: number, w: number, h: number, ax = 0) => each((s): Spec => {
    const b = BANNERS[s];
    return [b.x + (dx - b.w / 2) / DIM[s][0], b.ys[i] + dy / DIM[s][1], w, h, ax];
  });
  return {
    id: `note${i + 1}`, kind: "group", frame: fr, opacity: showHide(t, 0.2, EXIT, 0.3),
    dy: [[t, -0.12, "spring"], [t + 0.6, 0]], scale: [[t, 0.9, "out"], [t + 0.5, 1], [EXIT, 1, "in"], [EXIT + 0.3, 0.94]],
    children: [
      { id: `note${i + 1}-bg`, kind: "rect", frame: fr, radius: 0.035, fill: "@card/0.94", stroke: "#ffffff/0.18", strokeWidth: 0.002, shadow: { color: "#000000/0.4", blur: 0.04, y: 0.015 } },
      { id: `note${i + 1}-tile`, kind: "rect", frame: spot(0.025, 0, 0.075, 0.075), radius: 0.02, fill: { kind: "linear", angle: 135, stops: [[0, "@primary"], [1, "@accent"]] } },
      { id: `note${i + 1}-icon`, kind: "icon", icon: ICONS[i], color: "@onPrimary", strokeWidth: 2, frame: spot(0.0375, 0, 0.045, 0.045) },
      words(`t${i + 1}`, `t${i + 1}`, spot(0.12, -0.022, BANNERS["9:16"].w - 0.16, 0.042), { weight: 700, role: "detail", size: 0.036, minSize: 0.036, lines: 1, align: "left" }),
      words(`b${i + 1}`, `b${i + 1}`, spot(0.12, 0.022, BANNERS["9:16"].w - 0.16, 0.038), { role: "detail", size: 0.036, minSize: 0.036, lines: 1, align: "left", color: "@text/0.75" }),
    ],
  };
}

export const notifications: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "app-notify",
  name: "Notifications",
  category: "app",
  description: "Three notifications drop onto a phone's lock screen one after another: an order, the payment, the delivery.",
  tags: ["app", "notifications", "alerts", "lock screen", "orders", "phone", "push"],
  length: 6.6,
  hold: [2.6, EXIT],
  shapes: ALL_SHAPES,
  look: GLACIER,
  fields: [
    { id: "headline", kind: "text", label: "Headline", en: "Never miss an order", bn: "কোনো অর্ডার মিস হবে না", limit: 30 },
    { id: "t1", kind: "text", label: "Notification 1", en: "New order #1042", bn: "নতুন অর্ডার #১০৪২", limit: 28 },
    { id: "b1", kind: "text", label: "Notification 1 text", en: "2 × Aurora Buds · ৳12,980", bn: "২ × অরোরা বাডস · ৳১২,৯৮০", limit: 34 },
    { id: "t2", kind: "text", label: "Notification 2", en: "Payment received", bn: "পেমেন্ট পাওয়া গেছে", limit: 28 },
    { id: "b2", kind: "text", label: "Notification 2 text", en: "৳12,980 from Rahim", bn: "রহিমের কাছ থেকে ৳১২,৯৮০", limit: 34 },
    { id: "t3", kind: "text", label: "Notification 3", en: "Out for delivery", bn: "ডেলিভারিতে বের হয়েছে", limit: 28 },
    { id: "b3", kind: "text", label: "Notification 3 text", en: "Arriving today by 6 pm", bn: "আজ সন্ধ্যা ৬টার মধ্যে পৌঁছাবে", limit: 34 },
    { id: "caption", kind: "text", label: "Caption", en: "Real-time alerts for your shop", bn: "আপনার দোকানের রিয়েল-টাইম অ্যালার্ট", limit: 40 },
  ],
  hits: [{ t: 0.3, sfx: "whoosh" }, { t: 1.0, sfx: "ding" }, { t: 1.0 + STEP, sfx: "ding" }, { t: 1.0 + STEP * 2, sfx: "ding" }],
  layers: [
    BG,
    live("aurora", "aurora", { over: true, intensity: 0.6, speed: 0.8, seed: 2 }),
    glassCard("pane", PANE, BG, 0.5, EXIT),
    {
      id: "phone", kind: "device", device: "phone", screen: "lock", frame: PHONE, shadow: { color: "#000000/0.5", blur: 0.06, y: 0.035 },
      // The signature (§12): at the end the camera zooms through the screen into the app.
      opacity: showHide(0.2, 0.3, EXIT + 0.5, 0.1), dy: [[0.2, 0.1, "out"], [1.0, 0]], scale: zoomThrough([[0.2, 0.92, "out"], [1.0, 1]], EXIT), idle: { dy: -0.01 },
    },
    ...[0, 1, 2].map(banner),
    words("headline", "headline", at4({
      "9:16": [0.5, 0.14, 0.76, 0.1], "16:9": [0.05, 0.4, 0.42, 0.24, 0], "1:1": [0.5, 0.1, 0.86, 0.08], "4:5": [0.5, 0.1, 0.86, 0.09],
    }), { font: "heading", size: 0.075, minSize: 0.07, lines: 2, textAt: { "16:9": { size: 0.08, align: "left" }, "1:1": { size: 0.07, lines: 1 }, "4:5": { lines: 1 } }, animate: rise(0.4), exit: sink(EXIT) }),
    words("caption", "caption", at4({
      "9:16": [0.5, 0.8905, 0.76, 0.045], "16:9": [0.05, 0.62, 0.42, 0.08, 0], "1:1": [0.5, 0.93, 0.8, 0.04], "4:5": [0.5, 0.9, 0.8, 0.045],
    }), { weight: 500, role: "detail", size: 0.036, minSize: 0.036, lines: 2, color: "@text/0.8", textAt: { "16:9": { align: "left" } }, animate: soft(2.6), exit: leave(EXIT) }),
    grain(),
  ],
}, ["phone"]));
