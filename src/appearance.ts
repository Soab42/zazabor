import { WHEEL_CURVE, type Curve } from "./modules/gallery/viewer/easing";
import { clamp, h } from "./ui/dom";

export type GridLayout = "justified" | "square";
export type ThemeMode = "dark" | "light" | "system";

/** How the whole app looks; edited live in Settings. */
export interface Appearance {
  mode: ThemeMode;
  layout: GridLayout;
  /** Pixels between photos in the grid. */
  gap: number;
  /** Corner rounding of grid photos, in pixels. */
  radius: number;
  /** #rrggbb */
  accent: string;
  tone: ToneId;
  /** Cubic-bezier control points for zoom steps (wheel, keys, slider). */
  zoomCurve: Curve;
  /** Extra CSS applied on top of Zazabor's own. */
  customCss: string;
}

const DEFAULT_ACCENT = "#eaa53f";

export const ACCENTS = [DEFAULT_ACCENT, "#e8664a", "#e85d8f", "#a77bf3", "#5b8def", "#3fb8c9", "#4cbb7f", "#c9cbd1"];

type Tone = { label: string; bg: string; raised: string; glass: string };

/**
 * Background tones, each in a dark and a light version: the window backdrop, solid raised
 * surfaces, and the tint of the frosted glass (as "r, g, b"). Charcoal matches the stylesheet.
 */
export const TONES: Record<"charcoal" | "black" | "slate" | "warm" | "graphite", { dark: Tone; light: Tone }> = {
  charcoal: {
    dark: { label: "Charcoal", bg: "#0f1013", raised: "#1a1c20", glass: "28, 30, 35" },
    light: { label: "Soft", bg: "#e9ebef", raised: "#dfe2e7", glass: "248, 248, 250" },
  },
  black: {
    dark: { label: "Black", bg: "#000000", raised: "#121214", glass: "18, 18, 20" },
    light: { label: "White", bg: "#f7f7f8", raised: "#ececee", glass: "255, 255, 255" },
  },
  slate: {
    dark: { label: "Slate", bg: "#0c1118", raised: "#161d27", glass: "24, 31, 42" },
    light: { label: "Cool", bg: "#e4eaf2", raised: "#d9e0ea", glass: "244, 247, 251" },
  },
  warm: {
    dark: { label: "Warm", bg: "#13100d", raised: "#1e1a16", glass: "36, 31, 26" },
    light: { label: "Cream", bg: "#f1ece4", raised: "#e7e0d5", glass: "251, 248, 243" },
  },
  graphite: {
    dark: { label: "Graphite", bg: "#1c1d20", raised: "#27292d", glass: "44, 46, 51" },
    light: { label: "Grey", bg: "#dadce0", raised: "#cfd2d7", glass: "238, 239, 241" },
  },
};

export type ToneId = keyof typeof TONES;

export const ZOOM_CURVES: { label: string; curve: Curve }[] = [
  { label: "Smooth", curve: WHEEL_CURVE },
  { label: "Snappy", curve: [0.2, 0.9, 0.25, 1] },
  { label: "Gentle", curve: [0.33, 1, 0.68, 1] },
  { label: "Glide", curve: [0.16, 1, 0.3, 1] },
  { label: "Bouncy", curve: [0.34, 1.45, 0.64, 1] },
];

export const DEFAULT_APPEARANCE: Appearance = {
  mode: "dark", layout: "justified", gap: 2, radius: 0, accent: DEFAULT_ACCENT, tone: "charcoal", zoomCurve: WHEEL_CURVE, customCss: "",
};

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Fills in missing or invalid fields, e.g. from an older saved config. */
export function normalizeAppearance(raw: Partial<Appearance> | undefined): Appearance {
  const a = { ...DEFAULT_APPEARANCE, ...raw };
  const curve = Array.isArray(a.zoomCurve) && a.zoomCurve.length === 4 && a.zoomCurve.every(isNumber) ? a.zoomCurve : WHEEL_CURVE;
  return {
    mode: a.mode === "light" || a.mode === "system" ? a.mode : "dark",
    layout: a.layout === "square" ? "square" : "justified",
    gap: isNumber(a.gap) ? clamp(Math.round(a.gap), 0, 16) : DEFAULT_APPEARANCE.gap,
    radius: isNumber(a.radius) ? clamp(Math.round(a.radius), 0, 24) : DEFAULT_APPEARANCE.radius,
    accent: typeof a.accent === "string" && /^#[0-9a-f]{6}$/i.test(a.accent) ? a.accent.toLowerCase() : DEFAULT_ACCENT,
    tone: a.tone in TONES ? a.tone : "charcoal",
    zoomCurve: [clamp(curve[0], 0, 1), clamp(curve[1], -1, 2), clamp(curve[2], 0, 1), clamp(curve[3], -1, 2)],
    customCss: typeof a.customCss === "string" ? a.customCss : "",
  };
}

type Rgb = [number, number, number];

const toRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const toHex = (rgb: Rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;

/** Relative luminance (0 black – 1 white). */
function luminance([r, g, b]: Rgb) {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

let customStyle: HTMLStyleElement | null = null;

/** Whether the light palette is in use, following the desktop for "system". */
export const isLight = (a: Appearance) =>
  a.mode === "light" || (a.mode === "system" && matchMedia("(prefers-color-scheme: light)").matches);

/** Applies the theme, colours, grid rounding and custom CSS to the document. */
export function applyAppearance(a: Appearance) {
  const light = isLight(a);
  document.documentElement.dataset.theme = light ? "light" : "dark";
  const root = document.documentElement.style;
  // The stylesheet holds the defaults, so a default value just clears its override.
  const set = (name: string, value: string | null) => (value === null ? root.removeProperty(`--${name}`) : root.setProperty(`--${name}`, value));

  const rgb = toRgb(a.accent);
  const custom = a.accent !== DEFAULT_ACCENT;
  const [r, g, b] = rgb.map(Math.round);
  set("accent", custom ? a.accent : null);
  set("accent-hover", custom ? toHex(mix(rgb, [255, 255, 255], 0.18)) : null);
  set("accent-ink", custom ? (luminance(rgb) > 0.3 ? toHex(mix(rgb, [0, 0, 0], 0.88)) : "#ffffff") : null);
  set("accent-soft", custom ? `rgba(${r}, ${g}, ${b}, ${light ? 0.22 : 0.16})` : null);
  set("focus", custom ? `rgba(${r}, ${g}, ${b}, 0.55)` : null);

  const tone = TONES[a.tone][light ? "light" : "dark"];
  const own = a.tone !== "charcoal";
  set("bg", own ? tone.bg : null);
  set("bg-raised", own ? tone.raised : null);
  set("glass-rgb", own ? tone.glass : null);
  set("tile-radius", a.radius ? `${a.radius}px` : null);

  if (!customStyle) {
    customStyle = h("style", { id: "custom-css" });
    document.head.append(customStyle);
  }
  customStyle.textContent = a.customCss;
}

const curveText = (c: Curve) => `cubic-bezier(${c.map((v) => +v.toFixed(2)).join(", ")})`;
const sameCurve = (a: Curve, b: Curve) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);

/** One labelled control on the Settings page; `label` is what search matches. */
export interface SettingsRow {
  label: string;
  el: HTMLElement;
}

/** A titled card of rows on the Settings page. */
export interface SettingsGroup {
  title: string;
  rows: SettingsRow[];
}

/** The appearance controls for the Settings page; all of them edit one `Appearance` live. */
export interface AppearanceControls {
  /** Theme, accent and background tone. */
  general(): SettingsGroup[];
  /** Photo grid, zoom animation, custom CSS. */
  appearance(): SettingsGroup[];
  /** Re-reads the appearance into every control (after an edit elsewhere). */
  sync(): void;
  /** Applies pending debounced edits (custom CSS) at once. */
  flush(): void;
}

/** Builds the controls once; `onChange` runs after every edit so the app can follow along. */
export function createAppearanceControls(appearance: Appearance, onChange: () => void): AppearanceControls {
  const syncers: (() => void)[] = [];
  const sync = () => {
    for (const fn of syncers) fn();
  };
  const changed = () => {
    sync();
    onChange();
  };
  /** `layout`: "wide" puts the control under its label; "plain" omits the value column. */
  const row = (label: string, control: HTMLElement, value?: HTMLElement, layout: "wide" | "plain" | "" = value ? "" : "plain"): SettingsRow => ({
    label,
    el: h("div", { class: `sf-row${layout ? ` ${layout}` : ""}` }, h("span", { class: "sf-label" }, label), control, value ?? null),
  });

  const segmented = <T extends string>(options: [T, string][], get: () => T, put: (v: T) => void) => {
    const group = h("div", { class: "segmented" });
    const buttons = options.map(([value, text]) => {
      const button = h("button", { type: "button", onclick: () => (put(value), changed()) }, text);
      group.append(button);
      return [value, button] as const;
    });
    syncers.push(() => buttons.forEach(([value, button]) => button.classList.toggle("active", get() === value)));
    return group;
  };

  const slider = (label: string, key: "gap" | "radius", max: number) => {
    const input = h("input", { type: "range", min: 0, max, step: 1 });
    const value = h("span", { class: "sf-value" });
    input.addEventListener("input", () => {
      appearance[key] = Number(input.value);
      changed();
    });
    syncers.push(() => {
      input.value = String(appearance[key]);
      value.textContent = appearance[key] ? `${appearance[key]} px` : "None";
    });
    return row(label, input, value);
  };

  // ---- colours
  const swatches = h("div", { class: "ap-swatches" });
  const accentButtons = ACCENTS.map((color) => {
    const button = h("button", { type: "button", class: "ap-swatch", title: color, style: { background: color } });
    button.addEventListener("click", () => {
      appearance.accent = color;
      changed();
    });
    swatches.append(button);
    return [color, button] as const;
  });
  const picker = h("input", { type: "color", class: "ap-color", title: "Any colour" });
  picker.addEventListener("input", () => {
    appearance.accent = picker.value;
    changed();
  });
  swatches.append(picker);
  syncers.push(() => {
    accentButtons.forEach(([color, button]) => button.classList.toggle("active", color === appearance.accent));
    picker.value = appearance.accent;
    picker.classList.toggle("active", !ACCENTS.includes(appearance.accent));
  });

  // Each tone is shown in the version the current theme will use.
  const tones = h("div", { class: "ap-tones" });
  const toneButtons = (Object.keys(TONES) as ToneId[]).map((id) => {
    const chip = h("span", { class: "ap-tone-chip" });
    const label = h("span");
    const button = h("button", { type: "button", class: "ap-tone" }, chip, label);
    button.addEventListener("click", () => {
      appearance.tone = id;
      changed();
    });
    tones.append(button);
    return { id, button, chip, label };
  });
  syncers.push(() => {
    const light = isLight(appearance);
    for (const { id, button, chip, label } of toneButtons) {
      const tone = TONES[id][light ? "light" : "dark"];
      button.style.background = tone.bg;
      button.style.setProperty("--tone-text", light ? "#1d1d1f" : "#f5f5f7");
      chip.style.background = `rgb(${tone.glass})`;
      label.textContent = tone.label;
      button.classList.toggle("active", id === appearance.tone);
    }
  });

  // ---- zoom curve
  const presets = h("div", { class: "segmented ap-presets" });
  const presetButtons = ZOOM_CURVES.map(({ label, curve }) => {
    const button = h("button", { type: "button" }, label);
    button.addEventListener("click", () => {
      appearance.zoomCurve = [...curve];
      changed();
    });
    presets.append(button);
    return [curve, button] as const;
  });
  const numbers = (["x1", "y1", "x2", "y2"] as const).map((name, i) => {
    const x = i % 2 === 0;
    const input = h("input", { type: "number", class: "ap-num", min: x ? 0 : -1, max: x ? 1 : 2, step: 0.05, title: name });
    input.addEventListener("input", () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || input.value === "") return;
      appearance.zoomCurve[i] = clamp(value, x ? 0 : -1, x ? 1 : 2);
      for (const fn of syncers) if (fn !== syncNumbers) fn();
      onChange();
    });
    return h("label", { class: "ap-num-field" }, h("span", null, name), input);
  });
  const syncNumbers = () => numbers.forEach((field, i) => (field.querySelector("input")!.value = String(+appearance.zoomCurve[i].toFixed(2))));
  syncers.push(syncNumbers);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "-0.15 -0.75 1.3 2.5");
  svg.setAttribute("class", "ap-curve");
  svg.innerHTML = `<rect x="0" y="0" width="1" height="1" class="ap-curve-box"/><path class="ap-curve-handles"/><path class="ap-curve-line"/>`;
  syncers.push(() => {
    const [x1, y1, x2, y2] = appearance.zoomCurve;
    // SVG y grows downward; progress 0 sits at the bottom of the box.
    svg.querySelector(".ap-curve-line")!.setAttribute("d", `M0 1C${x1} ${1 - y1} ${x2} ${1 - y2} 1 0`);
    svg.querySelector(".ap-curve-handles")!.setAttribute("d", `M0 1L${x1} ${1 - y1}M1 0L${x2} ${1 - y2}`);
    presetButtons.forEach(([curve, button]) => button.classList.toggle("active", sameCurve(curve, appearance.zoomCurve)));
  });

  const demoBox = h("div", { class: "ap-demo-box" });
  const demo = h("button", { type: "button", class: "ap-demo", title: "Play the zoom curve" }, demoBox);
  demo.addEventListener("click", () => {
    demoBox.style.transition = `transform 300ms ${curveText(appearance.zoomCurve)}`;
    demoBox.classList.toggle("zoomed");
  });
  const curveEditor = h("div", { class: "ap-curve-row" }, svg, h("div", { class: "ap-curve-side" },
    h("div", { class: "ap-nums" }, ...numbers),
    h("p", { class: "sf-hint" }, "Each wheel notch, ↑ ↓ key and slider move follows this curve. Click the square to try it."),
    demo));

  // ---- custom CSS
  const css = h("textarea", {
    class: "ap-css", spellcheck: false, rows: 7,
    placeholder: "/* For example */\n.cell .thumb { filter: saturate(1.2); }\n.sidebar { background: rgba(var(--glass-rgb), 0.4); }",
  });
  let cssTimer = 0;
  const flush = () => {
    clearTimeout(cssTimer);
    if (css.value === appearance.customCss) return;
    appearance.customCss = css.value;
    onChange();
  };
  css.addEventListener("input", () => {
    clearTimeout(cssTimer);
    cssTimer = window.setTimeout(flush, 250);
  });
  syncers.push(() => {
    if (css.value !== appearance.customCss) css.value = appearance.customCss;
  });

  const reset = h("button", { type: "button", class: "btn", onclick: () => (Object.assign(appearance, structuredClone(DEFAULT_APPEARANCE)), changed()) }, "Reset");

  const groups = {
    general: [
      {
        title: "Colours",
        rows: [
          row("Theme", segmented<ThemeMode>([["dark", "Dark"], ["light", "Light"], ["system", "System"]], () => appearance.mode, (v) => (appearance.mode = v))),
          row("Accent", swatches),
          row("Background tone", tones, undefined, "wide"),
        ],
      },
    ],
    appearance: [
      {
        title: "Photo grid",
        rows: [
          row("Layout", segmented<GridLayout>([["justified", "Justified rows"], ["square", "Square tiles"]], () => appearance.layout, (v) => (appearance.layout = v))),
          slider("Gap", "gap", 16),
          slider("Corners", "radius", 24),
        ],
      },
      {
        title: "Zoom animation",
        rows: [row("Zoom curve", presets), row("Curve editor", curveEditor, undefined, "wide")],
      },
      {
        title: "Custom CSS",
        rows: [
          row("Custom CSS", css, undefined, "wide"),
          row("Reset appearance", reset),
        ],
      },
    ],
  };
  sync();

  return {
    general: () => groups.general,
    appearance: () => groups.appearance,
    sync,
    flush,
  };
}
