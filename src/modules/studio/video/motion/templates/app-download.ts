import { FORMAT_VERSION, type Template } from "../format";
import { ALL_SHAPES, pop, showHide } from "./build";
import { at4, grain, hookAt0, leave, live, soft, stars, words } from "./common-a";
import { DEEP_SPACE } from "./looks";
import { glassCard, zoomThrough } from "./signature";

/**
 * Get the App: the app's icon and name, its rating, and a QR code drawn from your link (made in
 * the app, sharp at any size) in a card whose corners draw on, with a download button under it.
 */

const EXIT = 6.0;
const CARD = at4({ "9:16": [0.5, 0.465, 0.28, 0.28], "16:9": [0.72, 0.44, 0.56, 0.56], "1:1": [0.5, 0.56, 0.28, 0.28], "4:5": [0.5, 0.5, 0.3, 0.3] });
const QR = at4({ "9:16": [0.5, 0.465, 0.235, 0.235], "16:9": [0.72, 0.44, 0.47, 0.47], "1:1": [0.5, 0.56, 0.235, 0.235], "4:5": [0.5, 0.5, 0.25, 0.25] });
const TILE = at4({ "9:16": [0.5, 0.2, 0.17, 0.17], "16:9": [0.12, 0.22, 0.17, 0.17], "1:1": [0.5, 0.12, 0.14, 0.14], "4:5": [0.5, 0.11, 0.15, 0.15] });
const BADGE = at4({ "9:16": [0.5, 0.618, 0.5, 0.075], "16:9": [0.2, 0.74, 0.5, 0.09], "1:1": [0.5, 0.82, 0.5, 0.075], "4:5": [0.5, 0.74, 0.5, 0.075] });
const BADGE_ICON = at4({ "9:16": [0.33, 0.618, 0.04, 0.04], "16:9": [0.105, 0.74, 0.045, 0.045], "1:1": [0.33, 0.82, 0.04, 0.04], "4:5": [0.33, 0.74, 0.04, 0.04] });
const BADGE_TEXT = at4({ "9:16": [0.54, 0.618, 0.38, 0.06], "16:9": [0.222, 0.74, 0.38, 0.07], "1:1": [0.54, 0.82, 0.38, 0.06], "4:5": [0.54, 0.74, 0.38, 0.06] });
const BG = live("bg", "mesh", { colors: ["@primaryDeep", "@secondary", "@primary", "@deep", "@bg", "@deep"], intensity: 0.7, seed: 61 });
/** The glass card behind the name and rating (the signature's, §12). */
const PANE = at4({ "9:16": [0.5, 0.325, 0.76, 0.26], "16:9": [0.26, 0.5, 0.72, 0.34], "1:1": [0.5, 0.3, 0.8, 0.22], "4:5": [0.5, 0.265, 0.8, 0.24] });
/** Corner brackets around the code, in a 100 × 100 box. */
const CORNERS = "M0 22V0H22M78 0H100V22M100 78V100H78M22 100H0V78";

export const getTheApp: Template = hookAt0({
  version: FORMAT_VERSION,
  id: "app-download",
  name: "Get the App",
  category: "app",
  description: "Your app's icon, name and rating, and a QR code drawn from your link, with a download button.",
  tags: ["app", "download", "qr code", "install", "store", "link", "scan"],
  length: 6.6,
  hold: [2.4, EXIT],
  shapes: ALL_SHAPES,
  look: DEEP_SPACE,
  fields: [
    { id: "name", kind: "text", label: "App name", en: "Zazabor Shop", bn: "জাজাবর শপ", limit: 22 },
    { id: "rating", kind: "text", label: "Rating", en: "4.8 · 12k reviews", bn: "৪.৮ · ১২ হাজার রিভিউ", limit: 28 },
    { id: "link", kind: "text", label: "Link (the QR code opens it)", en: "https://zazabor.app/get", bn: "https://zazabor.app/get", limit: 120 },
    { id: "scan", kind: "text", label: "Under the code", en: "Scan to install", bn: "স্ক্যান করে ইনস্টল করুন", limit: 26 },
    { id: "cta", kind: "text", label: "Button", en: "Download free", bn: "ফ্রি ডাউনলোড", limit: 18 },
  ],
  hits: [{ t: 0.3, sfx: "pop" }, { t: 1.2, sfx: "click" }, { t: 2.0, sfx: "ding" }],
  layers: [
    BG,
    live("glass", "glass", { over: true, intensity: 0.22, speed: 1.6, seed: 5 }),
    glassCard("pane", PANE, BG, 0.5, EXIT),
    {
      id: "tile", kind: "rect", frame: TILE, radius: 0.04, fill: { kind: "linear", angle: 135, stops: [[0, "@primary"], [1, "@accent"]] },
      // The signature (§12): at the end the camera zooms through the app's icon into the app.
      glow: { color: "@primary/0.5", blur: 0.04 }, scale: zoomThrough([[0, 0.92, "spring"], [0.6, 1]], EXIT, 14), idle: { scale: 0.03 },
      sheen: { at: [[0.6, -0.2, "inOut"], [1.4, 1.2]], width: 0.3, strength: 0.5 },
    },
    { id: "tile-icon", kind: "icon", icon: "sparkle", color: "@onPrimary", strokeWidth: 1.8, frame: TILE, scale: zoomThrough([[0, 0.55]], EXIT, 14, 0.55), draw: [[0.2, 0, "inOut"], [1.0, 1]] },
    words("name", "name", at4({
      "9:16": [0.5, 0.29, 0.76, 0.09], "16:9": [0.06, 0.42, 0.6, 0.12, 0], "1:1": [0.5, 0.25, 0.8, 0.08], "4:5": [0.5, 0.22, 0.8, 0.08],
    }), { font: "heading", size: 0.075, lines: 1, textAt: { "16:9": { size: 0.085, align: "left" } }, exit: leave(EXIT) }),
    ...stars("star", 5, (shape) => (({ "9:16": [0.5, 0.326], "16:9": [0.06 + 0.12 / (16 / 9), 0.52], "1:1": [0.5, 0.31], "4:5": [0.5, 0.275] }) as Record<string, [number, number]>)[shape], 0.034, 0.6, EXIT),
    words("rating", "rating", at4({
      "9:16": [0.5, 0.352, 0.7, 0.045], "16:9": [0.06, 0.59, 0.5, 0.05, 0], "1:1": [0.5, 0.35, 0.7, 0.04], "4:5": [0.5, 0.31, 0.7, 0.04],
    }), { role: "detail", weight: 600, size: 0.036, lines: 1, textAt: { "16:9": { align: "left" } }, animate: soft(0.9), exit: leave(EXIT) }),
    {
      id: "card", kind: "rect", frame: CARD, radius: 0.03, fill: "#ffffff", shadow: { color: "#000000/0.45", blur: 0.05, y: 0.02 },
      opacity: showHide(0.9, 0.25, EXIT, 0.3), scale: pop(0.9, 0.8, 0.6, EXIT, 0.9),
    },
    { id: "qr", kind: "qr", field: "link", frame: QR, color: "#0b0b10", draw: [[1.1, 0, "inOut"], [1.9, 1]], opacity: showHide(1.0, 0.2, EXIT, 0.3), scale: pop(0.9, 0.8, 0.6, EXIT, 0.9) },
    {
      id: "corners", kind: "path", d: CORNERS, frame: at4({ "9:16": [0.5, 0.465, 0.33, 0.33], "16:9": [0.72, 0.44, 0.64, 0.64], "1:1": [0.5, 0.56, 0.33, 0.33], "4:5": [0.5, 0.5, 0.35, 0.35] }),
      stroke: "@accent", strokeWidth: 0.006, glow: { color: "@accent/0.6", blur: 0.02 }, draw: [[1.2, 0, "inOut"], [1.8, 1]], opacity: showHide(1.2, 0.1, EXIT, 0.3),
      scale: [[1.2, 1.12, "out"], [1.8, 1]], idle: { scale: 0.03 },
    },
    words("scan", "scan", at4({
      "9:16": [0.5, 0.58, 0.6, 0.04], "16:9": [0.72, 0.8, 0.6, 0.05], "1:1": [0.5, 0.74, 0.6, 0.04], "4:5": [0.5, 0.66, 0.6, 0.04],
    }), { role: "detail", weight: 700, size: 0.04, lines: 1, animate: soft(1.7), exit: leave(EXIT) }),
    {
      id: "badge", kind: "group", frame: BADGE, opacity: showHide(2.0, 0.25, EXIT, 0.3), scale: pop(2.0, 0.6, 0.55, EXIT, 0.85),
      children: [
        { id: "badge-bg", kind: "rect", frame: BADGE, radius: "pill", fill: "#0b0b10", stroke: "#ffffff/0.35", strokeWidth: 0.0025, shadow: { color: "#000000/0.4", blur: 0.03, y: 0.012 } },
        { id: "badge-icon", kind: "icon", icon: "arrow", color: "#ffffff", strokeWidth: 2.2, frame: BADGE_ICON, rotate: 90 },
        words("badge-text", "cta", BADGE_TEXT, { role: "cta", weight: 700, size: 0.044, lines: 1, align: "left", color: "#ffffff" }),
      ],
    },
    words("link", "link", at4({
      "9:16": [0.5, 0.69, 0.76, 0.04], "16:9": [0.72, 0.87, 0.8, 0.045], "1:1": [0.5, 0.9, 0.8, 0.04], "4:5": [0.5, 0.82, 0.8, 0.04],
    }), { role: "detail", size: 0.036, lines: 1, animate: soft(2.2), exit: leave(EXIT) }),
    grain(),
  ],
}, ["name"]);
