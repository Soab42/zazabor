import { FORMAT_VERSION, type Layer, type Template } from "../format";
import { ALL_SHAPES, pop, showHide } from "./build";
import { at4, button, each, grain, hookAt0, leave, live, rise, sink, slideIn, type Spec, strict916, words } from "./common-a";
import { IOS_LIGHT } from "./looks";
import { glassCard, zoomThrough } from "./signature";

/**
 * Laptop Screen: a laptop opens toward you showing your product's screen (a live dashboard until
 * you add a screenshot), with three ticked points and a button; glass drops refract the grid behind.
 */

const EXIT = 5.8;
const LAPTOP = at4({ "9:16": [0.5, 0.42, 0.9, 0.55], "16:9": [0.68, 0.5, 0.96, 0.7], "1:1": [0.5, 0.45, 0.84, 0.5], "4:5": [0.5, 0.42, 0.86, 0.52] });
/** Each point: its icon's centre per shape; the text starts just right of it. */
const POINTS: Record<"9:16" | "16:9" | "1:1" | "4:5", [number, number][]> = {
  "9:16": [[0.15, 0.6], [0.15, 0.645], [0.15, 0.69]],
  "16:9": [[0.07, 0.54], [0.07, 0.61], [0.07, 0.68]],
  "1:1": [[0.14, 0.71], [0.14, 0.765], [0.14, 0.82]],
  "4:5": [[0.14, 0.67], [0.14, 0.72], [0.14, 0.77]],
};

const BG = live("bg", "waves", { intensity: 0.7, speed: 0.7, vignette: 0.12, seed: 15 });
/** The glass card behind the three points (the signature's, §12). */
const PANE = at4({ "9:16": [0.5, 0.645, 0.84, 0.2], "16:9": [0.2, 0.61, 0.62, 0.3], "1:1": [0.5, 0.765, 0.84, 0.2], "4:5": [0.5, 0.72, 0.84, 0.2] });

function point(i: number): Layer[] {
  const t = 1.4 + i * 0.12;
  return [
    { id: `tick${i + 1}`, kind: "icon", icon: "check", color: "@accent", strokeWidth: 2.4, frame: each((s): Spec => [...POINTS[s][i], 0.04, 0.04]), draw: [[t, 0, "out"], [t + 0.4, 1]], opacity: showHide(t, 0.1, EXIT, 0.3) },
    words(`p${i + 1}`, `p${i + 1}`, each((s): Spec => [POINTS[s][i][0] + 0.035 / (s === "16:9" ? 16 / 9 : 1), POINTS[s][i][1], s === "16:9" ? 0.5 : 0.68, 0.045, 0]), {
      weight: 600, role: "detail", size: 0.036, minSize: 0.036, lines: 1, align: "left", animate: slideIn(t + 0.05, -0.3), exit: leave(EXIT),
    }),
  ];
}

export const laptopScreen: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "app-laptop",
  name: "Laptop Screen",
  category: "app",
  description: "A laptop opens toward you with your screen on it, three ticked points and a button.",
  tags: ["app", "laptop", "saas", "dashboard", "mockup", "web app", "desktop", "screenshot"],
  length: 6.4,
  hold: [2.4, EXIT],
  shapes: ALL_SHAPES,
  look: IOS_LIGHT,
  fields: [
    { id: "headline", kind: "text", label: "Headline", en: "Your business at a glance", bn: "আপনার ব্যবসা এক নজরে", limit: 36 },
    { id: "p1", kind: "text", label: "Point 1", en: "Live sales and stock", bn: "লাইভ বিক্রি ও স্টক", limit: 30 },
    { id: "p2", kind: "text", label: "Point 2", en: "Reports in one click", bn: "এক ক্লিকে রিপোর্ট", limit: 30 },
    { id: "p3", kind: "text", label: "Point 3", en: "Works on any device", bn: "যেকোনো ডিভাইসে চলে", limit: 30 },
    { id: "cta", kind: "text", label: "Button", en: "Try it free", bn: "ফ্রি ট্রাই করুন", limit: 20 },
    { id: "screen", kind: "media", label: "Screenshot", en: "" },
  ],
  hits: [{ t: 0.3, sfx: "whoosh" }, { t: 1.4, sfx: "click" }, { t: 2.0, sfx: "pop" }],
  layers: [
    BG,
    live("glass", "glass", { over: true, intensity: 0.8, seed: 12 }),
    glassCard("pane", PANE, BG, 1.3, EXIT),
    {
      id: "laptop", kind: "device", device: "laptop", slot: "screen", screen: "dashboard", frame: LAPTOP,
      // The signature (§12): at the end the camera zooms through the screen into the app.
      shadow: { color: "#000000/0.5", blur: 0.06, y: 0.03 }, opacity: showHide(0.3, 0.3, EXIT + 0.5, 0.1), scale: zoomThrough(pop(0.3, 0.88, 0.8), EXIT, 6),
      turnY: [[0.3, -24, "out"], [1.3, -4], [EXIT, 4, "inOut"]], dy: [[0.3, 0.06, "out"], [1.2, 0]],
    },
    ...[0, 1, 2].flatMap(point),
    words("headline", "headline", at4({
      "9:16": [0.5, 0.16, 0.76, 0.14], "16:9": [0.05, 0.32, 0.6, 0.24, 0], "1:1": [0.5, 0.11, 0.86, 0.1], "4:5": [0.5, 0.1, 0.86, 0.1],
    }), { font: "heading", size: 0.08, minSize: 0.07, lines: 2, textAt: { "16:9": { align: "left" }, "1:1": { size: 0.07, lines: 1 }, "4:5": { size: 0.07, lines: 1 } }, animate: rise(0.5), exit: sink(EXIT) }),
    button("cta", "cta", at4({
      "9:16": [0.5, 0.74, 0.44, 0.075], "16:9": [0.05, 0.8, 0.3, 0.09, 0], "1:1": [0.5, 0.905, 0.36, 0.065], "4:5": [0.5, 0.88, 0.38, 0.075],
    }), 2.0, EXIT),
    grain(),
  ],
}, ["laptop"]));
