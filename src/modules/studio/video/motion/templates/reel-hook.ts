import { FORMAT_VERSION, type Layer, type Template } from "../format";
import type { Shape } from "../layout";
import { ALL_SHAPES, FULL, across, frame, per, pop, showHide } from "./build";

/**
 * Hook + Follow: a reel's opening line punched in word by word over light rays, then a circle wipe
 * to a follow card (logo, name, handle, a follow button and social icons). Stretching the clip
 * lengthens the follow card.
 */

const WIPE = 2.9;
const EXIT = 7.4;
const SCENE_A: [number, number] = [0, WIPE + 0.65];
const SCENE_B: [number, number] = [WIPE, 8];

/** Heights (canvas fractions) of the follow card's rows per shape. */
const ROWS: Record<Shape, { logo: number; size: number; name: number; handle: number; follow: number; icons: number }> = {
  "9:16": { logo: 0.3, size: 0.3, name: 0.44, handle: 0.49, follow: 0.585, icons: 0.68 },
  "16:9": { logo: 0.27, size: 0.26, name: 0.5, handle: 0.585, follow: 0.72, icons: 0.86 },
  "1:1": { logo: 0.21, size: 0.24, name: 0.44, handle: 0.52, follow: 0.66, icons: 0.82 },
  "4:5": { logo: 0.23, size: 0.26, name: 0.44, handle: 0.505, follow: 0.62, icons: 0.76 },
};

const row = (key: Exclude<keyof (typeof ROWS)["9:16"], "size">, w: number, h: number) => across((shape) => frame(0.5, ROWS[shape][key], w, h));
const LOGO_CIRCLE = across((shape) => frame(0.5, ROWS[shape].logo, ROWS[shape].size, ROWS[shape].size));
const LOGO_PIC = across((shape) => frame(0.5, ROWS[shape].logo, ROWS[shape].size * 0.62, ROWS[shape].size * 0.62));
const FOLLOW = across((shape) => frame(0.5, ROWS[shape].follow, shape === "16:9" ? 0.5 : 0.6, shape === "16:9" ? 0.1 : 0.11));

const SOCIAL = ["heart", "comment", "share", "bell"];

function social(i: number): Layer {
  const t = 4.45 + i * 0.1;
  return {
    id: `social${i + 1}`, kind: "icon", icon: SOCIAL[i], color: "@text/0.85", strokeWidth: 1.7, time: SCENE_B,
    frame: across((shape, d) => frame(0.5 + ((i - 1.5) * 0.13) / d.w, ROWS[shape].icons, 0.075, 0.075)),
    draw: [[t, 0, "inOut"], [t + 0.6, 1]], scale: pop(t, 0.4, 0.5), opacity: showHide(t, 0.15, EXIT + 0.1 + i * 0.05, 0.3),
  };
}

export const hookFollow: Template = {
  version: FORMAT_VERSION,
  id: "reel-hook",
  name: "Hook + Follow",
  category: "hook",
  description: "A reel's opening line punched in word by word, then a circle wipe to a follow card.",
  tags: ["reel", "hook", "tiktok", "shorts", "end card", "follow", "subscribe"],
  length: 8,
  hold: [5.2, EXIT],
  shapes: ALL_SHAPES,
  fields: [
    { id: "hook", kind: "text", label: "Hook", en: "3 things nobody tells you", bn: "৩টি কথা কেউ বলে না", limit: 60, multiline: true },
    { id: "logo", kind: "media", label: "Logo", en: "", bind: "logo" },
    { id: "name", kind: "text", label: "Name", en: "Lumen & Co.", bn: "লুমেন অ্যান্ড কো.", limit: 32 },
    { id: "handle", kind: "text", label: "Handle", en: "@lumen.co", bn: "@lumen.co", limit: 32 },
    { id: "follow", kind: "text", label: "Button", en: "Follow for more", bn: "আরও দেখতে ফলো করুন", limit: 28 },
  ],
  hits: [{ t: 0.1, sfx: "impact" }, { t: WIPE, sfx: "whoosh" }, { t: 3.4, sfx: "pop" }, { t: 4.1, sfx: "click" }, { t: 4.75, sfx: "ding" }],
  layers: [
    // Scene A: the hook.
    { id: "bg-a", kind: "rect", frame: FULL, time: SCENE_A, fill: { kind: "linear", angle: 160, stops: [[0, "@primary"], [1, "@primaryDeep"]] } },
    { id: "rays", kind: "fx", fx: "rays", frame: FULL, time: SCENE_A, color: "@onPrimary", amount: 0.55, opacity: [[0, 0], [0.6, 1]] },
    {
      id: "progress", kind: "fx", fx: "progress", time: SCENE_A, color: "@accent", value: [[0, 0, "linear"], [WIPE, 1]],
      frame: per({
        "9:16": frame(0.5, 0.11, 0.76, 0.012), "16:9": frame(0.5, 0.08, 1.5, 0.012),
        "1:1": frame(0.5, 0.06, 0.86, 0.012), "4:5": frame(0.5, 0.06, 0.86, 0.012),
      }),
      opacity: showHide(0, 0.2, WIPE - 0.2, 0.2),
    },
    {
      id: "hook", kind: "text", field: "hook", font: "heading", size: 0.125, minSize: 0.07, lines: 3, color: "@onPrimary", lineHeight: 1.04, time: SCENE_A,
      frame: per({
        "9:16": frame(0.5, 0.42, 0.76, 0.5), "16:9": frame(0.5, 0.5, 1.45, 0.5),
        "1:1": frame(0.5, 0.5, 0.86, 0.6), "4:5": frame(0.5, 0.48, 0.86, 0.6),
      }),
      textAt: { "16:9": { size: 0.12, lines: 2 }, "1:1": { size: 0.11 } },
      shadow: { color: "#000000/0.3", blur: 0.03, y: 0.01 },
      animate: { unit: "word", t: 0.12, stagger: 0.09, duration: 0.42, from: { opacity: 0, scale: 0.4, dy: 0.25 }, ease: "spring" },
      exit: { unit: "word", t: WIPE - 0.25, stagger: 0.03, duration: 0.3, from: { opacity: 0, scale: 1.25, blur: 0.08 } },
      idle: { scale: 0.05 },
    },
    // Scene B: the follow card, wiped in from the middle.
    {
      id: "wipe", kind: "ellipse", frame: frame(0.5, 0.5, 2.15, 2.15), time: SCENE_B, fill: "@bg",
      scale: [[WIPE, 0, "inOut"], [WIPE + 0.6, 1]],
    },
    { id: "blobs", kind: "fx", fx: "blobs", frame: FULL, time: SCENE_B, amount: 0.6, opacity: [[3.2, 0], [3.9, 1]] },
    {
      id: "logo-circle", kind: "ellipse", frame: LOGO_CIRCLE, time: SCENE_B, fill: "@surface", stroke: "@primary", strokeWidth: 0.006,
      glow: { color: "@primary/0.5", blur: 0.04 },
      scale: pop(3.4, 0, 0.6, EXIT, 0.7), opacity: showHide(3.4, 0.15, EXIT, 0.35),
    },
    {
      id: "logo", kind: "image", slot: "logo", ifFilled: "logo", fit: "contain", frame: LOGO_PIC, time: SCENE_B,
      scale: pop(3.55, 0.3, 0.6, EXIT, 0.7), opacity: showHide(3.55, 0.2, EXIT, 0.35),
    },
    {
      id: "logo-mark", kind: "icon", icon: "sparkle", ifEmpty: "logo", color: "@primary", strokeWidth: 1.6, time: SCENE_B,
      frame: across((shape) => frame(0.5, ROWS[shape].logo, ROWS[shape].size * 0.5, ROWS[shape].size * 0.5)),
      draw: [[3.55, 0, "inOut"], [4.3, 1]], opacity: showHide(3.55, 0.15, EXIT, 0.35),
    },
    {
      id: "name", kind: "text", field: "name", font: "heading", size: 0.068, minSize: 0.045, lines: 1, color: "@text", time: SCENE_B,
      frame: row("name", 0.76, 0.09), textAt: { "16:9": { size: 0.06 } },
      animate: { unit: "char", t: 3.7, stagger: 0.025, duration: 0.42, from: { opacity: 0, dy: 0.6 } },
      exit: { unit: "line", t: EXIT, stagger: 0, duration: 0.3, from: { opacity: 0, dy: -0.4 } },
    },
    {
      id: "handle", kind: "text", field: "handle", font: "body", size: 0.04, minSize: 0.028, lines: 1, color: "@text/0.68", time: SCENE_B,
      frame: row("handle", 0.76, 0.06),
      animate: { unit: "line", t: 3.95, stagger: 0, duration: 0.45, from: { opacity: 0, dy: 0.5 } },
      exit: { unit: "line", t: EXIT, stagger: 0, duration: 0.3, from: { opacity: 0 } },
    },
    {
      id: "follow", kind: "group", frame: FOLLOW, time: SCENE_B,
      scale: pop(4.1, 0.5, 0.55, EXIT, 0.8), opacity: showHide(4.1, 0.2, EXIT, 0.3), idle: { scale: 0.05 },
      children: [
        { id: "follow-pill", kind: "rect", frame: FOLLOW, radius: "pill", fill: { kind: "linear", angle: 0, stops: [[0, "@primary"], [1, "@accent"]] },
          glow: { color: "@primary/0.55", blur: 0.045 }, sheen: { at: [[4.7, -0.2, "inOut"], [5.4, 1.2]], width: 0.25, strength: 0.5 } },
        { id: "follow-text", kind: "text", field: "follow", font: "body", weight: 800, size: 0.042, minSize: 0.026, lines: 1, color: "@onPrimary", frame: FOLLOW,
          textAt: { "16:9": { size: 0.038 } } },
      ],
    },
    social(0),
    social(1),
    social(2),
    social(3),
    { id: "grain", kind: "fx", fx: "grain", frame: FULL, amount: 0.05 },
  ],
};
