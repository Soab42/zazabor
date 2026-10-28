import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Shape } from "../layout";
import { ALL_SHAPES, pop, showHide } from "./build";
import { at4, button, each, grain, hookAt0, leave, live, rise, sink, soft, type Spec, strict916, sway, words } from "./common-a";
import { NEON_BLUE } from "./looks";
import { glassCard, zoomThrough } from "./signature";

/**
 * Phone Showcase: a phone turns toward you with your screen recording on it (a built-in app
 * screen until you add one), and three feature chips float out around it at different depths.
 */

const EXIT = 5.8;
const DIM: Record<Shape, [number, number]> = { "9:16": [1, 16 / 9], "16:9": [16 / 9, 1], "1:1": [1, 1], "4:5": [1, 1.25] };

const PHONE = at4({ "9:16": [0.5, 0.47, 0.32, 0.66], "16:9": [0.68, 0.5, 0.36, 0.78], "1:1": [0.5, 0.53, 0.28, 0.6], "4:5": [0.5, 0.5, 0.3, 0.64] });
/** Chip centres per shape (canvas fractions); each chip is 0.3 × 0.07 short sides. */
const CHIPS: Record<Shape, [number, number][]> = {
  "9:16": [[0.24, 0.36], [0.74, 0.46], [0.26, 0.57]],
  "16:9": [[0.5, 0.33], [0.86, 0.5], [0.5, 0.67]],
  "1:1": [[0.22, 0.4], [0.78, 0.53], [0.24, 0.66]],
  "4:5": [[0.22, 0.38], [0.78, 0.5], [0.23, 0.62]],
};
const ICONS = ["bolt", "check", "shield"];
const BG = live("bg", "mesh", { colors: ["@primaryDeep", "@secondary", "@primary", "@deep", "@bg", "@primaryDeep"], intensity: 0.75, seed: 41 });
/** The glass card behind the phone (the signature's, §12). */
const PANE = at4({ "9:16": [0.5, 0.48, 0.66, 0.52], "16:9": [0.68, 0.5, 0.62, 0.62], "1:1": [0.5, 0.54, 0.6, 0.48], "4:5": [0.5, 0.51, 0.62, 0.5] });

function chip(i: number): Layer {
  const t = 1.3 + i * 0.13;
  const w = 0.3, h = 0.07;
  const fr = each((shape): Spec => [...CHIPS[shape][i], w, h]);
  const part = (dx: number, pw: number, ax = 0.5) => each((shape): Spec => {
    const [x, y] = CHIPS[shape][i];
    return [x + dx / DIM[shape][0], y, pw, h * 0.7, ax];
  });
  const side = CHIPS["9:16"][i][0] < 0.5 ? -1 : 1;
  return {
    id: `chip${i + 1}`, kind: "group", frame: fr, opacity: showHide(t, 0.25, EXIT, 0.3), scale: pop(t, 0.5, 0.55, EXIT, 0.8),
    dx: [[t, -side * 0.12, "out"], [t + 0.6, 0]], idle: { dy: (i % 2 ? 0.012 : -0.014) },
    children: [
      { id: `chip${i + 1}-bg`, kind: "rect", frame: fr, radius: "pill", fill: "@surface/0.88", stroke: "@text/0.18", strokeWidth: 0.002, shadow: { color: "#000000/0.35", blur: 0.03, y: 0.012 } },
      { id: `chip${i + 1}-dot`, kind: "ellipse", frame: part(-w / 2 + 0.04, 0.05), fill: "@primary" },
      { id: `chip${i + 1}-icon`, kind: "icon", icon: ICONS[i], color: "@onPrimary", strokeWidth: 2, frame: part(-w / 2 + 0.04, 0.03) },
      words(`chip${i + 1}-text`, `f${i + 1}`, part(-w / 2 + 0.08, w - 0.1, 0), { weight: 600, role: "detail", size: 0.036, minSize: 0.036, lines: 1, align: "left" }),
    ],
  };
}

export const phoneShowcase: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "app-phone",
  name: "Phone Showcase",
  category: "app",
  description: "A phone turns toward you with your screen recording on it, and feature chips float out around it.",
  tags: ["app", "phone", "mockup", "screen recording", "mobile", "features", "launch"],
  length: 6.4,
  hold: [2.4, EXIT],
  shapes: ALL_SHAPES,
  look: NEON_BLUE,
  light: { x: 0.8, y: 0.05 },
  fields: [
    { id: "kicker", kind: "text", label: "App name", en: "Zazabor Pay", bn: "জাজাবর পে", limit: 22 },
    { id: "headline", kind: "text", label: "Headline", en: "Pay anyone in seconds", bn: "সেকেন্ডেই যে কাউকে পেমেন্ট", limit: 36 },
    { id: "f1", kind: "text", label: "Feature 1", en: "Instant transfers", bn: "তাৎক্ষণিক ট্রান্সফার", limit: 22 },
    { id: "f2", kind: "text", label: "Feature 2", en: "Zero fees", bn: "কোনো ফি নেই", limit: 22 },
    { id: "f3", kind: "text", label: "Feature 3", en: "Bank-grade security", bn: "ব্যাংক-মানের সুরক্ষা", limit: 22 },
    { id: "cta", kind: "text", label: "Button", en: "Download free", bn: "ফ্রি ডাউনলোড", limit: 20 },
    { id: "screen", kind: "media", label: "Screen recording or screenshot", en: "" },
  ],
  hits: [{ t: 0.3, sfx: "whoosh" }, { t: 1.3, sfx: "pop" }, { t: 1.43, sfx: "pop" }, { t: 1.56, sfx: "pop" }, { t: 2.1, sfx: "click" }],
  layers: [
    BG,
    live("motes", "drift", { over: true, intensity: 0.5, seed: 8 }),
    glassCard("pane", PANE, BG, 0.6, EXIT),
    {
      id: "phone", kind: "device", device: "phone", slot: "screen", screen: "app-home", frame: PHONE,
      // The signature (§12): at the end the camera zooms through the screen into the app.
      shadow: { color: "#000000/0.5", blur: 0.06, y: 0.035, follow: true }, opacity: showHide(0.3, 0.3, EXIT + 0.5, 0.1), scale: zoomThrough([[0.3, 1]], EXIT),
      dy: [[0.3, 0.14, "out"], [1.1, 0]], turnY: [[0.3, -40, "out"], [1.2, -10], ...sway(1.2, EXIT, -10, 6, 3.2).slice(1)], rotate: [[0.3, 6, "out"], [1.2, 0]],
      lightWrap: { color: "@accent", amount: 0.35, width: 0.015 },
    },
    ...[0, 1, 2].map(chip),
    words("kicker", "kicker", at4({
      "9:16": [0.5, 0.107, 0.6, 0.04], "16:9": [0.06, 0.25, 0.5, 0.05, 0], "1:1": [0.5, 0.072, 0.6, 0.04], "4:5": [0.5, 0.068, 0.6, 0.045],
    }), { weight: 700, role: "detail", size: 0.036, lines: 1, upper: true, tracking: 0.2, color: "@accent", textAt: { "16:9": { align: "left" } }, animate: soft(0.7), exit: leave(EXIT) }),
    words("headline", "headline", at4({
      "9:16": [0.5, 0.1905, 0.76, 0.16], "16:9": [0.06, 0.42, 0.6, 0.24, 0], "1:1": [0.5, 0.135, 0.86, 0.08], "4:5": [0.5, 0.125, 0.86, 0.09],
    }), { font: "heading", size: 0.07, minSize: 0.07, lines: 2, textAt: { "16:9": { size: 0.085, align: "left" }, "1:1": { size: 0.07, lines: 1 }, "4:5": { size: 0.07, lines: 1 } }, animate: rise(0.5), exit: sink(EXIT) }),
    button("cta", "cta", at4({
      "9:16": [0.5, 0.73, 0.44, 0.08], "16:9": [0.06, 0.68, 0.32, 0.09, 0], "1:1": [0.5, 0.9, 0.36, 0.07], "4:5": [0.5, 0.88, 0.38, 0.075],
    }), 2.1, EXIT),
    grain(),
  ],
}, ["phone"]));
