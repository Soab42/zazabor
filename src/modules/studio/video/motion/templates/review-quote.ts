import { FORMAT_VERSION, type Template } from "../format";
import { ALL_SHAPES, pop, showHide } from "./build";
import { at4, grain, hookAt0, leave, live, sink, soft, stars, words } from "./common-a";
import { OAT } from "./looks";

/**
 * Quote Card: five stars in sequence, the customer's words in big type with an accent marker
 * swiping across them once they've landed (the testimonial's signature), the full review line by
 * line at reading speed, and who said it.
 */

const EXIT = 6.6;
const CARD = at4({ "9:16": [0.5, 0.44, 0.86, 1.03], "16:9": [0.5, 0.5, 1.5, 0.82], "1:1": [0.5, 0.5, 0.9, 0.86], "4:5": [0.5, 0.48, 0.9, 1.0] });
const HIGHLIGHT = at4({ "9:16": [0.5, 0.3, 0.76, 0.16], "16:9": [0.5, 0.3, 1.3, 0.14], "1:1": [0.5, 0.28, 0.82, 0.14], "4:5": [0.5, 0.27, 0.82, 0.14] });
const AVATAR = at4({ "9:16": [0.29, 0.635, 0.12, 0.12], "16:9": [0.36, 0.76, 0.11, 0.11], "1:1": [0.25, 0.75, 0.11, 0.11], "4:5": [0.25, 0.7, 0.11, 0.11] });
/** A person, drawn in code, while there's no photo. */
const PERSON = "M50 20a15 15 0 1 1-0.01 0ZM20 84c4-19 17-28 30-28s26 9 30 28Z";

export const quoteCard: Template = hookAt0({
  version: FORMAT_VERSION,
  id: "review-quote",
  name: "Quote Card",
  category: "review",
  description: "Five stars, the customer's words with an accent marker swiping across them, the full review and who said it.",
  tags: ["testimonial", "review", "quote", "stars", "customer", "social proof"],
  length: 7.2,
  hold: [3.0, EXIT],
  shapes: ALL_SHAPES,
  look: OAT,
  fields: [
    { id: "highlight", kind: "text", label: "The words to stand out", en: "Best purchase this year", bn: "এ বছরের সেরা কেনাকাটা", limit: 34 },
    { id: "quote", kind: "text", label: "The review", en: "Ordered on Monday, it came on Tuesday, and the sound is unreal.", bn: "সোমবার অর্ডার করেছি, মঙ্গলবারেই পেয়েছি, আর সাউন্ড অসাধারণ।", limit: 110, multiline: true },
    { id: "name", kind: "text", label: "Name", en: "Sadia Akter", bn: "সাদিয়া আক্তার", limit: 28 },
    { id: "who", kind: "text", label: "About them", en: "Verified buyer, Dhaka", bn: "যাচাইকৃত ক্রেতা, ঢাকা", limit: 34 },
    { id: "photo", kind: "media", label: "Their photo", en: "" },
  ],
  hits: [{ t: 0.4, sfx: "pop" }, { t: 0.49, sfx: "pop" }, { t: 0.58, sfx: "pop" }, { t: 0.67, sfx: "pop" }, { t: 0.76, sfx: "pop" }, { t: 1.6, sfx: "swoosh" }],
  layers: [
    live("bg", "mesh", { speed: 0.5, intensity: 0.65, vignette: 0.12, seed: 71 }),
    live("motes", "drift", { over: true, speed: 0.5, intensity: 0.45, seed: 3 }),
    { id: "card", kind: "rect", frame: CARD, radius: "theme", fill: "@card/0.85", stroke: "@text/0.14", strokeWidth: 0.002, shadow: { color: "#000000/0.35", blur: 0.05, y: 0.02 }, opacity: showHide(0, 0, EXIT, 0.35) },
    {
      id: "marks", kind: "path", d: "M8 62C8 40 18 24 38 18L41 26C30 31 26 39 26 46H40V78H8ZM56 62C56 40 66 24 86 18L89 26C78 31 74 39 74 46H88V78H56Z",
      frame: at4({ "9:16": [0.2, 0.2, 0.14, 0.11], "16:9": [0.13, 0.2, 0.14, 0.11], "1:1": [0.16, 0.15, 0.13, 0.1], "4:5": [0.16, 0.14, 0.13, 0.1] }),
      fill: "@accent/0.9", opacity: showHide(0.2, 0.3, EXIT, 0.3), scale: pop(0.2, 0.5, 0.6, EXIT, 0.8),
    },
    ...stars("star", 5, (shape) => (({ "9:16": [0.6, 0.2], "16:9": [0.5, 0.15], "1:1": [0.55, 0.14], "4:5": [0.55, 0.14] }) as Record<string, [number, number]>)[shape], 0.045, 0.4, EXIT),
    // The signature (§12): a marker swipes across the words once they've landed, line after line.
    words("highlight", "highlight", HIGHLIGHT, {
      font: "heading", size: 0.075, lines: 2, lineHeight: 1.08, exit: sink(EXIT), opacity: [[EXIT, 1, "in"], [EXIT + 0.3, 0]],
      marker: { draw: [[1.6, 0, "out"], [2.3, 1]], color: "@accent/0.45" },
    }),
    words("quote", "quote", at4({
      "9:16": [0.5, 0.45, 0.76, 0.22], "16:9": [0.5, 0.52, 1.3, 0.2], "1:1": [0.5, 0.5, 0.8, 0.22], "4:5": [0.5, 0.47, 0.8, 0.24],
    }), { size: 0.044, lines: 4, lineHeight: 1.3, color: "@text/0.9", animate: { unit: "line", t: 1.0, stagger: 0.12, duration: 0.6, from: { opacity: 0, dy: 0.5 } }, exit: leave(EXIT) }),
    {
      id: "rule", kind: "rect", fill: "@text/0.14",
      frame: at4({ "9:16": [0.5, 0.567, 0.7, 0.002], "16:9": [0.5, 0.68, 1.2, 0.002], "1:1": [0.5, 0.665, 0.74, 0.002], "4:5": [0.5, 0.625, 0.74, 0.002] }),
      reveal: { from: "center", v: [[1.9, 0, "out"], [2.5, 1]] }, opacity: showHide(1.9, 0.1, EXIT, 0.3),
    },
    {
      id: "avatar", kind: "group", frame: AVATAR, clip: "ellipse", opacity: showHide(2.0, 0.3, EXIT, 0.3), scale: pop(2.0, 0.6, 0.5, EXIT, 0.8),
      children: [
        { id: "avatar-bg", kind: "ellipse", frame: AVATAR, fill: { kind: "linear", angle: 135, stops: [[0, "@primary"], [1, "@accent"]] } },
        { id: "avatar-person", kind: "path", d: PERSON, frame: AVATAR, fill: "@onPrimary/0.85", ifEmpty: "photo" },
        { id: "avatar-photo", kind: "image", slot: "photo", frame: AVATAR, fit: "cover" },
      ],
    },
    words("name", "name", at4({
      "9:16": [0.37, 0.62, 0.5, 0.05, 0], "16:9": [0.4, 0.75, 0.6, 0.05, 0], "1:1": [0.32, 0.735, 0.56, 0.05, 0], "4:5": [0.32, 0.69, 0.56, 0.05, 0],
    }), { weight: 700, size: 0.044, lines: 1, align: "left", animate: soft(2.1), exit: leave(EXIT) }),
    words("who", "who", at4({
      "9:16": [0.37, 0.658, 0.5, 0.045, 0], "16:9": [0.4, 0.8, 0.6, 0.045, 0], "1:1": [0.32, 0.78, 0.56, 0.045, 0], "4:5": [0.32, 0.73, 0.56, 0.045, 0],
    }), { role: "detail", size: 0.036, lines: 1, align: "left", color: "@text/0.75", animate: soft(2.25), exit: leave(EXIT) }),
    grain(),
  ],
}, ["highlight", "card"]);
