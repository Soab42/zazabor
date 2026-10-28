import { FORMAT_VERSION, type Layer, type Template } from "../format";
import { ALL_SHAPES, pop, showHide } from "./build";
import { at4, grain, hookAt0, leave, live, rise, sink, soft, strict916, words } from "./common-a";
import { INDIGO_CYAN } from "./looks";
import { glassCard, zoomThrough } from "./signature";

/**
 * Scroll Through: a big phone scrolls through your app's feed (a tall screenshot from top to
 * bottom, or the built-in feed), with a finger's taps rippling and hearts floating off.
 */

const EXIT = 5.8;
const PHONE = at4({ "9:16": [0.5, 0.45, 0.36, 0.74], "16:9": [0.5, 0.5, 0.36, 0.82], "1:1": [0.5, 0.53, 0.3, 0.64], "4:5": [0.5, 0.5, 0.32, 0.68] });
const TAP = at4({ "9:16": [0.56, 0.5, 0.09, 0.09], "16:9": [0.53, 0.55, 0.1, 0.1], "1:1": [0.55, 0.57, 0.08, 0.08], "4:5": [0.55, 0.54, 0.085, 0.085] });
const TAPS = [2.2, 3.9];
const BG = live("bg", "rays", { colors: ["@primary", "@secondary", "@secondary", "@deep", "@bg"], intensity: 0.5, speed: 0.8, vignette: 0.5 });
/** The glass card behind the phone (the signature's, §12). */
const PANE = at4({ "9:16": [0.5, 0.5, 0.7, 0.42], "16:9": [0.5, 0.52, 0.66, 0.5], "1:1": [0.5, 0.56, 0.6, 0.4], "4:5": [0.5, 0.53, 0.62, 0.42] });

function hearts(): Layer[] {
  return TAPS.flatMap((t, k) => [0, 1, 2].map((i): Layer => ({
    id: `heart${k + 1}-${i + 1}`, kind: "icon", icon: "heart", color: i === 1 ? "@accent" : "@primary", strokeWidth: 2.4, frame: TAP,
    time: [t, t + 1.4], opacity: [[t, 0, "out"], [t + 0.15, 1], [t + 0.9, 1, "in"], [t + 1.3, 0]], scale: [[t, 0.3, "spring"], [t + 0.5, 0.75 + i * 0.12]],
    dy: [[t, 0, "out"], [t + 1.3, -0.16 - i * 0.05]], dx: [[t, 0, "out"], [t + 1.3, (i - 1) * 0.07]],
  })));
}

export const scrollThrough: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "app-scroll",
  name: "Scroll Through",
  category: "app",
  description: "A big phone scrolls through your app's feed from top to bottom, with taps rippling and hearts floating off.",
  tags: ["app", "scroll", "feed", "ui", "phone", "mockup", "social", "shop"],
  length: 6.4,
  hold: [2.0, EXIT],
  shapes: ALL_SHAPES,
  look: INDIGO_CYAN,
  light: { x: 0.2, y: 0.0 },
  fields: [
    { id: "headline", kind: "text", label: "Headline", en: "Scroll. Tap. Shop.", bn: "স্ক্রল। ট্যাপ। কেনাকাটা।", limit: 30 },
    { id: "caption", kind: "text", label: "Caption", en: "Your whole shop in one feed", bn: "পুরো দোকান এক ফিডে", limit: 36 },
    { id: "screen", kind: "media", label: "Tall screenshot or screen recording", en: "" },
  ],
  hits: [{ t: 0.3, sfx: "whoosh" }, { t: TAPS[0], sfx: "pop" }, { t: TAPS[1], sfx: "pop" }],
  layers: [
    BG,
    live("bokeh", "bokeh", { over: true, intensity: 0.5, soft: 0.6, seed: 33 }),
    glassCard("pane", PANE, BG, 0.7, EXIT),
    {
      id: "phone", kind: "device", device: "phone", slot: "screen", screen: "app-feed", frame: PHONE,
      scroll: [[1.0, 0, "inOut"], [2.1, 0.32], [2.6, 0.32, "inOut"], [3.8, 0.66], [4.3, 0.66, "inOut"], [5.4, 1]],
      // The signature (§12): at the end the camera zooms through the screen into the app.
      shadow: { color: "#000000/0.5", blur: 0.06, y: 0.035, follow: true }, opacity: showHide(0.2, 0.3, EXIT + 0.5, 0.1),
      scale: zoomThrough(pop(0.2, 0.86, 0.8), EXIT), rotate: [[0.2, -8, "out"], [1.1, -3], [EXIT, 3, "inOut"]], lightWrap: { color: "@primary", amount: 0.3, width: 0.015 },
    },
    ...TAPS.map((t, k): Layer => ({
      id: `tap${k + 1}`, kind: "ellipse", frame: TAP, stroke: "#ffffff/0.9", strokeWidth: 0.004, fill: "#ffffff/0.18", time: [t - 0.1, t + 0.7],
      opacity: [[t - 0.1, 0, "out"], [t, 1], [t + 0.25, 1, "in"], [t + 0.6, 0]], scale: [[t - 0.1, 0.5, "out"], [t + 0.6, 1.5]],
    })),
    ...hearts(),
    words("headline", "headline", at4({
      "9:16": [0.5, 0.15, 0.76, 0.1], "16:9": [0.05, 0.42, 0.5, 0.24, 0], "1:1": [0.5, 0.1, 0.86, 0.08], "4:5": [0.5, 0.1, 0.86, 0.09],
    }), { font: "heading", size: 0.075, minSize: 0.07, lines: 2, textAt: { "16:9": { size: 0.08, align: "left" }, "1:1": { size: 0.07, lines: 1 }, "4:5": { lines: 1 } }, animate: rise(0.5), exit: sink(EXIT) }),
    words("caption", "caption", at4({
      "9:16": [0.5, 0.72, 0.76, 0.06], "16:9": [0.95, 0.58, 0.5, 0.12, 1], "1:1": [0.5, 0.92, 0.8, 0.045], "4:5": [0.5, 0.88, 0.8, 0.05],
    }), { weight: 500, role: "detail", size: 0.036, minSize: 0.036, lines: 2, color: "@text/0.85", textAt: { "16:9": { align: "right" }, "1:1": { lines: 1 } }, animate: soft(1.3), exit: leave(EXIT) }),
    grain(),
  ],
}, ["phone"]));
