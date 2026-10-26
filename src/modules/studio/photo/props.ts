import { h } from "../../../ui/dom";
import { CHANNELS, HUE_RANGES, PHOTO_FILTERS, type AdjSpec, type Channel, type HueRange, type Tone } from "./layeradjust";
import { curveFunction, CURVE_IDENTITY, LEVELS_IDENTITY, type CurvePoints } from "./tone";

/**
 * The Properties panel's editors for adjustment layers other than Light & Colour. Each changes
 * its spec in place: `live` while a control moves, `commit` when a change is done.
 */
export interface PropsContext {
  live(): void;
  commit(label: string): void;
  /** What lies below the layer, as 256-bin histograms: red, green, blue and brightness. */
  histogram(): Uint32Array[] | null;
}

interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
  format?: (v: number) => string;
  reset?: number;
  /** A gradient under the track (Color Balance, Hue/Saturation). */
  track?: string;
}

function slider(ctx: PropsContext, o: SliderOptions, commitLabel = o.label) {
  const fmt = o.format ?? ((v: number) => `${Math.round(v)}`);
  const input = h("input", { type: "range", class: "ph-prop-range", min: o.min, max: o.max, step: o.step, value: o.get(), "aria-label": o.label });
  if (o.track) input.style.setProperty("--track", o.track);
  const value = h("span", { class: "ph-prop-value" }, fmt(o.get()));
  input.addEventListener("input", () => {
    o.set(Number(input.value));
    value.textContent = fmt(o.get());
    ctx.live();
  });
  input.addEventListener("change", () => ctx.commit(commitLabel));
  input.addEventListener("dblclick", () => {
    const r = o.reset ?? 0;
    o.set(r);
    input.value = String(r);
    value.textContent = fmt(r);
    ctx.live();
    ctx.commit(commitLabel);
  });
  return h("label", { class: `ph-prop${o.track ? " tracked" : ""}` }, h("span", null, o.label), value, input);
}

function check(ctx: PropsContext, label: string, get: () => boolean, set: (v: boolean) => void) {
  const input = h("input", { type: "checkbox", checked: get() });
  input.addEventListener("change", () => {
    set(input.checked);
    ctx.live();
    ctx.commit(label);
  });
  return h("label", { class: "ph-check" }, input, label);
}

function select<T extends string>(options: { id: T; label: string }[], value: T, onChange: (v: T) => void, label: string) {
  const el = h("select", { class: "ph-select small", "aria-label": label }, ...options.map((o) => h("option", { value: o.id }, o.label)));
  el.value = value;
  el.addEventListener("change", () => onChange(el.value as T));
  return el;
}

function colorField(ctx: PropsContext, label: string, get: () => string, set: (v: string) => void) {
  const input = h("input", { type: "color", class: "ph-color-field", value: get(), "aria-label": label });
  input.addEventListener("input", () => {
    set(input.value);
    ctx.live();
  });
  input.addEventListener("change", () => ctx.commit(label));
  return h("label", { class: "ph-prop ph-prop-color" }, h("span", null, label), input);
}

const group = (title: string | null, ...children: (HTMLElement | null)[]) =>
  h("div", { class: "ph-prop-group" }, title ? h("h4", null, title) : null, ...children);

/** Draws a histogram (log-ish scale, as Photoshop shows it) into a canvas. */
function drawHistogram(ctx2: CanvasRenderingContext2D, w: number, hgt: number, bins: Uint32Array | null, color: string) {
  if (!bins) return;
  let max = 1;
  for (let i = 1; i < 255; i++) max = Math.max(max, bins[i]);
  ctx2.fillStyle = color;
  for (let i = 0; i < 256; i++) {
    const v = Math.min(1, Math.sqrt(bins[i] / max));
    const x = (i / 256) * w;
    ctx2.fillRect(x, hgt - v * hgt, Math.max(1, w / 256 + 0.5), v * hgt);
  }
}

const CHANNEL_COLORS: Record<Channel, string> = { rgb: "rgba(220, 220, 225, 0.55)", r: "rgba(255, 90, 90, 0.6)", g: "rgba(90, 220, 110, 0.6)", b: "rgba(90, 140, 255, 0.65)" };
const binsFor = (hist: Uint32Array[] | null, c: Channel) => (hist ? hist[c === "r" ? 0 : c === "g" ? 1 : c === "b" ? 2 : 3] : null);

function levelsEditor(spec: Extract<AdjSpec, { type: "levels" }>, ctx: PropsContext): HTMLElement[] {
  let channel: Channel = "rgb";
  const hist = ctx.histogram();
  const body = h("div");
  const draw = () => {
    const l = spec.levels[channel];
    const canvas = h("canvas", { class: "ph-histogram" });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(236 * dpr);
    canvas.height = Math.round(72 * dpr);
    const c2 = canvas.getContext("2d")!;
    drawHistogram(c2, canvas.width, canvas.height, binsFor(hist, channel), CHANNEL_COLORS[channel]);
    // The input points.
    c2.fillStyle = "rgba(255, 255, 255, 0.85)";
    for (const v of [l.inBlack, l.inWhite]) c2.fillRect((v / 255) * canvas.width - dpr, 0, 2 * dpr, canvas.height);
    body.replaceChildren(
      canvas,
      slider(ctx, { label: "Shadows", min: 0, max: 253, step: 1, get: () => l.inBlack, set: (v) => (l.inBlack = Math.min(v, l.inWhite - 2)), reset: 0 }, "Levels"),
      slider(ctx, { label: "Midtones", min: 0.1, max: 9.99, step: 0.01, get: () => l.gamma, set: (v) => (l.gamma = v), format: (v) => v.toFixed(2), reset: 1 }, "Levels"),
      slider(ctx, { label: "Highlights", min: 2, max: 255, step: 1, get: () => l.inWhite, set: (v) => (l.inWhite = Math.max(v, l.inBlack + 2)), reset: 255 }, "Levels"),
      slider(ctx, { label: "Output black", min: 0, max: 255, step: 1, get: () => l.outBlack, set: (v) => (l.outBlack = v), reset: 0 }, "Levels"),
      slider(ctx, { label: "Output white", min: 0, max: 255, step: 1, get: () => l.outWhite, set: (v) => (l.outWhite = v), reset: 255 }, "Levels"),
      h("button", { class: "btn small", type: "button", onclick: () => {
        spec.levels[channel] = { ...LEVELS_IDENTITY };
        ctx.live();
        ctx.commit("Levels");
        draw();
      } }, "Reset Channel"));
  };
  const channels = select(CHANNELS, channel, (v) => {
    channel = v;
    draw();
  }, "Channel");
  draw();
  return [group(null, h("div", { class: "ph-prop-row" }, h("span", null, "Channel"), channels), body)];
}

function curvesEditor(spec: Extract<AdjSpec, { type: "curves" }>, ctx: PropsContext): HTMLElement[] {
  let channel: Channel = "rgb";
  let selected = -1;
  const hist = ctx.histogram();
  const SIZE = 236;
  const dpr = window.devicePixelRatio || 1;
  const canvas = h("canvas", { class: "ph-curves", style: { width: `${SIZE}px`, height: `${SIZE}px` } });
  canvas.width = canvas.height = Math.round(SIZE * dpr);
  const inBox = h("input", { type: "number", class: "ph-opt-number", min: 0, max: 255, step: 1, "aria-label": "Input" });
  const outBox = h("input", { type: "number", class: "ph-opt-number", min: 0, max: 255, step: 1, "aria-label": "Output" });
  const points = () => spec.curves[channel];
  const draw = () => {
    const c2 = canvas.getContext("2d")!;
    const W = canvas.width;
    c2.clearRect(0, 0, W, W);
    c2.fillStyle = "rgba(0, 0, 0, 0.25)";
    c2.fillRect(0, 0, W, W);
    drawHistogram(c2, W, W, binsFor(hist, channel), "rgba(255, 255, 255, 0.12)");
    c2.strokeStyle = "rgba(255, 255, 255, 0.12)";
    c2.lineWidth = 1;
    c2.beginPath();
    for (let i = 1; i < 4; i++) {
      c2.moveTo((i / 4) * W, 0);
      c2.lineTo((i / 4) * W, W);
      c2.moveTo(0, (i / 4) * W);
      c2.lineTo(W, (i / 4) * W);
    }
    c2.moveTo(0, W);
    c2.lineTo(W, 0);
    c2.stroke();
    const f = curveFunction(points());
    c2.strokeStyle = channel === "rgb" ? "#ffffff" : CHANNEL_COLORS[channel].replace(/[\d.]+\)$/, "1)");
    c2.lineWidth = 1.5 * dpr;
    c2.beginPath();
    for (let i = 0; i <= W; i++) {
      const y = W - f(i / W) * W;
      if (i) c2.lineTo(i, y);
      else c2.moveTo(i, y);
    }
    c2.stroke();
    points().forEach(([x, y], i) => {
      const px = (x / 255) * W, py = W - (y / 255) * W;
      c2.fillStyle = i === selected ? "#ffffff" : "rgba(0, 0, 0, 0.8)";
      c2.strokeStyle = "#ffffff";
      c2.lineWidth = 1.2 * dpr;
      c2.beginPath();
      c2.rect(px - 4 * dpr, py - 4 * dpr, 8 * dpr, 8 * dpr);
      c2.fill();
      c2.stroke();
    });
    const p = points()[selected];
    inBox.disabled = outBox.disabled = !p;
    inBox.value = p ? String(Math.round(p[0])) : "";
    outBox.value = p ? String(Math.round(p[1])) : "";
  };
  const toCurve = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [Math.min(255, Math.max(0, ((e.clientX - r.left) / r.width) * 255)), Math.min(255, Math.max(0, (1 - (e.clientY - r.top) / r.height) * 255))];
  };
  canvas.addEventListener("pointerdown", (e) => {
    const [x, y] = toCurve(e);
    const pts = points();
    let hit = pts.findIndex(([px, py]) => Math.abs(px - x) < 7 && Math.abs(py - y) < 7);
    if (hit < 0) {
      if (pts.length >= 16) return;
      pts.push([x, y]);
      pts.sort((a, b) => a[0] - b[0]);
      hit = pts.findIndex((p) => p[0] === x && p[1] === y);
      ctx.live();
    }
    selected = hit;
    draw();
    canvas.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const [nx, ny] = toCurve(ev);
      const list = points();
      const i = selected;
      const r = canvas.getBoundingClientRect();
      const out = ev.clientY < r.top - 30 || ev.clientY > r.bottom + 30 || ev.clientX < r.left - 30 || ev.clientX > r.right + 30;
      // Dragging a middle point off the graph removes it, as in Photoshop.
      if (out && i > 0 && i < list.length - 1) {
        list.splice(i, 1);
        selected = -1;
        ctx.live();
        draw();
        return;
      }
      if (i < 0) return;
      // Points keep their order: each stays between its neighbours.
      const lo = i > 0 ? list[i - 1][0] + 1 : 0, hi = i < list.length - 1 ? list[i + 1][0] - 1 : 255;
      list[i] = [Math.min(hi, Math.max(lo, nx)), ny];
      ctx.live();
      draw();
    };
    const up = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      ctx.commit("Curves");
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
  });
  const typed = () => {
    const pts = points();
    const p = pts[selected];
    if (!p) return;
    const lo = selected > 0 ? pts[selected - 1][0] + 1 : 0, hi = selected < pts.length - 1 ? pts[selected + 1][0] - 1 : 255;
    pts[selected] = [Math.min(hi, Math.max(lo, Number(inBox.value) || 0)), Math.min(255, Math.max(0, Number(outBox.value) || 0))];
    ctx.live();
    ctx.commit("Curves");
    draw();
  };
  inBox.addEventListener("change", typed);
  outBox.addEventListener("change", typed);
  const channels = select(CHANNELS, channel, (v) => {
    channel = v;
    selected = -1;
    draw();
  }, "Channel");
  draw();
  return [group(null,
    h("div", { class: "ph-prop-row" }, h("span", null, "Channel"), channels),
    canvas,
    h("div", { class: "ph-prop-row" }, h("span", null, "Input"), inBox, h("span", null, "Output"), outBox),
    h("p", { class: "ph-hint" }, "Click the curve to add a point; drag a point off the graph to remove it."),
    h("button", { class: "btn small", type: "button", onclick: () => {
      spec.curves[channel] = CURVE_IDENTITY.map((p) => [...p] as [number, number]) as CurvePoints;
      selected = -1;
      ctx.live();
      ctx.commit("Curves");
      draw();
    } }, "Reset Channel"))];
}

function hueSatEditor(spec: Extract<AdjSpec, { type: "hueSat" }>, ctx: PropsContext): HTMLElement[] {
  let range: HueRange = "master";
  const body = h("div");
  const draw = () => {
    const r = spec.ranges[range];
    const m = spec.ranges.master;
    body.replaceChildren(...(spec.colorize
      ? [
        slider(ctx, { label: "Hue", min: 0, max: 360, step: 1, get: () => spec.colorizeHue, set: (v) => (spec.colorizeHue = v), track: "linear-gradient(90deg, red, yellow, lime, cyan, blue, magenta, red)" }, "Hue/Saturation"),
        slider(ctx, { label: "Saturation", min: 0, max: 100, step: 1, get: () => spec.colorizeSat, set: (v) => (spec.colorizeSat = v), reset: 25 }, "Hue/Saturation"),
        slider(ctx, { label: "Lightness", min: -100, max: 100, step: 1, get: () => m.light, set: (v) => (m.light = v) }, "Hue/Saturation"),
      ]
      : [
        slider(ctx, { label: "Hue", min: -180, max: 180, step: 1, get: () => r.hue, set: (v) => (r.hue = v), track: "linear-gradient(90deg, cyan, blue, magenta, red, yellow, lime, cyan)" }, "Hue/Saturation"),
        slider(ctx, { label: "Saturation", min: -100, max: 100, step: 1, get: () => r.sat, set: (v) => (r.sat = v) }, "Hue/Saturation"),
        slider(ctx, { label: "Lightness", min: -100, max: 100, step: 1, get: () => r.light, set: (v) => (r.light = v) }, "Hue/Saturation"),
      ]));
  };
  const ranges = select(HUE_RANGES, range, (v) => {
    range = v;
    draw();
  }, "Range");
  const colorize = h("input", { type: "checkbox", checked: spec.colorize });
  colorize.addEventListener("change", () => {
    spec.colorize = colorize.checked;
    ranges.disabled = spec.colorize;
    if (spec.colorize) range = "master";
    ranges.value = range;
    ctx.live();
    ctx.commit("Colorize");
    draw();
  });
  ranges.disabled = spec.colorize;
  draw();
  return [group(null, h("div", { class: "ph-prop-row" }, h("span", null, "Range"), ranges), body, h("label", { class: "ph-check" }, colorize, "Colorize"))];
}

function colorBalanceEditor(spec: Extract<AdjSpec, { type: "colorBalance" }>, ctx: PropsContext): HTMLElement[] {
  let tone: Tone = "midtones";
  const body = h("div");
  const pairs: [string, string, string][] = [["Cyan", "Red", "linear-gradient(90deg, #00b8c8, #888, #e03a3a)"], ["Magenta", "Green", "linear-gradient(90deg, #d23ad2, #888, #3ac83a)"], ["Yellow", "Blue", "linear-gradient(90deg, #e0d23a, #888, #3a5ae0)"]];
  const draw = () => {
    const t = spec.tones[tone];
    body.replaceChildren(...pairs.map(([a, b, track], i) =>
      slider(ctx, { label: `${a} – ${b}`, min: -100, max: 100, step: 1, get: () => t[i], set: (v) => (t[i] = v), track }, "Color Balance")));
  };
  const tones = h("div", { class: "segmented small" }, ...(["shadows", "midtones", "highlights"] as Tone[]).map((t) => {
    const button = h("button", { type: "button", class: t === tone ? "active" : "", onclick: () => {
      tone = t;
      for (const b of tones.children) b.classList.toggle("active", b === button);
      draw();
    } }, t === "shadows" ? "Shadows" : t === "midtones" ? "Midtones" : "Highlights");
    return button;
  }));
  draw();
  return [group(null, tones, body, check(ctx, "Preserve Luminosity", () => spec.preserve, (v) => (spec.preserve = v)))];
}

function blackWhiteEditor(spec: Extract<AdjSpec, { type: "blackWhite" }>, ctx: PropsContext): HTMLElement[] {
  const colors: [keyof typeof spec & ("reds" | "yellows" | "greens" | "cyans" | "blues" | "magentas"), string, string, number][] = [
    ["reds", "Reds", "#e03a3a", 40], ["yellows", "Yellows", "#e0d23a", 60], ["greens", "Greens", "#3ac83a", 40],
    ["cyans", "Cyans", "#00b8c8", 60], ["blues", "Blues", "#3a5ae0", 20], ["magentas", "Magentas", "#d23ad2", 80],
  ];
  return [
    group(null, ...colors.map(([key, label, color, d]) =>
      slider(ctx, { label, min: -200, max: 300, step: 1, get: () => spec[key], set: (v) => (spec[key] = v), format: (v) => `${Math.round(v)}%`, reset: d, track: `linear-gradient(90deg, #000, ${color})` }, "Black & White"))),
    group("Tint",
      check(ctx, "Tint", () => spec.tint, (v) => (spec.tint = v)),
      slider(ctx, { label: "Hue", min: 0, max: 360, step: 1, get: () => spec.tintHue, set: (v) => (spec.tintHue = v), format: (v) => `${Math.round(v)}°`, reset: 42, track: "linear-gradient(90deg, red, yellow, lime, cyan, blue, magenta, red)" }, "Black & White"),
      slider(ctx, { label: "Saturation", min: 0, max: 100, step: 1, get: () => spec.tintSat, set: (v) => (spec.tintSat = v), format: (v) => `${Math.round(v)}%`, reset: 20 }, "Black & White")),
  ];
}

/** The editor for a spec, or null for Light & Colour (the editor's own sliders). */
export function specEditor(spec: AdjSpec, ctx: PropsContext): HTMLElement[] | null {
  switch (spec.type) {
    case "basic":
      return null;
    case "levels":
      return levelsEditor(spec, ctx);
    case "curves":
      return curvesEditor(spec, ctx);
    case "hueSat":
      return hueSatEditor(spec, ctx);
    case "colorBalance":
      return colorBalanceEditor(spec, ctx);
    case "blackWhite":
      return blackWhiteEditor(spec, ctx);
    case "vibrance":
      return [group(null,
        slider(ctx, { label: "Vibrance", min: -100, max: 100, step: 1, get: () => spec.vibrance, set: (v) => (spec.vibrance = v) }),
        slider(ctx, { label: "Saturation", min: -100, max: 100, step: 1, get: () => spec.saturation, set: (v) => (spec.saturation = v) }))];
    case "exposure":
      return [group(null,
        slider(ctx, { label: "Exposure", min: -20, max: 20, step: 0.01, get: () => spec.exposure, set: (v) => (spec.exposure = v), format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}` }),
        slider(ctx, { label: "Offset", min: -0.5, max: 0.5, step: 0.0001, get: () => spec.offset, set: (v) => (spec.offset = v), format: (v) => v.toFixed(4) }),
        slider(ctx, { label: "Gamma Correction", min: 0.01, max: 9.99, step: 0.01, get: () => spec.gamma, set: (v) => (spec.gamma = v), format: (v) => v.toFixed(2), reset: 1 }))];
    case "photoFilter": {
      const preset = h("select", { class: "ph-select small", "aria-label": "Filter" }, h("option", { value: "" }, "Custom"), ...PHOTO_FILTERS.map((f) => h("option", { value: f.color }, f.label)));
      preset.value = PHOTO_FILTERS.some((f) => f.color === spec.color) ? spec.color : "";
      const color = colorField(ctx, "Colour", () => spec.color, (v) => {
        spec.color = v;
        preset.value = PHOTO_FILTERS.some((f) => f.color === v) ? v : "";
      });
      preset.addEventListener("change", () => {
        if (!preset.value) return;
        spec.color = preset.value;
        (color.querySelector("input") as HTMLInputElement).value = spec.color;
        ctx.live();
        ctx.commit("Photo Filter");
      });
      return [group(null,
        h("div", { class: "ph-prop-row" }, h("span", null, "Filter"), preset),
        color,
        slider(ctx, { label: "Density", min: 1, max: 100, step: 1, get: () => spec.density, set: (v) => (spec.density = v), format: (v) => `${Math.round(v)}%`, reset: 25 }),
        check(ctx, "Preserve Luminosity", () => spec.preserve, (v) => (spec.preserve = v)))];
    }
    case "gradientMap":
      return [group(null,
        colorField(ctx, "Shadows", () => spec.from, (v) => (spec.from = v)),
        colorField(ctx, "Highlights", () => spec.to, (v) => (spec.to = v)),
        check(ctx, "Reverse", () => spec.reverse, (v) => (spec.reverse = v)))];
    case "invert":
      return [group(null, h("p", { class: "ph-hint" }, "Every colour below becomes its opposite. Use the layer's opacity or mask to limit it."))];
    case "posterize":
      return [group(null, slider(ctx, { label: "Levels", min: 2, max: 255, step: 1, get: () => spec.levels, set: (v) => (spec.levels = v), reset: 4 }))];
    case "threshold": {
      const hist = ctx.histogram();
      const canvas = h("canvas", { class: "ph-histogram" });
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(236 * dpr);
      canvas.height = Math.round(72 * dpr);
      drawHistogram(canvas.getContext("2d")!, canvas.width, canvas.height, binsFor(hist, "rgb"), CHANNEL_COLORS.rgb);
      return [group(null, canvas, slider(ctx, { label: "Threshold Level", min: 1, max: 255, step: 1, get: () => spec.level, set: (v) => (spec.level = v), reset: 128 }))];
    }
  }
}
