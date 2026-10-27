/**
 * Zazabor's own stickers: shapes, arrows, callouts and badges drawn here as SVG (no third-party
 * art). A sticker is a text clip with `sticker` set, so it moves, animates and keyframes like a
 * text; most take the clip's colour (`{c}` below), and a few keep their own.
 */

export interface Sticker {
  id: string;
  label: string;
  /** Aspect of the drawing (width / height). */
  aspect: number;
  /** Takes the clip's colour. */
  tint: boolean;
  /** The SVG, given the colour. */
  svg: (c: string) => string;
}

const W = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;
const font = `font-family="DejaVu Sans, Noto Sans, sans-serif" font-weight="800"`;
const shadow = `<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-opacity="0.35"/></filter>`;

export const STICKERS: Sticker[] = [
  // ---- arrows and marks
  { id: "arrow", label: "Arrow", aspect: 2, tint: true, svg: (c) => W(200, 100, `<defs>${shadow}</defs><path filter="url(#s)" d="M10 38h110V12l70 38-70 38V62H10z" fill="${c}" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>`) },
  { id: "arrow-curve", label: "Curved arrow", aspect: 1.2, tint: true, svg: (c) => W(240, 200, `<path d="M30 170C40 90 100 50 175 55" fill="none" stroke="${c}" stroke-width="18" stroke-linecap="round"/><path d="M150 20l50 38-55 30z" fill="${c}"/>`) },
  { id: "arrow-down", label: "Arrow down", aspect: 0.6, tint: true, svg: (c) => W(120, 200, `<path d="M42 10h36v110h32L60 190 10 120h32z" fill="${c}" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>`) },
  { id: "chevrons", label: "Swipe up", aspect: 0.8, tint: true, svg: (c) => W(160, 200, `${[0, 1, 2].map((i) => `<path d="M25 ${160 - i * 50}l55-45 55 45" fill="none" stroke="${c}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round" opacity="${1 - i * 0.25}"/>`).join("")}`) },
  { id: "circle", label: "Circle it", aspect: 1.3, tint: true, svg: (c) => W(260, 200, `<path d="M40 110c-10-55 60-90 130-85s90 45 75 85-90 70-155 55S20 120 60 60" fill="none" stroke="${c}" stroke-width="12" stroke-linecap="round"/>`) },
  { id: "underline", label: "Underline", aspect: 4, tint: true, svg: (c) => W(400, 100, `<path d="M15 60c90-30 220-35 370-12" fill="none" stroke="${c}" stroke-width="16" stroke-linecap="round"/><path d="M60 82c80-16 180-18 280-6" fill="none" stroke="${c}" stroke-width="9" stroke-linecap="round" opacity=".7"/>`) },
  { id: "check", label: "Check", aspect: 1, tint: true, svg: (c) => W(200, 200, `<circle cx="100" cy="100" r="90" fill="${c}"/><path d="M55 104l30 30 62-66" fill="none" stroke="#fff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>`) },
  { id: "cross", label: "Cross", aspect: 1, tint: true, svg: (c) => W(200, 200, `<circle cx="100" cy="100" r="90" fill="${c}"/><path d="M65 65l70 70M135 65l-70 70" stroke="#fff" stroke-width="20" stroke-linecap="round"/>`) },
  // ---- callouts
  { id: "bubble", label: "Speech bubble", aspect: 1.3, tint: true, svg: (c) => W(260, 200, `<defs>${shadow}</defs><path filter="url(#s)" d="M30 20h200a20 20 0 0 1 20 20v100a20 20 0 0 1-20 20H110l-50 34 8-34H30a20 20 0 0 1-20-20V40a20 20 0 0 1 20-20z" fill="${c}" stroke="#fff" stroke-width="6"/>`) },
  { id: "thought", label: "Thought", aspect: 1.3, tint: true, svg: (c) => W(260, 200, `<g fill="${c}" stroke="#fff" stroke-width="5"><ellipse cx="135" cy="80" rx="115" ry="65"/><circle cx="70" cy="160" r="16"/><circle cx="40" cy="186" r="9"/></g>`) },
  { id: "burst", label: "Burst", aspect: 1, tint: true, svg: (c) => W(200, 200, `<path d="${burst(100, 100, 95, 62, 14)}" fill="${c}" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>`) },
  { id: "dots", label: "Typing…", aspect: 1.6, tint: true, svg: (c) => W(240, 150, `<rect x="10" y="20" width="220" height="100" rx="50" fill="${c}"/><g fill="#fff">${[70, 120, 170].map((x) => `<circle cx="${x}" cy="70" r="14"/>`).join("")}</g>`) },
  // ---- badges and buttons (their own colours)
  {
    id: "subscribe", label: "Subscribe", aspect: 3.2, tint: false,
    svg: () => W(480, 150, `<defs>${shadow}</defs><rect filter="url(#s)" x="10" y="15" width="460" height="120" rx="24" fill="#e62117"/><rect x="40" y="45" width="84" height="60" rx="16" fill="#fff"/><path d="M73 60v30l26-15z" fill="#e62117"/><text x="292" y="96" ${font} font-size="54" fill="#fff" text-anchor="middle">SUBSCRIBE</text>`),
  },
  {
    id: "like", label: "Like", aspect: 1, tint: true,
    svg: (c) => W(200, 200, `<circle cx="100" cy="100" r="92" fill="${c}"/><path d="M60 92h22v62H60zM92 152h50c10 0 16-6 18-14l10-38c2-10-4-18-14-18h-34l6-26c2-12-10-20-18-10L92 92z" fill="#fff"/>`),
  },
  { id: "heart", label: "Heart", aspect: 1.1, tint: true, svg: (c) => W(220, 200, `<path d="M110 185C40 130 10 95 10 60a50 50 0 0 1 100-10 50 50 0 0 1 100 10c0 35-30 70-100 125z" fill="${c}" stroke="#fff" stroke-width="6"/>`) },
  { id: "star", label: "Star", aspect: 1, tint: true, svg: (c) => W(200, 200, `<path d="${burst(100, 106, 92, 40, 5, -90)}" fill="${c}" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>`) },
  { id: "sparkle", label: "Sparkle", aspect: 1, tint: true, svg: (c) => W(200, 200, `<path d="M100 5c8 60 35 87 95 95-60 8-87 35-95 95-8-60-35-87-95-95 60-8 87-35 95-95z" fill="${c}"/><path d="M160 20c3 15 8 20 22 22-14 3-19 8-22 22-3-14-8-19-22-22 14-2 19-7 22-22z" fill="${c}" opacity=".8"/>`) },
  { id: "bell", label: "Bell", aspect: 1, tint: true, svg: (c) => W(200, 200, `<path d="M100 20c-35 0-55 28-55 60v40l-18 26h146l-18-26V80c0-32-20-60-55-60z" fill="${c}" stroke="#fff" stroke-width="6" stroke-linejoin="round"/><circle cx="100" cy="166" r="16" fill="${c}" stroke="#fff" stroke-width="6"/><circle cx="160" cy="45" r="24" fill="#e62117" stroke="#fff" stroke-width="5"/>`) },
  {
    id: "new", label: "NEW", aspect: 1, tint: true,
    svg: (c) => W(200, 200, `<path d="${burst(100, 100, 95, 75, 18)}" fill="${c}" stroke="#fff" stroke-width="5"/><text x="100" y="117" ${font} font-size="50" fill="#fff" text-anchor="middle">NEW</text>`),
  },
  {
    id: "sale", label: "SALE tag", aspect: 1.8, tint: true,
    svg: (c) => W(320, 180, `<defs>${shadow}</defs><path filter="url(#s)" d="M60 20h240a12 12 0 0 1 12 12v116a12 12 0 0 1-12 12H60L10 90z" fill="${c}"/><circle cx="58" cy="90" r="12" fill="#fff"/><text x="185" y="113" ${font} font-size="62" fill="#fff" text-anchor="middle">SALE</text>`),
  },
  {
    id: "percent", label: "−50%", aspect: 1, tint: true,
    svg: (c) => W(200, 200, `<circle cx="100" cy="100" r="92" fill="${c}" stroke="#fff" stroke-width="6"/><text x="100" y="122" ${font} font-size="60" fill="#fff" text-anchor="middle">-50%</text>`),
  },
  {
    id: "live", label: "LIVE", aspect: 2.4, tint: false,
    svg: () => W(288, 120, `<rect x="6" y="10" width="276" height="100" rx="50" fill="#e62117"/><circle cx="60" cy="60" r="16" fill="#fff"/><text x="168" y="80" ${font} font-size="56" fill="#fff" text-anchor="middle">LIVE</text>`),
  },
  {
    id: "follow", label: "Follow", aspect: 2.8, tint: true,
    svg: (c) => W(336, 120, `<rect x="6" y="10" width="324" height="100" rx="50" fill="${c}"/><path d="M52 60h40M72 40v40" stroke="#fff" stroke-width="12" stroke-linecap="round"/><text x="205" y="80" ${font} font-size="54" fill="#fff" text-anchor="middle">FOLLOW</text>`),
  },
  {
    id: "link", label: "Link in bio", aspect: 3.2, tint: true,
    svg: (c) => W(384, 120, `<rect x="6" y="10" width="372" height="100" rx="50" fill="#fff"/><g fill="none" stroke="${c}" stroke-width="10" stroke-linecap="round"><path d="M50 72l26-26M44 58l-8 8a14 14 0 0 0 20 20l8-8M82 62l8-8a14 14 0 0 0-20-20l-8 8"/></g><text x="226" y="78" ${font} font-size="44" fill="${c}" text-anchor="middle">LINK IN BIO</text>`),
  },
  {
    id: "banner", label: "Ribbon", aspect: 3.4, tint: true,
    svg: (c) => W(408, 120, `<path d="M10 30h50v60H10l18-30zM398 30h-50v60h50l-18-30z" fill="${c}" opacity=".75"/><rect x="40" y="16" width="328" height="76" fill="${c}"/><path d="M40 92l20 14V92zM368 92l-20 14V92z" fill="#000" opacity=".3"/>`),
  },
  // ---- shapes and symbols
  { id: "pin", label: "Location", aspect: 0.8, tint: true, svg: (c) => W(160, 200, `<path d="M80 190C35 130 15 100 15 70a65 65 0 0 1 130 0c0 30-20 60-65 120z" fill="${c}" stroke="#fff" stroke-width="6"/><circle cx="80" cy="70" r="24" fill="#fff"/>`) },
  { id: "play", label: "Play", aspect: 1, tint: true, svg: (c) => W(200, 200, `<circle cx="100" cy="100" r="92" fill="${c}" stroke="#fff" stroke-width="6"/><path d="M80 60v80l65-40z" fill="#fff"/>`) },
  { id: "warning", label: "Warning", aspect: 1.1, tint: true, svg: (c) => W(220, 200, `<path d="M110 12l100 176H10z" fill="${c}" stroke="#fff" stroke-width="8" stroke-linejoin="round"/><path d="M110 70v60" stroke="#fff" stroke-width="18" stroke-linecap="round"/><circle cx="110" cy="160" r="11" fill="#fff"/>`) },
  { id: "bolt", label: "Lightning", aspect: 0.7, tint: true, svg: (c) => W(140, 200, `<path d="M90 5L15 115h45l-15 80 80-115H80z" fill="${c}" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>`) },
  { id: "crown", label: "Crown", aspect: 1.4, tint: true, svg: (c) => W(280, 200, `<path d="M20 60l60 50 60-80 60 80 60-50-25 120H45z" fill="${c}" stroke="#fff" stroke-width="7" stroke-linejoin="round"/><rect x="45" y="168" width="190" height="20" rx="6" fill="${c}" stroke="#fff" stroke-width="6"/>`) },
  { id: "note", label: "Music note", aspect: 0.9, tint: true, svg: (c) => W(180, 200, `<path d="M70 30l90-20v120" fill="none" stroke="${c}" stroke-width="16" stroke-linejoin="round"/><path d="M70 30v130" stroke="${c}" stroke-width="16"/><ellipse cx="45" cy="160" rx="30" ry="22" fill="${c}"/><ellipse cx="135" cy="132" rx="30" ry="22" fill="${c}"/>`) },
  { id: "confetti", label: "Confetti", aspect: 1, tint: false, svg: () => W(200, 200, confetti()) },
];

/** A star or burst outline: `points` spikes between radii `outer` and `inner`. */
function burst(cx: number, cy: number, outer: number, inner: number, points: number, rotate = 0): string {
  const out: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = ((rotate + (i * 180) / points) * Math.PI) / 180;
    out.push(`${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return `M${out.join("L")}z`;
}

/** A fixed scatter of confetti (the same every time). */
function confetti(): string {
  const colors = ["#ff4d6d", "#ffd166", "#06d6a0", "#118ab2", "#9b5de5", "#f15bb5"];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const parts: string[] = [];
  for (let i = 0; i < 34; i++) {
    const x = 15 + rnd() * 170, y = 15 + rnd() * 170, r = rnd() * 180, c = colors[i % colors.length];
    parts.push(i % 3 === 0
      ? `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(4 + rnd() * 4).toFixed(1)}" fill="${c}"/>`
      : `<rect x="${(x - 7).toFixed(0)}" y="${(y - 3).toFixed(0)}" width="14" height="6" rx="2" fill="${c}" transform="rotate(${r.toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"/>`);
  }
  return parts.join("");
}

export function stickerOf(id: string | undefined): Sticker | null {
  return (id && STICKERS.find((s) => s.id === id)) || null;
}

const images = new Map<string, Promise<HTMLImageElement>>();

/** The sticker drawn as an image (cached per colour). */
export function stickerImage(s: Sticker, color: string): Promise<HTMLImageElement> {
  const key = `${s.id}\u0000${s.tint ? color : ""}`;
  let p = images.get(key);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`The sticker “${s.label}” couldn't be drawn.`));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s.svg(color))}`;
    });
    images.set(key, p);
  }
  return p;
}

/** Draws a sticker `heightPx` tall into `out`; returns its size. */
export function drawSticker(out: HTMLCanvasElement, s: Sticker, img: HTMLImageElement, heightPx: number): { width: number; height: number } {
  const h = Math.max(8, Math.round(heightPx));
  const w = Math.max(8, Math.round(h * s.aspect));
  if (out.width !== w || out.height !== h) {
    out.width = w;
    out.height = h;
  }
  const ctx = out.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { width: w, height: h };
}

/** A sticker's height in pixels: `size` is in thousandths of the canvas height. */
export const stickerHeight = (size: number, canvasHeight: number) => (size / 1000) * canvasHeight;
export const STICKER_SIZE = 240;
