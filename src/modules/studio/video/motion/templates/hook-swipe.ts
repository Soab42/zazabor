import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Look } from "../brand";
import type { Shape } from "../layout";
import { ALL_SHAPES, across, frame, pop } from "./build";
import { CHEVRON, F, backdrop, outFade, outWords, popWords, pulse, punch, riseWords, txt, vis } from "./common-b";

/**
 * Link in Bio: a call to action that keeps moving while it holds. Chevrons climb in a wave over a
 * glowing button that's tapped every couple of seconds (a ripple runs out of it), with the link
 * written underneath.
 */

const EXIT = 5.4;
const LEN = 6.0;
/** The chevrons' middle per shape (canvas fractions). */
const ARROWS: Record<Shape, [number, number]> = { "9:16": [0.47, 0.455], "16:9": [0.72, 0.37], "1:1": [0.5, 0.47], "4:5": [0.5, 0.47] };
const BUTTON = F({ "9:16": [0.47, 0.595, 0.6, 0.12], "16:9": [0.72, 0.66, 0.62, 0.13], "1:1": [0.5, 0.68, 0.56, 0.11], "4:5": [0.5, 0.68, 0.56, 0.11] });
const ACTION = F({ "9:16": [0.47, 0.595, 0.5, 0.07], "16:9": [0.72, 0.66, 0.52, 0.075], "1:1": [0.5, 0.68, 0.46, 0.065], "4:5": [0.5, 0.68, 0.46, 0.065] });

function chevron(i: number): Layer {
  return {
    id: `chevron${i}`, kind: "path", d: CHEVRON, stroke: i === 0 ? "@accent" : "@text", strokeWidth: 0.012, cap: "round",
    frame: across((shape, d) => frame(ARROWS[shape][0], ARROWS[shape][1] + ((i - 1) * 0.075) / d.h, 0.22, 0.13)),
    // The wave climbs: the lowest chevron lights first.
    opacity: [[0.5 + (2 - i) * 0.1, 0, "out"], [0.8 + (2 - i) * 0.1, 0.3], ...pulse(1.0, EXIT, 0.9, 0.3, 1, (2 - i) * 0.15).slice(1), [EXIT + 0.3, 0]],
    dy: pulse(1.0, EXIT, 0.9, 0, -0.02, (2 - i) * 0.15),
  };
}

/** A tap on the button at `t`: the ripple. */
const ripple = (n: number, t: number): Layer => ({
  id: `ripple${n}`, kind: "rect", frame: BUTTON, radius: "pill", stroke: "@accent", strokeWidth: 0.006,
  scale: [[t, 1, "out"], [t + 0.8, 1.35]], opacity: [[t - 0.01, 0], [t, 0.9, "out"], [t + 0.8, 0]],
});

/**
 * This template's own look (Citrus (light): butter yellow, orange button.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const linkInBioLook: Look = {
  colors: { primary: "#ff4d00", secondary: "#ffd166", accent: "#00a676", background: "#fff7d6", text: "#1b1b1b" },
  heading: { family: "Anton", weight: 400 }, body: { family: "Inter", weight: 600 }, bangla: { family: "Baloo Da 2", weight: 700 },
  radius: 1, motion: "playful", grain: 0.02,
};

export const linkInBio: Template = {
  version: FORMAT_VERSION,
  id: "hook-swipe",
  name: "Link in Bio",
  category: "hook",
  description: "A call to action that keeps moving: climbing chevrons, a glowing button that's tapped, and your link.",
  tags: ["call to action", "link in bio", "swipe up", "shop now", "cta", "reel", "story"],
  length: LEN,
  hold: [1.6, EXIT],
  shapes: ALL_SHAPES,
  look: linkInBioLook,
  light: { x: 0.47, y: 0.7 },
  fields: [
    { id: "hook", kind: "text", label: "Headline", en: "Get yours today", bn: "আজই আপনারটি নিন", limit: 36 },
    { id: "note", kind: "text", label: "Above the arrows", en: "Swipe up", bn: "উপরে সোয়াইপ করুন", limit: 24 },
    { id: "action", kind: "text", label: "Button", en: "Link in bio", bn: "লিংক বায়োতে", limit: 20 },
    { id: "link", kind: "text", label: "Link", en: "lumen.co/shop", bn: "lumen.co/shop", limit: 40 },
  ],
  hits: [{ t: 0, sfx: "whoosh" }, { t: 0.9, sfx: "pop" }, { t: 2.2, sfx: "click" }, { t: 4.2, sfx: "click" }],
  layers: [
    ...backdrop("rays", "drift", { intensity: 0.65, overIntensity: 0.45, speed: 1.2 }),
    txt("hook", "hook", F({
      "9:16": [0.47, 0.22, 0.78, 0.2], "16:9": [0.06, 0.42, 0.78, 0.32, 0], "1:1": [0.5, 0.15, 0.86, 0.15], "4:5": [0.5, 0.155, 0.86, 0.17],
    }), {
      role: "headline",
      font: "heading", weight: 800, size: 0.1, minSize: 0.07, lines: 2, color: "@text", lineHeight: 1.02,
      textAt: { "16:9": { size: 0.105, align: "left" }, "1:1": { size: 0.085 }, "4:5": { size: 0.09 } },
      exit: outWords(EXIT), scale: punch(),
    }),
    txt("note", "note", F({
      "9:16": [0.47, 0.35, 0.7, 0.045], "16:9": [0.06, 0.62, 0.7, 0.055, 0], "1:1": [0.5, 0.285, 0.7, 0.045], "4:5": [0.5, 0.295, 0.7, 0.045],
    }), {
      role: "detail",
      size: 0.036, minSize: 0.036, lines: 1, color: "@text/0.8", upper: true, tracking: 0.2, weight: 600,
      textAt: { "16:9": { align: "left" } }, animate: riseWords(0.45, 0.05, 0.45), exit: outFade(EXIT, 0.25),
    }),
    chevron(0),
    chevron(1),
    chevron(2),
    ripple(1, 2.2),
    ripple(2, 4.2),
    {
      id: "button", kind: "rect", frame: BUTTON, radius: "pill", fill: "@primary", lightWrap: { color: "@accent", amount: 0.5 }, glow: { color: "@accent/0.7", blur: 0.04 },
      scale: [[0.85, 0.5, "spring"], [1.4, 1], [2.15, 1, "out"], [2.22, 0.92, "spring"], [2.7, 1], [4.15, 1, "out"], [4.22, 0.92, "spring"], [4.7, 1], [EXIT, 1, "in"], [EXIT + 0.35, 0.6]],
      opacity: vis(0.85, 0.2, EXIT, 0.35), sheen: { at: [[1.3, -0.2, "inOut"], [2.0, 1.2], [3.3, -0.2, "inOut"], [4.0, 1.2]], width: 0.25, angle: 20, strength: 0.35 },
    },
    txt("action", "action", ACTION, {
      role: "cta",
      font: "heading", weight: 800, size: 0.05, minSize: 0.044, lines: 1, color: "@onPrimary",
      scale: [[2.15, 1, "out"], [2.22, 0.92, "spring"], [2.7, 1], [4.15, 1, "out"], [4.22, 0.92, "spring"], [4.7, 1]],
      animate: popWords(1.0), exit: outFade(EXIT, 0.3),
    }),
    txt("link", "link", F({
      "9:16": [0.47, 0.67, 0.7, 0.045], "16:9": [0.72, 0.79, 0.62, 0.055], "1:1": [0.5, 0.8, 0.7, 0.045], "4:5": [0.5, 0.79, 0.7, 0.045],
    }), {
      role: "body",
      size: 0.044, minSize: 0.044, lines: 1, color: "@text/0.9", weight: 600, shadow: { color: "#000000/0.5", blur: 0.012, y: 0.003 },
      animate: riseWords(1.25, 0.04, 0.45), exit: outFade(EXIT, 0.25), scale: pop(1.25, 0.9, 0.5),
    }),
  ],
};
