import type { Key } from "../ease";
import { FORMAT_VERSION, type Template } from "../format";
import { ALL_SHAPES, pop, showHide } from "./build";
import { at4, grain, hookAt0, leave, live, rise, sink, soft, standIn, strict916, words } from "./common-a";
import { MINT } from "./looks";
import { handoff } from "./signature";

/**
 * Before / After: two pictures in one frame with a handle that sweeps across, back and forth, so
 * the difference shows; labels on each side.
 */

const EXIT = 5.8;

/** Where the handle is (0 left … 1 right); the "after" side shows right of it. */
const HANDLE: Key[] = [[0.9, 0.98, "out"], [1.8, 0.5], [2.6, 0.5, "inOut"], [3.5, 0.2], [4.3, 0.2, "inOut"], [5.2, 0.72]];
const AFTER: Key[] = HANDLE.map(([t, v, e]) => (e ? [t, 1 - v, e] : [t, 1 - v]));

const AREA = at4({ "9:16": [0.5, 0.522, 1.0, 1.19], "16:9": [0.5, 0.52, 1.3, 0.72], "1:1": [0.5, 0.5, 0.8, 0.66], "4:5": [0.5, 0.49, 0.8, 0.8] });
const ART = at4({ "9:16": [0.5, 0.522, 0.8, 0.8], "16:9": [0.5, 0.52, 0.6, 0.6], "1:1": [0.5, 0.5, 0.56, 0.56], "4:5": [0.5, 0.49, 0.62, 0.62] });
const pill = (side: 0 | 1) => at4({
  "9:16": [side ? 0.75 : 0.25, 0.222, 0.2, 0.055], "16:9": [side ? 0.8 : 0.2, 0.22, 0.2, 0.06],
  "1:1": [side ? 0.78 : 0.22, 0.22, 0.18, 0.05], "4:5": [side ? 0.78 : 0.22, 0.22, 0.18, 0.05],
});

export const beforeAfter: Template = strict916(hookAt0({
  version: FORMAT_VERSION,
  id: "feature-compare",
  name: "Before / After",
  category: "feature",
  description: "Two pictures in one frame and a handle that sweeps across, so the difference shows.",
  tags: ["feature", "before after", "compare", "slider", "results", "transformation"],
  length: 6.4,
  hold: [2.0, EXIT],
  shapes: ALL_SHAPES,
  look: MINT,
  fields: [
    { id: "headline", kind: "text", label: "Headline", en: "See the difference", bn: "পার্থক্যটা দেখুন", limit: 28 },
    { id: "before", kind: "text", label: "Before label", en: "Before", bn: "আগে", limit: 10 },
    { id: "after", kind: "text", label: "After label", en: "After", bn: "পরে", limit: 10 },
    { id: "caption", kind: "text", label: "Caption", en: "After 2 weeks of daily use", bn: "২ সপ্তাহ নিয়মিত ব্যবহারের পর", limit: 40 },
    { id: "pic-before", kind: "media", label: "Before picture", en: "" },
    { id: "pic-after", kind: "media", label: "After picture", en: "" },
  ],
  hits: [{ t: 0.3, sfx: "whoosh" }, { t: 0.9, sfx: "swoosh" }, { t: 2.6, sfx: "swoosh" }, { t: 4.3, sfx: "swoosh" }],
  layers: [
    live("bg", "glass", { intensity: 0.7, vignette: 0.15, seed: 31 }),
    live("bokeh", "bokeh", { over: true, intensity: 0.45, soft: 0.7, seed: 3 }),
    {
      id: "frame", kind: "group", frame: AREA, clip: "round", opacity: showHide(0.3, 0.3, EXIT, 0.3), scale: pop(0.3, 0.9, 0.6, EXIT, 0.95),
      shadow: { color: "#000000/0.4", blur: 0.05, y: 0.02 },
      children: [
        { id: "before-back", kind: "rect", frame: AREA, fill: { kind: "linear", angle: 90, stops: [[0, "#5b5f68"], [1, "#2a2c31"]] } },
        standIn("before-art", "sneaker", "pic-before", ART, { tint: "#8a8f98", tint2: "#6b6f78" }),
        { id: "before-pic", kind: "image", slot: "pic-before", frame: AREA, fit: "cover", placeholder: "Add the before picture" },
        {
          id: "after-side", kind: "group", frame: AREA, reveal: { from: "right", v: AFTER },
          children: [
            { id: "after-back", kind: "rect", frame: AREA, fill: { kind: "radial", stops: [[0, "@primary"], [1, "@primaryDeep"]] } },
            standIn("after-art", "sneaker", "pic-after", ART, { tint: "@bg", tint2: "@accent", glow: { color: "@accent/0.5", blur: 0.04 } }),
            { id: "after-pic", kind: "image", slot: "pic-after", frame: AREA, fit: "cover", placeholder: "Add the after picture" },
          ],
        },
        { id: "handle", kind: "fx", fx: "divider", frame: AREA, value: HANDLE, color: "#ffffff", color2: "@primary" },
      ],
    },
    ...([0, 1] as const).flatMap((side) => [{
      id: side ? "after-pill" : "before-pill", kind: "group" as const, frame: pill(side), opacity: showHide(1.4 + side * 0.12, 0.25, EXIT, 0.3), scale: pop(1.4 + side * 0.12, 0.6, 0.5, EXIT, 0.8),
      children: [
        { id: side ? "after-pill-bg" : "before-pill-bg", kind: "rect" as const, frame: pill(side), radius: "pill" as const, fill: side ? "@accent" : "#000000/0.55" },
        words(side ? "after-text" : "before-text", side ? "after" : "before", pill(side), { weight: 700, role: "detail", size: 0.036, minSize: 0.036, lines: 1, upper: true, tracking: 0.12, color: side ? "@onAccent" : "#ffffff" }),
      ],
    }]),
    words("headline", "headline", at4({
      "9:16": [0.5, 0.14, 0.76, 0.08], "16:9": [0.5, 0.09, 1.2, 0.07], "1:1": [0.5, 0.09, 0.86, 0.07], "4:5": [0.5, 0.09, 0.86, 0.08],
    }), { font: "heading", size: 0.07, minSize: 0.07, lines: 1, textAt: { "16:9": { size: 0.07 }, "1:1": { size: 0.07 } }, animate: rise(0.4), exit: sink(EXIT) }),
    words("caption", "caption", at4({
      "9:16": [0.5, 0.877, 0.76, 0.05], "16:9": [0.5, 0.925, 1.0, 0.045], "1:1": [0.5, 0.9, 0.8, 0.05], "4:5": [0.5, 0.9, 0.8, 0.055],
    }), { weight: 500, role: "detail", size: 0.036, minSize: 0.036, lines: 1, color: "@text/0.85", animate: soft(1.8), exit: leave(EXIT) }),
    // The signature (§12): the frame just read grows into the next scene's.
    handoff("handoff", AREA, EXIT, 2.6),
    grain(),
  ],
}, ["headline"]));
