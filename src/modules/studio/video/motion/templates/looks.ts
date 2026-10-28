import type { FontRef, Grade, Look } from "../brand";

/**
 * The designed looks of the launch, sale, feature, app and testimonial templates (and the first
 * six), by the rule book's playbooks (motion-rulebook.md §12, colour §9): launches cinematic dark
 * or bright, sales hot reds, oranges and yellows or electric with heavy display type, features
 * clean and bright, apps cool blues and cyan in Space Grotesk or Inter, testimonials warm and
 * light. Dark looks lift their blacks a little and keep chroma low but for one accent; light ones
 * carry their own background paints (brand.ts `backdrop`) on a mixing preset.
 */

const font = (family: string, weight: number): FontRef => ({ family, weight });

function look(
  colors: [primary: string, secondary: string, accent: string, background: string, text: string],
  heading: FontRef, body: FontRef, bangla: FontRef,
  more: { radius?: number; motion?: Look["motion"]; backdrop?: string[]; grade?: Grade; grain?: number } = {},
): Look {
  const [primary, secondary, accent, background, text] = colors;
  return { colors: { primary, secondary, accent, background, text }, heading, body, bangla, ...more };
}

// ---- launch

/** Product Hero: an ember glow in a warm black room. */
export const EMBER_NOIR = look(["#ff5a36", "#2a1a24", "#ffd2b5", "#0e0c10", "#fbf4ef"], font("Sora", 800), font("Inter", 500), font("Anek Bangla", 700), {
  radius: 0.5, motion: "smooth", backdrop: ["#4a170f", "#2a1723", "#a8452a", "#0b090c", "#18110f", "#3a120c"],
  grade: { warmth: 0.15, fade: 0.14, saturation: 0.92 }, grain: 0.03,
});

/** Introducing: daylight, violet type and a coral word. */
export const DAYBREAK = look(["#4b2fd6", "#e4defa", "#c2410c", "#f6f3ee", "#15122a"], font("Plus Jakarta Sans", 800), font("Inter", 500), font("Anek Bangla", 700), {
  radius: 0.5, motion: "smooth", backdrop: ["#e6e0ff", "#ffe1d2", "#d4cbff", "#f7f4ef", "#ffffff", "#efe8ff"],
  grade: { warmth: 0.06 }, grain: 0.02,
});

/** Turntable: graphite and acid lime, a streetwear drop. */
export const GRAPHITE_LIME = look(["#b8f53a", "#24272c", "#d9ff8a", "#0f1012", "#f4f6f0"], font("Unbounded", 700), font("Manrope", 600), font("Anek Bangla", 700), {
  radius: 0.35, motion: "snappy", backdrop: ["#6e9e22", "#2f4a0b", "#2b2f36", "#0b0c0e", "#17191d", "#ffffff"],
  grade: { fade: 0.12, saturation: 0.9, warmth: -0.05 }, grain: 0.03,
});

/** Spec Call-outs: porcelain and cobalt, an engineering sheet. */
export const PORCELAIN = look(["#1d4ed8", "#d8dee6", "#c2410c", "#eef1f4", "#0f172a"], font("Manrope", 800), font("Inter", 500), font("Hind Siliguri", 600), {
  radius: 0.4, motion: "smooth", backdrop: ["#d9e2ee", "#f5e3d6", "#ffffff", "#edf1f5", "#ffffff", "#ffffff"],
  grade: { warmth: -0.05 }, grain: 0.015,
});

/** Dark Luxury: black, warm gold and a serif. */
export const NOIR_GOLD = look(["#d4af37", "#1c1a16", "#e8cf8a", "#0a0907", "#f7f3ea"], font("Playfair Display", 500), font("Manrope", 500), font("Tiro Bangla", 400), {
  radius: 0.12, motion: "smooth", grade: { warmth: 0.3, fade: 0.18, saturation: 0.85 }, grain: 0.035,
});

/** Colourways: three loud colours over midnight. */
export const TRICOLOUR = look(["#e8432f", "#2f3e9e", "#14a39a", "#10131c", "#ffffff"], font("Montserrat", 800), font("DM Sans", 600), font("Baloo Da 2", 700), {
  radius: 0.45, motion: "playful", grade: { fade: 0.1 }, grain: 0.025,
});

// ---- sale

/** Price Drop: hot red with orange and yellow. */
export const RED_ALERT = look(["#e10600", "#ff7a00", "#ffd60a", "#5c0000", "#ffffff"], font("Anton", 400), font("Poppins", 700), font("Hind Siliguri", 700), {
  radius: 0.3, motion: "playful", grade: { warmth: 0.1 }, grain: 0.02,
});

/** Flash Countdown: electric violet and acid yellow. */
export const VOLT = look(["#6d28ff", "#1b1446", "#d7ff1f", "#07051a", "#ffffff"], font("Bebas Neue", 400), font("Montserrat", 700), font("Anek Bangla", 800), {
  radius: 0.3, motion: "snappy", grade: { fade: 0.08 }, grain: 0.02,
});

/** Percent Burst: a yellow field, red and orange. */
export const YELLOW_POP = look(["#ff4d00", "#fff1a8", "#d90429", "#ffd60a", "#1a1300"], font("Archivo Black", 400), font("Poppins", 600), font("Hind Siliguri", 700), {
  radius: 0.4, motion: "playful", backdrop: ["#ffb703", "#ffc93c", "#ff8c1a", "#ffd60a", "#fff3b0", "#ff9f1c"], grain: 0.02,
});

/** Limited Stock: blaze orange in the dark. */
export const BLAZE = look(["#ff5a00", "#3d1806", "#ffc93c", "#160a04", "#fff6ea"], font("Oswald", 700), font("Inter", 600), font("Anek Bangla", 700), {
  radius: 0.25, motion: "snappy", grade: { warmth: 0.12, fade: 0.1 }, grain: 0.025,
});

/** Buy One Get One: bubblegum pink and violet. */
export const BUBBLEGUM = look(["#d1106e", "#ffc6df", "#5b21b6", "#ffe8f2", "#2a0a1c"], font("Unbounded", 800), font("DM Sans", 600), font("Baloo Da 2", 700), {
  radius: 0.6, motion: "playful", backdrop: ["#ffd1e6", "#e9d8ff", "#ffffff", "#ffe9f3", "#ffffff", "#ffffff"], grain: 0.015,
});

/** Coupon Code: tangerine on cream. */
export const TANGERINE = look(["#d23b10", "#ffd6b0", "#7a2e0e", "#fff3e6", "#2b1406"], font("Righteous", 400), font("Poppins", 600), font("Baloo Da 2", 700), {
  radius: 0.4, motion: "playful", backdrop: ["#ffc59c", "#ffe0c7", "#ff9a62", "#fff4e8", "#ffffff", "#ffd3b0"], grain: 0.02,
});

// ---- feature

/** Three Features: clear sky blue on white. */
export const CLEAR_SKY = look(["#2563eb", "#dce6f7", "#0e9f6e", "#f3f6fb", "#0f172a"], font("Outfit", 700), font("Inter", 500), font("Hind Siliguri", 600), {
  radius: 0.5, motion: "smooth", backdrop: ["#cfe0ff", "#e3ecff", "#a8c5ff", "#f4f7fc", "#ffffff", "#dbe6ff"], grain: 0.015,
});

/** Before / After: fresh mint and a coral label. */
export const MINT = look(["#0f8f6b", "#cfeee1", "#e8552e", "#effaf5", "#0b2a20"], font("Sora", 700), font("Inter", 500), font("Anek Bangla", 600), {
  radius: 0.5, motion: "smooth", backdrop: ["#cfeee0", "#fde3d6", "#ffffff", "#eefaf5", "#ffffff", "#ffffff"], grain: 0.015,
});

/** Detail Zoom: warm paper, ink and one rose accent. */
export const PAPER = look(["#1f2937", "#e6e1d6", "#be123c", "#f7f4ee", "#111827"], font("Montserrat", 800), font("Inter", 500), font("Hind Siliguri", 600), {
  radius: 0.4, motion: "smooth", backdrop: ["#ece6da", "#f5ddd8", "#ffffff", "#f7f4ee", "#ffffff", "#efe9df"], grade: { warmth: 0.06 }, grain: 0.02,
});

/** Three Steps: lilac and teal. */
export const LILAC = look(["#6d28d9", "#e2dcff", "#0e7490", "#f6f4ff", "#1e1b3a"], font("Poppins", 700), font("Inter", 500), font("Hind Siliguri", 600), {
  radius: 0.5, motion: "smooth", backdrop: ["#e6defe", "#d8f1f7", "#cfc2ff", "#f6f4ff", "#ffffff", "#ece6ff"], grain: 0.015,
});

/** Stat Counters: bright cobalt and mint numbers. */
export const COBALT = look(["#4f7dff", "#1534b8", "#7cf7d4", "#0d2fbf", "#ffffff"], font("Plus Jakarta Sans", 800), font("Inter", 500), font("Anek Bangla", 700), {
  radius: 0.45, motion: "smooth", grade: { fade: 0.06 }, grain: 0.02,
});

// ---- app

/** Phone Showcase: neon blue and cyan at night. */
export const NEON_BLUE = look(["#2f7bff", "#0c1a3a", "#2ee6ff", "#050a18", "#eef5ff"], font("Space Grotesk", 700), font("Inter", 500), font("Hind Siliguri", 600), {
  radius: 0.45, motion: "smooth", grade: { warmth: -0.12, fade: 0.1 }, grain: 0.02,
});

/** Laptop Screen: light, iOS-like blue. */
export const IOS_LIGHT = look(["#0a6cff", "#dde6f3", "#0b7f93", "#f2f5f9", "#0b1220"], font("Inter", 800), font("Inter", 500), font("Hind Siliguri", 600), {
  radius: 0.45, motion: "smooth", backdrop: ["#cfe3ff", "#dff5f7", "#a9cdfc", "#f2f6fb", "#ffffff", "#d9e8fb"], grain: 0.012,
});

/** Scroll Through: indigo and cyan. */
export const INDIGO_CYAN = look(["#5a5ce8", "#1a1b48", "#22d3ee", "#0a0a24", "#f1f2ff"], font("Space Grotesk", 700), font("Inter", 500), font("Anek Bangla", 600), {
  radius: 0.45, motion: "smooth", grade: { warmth: -0.1, fade: 0.1 }, grain: 0.02,
});

/** Notifications: glacier blue, light. */
export const GLACIER = look(["#1d64f2", "#d6e4f5", "#0e7490", "#eef4fb", "#0b1526"], font("Space Grotesk", 700), font("Inter", 500), font("Hind Siliguri", 600), {
  radius: 0.45, motion: "smooth", backdrop: ["#d6e5fb", "#e3f3f9", "#bcd4fb", "#eef4fb", "#ffffff", "#dde9f8"], grain: 0.012,
});

/** Get the App: deep space blue and mint cyan. */
export const DEEP_SPACE = look(["#3b82f6", "#121d42", "#2dd4bf", "#060b1d", "#f1f5ff"], font("Inter", 800), font("Inter", 500), font("Hind Siliguri", 600), {
  radius: 0.45, motion: "smooth", grade: { warmth: -0.1, fade: 0.1 }, grain: 0.02,
});

// ---- testimonials

/** Quote Card: oat and terracotta, an amber marker. */
export const OAT = look(["#b4532a", "#e9dcc8", "#dc8f1f", "#f6efe4", "#2a2118"], font("Outfit", 700), font("DM Sans", 500), font("Baloo Da 2", 600), {
  radius: 0.6, motion: "smooth", backdrop: ["#efe2cf", "#f6dccd", "#ffffff", "#f7f0e6", "#ffffff", "#efe6d8"], grade: { warmth: 0.08 }, grain: 0.015,
});

/** Review Carousel: linen and coral. */
export const LINEN = look(["#c8462e", "#eee5d8", "#d4891a", "#faf6f1", "#2b2420"], font("Poppins", 600), font("DM Sans", 500), font("Baloo Da 2", 600), {
  radius: 0.6, motion: "smooth", backdrop: ["#f3e3d3", "#f9dcd2", "#ffffff", "#faf6f1", "#ffffff", "#f1e8dc"], grade: { warmth: 0.06 }, grain: 0.015,
});

/** Customer Counter: espresso and caramel. */
export const ESPRESSO = look(["#e0a458", "#35271d", "#ffd38a", "#1c140f", "#fbf4ea"], font("Outfit", 800), font("DM Sans", 500), font("Baloo Da 2", 700), {
  radius: 0.6, motion: "smooth", grade: { warmth: 0.2, fade: 0.14, saturation: 0.9 }, grain: 0.025,
});

// ---- the first six's logo, lower third and hook

/** Logo Line: deep teal. */
export const DEEP_TEAL = look(["#19c2b0", "#0a2c33", "#9ff5e6", "#04161a", "#effdfb"], font("Manrope", 800), font("Manrope", 500), font("Anek Bangla", 700), {
  radius: 0.5, motion: "smooth", backdrop: ["#0b6f67", "#094a52", "#178a7e", "#03100f", "#06201f", "#ffffff"],
  grade: { warmth: -0.08, fade: 0.12 }, grain: 0.025,
});

/** Name Bar: slate and amber (over video, so no grade). */
export const SLATE_AMBER = look(["#f59e0b", "#1e293b", "#fcd34d", "#0f172a", "#ffffff"], font("Inter", 700), font("Inter", 500), font("Hind Siliguri", 600), {
  radius: 0.35, motion: "snappy", backdrop: ["#1e293b", "#334155", "#f59e0b", "#0b1220", "#111827", "#0f172a"],
});

/** Reel Hook: hot pink and yellow, electric. */
export const HOT_PINK = look(["#e0186a", "#2d0a52", "#ffe14d", "#12001f", "#ffffff"], font("Archivo Black", 400), font("Inter", 600), font("Anek Bangla", 800), {
  radius: 0.5, motion: "snappy", grade: { fade: 0.08 }, grain: 0.02,
});
