/**
 * The maths behind the engine's moving details, kept pure so it's tested in tools/motion.test.mjs:
 * shape morphs, particles (confetti, sparks, dust), chart values and countdown clocks.
 */

const BN = "০১২৩৪৫৬৭৮৯";
const latinDigits = (s: string) => s.replace(/[০-৯]/g, (d) => String(BN.indexOf(d)));

// ---- morphs

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const parsed = new Map<string, { parts: string[]; nums: number[]; shape: string }>();

function parsePath(d: string) {
  let p = parsed.get(d);
  if (!p) {
    const nums = (d.match(NUMBER) ?? []).map(Number);
    const parts = d.split(NUMBER);
    p = { parts, nums, shape: parts.map((s) => s.replace(/[\s,]+/g, " ").trim()).join("|") };
    if (parsed.size > 256) parsed.clear();
    parsed.set(d, p);
  }
  return p;
}

/**
 * Path `a` turned `v` (0…1) of the way into `b`. They need the same commands in the same order
 * (only the numbers move); otherwise it swaps halfway.
 */
export function morphPath(a: string, b: string, v: number): string {
  if (v <= 0) return a;
  if (v >= 1) return b;
  const pa = parsePath(a), pb = parsePath(b);
  if (pa.nums.length !== pb.nums.length || pa.shape !== pb.shape) return v < 0.5 ? a : b;
  let out = pa.parts[0];
  for (let i = 0; i < pa.nums.length; i++) {
    const n = pa.nums[i] + (pb.nums[i] - pa.nums[i]) * v;
    // Numbers written back to back ("10-5") need a space once the second one can turn positive.
    out += String(Math.round(n * 1000) / 1000) + (pa.parts[i + 1] || " ");
  }
  return out;
}

// ---- particles

/** A repeatable random sequence for a seed (mulberry32 over an FNV hash). */
export function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** One particle's random make-up, every value 0…1. */
export interface Seed {
  x: number;
  y: number;
  a: number;
  b: number;
  size: number;
  spin: number;
  phase: number;
  hue: number;
  life: number;
}

const seeds = new Map<string, Seed[]>();

/** `n` particles for a layer (the same ones every frame and every time). */
export function particleSeeds(seed: string, n: number): Seed[] {
  const key = `${seed}\u0000${n}`;
  let out = seeds.get(key);
  if (!out) {
    const r = seeded(seed);
    out = Array.from({ length: n }, () => ({ x: r(), y: r(), a: r(), b: r(), size: r(), spin: r(), phase: r(), hue: r(), life: r() }));
    if (seeds.size > 64) seeds.clear();
    seeds.set(key, out);
  }
  return out;
}

export type ParticleKind = "confetti" | "sparks" | "dust";

const BASE_COUNT: Record<ParticleKind, number> = { confetti: 90, sparks: 64, dust: 54 };

/** How many particles to draw: fewer on small canvases (previews, cards), more with `amount`. */
export function particleCount(kind: ParticleKind, shortSide: number, amount = 1): number {
  return Math.round(BASE_COUNT[kind] * Math.max(0, Math.min(3, amount)) * Math.max(0.3, Math.min(1, shortSide / 1080)));
}

/** Where a particle is: pixels from the box's top left, how visible, turned how far, and its streak. */
export interface Placed {
  x: number;
  y: number;
  alpha: number;
  rotate: number;
  /** Confetti's flutter (−1…1, how much of its face shows); a spark's streak length in pixels. */
  flip: number;
  len: number;
}

/**
 * A particle at template time `t` in a w × h box. With `burst` (a template time) confetti and
 * sparks fly out of the centre then; without, confetti rains, sparks rise as embers, and dust drifts.
 */
export function particleAt(kind: ParticleKind, p: Seed, t: number, burst: number | undefined, w: number, h: number): Placed | null {
  const R = Math.max(w, h);
  const TAU = Math.PI * 2;
  if (kind === "dust") {
    const wrap = (v: number) => ((v % 1) + 1) % 1;
    const x = wrap(p.x + t * 0.014 * (p.a - 0.5) + 0.02 * Math.sin(t * 0.4 + p.phase * TAU));
    const y = wrap(p.y - t * 0.018 * (0.3 + p.b));
    return { x: x * w, y: y * h, alpha: (0.3 + 0.7 * p.size) * (0.55 + 0.45 * Math.sin(t * (0.8 + p.spin * 1.6) + p.phase * TAU)), rotate: 0, flip: 1, len: 0 };
  }
  if (burst === undefined) {
    if (kind === "confetti") {
      const period = 3.4 + p.life * 2.2;
      const u = (((t + p.phase * period) / period) % 1 + 1) % 1;
      const sway = Math.sin(t * (1.6 + p.spin * 1.8) + p.phase * TAU) * 0.025 * w;
      return { x: p.x * w + sway, y: (u * 1.15 - 0.08) * h, alpha: 1, rotate: p.phase * TAU + t * (p.spin - 0.5) * 6, flip: Math.cos(t * (3 + p.spin * 5) + p.phase * TAU), len: 0 };
    }
    const period = 2.4 + p.life * 2.2;
    const u = (((t + p.phase * period) / period) % 1 + 1) % 1;
    return { x: p.x * w + Math.sin(u * 6 + p.phase * TAU) * 0.03 * w, y: (1.02 - u * 1.1) * h, alpha: Math.sin(u * Math.PI) * (0.45 + 0.55 * p.size), rotate: -Math.PI / 2, flip: 1, len: R * 0.012 };
  }
  const tau = t - burst;
  if (kind === "confetti") {
    const life = 2.6 + p.life * 1.4;
    if (tau < 0 || tau > life) return null;
    const angle = -Math.PI / 2 + (p.a - 0.5) * 2.5;
    const speed = 1.3 + p.b * 1.7;
    const k = 3.2, fall = 0.14 + p.size * 0.1;
    const e = 1 - Math.exp(-k * tau);
    const vx = Math.cos(angle) * speed, vy = Math.sin(angle) * speed;
    const sway = Math.sin(tau * (3 + p.spin * 3) + p.phase * TAU) * 0.02 * Math.min(1, tau * 2);
    return {
      x: w / 2 + ((vx / k) * e + sway) * R,
      y: h / 2 + (fall * tau + ((vy - fall) / k) * e) * R,
      alpha: Math.min(1, (life - tau) / 0.5, tau * 20),
      rotate: p.phase * TAU + tau * (p.spin - 0.5) * 12,
      flip: Math.cos(tau * (4 + p.spin * 6) + p.phase * TAU),
      len: 0,
    };
  }
  const life = 0.6 + p.life * 0.7;
  if (tau < 0 || tau > life) return null;
  const angle = p.a * TAU;
  const speed = 1.1 + p.b * 2.1, k = 2.6;
  const dist = (speed / k) * (1 - Math.exp(-k * tau));
  const now = speed * Math.exp(-k * tau);
  const x = Math.cos(angle) * dist, y = Math.sin(angle) * dist + 0.22 * tau * tau;
  const fade = 1 - tau / life;
  return { x: w / 2 + x * R, y: h / 2 + y * R, alpha: fade * fade, rotate: Math.atan2(Math.sin(angle) * now + 0.44 * tau, Math.cos(angle) * now), flip: 1, len: Math.max(R * 0.004, now * R * 0.045) };
}

// ---- charts

/** The numbers in a chart's field ("40, 65, 90" or "৯৮%"), up to 24; commas separate values. */
export function chartValues(text: string): number[] {
  return (latinDigits(text).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite).slice(0, 24);
}

/** How far bar `i` of `n` has grown when the whole chart is at `grow` (0…1), `stagger` apart. */
export function barGrowth(grow: number, i: number, n: number, stagger: number): number {
  const s = Math.max(0, Math.min(stagger, 0.9 / Math.max(1, n - 1)));
  const span = 1 - s * (n - 1);
  return Math.max(0, Math.min(1, (grow - s * i) / Math.max(1e-3, span)));
}

// ---- countdowns

/**
 * A countdown's text `elapsed` seconds later: "02:59:59" → "02:59:57" after 2 s, never below zero,
 * with the parts, padding and digits it was written in ("০২:৫৯:৫৯" stays Bangla). Text that isn't a
 * time ("Ends tonight") stays as it is.
 */
export function tickClock(text: string, elapsed: number): string {
  const latin = latinDigits(text);
  const m = /^(.*?)(\d{1,3}(?::\d{1,2}){1,2})(.*)$/s.exec(latin);
  if (!m) return text;
  const fields = m[2].split(":");
  const total = fields.reduce((acc, v) => acc * 60 + Number(v), 0);
  let rest = Math.max(0, total - Math.floor(Math.max(0, elapsed)));
  const out: string[] = [];
  for (let i = fields.length - 1; i >= 0; i--) {
    const v = i === 0 ? rest : rest % 60;
    rest = Math.floor(rest / 60);
    out.unshift(String(v).padStart(fields[i].length, "0"));
  }
  let clock = out.join(":");
  if (/[০-৯]/.test(text)) clock = clock.replace(/\d/g, (d) => BN[Number(d)]);
  // Bangla digits are one code unit each, so the original's prefix and suffix line up.
  return text.slice(0, m[1].length) + clock + text.slice(m[1].length + m[2].length);
}
