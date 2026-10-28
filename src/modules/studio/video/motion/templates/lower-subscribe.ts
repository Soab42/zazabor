import type { Key } from "../ease";
import { FORMAT_VERSION, type PathLayer, type Template } from "../format";
import type { Look } from "../brand";
import type { Shape } from "../layout";
import { ALL_SHAPES, across, frame, pop } from "./build";
import { BELL, CURSOR, outFade, popWords, settle, steps, txt, vis } from "./common-b";

/**
 * Subscribe: a channel card for over video. A pointer glides in and clicks Subscribe, which turns
 * into Subscribed, then rings the bell. Every part sits at the same place on the card in every
 * shape, so the pointer's path is the same everywhere; only the card moves.
 */

const EXIT = 5.6;
/** The card's middle per shape (canvas fractions); it is W wide and H tall (short sides). */
const CARD: Record<Shape, [number, number]> = { "9:16": [0.47, 0.6], "16:9": [0.5, 0.82], "1:1": [0.5, 0.82], "4:5": [0.5, 0.83] };
const W = 0.82;
const H = 0.12;
const BUTTON = 0.15;
const BELL_AT = 0.355;
/** When the pointer clicks Subscribe and the bell. */
const CLICK = 2.45;
const RING = 3.6;

/** A box `x` short sides from the card's middle. */
const on = (x: number, w: number, h: number, ax = 0.5, ay = 0.5) => across((shape, d) => frame(CARD[shape][0] + x / d.w, CARD[shape][1], w, h, ax, ay));

/** The whole card leaves together. */
const gone: Key[] = [[EXIT, 1, "in"], [EXIT + 0.35, 0]];
/** A press: in, and back on a spring. */
const press = (t: number): Key[] => [[0, 0.6, "spring"], [0.55, 1], [t, 1, "out"], [t + 0.08, 0.88, "spring"], [t + 0.5, 1], [EXIT, 1, "in"], [EXIT + 0.35, 0.8]];

/** The bell: outlined, or filled once it's rung; it swings when rung. */
const bell = (id: string, fill: string, opacity: Key[]): PathLayer => ({
  id, kind: "path", d: BELL, frame: on(BELL_AT, 0.06, 0.06, 0.5, 0.2), stroke: "@text", strokeWidth: 0.005, fill,
  scale: pop(0.7, 0.3, 0.5, EXIT, 0.8), opacity,
  rotate: [[RING, 0, "out"], [RING + 0.1, 20], [RING + 0.22, -16], [RING + 0.34, 11], [RING + 0.46, -6], [RING + 0.6, 0]],
});

/** The card pops up. */
const CARD_IN = { scale: pop(0.1, 0.7, 0.5, EXIT, 0.9), opacity: vis(0.1, 0.25, EXIT, 0.35), dy: [[0.1, 0.05, "out"], [0.6, 0]] as Key[] };

/**
 * This template's own look (Clean (light card): white plate, red button.) shown until a Brand Kit is
 * applied (a kit replaces it; Reset brings it back).
 */
export const subscribeCardLook: Look = {
  colors: { primary: "#e63946", secondary: "#f1f1f1", accent: "#1d3557", background: "#ffffff", text: "#111111" },
  heading: { family: "Poppins", weight: 700 }, body: { family: "Poppins", weight: 400 }, bangla: { family: "Hind Siliguri", weight: 600 },
  radius: 0.6, motion: "snappy",
};

export const subscribeCard: Template = {
  version: FORMAT_VERSION,
  id: "lower-subscribe",
  name: "Subscribe",
  category: "lower",
  description: "A channel card over your video: a pointer clicks Subscribe, it turns to Subscribed, and the bell rings.",
  tags: ["subscribe", "follow", "youtube", "channel", "bell", "call to action", "overlay"],
  length: 6.1,
  hold: [RING + 0.6, EXIT],
  shapes: ALL_SHAPES,
  look: subscribeCardLook,
  overlay: true,
  fields: [
    { id: "logo", kind: "media", label: "Channel picture", en: "", bind: "logo" },
    { id: "channel", kind: "text", label: "Channel", en: "Lumen Studio", bn: "লুমেন স্টুডিও", limit: 24 },
    { id: "action", kind: "text", label: "Button", en: "Subscribe", bn: "সাবস্ক্রাইব", limit: 14 },
    { id: "done", kind: "text", label: "After the click", en: "Subscribed", bn: "সাবস্ক্রাইবড", limit: 14 },
  ],
  hits: [{ t: 0.1, sfx: "pop" }, { t: CLICK, sfx: "click" }, { t: CLICK + 0.08, sfx: "ding" }, { t: RING, sfx: "click" }, { t: RING + 0.05, sfx: "chime" }],
  layers: [
    {
      id: "card-shadow", kind: "rect", frame: on(0, W, H), radius: "theme", fill: "@bg", shadow: { color: "#000000/0.35", blur: 0.035, y: 0.01 }, ...CARD_IN,
    },
    {
      id: "card", kind: "group", frame: on(0, W, H), clip: "round", ...CARD_IN,
      children: [
        { id: "card-live", kind: "background", preset: "glass", frame: on(0, W, H), intensity: 0.8, vignette: 0, grain: 0.02, drift: 0.2, seed: 3 },
        { id: "card-tint", kind: "rect", frame: on(0, W, H), fill: "@bg/0.72" },
      ],
    },
    {
      id: "avatar-ring", kind: "ellipse", frame: on(-0.345, 0.092, 0.092), fill: { kind: "linear", angle: 135, stops: [[0, "@primary"], [1, "@accent"]] },
      scale: pop(0.3, 0.4, 0.5, EXIT, 0.8), opacity: vis(0.3, 0.2, EXIT, 0.3),
    },
    {
      id: "avatar", kind: "image", slot: "logo", ifFilled: "logo", fit: "cover", radius: "pill", frame: on(-0.345, 0.08, 0.08),
      scale: pop(0.35, 0.4, 0.5, EXIT, 0.8), opacity: vis(0.35, 0.2, EXIT, 0.3),
    },
    {
      id: "avatar-mark", kind: "icon", icon: "camera", ifEmpty: "logo", color: "@onPrimary", strokeWidth: 2, frame: on(-0.345, 0.045, 0.045),
      opacity: vis(0.4, 0.2, EXIT, 0.3),
    },
    txt("channel", "channel", on(-0.29, 0.29, 0.055, 0), {
      role: "detail",
      font: "heading", weight: 700, size: 0.038, minSize: 0.036, lines: 1, align: "left",
      animate: settle(), exit: outFade(EXIT, 0.3),
    }),
    {
      id: "button", kind: "rect", frame: on(BUTTON, 0.28, 0.075), radius: "pill", fill: "@primary",
      scale: press(CLICK), opacity: steps([[0, 0], [0.55, 1], [CLICK + 0.08, 0]]),
    },
    {
      id: "button-done", kind: "rect", frame: on(BUTTON, 0.28, 0.075), radius: "pill", fill: "@text/0.12",
      scale: press(CLICK), opacity: [[CLICK + 0.08, 1], ...gone],
    },
    txt("action", "action", on(BUTTON, 0.27, 0.05), {
      role: "cta",
      font: "heading", weight: 700, size: 0.044, minSize: 0.044, lines: 1, color: "@onPrimary", time: [0, CLICK + 0.08],
      scale: press(CLICK), animate: popWords(0.6),
    }),
    txt("done", "done", on(BUTTON, 0.27, 0.05), {
      role: "cta",
      font: "heading", weight: 600, size: 0.044, minSize: 0.044, lines: 1, color: "@text/0.75", time: [CLICK + 0.08, 99],
      scale: press(CLICK), animate: { ...popWords(CLICK + 0.08), stagger: 0 }, exit: outFade(EXIT, 0.3),
    }),
    bell("bell", "@text/0", vis(0.7, 0.2, EXIT, 0.3)),
    bell("bell-on", "@text", [[RING + 0.04, 0, "out"], [RING + 0.14, 1], ...gone]),
    {
      id: "pointer", kind: "path", d: CURSOR, view: [60, 80], frame: on(BUTTON, 0.05, 0.067, 0.1, 0.05), fill: "#ffffff", stroke: "#111111", strokeWidth: 0.003,
      shadow: { color: "#000000/0.4", blur: 0.012, y: 0.005 }, time: [0, CLICK + 0.6],
      dx: [[CLICK - 0.75, 0.36, "inOut"], [CLICK - 0.15, 0]], dy: [[CLICK - 0.75, 0.3, "inOut"], [CLICK - 0.15, 0]],
      scale: [[CLICK - 0.02, 1, "out"], [CLICK + 0.06, 0.82], [CLICK + 0.2, 1]], opacity: [[CLICK - 0.75, 0, "out"], [CLICK - 0.55, 1]],
    },
    {
      id: "pointer-bell", kind: "path", d: CURSOR, view: [60, 80], frame: on(BELL_AT, 0.05, 0.067, 0.1, 0.05), fill: "#ffffff", stroke: "#111111", strokeWidth: 0.003,
      shadow: { color: "#000000/0.4", blur: 0.012, y: 0.005 }, time: [CLICK + 0.6, 99],
      dx: [[CLICK + 0.6, BUTTON - BELL_AT, "inOut"], [RING - 0.15, 0], [RING + 0.35, 0, "in"], [RING + 0.85, 0.3]], dy: [[RING + 0.35, 0, "in"], [RING + 0.85, 0.25]],
      scale: [[RING - 0.02, 1, "out"], [RING + 0.06, 0.82], [RING + 0.2, 1]], opacity: [[RING + 0.55, 1, "in"], [RING + 0.85, 0]],
    },
  ],
};
