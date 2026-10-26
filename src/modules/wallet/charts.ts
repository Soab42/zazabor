import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";

/**
 * Wallet's charts, after the dataviz rules: thin marks with 4px rounded data ends, recessive
 * hairline grids, one axis, a legend for two series, text in text colours (never the series'),
 * a hover tooltip on every mark, and a table view behind every chart. Colours come from
 * `--viz-*` in wallet.css (validated for both themes).
 */

const SVG = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// ---- tooltip (one per page)

let tip: HTMLElement | null = null;

/** Shows the tooltip near a point: rows of [value, label, colour key]. Values lead, labels follow. */
export function showTip(x: number, y: number, title: string, rows: { value: string; label: string; key?: string; line?: boolean }[]) {
  if (!tip) {
    tip = h("div", { class: "wl-tip", role: "tooltip" });
    document.body.append(tip);
  }
  tip.replaceChildren(
    h("div", { class: "wl-tip-title" }, title),
    ...rows.map((r) => h("div", { class: "wl-tip-row" },
      r.key ? h("span", { class: `wl-tip-key${r.line ? " line" : ""}`, style: { background: r.key } }) : null,
      h("strong", null, r.value), h("span", null, r.label))));
  tip.hidden = false;
  const w = tip.offsetWidth;
  const ht = tip.offsetHeight;
  tip.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, x + 14))}px`;
  tip.style.top = `${Math.min(innerHeight - ht - 8, Math.max(8, y - ht - 10))}px`;
}

export function hideTip() {
  if (tip) tip.hidden = true;
}

/** Hover and keyboard focus show the same details. */
function hover(el: Element, show: (x: number, y: number) => void) {
  el.addEventListener("pointermove", (e) => show((e as PointerEvent).clientX, (e as PointerEvent).clientY));
  el.addEventListener("pointerleave", hideTip);
  el.addEventListener("focus", () => {
    const r = (el as HTMLElement).getBoundingClientRect();
    show(r.left + r.width / 2, r.top);
  });
  el.addEventListener("blur", hideTip);
}

// ---- a card with a chart and its table

export interface TableData {
  head: string[];
  rows: string[][];
}

/** A titled card that shows a chart, or (from its toggle) the same numbers as a table. */
export function chartCard(title: string, subtitle: string | null, chart: HTMLElement | SVGElement, table: TableData, extra: HTMLElement | null = null): HTMLElement {
  let asTable = false;
  const body = h("div", { class: "wl-chart-body" });
  const toggle = h("button", { class: "icon-btn small", type: "button", title: "Show as a table", "aria-label": "Show as a table", "aria-pressed": "false" }, icon("list", 15));
  const tableEl = h("table", { class: "wl-table" },
    h("thead", null, h("tr", null, ...table.head.map((c, i) => h("th", { class: i ? "num" : "" }, c)))),
    h("tbody", null, ...table.rows.map((r) => h("tr", null, ...r.map((c, i) => h("td", { class: i ? "num" : "" }, c))))));
  const draw = () => {
    body.replaceChildren(asTable ? tableEl : chart);
    toggle.classList.toggle("active", asTable);
    toggle.setAttribute("aria-pressed", String(asTable));
    toggle.title = asTable ? "Show as a chart" : "Show as a table";
  };
  toggle.addEventListener("click", () => ((asTable = !asTable), draw()));
  draw();
  return h("section", { class: "wl-card wl-chart-card" },
    h("header", { class: "wl-card-head" },
      h("div", null, h("h3", null, title), subtitle ? h("p", { class: "wl-card-sub" }, subtitle) : null),
      h("span", { class: "spacer" }), extra, table.rows.length ? toggle : null),
    body);
}

// ---- horizontal bars (one series: magnitude by category)

export interface BarRow {
  label: string;
  value: number;
  /** Shown at the tip. */
  text: string;
  glyph?: IconName;
  /** The category's colour, for the icon chip beside the label (identity), not the bar. */
  chipColor?: string;
  /** Extra lines in the tooltip (sub-categories). */
  detail?: { label: string; text: string }[];
  onClick?: () => void;
}

export function hbars(rows: BarRow[], empty = "Nothing spent in this span."): HTMLElement {
  if (!rows.length) return h("p", { class: "wl-chart-empty" }, empty);
  const max = Math.max(...rows.map((r) => r.value), 1);
  return h("div", { class: "wl-hbars" }, ...rows.map((r) => {
    const bar = h("span", { class: "wl-hbar-fill", style: { width: `${Math.max(1.5, (r.value / max) * 100)}%` } });
    const row = h(r.onClick ? "button" : "div", { class: "wl-hbar", type: r.onClick ? "button" : undefined, tabindex: r.onClick ? undefined : 0, onclick: r.onClick },
      h("span", { class: "wl-hbar-label" },
        r.glyph ? h("span", { class: `wl-chip wl-c-${r.chipColor ?? "gray"}`, style: { width: "22px", height: "22px" } }, icon(r.glyph, 12)) : null,
        h("span", { class: "wl-hbar-name", title: r.label }, r.label)),
      h("span", { class: "wl-hbar-track" }, bar),
      h("span", { class: "wl-hbar-value" }, r.text));
    hover(row, (x, y) => showTip(x, y, r.label, [{ value: r.text, label: "spent" }, ...(r.detail ?? []).map((d) => ({ value: d.text, label: d.label }))]));
    return row;
  }));
}

// ---- a meter (a budget): fill carries severity, the track is a lighter step of the same hue

export function meter(ratio: number): HTMLElement {
  const state = ratio > 1 ? "over" : ratio >= 0.8 ? "near" : "ok";
  return h("span", { class: `wl-meter ${state}`, role: "meter", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(ratio * 100) },
    h("span", { class: "wl-meter-fill", style: { width: `${Math.min(100, Math.max(ratio > 0 ? 2 : 0, ratio * 100))}%` } }));
}

// ---- y-axis ticks

function niceStep(max: number, count: number): number {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}

function ticks(min: number, max: number): number[] {
  const step = niceStep(Math.max(max - min, 1), 4);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(v);
  return out;
}

const W = 640;
const PAD = { top: 12, right: 12, bottom: 26, left: 56 };

/** A path for a bar with 4px rounded data end and a square base. */
function barPath(x: number, y: number, w: number, hgt: number): string {
  const r = Math.min(4, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

// ---- grouped columns (two series over months)

export interface Series {
  name: string;
  /** A CSS colour (a `--viz-*` variable). */
  color: string;
  values: number[];
}

export function columns(labels: string[], titles: string[], series: Series[], format: (v: number) => string, axis: (v: number) => string, height = 220): HTMLElement {
  const H = height;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const ys = ticks(0, max);
  const top = ys[ys.length - 1];
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "wl-svg", role: "img", "aria-label": series.map((s) => s.name).join(" and ") });
  for (const t of ys) {
    root.append(svg("line", { x1: PAD.left, x2: W - PAD.right, y1: y(t), y2: y(t), class: t === 0 ? "wl-base" : "wl-grid" }));
    const label = svg("text", { x: PAD.left - 8, y: y(t) + 4, class: "wl-axis", "text-anchor": "end" });
    label.textContent = axis(t);
    root.append(label);
  }
  const band = plotW / labels.length;
  const barW = Math.min(18, (band - 10) / series.length - 2);
  labels.forEach((label, i) => {
    const groupW = series.length * barW + (series.length - 1) * 2;
    const x0 = PAD.left + i * band + (band - groupW) / 2;
    const hit = svg("rect", { x: PAD.left + i * band, y: PAD.top, width: band, height: plotH, class: "wl-hit band", tabindex: 0 });
    series.forEach((s, k) => {
      const v = s.values[i] ?? 0;
      if (v <= 0) return;
      const top = y(v);
      root.append(svg("path", { d: barPath(x0 + k * (barW + 2), top, barW, PAD.top + plotH - top), fill: s.color, class: "wl-mark" }));
    });
    const text = svg("text", { x: PAD.left + i * band + band / 2, y: H - 8, class: "wl-axis", "text-anchor": "middle" });
    text.textContent = label;
    root.append(text, hit);
    hover(hit, (cx, cy) => showTip(cx, cy, titles[i], series.map((s) => ({ value: format(s.values[i] ?? 0), label: s.name, key: s.color }))));
  });
  const legend = h("div", { class: "wl-legend" }, ...series.map((s) => h("span", { class: "wl-legend-item" }, h("span", { class: "wl-legend-key", style: { background: s.color } }), s.name)));
  return h("div", { class: "wl-chart" }, legend, root);
}

// ---- a line with a light wash (one series over months), crosshair tooltip

export function line(labels: string[], titles: string[], values: number[], name: string, format: (v: number) => string, axis: (v: number) => string, height = 220): HTMLElement {
  const H = height;
  const lo = Math.min(0, ...values);
  const hi = Math.max(1, ...values);
  const ys = ticks(lo, hi);
  const min = ys[0];
  const max = ys[ys.length - 1];
  const plotW = W - PAD.left - PAD.right - 70;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (labels.length === 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - ((v - min) / (max - min || 1)) * plotH;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "wl-svg", role: "img", "aria-label": name });
  for (const t of ys) {
    root.append(svg("line", { x1: PAD.left, x2: PAD.left + plotW, y1: y(t), y2: y(t), class: t === 0 ? "wl-base" : "wl-grid" }));
    const label = svg("text", { x: PAD.left - 8, y: y(t) + 4, class: "wl-axis", "text-anchor": "end" });
    label.textContent = axis(t);
    root.append(label);
  }
  const pts = values.map((v, i) => `${x(i)},${y(v)}`);
  const zero = y(Math.max(min, 0));
  root.append(svg("path", { d: `M${x(0)},${zero}L${pts.join("L")}L${x(values.length - 1)},${zero}Z`, class: "wl-area" }));
  root.append(svg("polyline", { points: pts.join(" "), class: "wl-line" }));
  const last = values.length - 1;
  labels.forEach((label, i) => {
    // Past six months, every other label (always the latest).
    if (labels.length > 6 && (last - i) % 2 !== 0) return;
    const text = svg("text", { x: x(i), y: H - 8, class: "wl-axis", "text-anchor": "middle" });
    text.textContent = label;
    root.append(text);
  });
  // The end: a dot with its value beside it.
  root.append(svg("circle", { cx: x(last), cy: y(values[last]), r: 4.5, class: "wl-dot" }));
  const end = svg("text", { x: x(last) + 10, y: y(values[last]) + 4, class: "wl-end-label" });
  end.textContent = format(values[last]);
  root.append(end);
  // The crosshair snaps to the nearest month.
  const cross = svg("line", { x1: 0, x2: 0, y1: PAD.top, y2: PAD.top + plotH, class: "wl-cross" });
  const dot = svg("circle", { cx: 0, cy: 0, r: 4.5, class: "wl-dot" });
  cross.style.display = dot.style.display = "none";
  const hit = svg("rect", { x: PAD.left - 10, y: PAD.top, width: plotW + 20, height: plotH, class: "wl-hit", tabindex: 0 });
  root.append(cross, dot, hit);
  const at = (clientX: number) => {
    const r = root.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    return Math.max(0, Math.min(last, Math.round(((px - PAD.left) / (plotW || 1)) * last)));
  };
  hit.addEventListener("pointermove", (e) => {
    const i = at(e.clientX);
    cross.setAttribute("x1", String(x(i)));
    cross.setAttribute("x2", String(x(i)));
    dot.setAttribute("cx", String(x(i)));
    dot.setAttribute("cy", String(y(values[i])));
    cross.style.display = dot.style.display = "";
    showTip(e.clientX, e.clientY, titles[i], [{ value: format(values[i]), label: name, key: "var(--viz-1)", line: true }]);
  });
  hit.addEventListener("pointerleave", () => {
    cross.style.display = dot.style.display = "none";
    hideTip();
  });
  return h("div", { class: "wl-chart" }, root);
}
