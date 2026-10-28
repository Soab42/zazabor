import type { Box } from "./layout";

/**
 * Vector drawings that ship with the templates, drawn for Zazabor in code: products (earbuds,
 * sneaker, bottle, watch, headphones, speaker) for when the user hasn't added a photo yet, and app
 * screens (home, shop, feed, dashboard, lock screen) for device mockups. They take the Brand Kit's
 * colours, so a template looks finished before anything is filled in.
 */

export interface ArtEnv {
  /** A theme colour or hex ("@primary", "#ffffff/0.5") as CSS. */
  col: (p: string) => string;
  /** The product's colour, and a second one. */
  tint: string;
  tint2: string;
  /** Template time (small live details: a clock, a blinking caret). */
  t: number;
  /** 0 top … 1 bottom of tall content (screens). */
  scroll: number;
  /** A CSS font for a size in pixels (`weight` 400–800; heading or body face). */
  font: (size: number, weight: number, heading?: boolean) => string;
}

export const PRODUCT_ART = ["buds", "sneaker", "bottle", "watch", "headphones", "speaker"] as const;
export const SCREEN_ART = ["app-home", "app-shop", "app-feed", "dashboard", "lock"] as const;
export const ART_IDS: readonly string[] = [...PRODUCT_ART, ...SCREEN_ART];

/** Draws art `id` into `box` (products keep their shape, centred; screens fill the box). */
export function drawArt(ctx: CanvasRenderingContext2D, id: string, box: Box, env: ArtEnv) {
  ctx.save();
  if ((SCREEN_ART as readonly string[]).includes(id)) {
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    SCREENS[id as (typeof SCREEN_ART)[number]](ctx, box, env);
  } else {
    // Products are drawn in a 100 × 100 square, fitted into the box.
    const s = Math.min(box.w, box.h) / 100;
    ctx.translate(box.x + (box.w - 100 * s) / 2, box.y + (box.h - 100 * s) / 2);
    ctx.scale(s, s);
    (PRODUCTS[id as (typeof PRODUCT_ART)[number]] ?? PRODUCTS.buds)(ctx, env);
  }
  ctx.restore();
}

// ---- helpers

const shade = (hex: string, k: number): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (v: number) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
};

/** A vertical gradient across a rectangle (lighter at the top for a lit, glossy look). */
function lit(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, color: string, from = 0.35, to = -0.25): CanvasGradient {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, shade(color, from));
  g.addColorStop(1, shade(color, to));
  return g;
}

function round(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

function shadow(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, alpha = 0.28) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
  g.addColorStop(0, `rgba(0,0,0,${alpha})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  ctx.translate(-cx, -cy);
  ctx.fillStyle = g;
  ctx.fillRect(cx - rx, cy - rx, rx * 2, rx * 2);
  ctx.restore();
}

/** A glossy highlight streak over a shape already in the path (call after filling it). */
function gloss(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha = 0.35) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, `rgba(255,255,255,${alpha})`);
  g.addColorStop(0.45, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fill();
}

// ---- products (100 × 100)

const PRODUCTS: Record<(typeof PRODUCT_ART)[number], (ctx: CanvasRenderingContext2D, env: ArtEnv) => void> = {
  buds(ctx, env) {
    shadow(ctx, 50, 82, 34, 6);
    round(ctx, 18, 30, 64, 50, 22);
    ctx.fillStyle = lit(ctx, 18, 30, 50, "#f2f3f7", 0.5, -0.18);
    ctx.fill();
    gloss(ctx, 18, 30, 64, 50);
    ctx.strokeStyle = "rgba(0,0,0,0.14)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(19, 47);
    ctx.lineTo(81, 47);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(50, 63, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = env.tint;
    ctx.fill();
  },
  sneaker(ctx, env) {
    shadow(ctx, 50, 79, 42, 5);
    // Sole.
    ctx.beginPath();
    ctx.moveTo(8, 70);
    ctx.bezierCurveTo(8, 77, 14, 78, 22, 78);
    ctx.lineTo(86, 78);
    ctx.bezierCurveTo(94, 78, 95, 70, 92, 66);
    ctx.lineTo(10, 64);
    ctx.closePath();
    ctx.fillStyle = "#f6f6f8";
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.fillRect(10, 72, 82, 1.2);
    // Upper.
    ctx.beginPath();
    ctx.moveTo(10, 65);
    ctx.bezierCurveTo(10, 52, 18, 45, 30, 43);
    ctx.lineTo(44, 30);
    ctx.bezierCurveTo(50, 26, 58, 28, 60, 34);
    ctx.bezierCurveTo(66, 42, 80, 48, 88, 52);
    ctx.bezierCurveTo(94, 55, 94, 63, 91, 66);
    ctx.closePath();
    ctx.fillStyle = lit(ctx, 0, 28, 40, env.tint, 0.3, -0.3);
    ctx.fill();
    gloss(ctx, 10, 28, 80, 38, 0.25);
    // Side stripes and laces.
    ctx.strokeStyle = env.tint2;
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(28, 60);
    ctx.bezierCurveTo(45, 52, 62, 50, 82, 58);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(46 + i * 4.5, 34 + i * 2.6);
      ctx.lineTo(52 + i * 4.5, 31 + i * 2.6);
      ctx.stroke();
    }
  },
  bottle(ctx, env) {
    shadow(ctx, 50, 88, 22, 4);
    // Dropper bulb and collar.
    round(ctx, 43, 6, 14, 18, 7);
    ctx.fillStyle = lit(ctx, 43, 6, 18, "#2a2a30", 0.4, -0.2);
    ctx.fill();
    round(ctx, 38, 22, 24, 10, 2.5);
    ctx.fillStyle = lit(ctx, 38, 22, 10, "#d8b26a", 0.45, -0.25);
    ctx.fill();
    // Glass body with the liquid.
    round(ctx, 30, 30, 40, 58, 9);
    ctx.fillStyle = lit(ctx, 30, 30, 58, env.tint, 0.15, -0.35);
    ctx.fill();
    round(ctx, 33, 42, 34, 43, 7);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fill();
    round(ctx, 30, 30, 40, 58, 9);
    gloss(ctx, 30, 30, 40, 58, 0.45);
    // Label.
    round(ctx, 35, 52, 30, 22, 3);
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.fill();
    ctx.fillStyle = env.tint;
    ctx.fillRect(40, 59, 20, 2.2);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(43, 65, 14, 1.4);
  },
  watch(ctx, env) {
    shadow(ctx, 50, 92, 22, 4);
    // Strap.
    round(ctx, 36, 2, 28, 96, 10);
    ctx.fillStyle = lit(ctx, 36, 2, 96, env.tint2, 0.1, -0.3);
    ctx.fill();
    // Case and screen.
    round(ctx, 24, 24, 52, 56, 15);
    ctx.fillStyle = lit(ctx, 24, 24, 56, "#3a3d46", 0.5, -0.4);
    ctx.fill();
    round(ctx, 28, 28, 44, 48, 12);
    ctx.fillStyle = "#07080c";
    ctx.fill();
    // Activity rings that fill over time.
    const rings: [number, string][] = [[15, env.tint], [11, "#3ee0cf"], [7, "#ffd166"]];
    rings.forEach(([r, c], i) => {
      ctx.lineCap = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.1)";
      ctx.beginPath();
      ctx.arc(50, 52, r, 0, Math.PI * 2);
      ctx.stroke();
      const v = 0.55 + 0.3 * Math.sin(env.t * 0.6 + i);
      ctx.strokeStyle = c;
      ctx.beginPath();
      ctx.arc(50, 52, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * v);
      ctx.stroke();
    });
    round(ctx, 24, 24, 52, 56, 15);
    gloss(ctx, 24, 24, 52, 56, 0.3);
    round(ctx, 75, 40, 4, 10, 1.5);
    ctx.fillStyle = "#5a5e69";
    ctx.fill();
  },
  headphones(ctx, env) {
    shadow(ctx, 50, 90, 36, 5);
    ctx.lineCap = "round";
    ctx.strokeStyle = lit(ctx, 0, 10, 50, env.tint, 0.25, -0.3);
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(50, 52, 34, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(50, 52, 35.5, Math.PI * 1.15, Math.PI * 1.55);
    ctx.stroke();
    for (const side of [-1, 1]) {
      const cx = 50 + side * 33;
      round(ctx, cx - 11, 46, 22, 36, 10);
      ctx.fillStyle = lit(ctx, cx - 11, 46, 36, env.tint, 0.3, -0.35);
      ctx.fill();
      gloss(ctx, cx - 11, 46, 22, 36, 0.35);
      round(ctx, cx - side * 9 - 3.5, 50, 7, 28, 3.5);
      ctx.fillStyle = shade(env.tint2, -0.2);
      ctx.fill();
    }
  },
  speaker(ctx, env) {
    shadow(ctx, 50, 92, 28, 5);
    round(ctx, 26, 6, 48, 86, 22);
    ctx.fillStyle = lit(ctx, 26, 6, 86, env.tint, 0.25, -0.35);
    ctx.fill();
    // Fabric dots.
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    for (let y = 16; y < 84; y += 4) for (let x = 32; x < 70; x += 4) {
      ctx.beginPath();
      ctx.arc(x + ((y / 4) % 2) * 2, y, 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
    round(ctx, 26, 6, 48, 86, 22);
    gloss(ctx, 26, 6, 48, 86, 0.3);
    round(ctx, 41, 10, 18, 4, 2);
    ctx.fillStyle = env.tint2;
    ctx.fill();
  },
};

// ---- screens (fill the box; sizes relative to its width)

type ScreenFn = (ctx: CanvasRenderingContext2D, b: Box, env: ArtEnv) => void;

function statusBar(ctx: CanvasRenderingContext2D, b: Box, env: ArtEnv, dark: boolean) {
  const u = b.w / 100;
  ctx.fillStyle = dark ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.85)";
  ctx.font = env.font(u * 3.6, 700);
  ctx.textBaseline = "middle";
  ctx.fillText("9:41", b.x + u * 7, b.y + u * 6);
  ctx.textBaseline = "alphabetic";
  round(ctx, b.x + b.w - u * 14, b.y + u * 4.6, u * 7, u * 2.8, u * 0.8);
  ctx.fill();
}

const SCREENS: Record<(typeof SCREEN_ART)[number], ScreenFn> = {
  "app-home"(ctx, b, env) {
    const u = b.w / 100;
    ctx.fillStyle = env.col("@bg");
    ctx.fillRect(b.x, b.y, b.w, b.h);
    statusBar(ctx, b, env, true);
    ctx.fillStyle = env.col("@text/0.6");
    ctx.font = env.font(u * 4, 500);
    ctx.fillText("Good morning", b.x + u * 7, b.y + u * 18);
    ctx.fillStyle = env.col("@text");
    ctx.font = env.font(u * 6.5, 800, true);
    ctx.fillText("Maya", b.x + u * 7, b.y + u * 26);
    // Balance card.
    round(ctx, b.x + u * 6, b.y + u * 32, u * 88, u * 44, u * 6);
    const g = ctx.createLinearGradient(b.x, b.y + u * 32, b.x + b.w, b.y + u * 76);
    g.addColorStop(0, env.col("@primary"));
    g.addColorStop(1, env.col("@accent"));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.font = env.font(u * 3.6, 500);
    ctx.fillText("Balance", b.x + u * 12, b.y + u * 44);
    ctx.fillStyle = "#ffffff";
    ctx.font = env.font(u * 9, 800, true);
    ctx.fillText("৳48,250", b.x + u * 12, b.y + u * 57);
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = env.font(u * 3.4, 500);
    ctx.fillText("+12% this month", b.x + u * 12, b.y + u * 68);
    // Quick actions.
    for (let i = 0; i < 4; i++) {
      const cx = b.x + u * (17 + i * 22), cy = b.y + u * 89;
      ctx.beginPath();
      ctx.arc(cx, cy, u * 7, 0, Math.PI * 2);
      ctx.fillStyle = env.col("@surface");
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, u * 2.6, 0, Math.PI * 2);
      ctx.fillStyle = env.col(i === 0 ? "@primary" : "@text/0.55");
      ctx.fill();
    }
    // Recent list.
    for (let i = 0; i < 6; i++) {
      const y = b.y + u * (106 + i * 15);
      if (y > b.y + b.h) break;
      round(ctx, b.x + u * 6, y, u * 88, u * 12, u * 3);
      ctx.fillStyle = env.col("@surface");
      ctx.fill();
      ctx.beginPath();
      ctx.arc(b.x + u * 13, y + u * 6, u * 3.5, 0, Math.PI * 2);
      ctx.fillStyle = env.col(i % 2 ? "@accent/0.7" : "@primary/0.7");
      ctx.fill();
      ctx.fillStyle = env.col("@text/0.75");
      ctx.fillRect(b.x + u * 20, y + u * 4, u * 30, u * 1.6);
      ctx.fillStyle = env.col("@text/0.35");
      ctx.fillRect(b.x + u * 20, y + u * 7.4, u * 18, u * 1.3);
      ctx.fillStyle = env.col("@text/0.8");
      ctx.fillRect(b.x + u * 78, y + u * 5, u * 10, u * 1.8);
    }
  },
  "app-shop"(ctx, b, env) {
    const u = b.w / 100;
    ctx.fillStyle = env.col("@bg");
    ctx.fillRect(b.x, b.y, b.w, b.h);
    statusBar(ctx, b, env, true);
    round(ctx, b.x + u * 6, b.y + u * 13, u * 88, u * 10, u * 5);
    ctx.fillStyle = env.col("@surface");
    ctx.fill();
    ctx.fillStyle = env.col("@text/0.45");
    ctx.font = env.font(u * 3.6, 500);
    ctx.fillText("Search products", b.x + u * 14, b.y + u * 19.6);
    const items = ["buds", "sneaker", "watch", "bottle", "headphones", "speaker"];
    items.forEach((art, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = b.x + u * (6 + col * 45), y = b.y + u * (29 + row * 52);
      if (y > b.y + b.h) return;
      round(ctx, x, y, u * 43, u * 48, u * 5);
      ctx.fillStyle = env.col("@surface");
      ctx.fill();
      drawArt(ctx, art, { x: x + u * 6, y: y + u * 3, w: u * 31, h: u * 29 }, { ...env, tint: i % 3 === 0 ? env.tint : i % 3 === 1 ? env.col("@accent") : env.col("@secondary") });
      ctx.fillStyle = env.col("@text/0.75");
      ctx.fillRect(x + u * 4, y + u * 36, u * 22, u * 1.8);
      ctx.fillStyle = env.col("@primary");
      ctx.font = env.font(u * 4, 800, true);
      ctx.fillText(`৳${(1290 + i * 650).toLocaleString("en-IN")}`, x + u * 4, y + u * 44);
    });
    // Tab bar.
    ctx.fillStyle = env.col("@surface");
    ctx.fillRect(b.x, b.y + b.h - u * 14, b.w, u * 14);
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(b.x + u * (14 + i * 24), b.y + b.h - u * 7, u * 2.6, 0, Math.PI * 2);
      ctx.fillStyle = env.col(i === 1 ? "@primary" : "@text/0.4");
      ctx.fill();
    }
  },
  "app-feed"(ctx, b, env) {
    const u = b.w / 100;
    ctx.fillStyle = env.col("@bg");
    ctx.fillRect(b.x, b.y, b.w, b.h);
    // A tall feed: the scroll moves through about three screens of posts.
    const content = b.h * 3;
    const offset = -env.scroll * (content - b.h);
    ctx.save();
    ctx.translate(0, offset);
    for (let i = 0; i < 9; i++) {
      const y = b.y + u * 16 + i * u * 112;
      if (y + offset > b.y + b.h || y + u * 112 + offset < b.y) continue;
      ctx.beginPath();
      ctx.arc(b.x + u * 11, y + u * 6, u * 5, 0, Math.PI * 2);
      ctx.fillStyle = env.col(i % 2 ? "@accent" : "@primary");
      ctx.fill();
      ctx.fillStyle = env.col("@text/0.8");
      ctx.fillRect(b.x + u * 19, y + u * 3.5, u * 26, u * 1.8);
      ctx.fillStyle = env.col("@text/0.4");
      ctx.fillRect(b.x + u * 19, y + u * 7, u * 16, u * 1.4);
      round(ctx, b.x + u * 6, y + u * 14, u * 88, u * 72, u * 4);
      const g = ctx.createLinearGradient(b.x, y + u * 14, b.x + b.w, y + u * 86);
      const hues = [["@primary", "@accent"], ["@secondary", "@primary"], ["@accent", "@secondary"]][i % 3];
      g.addColorStop(0, env.col(hues[0]));
      g.addColorStop(1, env.col(hues[1]));
      ctx.fillStyle = g;
      ctx.fill();
      drawArt(ctx, PRODUCT_ART[i % PRODUCT_ART.length], { x: b.x + u * 26, y: y + u * 22, w: u * 48, h: u * 56 }, env);
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        ctx.arc(b.x + u * (10 + k * 9), y + u * 93, u * 2.4, 0, Math.PI * 2);
        ctx.strokeStyle = env.col("@text/0.7");
        ctx.lineWidth = u * 0.8;
        ctx.stroke();
      }
      ctx.fillStyle = env.col("@text/0.55");
      ctx.fillRect(b.x + u * 6, y + u * 100, u * 60, u * 1.5);
    }
    ctx.restore();
    // Fixed header.
    ctx.fillStyle = env.col("@bg");
    ctx.fillRect(b.x, b.y, b.w, u * 13);
    statusBar(ctx, b, env, true);
  },
  dashboard(ctx, b, env) {
    const u = b.w / 100;
    ctx.fillStyle = env.col("@bg");
    ctx.fillRect(b.x, b.y, b.w, b.h);
    // Sidebar.
    ctx.fillStyle = env.col("@surface");
    ctx.fillRect(b.x, b.y, u * 16, b.h);
    round(ctx, b.x + u * 3, b.y + u * 3, u * 10, u * 3, u * 1);
    ctx.fillStyle = env.col("@primary");
    ctx.fill();
    for (let i = 0; i < 6; i++) {
      round(ctx, b.x + u * 3, b.y + u * (11 + i * 5), u * (i === 0 ? 10 : 8), u * 1.6, u * 0.8);
      ctx.fillStyle = env.col(i === 0 ? "@text/0.8" : "@text/0.35");
      ctx.fill();
    }
    ctx.fillStyle = env.col("@text");
    ctx.font = env.font(u * 2.6, 800, true);
    ctx.fillText("Overview", b.x + u * 20, b.y + u * 6.5);
    // KPI cards.
    const kpis = ["৳2.4L", "1,284", "4.9★"];
    kpis.forEach((k, i) => {
      const x = b.x + u * (20 + i * 26.5);
      round(ctx, x, b.y + u * 10, u * 24, u * 11, u * 1.6);
      ctx.fillStyle = env.col("@surface");
      ctx.fill();
      ctx.fillStyle = env.col("@text/0.45");
      ctx.fillRect(x + u * 2, b.y + u * 12.5, u * 9, u * 1);
      ctx.fillStyle = env.col(i === 0 ? "@primary" : "@text");
      ctx.font = env.font(u * 3.4, 800, true);
      ctx.fillText(k, x + u * 2, b.y + u * 18.5);
    });
    // Bar chart that rises with time.
    round(ctx, b.x + u * 20, b.y + u * 24, u * 51, b.h - u * 27, u * 1.6);
    ctx.fillStyle = env.col("@surface");
    ctx.fill();
    const base = b.y + b.h - u * 6;
    const top = b.y + u * 30;
    for (let i = 0; i < 8; i++) {
      const v = [0.42, 0.55, 0.48, 0.66, 0.6, 0.78, 0.72, 0.92][i];
      const grow = Math.max(0, Math.min(1, env.t * 1.2 - i * 0.08));
      const h = (base - top) * v * grow;
      round(ctx, b.x + u * (23.5 + i * 5.8), base - h, u * 3.6, h, u * 0.8);
      ctx.fillStyle = env.col(i === 7 ? "@accent" : "@primary/0.75");
      ctx.fill();
    }
    // Donut.
    round(ctx, b.x + u * 74, b.y + u * 24, u * 23, b.h - u * 27, u * 1.6);
    ctx.fillStyle = env.col("@surface");
    ctx.fill();
    const cx = b.x + u * 85.5, cy = b.y + u * 24 + (b.h - u * 27) / 2, r = Math.min(u * 7.5, (b.h - u * 27) * 0.3);
    ctx.lineWidth = r * 0.42;
    [["@primary", 0.5], ["@accent", 0.3], ["@text/0.25", 0.2]].reduce((start, [c, v]) => {
      ctx.strokeStyle = env.col(c as string);
      ctx.beginPath();
      ctx.arc(cx, cy, r, start, start + Math.PI * 2 * (v as number) - 0.05);
      ctx.stroke();
      return start + Math.PI * 2 * (v as number);
    }, -Math.PI / 2);
  },
  lock(ctx, b, env) {
    const u = b.w / 100;
    const g = ctx.createLinearGradient(b.x, b.y, b.x + b.w, b.y + b.h);
    g.addColorStop(0, env.col("@secondary"));
    g.addColorStop(1, env.col("@bg"));
    ctx.fillStyle = g;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    const glow = ctx.createRadialGradient(b.x + b.w * 0.7, b.y + b.h * 0.3, 0, b.x + b.w * 0.7, b.y + b.h * 0.3, b.w * 0.9);
    glow.addColorStop(0, env.col("@primary/0.45"));
    glow.addColorStop(1, env.col("@primary/0"));
    ctx.fillStyle = glow;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    statusBar(ctx, b, env, true);
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = env.font(u * 4.2, 600);
    ctx.textAlign = "center";
    ctx.fillText("Monday, 27 October", b.x + b.w / 2, b.y + u * 22);
    ctx.fillStyle = "#ffffff";
    ctx.font = env.font(u * 22, 700, true);
    ctx.fillText("9:41", b.x + b.w / 2, b.y + u * 44);
    ctx.textAlign = "start";
  },
};
