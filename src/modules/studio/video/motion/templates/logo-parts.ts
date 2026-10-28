import type { Field, Layer } from "../format";
import type { Responsive } from "../layout";
import { F, outFade, txt } from "./common-b";

/**
 * What the five extra logo reveals share: the logo, brand and tagline fields, where the logo sits
 * and the brand name and tagline under it (the same places as Line Logo, so they can swap).
 */

export const LOGO_FIELDS: Field[] = [
  { id: "logo", kind: "media", label: "Logo", en: "", bind: "logo" },
  { id: "brand", kind: "text", label: "Brand name", en: "Lumen & Co.", bn: "লুমেন অ্যান্ড কো.", limit: 32 },
  { id: "tagline", kind: "text", label: "Tagline", en: "Made to move", bn: "চলার জন্য তৈরি", limit: 48 },
];

/** The logo's box, scaled by `k`. */
export const logoBox = (k = 1): Responsive => F({
  "9:16": [0.5, 0.4, 0.46 * k, 0.46 * k],
  "16:9": [0.5, 0.38, 0.4 * k, 0.4 * k],
  "1:1": [0.5, 0.38, 0.4 * k, 0.4 * k],
  "4:5": [0.5, 0.39, 0.44 * k, 0.44 * k],
});

export const BRAND = F({
  "9:16": [0.5, 0.6, 0.76, 0.12],
  "16:9": [0.5, 0.71, 1.3, 0.12],
  "1:1": [0.5, 0.7, 0.86, 0.1],
  "4:5": [0.5, 0.68, 0.86, 0.11],
});

export const TAGLINE = F({
  "9:16": [0.5, 0.655, 0.76, 0.06],
  "16:9": [0.5, 0.8, 1.2, 0.06],
  "1:1": [0.5, 0.79, 0.84, 0.06],
  "4:5": [0.5, 0.755, 0.84, 0.06],
});

/** The tagline in small capitals, words coming up at `t`, fading at `exit`. */
export function taglineLayer(t: number, exit: number, color = "@text/0.66"): Layer {
  return txt("tagline", "tagline", TAGLINE, {
      role: "detail",
    size: 0.036, minSize: 0.036, lines: 1, color, upper: true, tracking: 0.22, textAt: { "1:1": { size: 0.036 } },
    animate: { unit: "word", t, stagger: 0.07, duration: 0.5, from: { opacity: 0, dy: 0.5 } },
    exit: outFade(exit),
  });
}
