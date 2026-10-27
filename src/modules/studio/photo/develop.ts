import { invoke } from "@tauri-apps/api/core";
import { h } from "../../../ui/dom";
import { photoApi, type Decoded } from "./api";

/**
 * Camera RAW files (src-tauri/src/photo/raw.rs). A RAW file opens as one layer developed as shot;
 * the layer remembers the file and its Develop settings, so the Properties panel can develop it
 * again: white balance, exposure, highlights, shadows and the colour space.
 */

/** Extensions LibRaw opens. */
export const RAW_EXTENSIONS = [
  "3fr", "arw", "cr2", "cr3", "crw", "dcr", "dng", "erf", "fff", "iiq", "k25", "kdc", "mef", "mos", "mrw", "nef", "nrw", "orf", "pef",
  "raf", "raw", "rw2", "rwl", "sr2", "srf", "srw", "x3f",
];

export const isRaw = (path: string) => RAW_EXTENSIONS.includes(path.slice(path.lastIndexOf(".") + 1).toLowerCase());

export interface DevelopSettings {
  /** Kelvin; null for as shot. */
  temperature: number | null;
  tint: number;
  exposure: number;
  highlights: number;
  shadows: number;
  space: "srgb" | "p3";
}

export const DEFAULT_DEVELOP: DevelopSettings = { temperature: null, tint: 0, exposure: 0, highlights: 50, shadows: 0, space: "srgb" };

/** What a layer developed from a RAW file keeps. */
export interface RawState {
  path: string;
  settings: DevelopSettings;
}

export interface RawInfo {
  width: number;
  height: number;
  make: string;
  model: string;
  iso: number;
  shutter: number;
  aperture: number;
  focal: number;
  asShotTemperature: number;
  asShotTint: number;
}

/** White balance presets, as in Lightroom and Camera Raw. */
export const WB_PRESETS: { id: string; label: string; temperature: number | null; tint: number }[] = [
  { id: "asShot", label: "As Shot", temperature: null, tint: 0 },
  { id: "daylight", label: "Daylight", temperature: 5500, tint: 10 },
  { id: "cloudy", label: "Cloudy", temperature: 6500, tint: 10 },
  { id: "shade", label: "Shade", temperature: 7500, tint: 10 },
  { id: "tungsten", label: "Tungsten", temperature: 2850, tint: 0 },
  { id: "fluorescent", label: "Fluorescent", temperature: 3800, tint: 21 },
  { id: "flash", label: "Flash", temperature: 5500, tint: 0 },
];

export function normalizeDevelop(raw: unknown): DevelopSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    temperature: typeof r.temperature === "number" && Number.isFinite(r.temperature) ? Math.min(25000, Math.max(1800, r.temperature)) : null,
    tint: num(r.tint, -100, 100, 0),
    exposure: num(r.exposure, -5, 5, 0),
    highlights: num(r.highlights, 0, 100, 50),
    shadows: num(r.shadows, -100, 100, 0),
    space: r.space === "p3" ? "p3" : "srgb",
  };
}

export const rawApi = {
  info: (path: string) => invoke<RawInfo>("photo_raw_info", { path }),
  /** Develops the file again; same shape as a decoded picture. */
  async develop(path: string, settings: DevelopSettings, maxDim: number): Promise<Decoded> {
    return photoApi.unpack(await invoke("photo_raw_develop", { path, settings, maxDim }), path);
  },
};

export interface DevelopPanelHost {
  /** Settings changed: `final` once a slider is let go (one History step). */
  change(next: DevelopSettings, label: string, final: boolean): void;
}

const shutterText = (s: number) => (s <= 0 ? "" : s >= 1 ? `${s.toFixed(s >= 10 ? 0 : 1)} s` : `1/${Math.round(1 / s)} s`);

/** The Develop panel for a RAW layer. */
export function developPanel(state: RawState, info: RawInfo | null, host: DevelopPanelHost): HTMLElement[] {
  let s = { ...state.settings };
  const asShotT = info?.asShotTemperature ?? 5500;
  const asShotTint = info?.asShotTint ?? 0;
  const preset = h("select", { class: "ph-select small", "aria-label": "White balance" }, ...WB_PRESETS.map((p) => h("option", { value: p.id }, p.label)), h("option", { value: "custom" }, "Custom"));
  const presetOf = (x: DevelopSettings) => WB_PRESETS.find((p) => p.temperature === x.temperature && (p.temperature === null || p.tint === x.tint))?.id ?? "custom";
  const sliders: { input: HTMLInputElement; value: HTMLElement; get: () => number; text: (v: number) => string }[] = [];
  const sync = () => {
    preset.value = presetOf(s);
    for (const sl of sliders) {
      sl.input.value = String(sl.get());
      sl.value.textContent = sl.text(sl.get());
    }
  };
  const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, text: (v: number) => string, reset: number) => {
    const input = h("input", { type: "range", class: "ph-prop-range", min, max, step, value: get(), "aria-label": label });
    const value = h("span", { class: "ph-prop-value" }, text(get()));
    sliders.push({ input, value, get, text });
    input.addEventListener("input", () => {
      set(Number(input.value));
      sync();
      host.change({ ...s }, label, false);
    });
    input.addEventListener("change", () => host.change({ ...s }, label, true));
    input.addEventListener("dblclick", () => {
      set(reset);
      sync();
      host.change({ ...s }, label, true);
    });
    return h("label", { class: "ph-prop" }, h("span", null, label), value, input);
  };
  preset.addEventListener("change", () => {
    const p = WB_PRESETS.find((x) => x.id === preset.value);
    if (!p) return;
    s = { ...s, temperature: p.temperature, tint: p.temperature === null ? 0 : p.tint };
    sync();
    host.change({ ...s }, "White Balance", true);
  });
  const temperature = slider("Temperature", 2000, 12000, 50, () => s.temperature ?? asShotT, (v) => {
    // Leaving As Shot keeps its tint.
    if (s.temperature === null) s.tint = asShotTint;
    s.temperature = v;
  }, (v) => `${Math.round(v)} K`, asShotT);
  const tint = slider("Tint", -100, 100, 1, () => (s.temperature === null ? asShotTint : s.tint), (v) => {
    if (s.temperature === null) s.temperature = asShotT;
    s.tint = v;
  }, (v) => `${v > 0 ? "+" : ""}${Math.round(v)}`, asShotTint);
  const space = h("div", { class: "segmented" }, ...(["srgb", "p3"] as const).map((id) => {
    const button = h("button", { type: "button", class: s.space === id ? "active" : "", onclick: () => {
      if (s.space === id) return;
      s = { ...s, space: id };
      for (const other of space.children) other.classList.toggle("active", other === button);
      host.change({ ...s }, "Colour Space", true);
    } }, id === "srgb" ? "sRGB" : "Display P3");
    return button;
  }));
  const camera = info ? [info.make, info.model].filter(Boolean).join(" ") : "";
  const exif = info ? [info.iso ? `ISO ${Math.round(info.iso)}` : "", shutterText(info.shutter), info.aperture ? `f/${info.aperture.toFixed(1)}` : "", info.focal ? `${Math.round(info.focal)} mm` : ""].filter(Boolean).join(" · ") : "";
  sync();
  return [
    h("p", { class: "ph-empty" }, camera ? `${camera}${exif ? ` · ${exif}` : ""}` : "A camera RAW file."),
    h("div", { class: "ph-prop-group" }, h("h4", null, "White Balance"), preset, temperature, tint),
    h("div", { class: "ph-prop-group" }, h("h4", null, "Tone"),
      slider("Exposure", -5, 5, 0.05, () => s.exposure, (v) => (s.exposure = v), (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} EV`, 0),
      slider("Highlights", 0, 100, 1, () => s.highlights, (v) => (s.highlights = v), (v) => `${Math.round(v)}`, 50),
      slider("Shadows", -100, 100, 1, () => s.shadows, (v) => (s.shadows = v), (v) => `${v > 0 ? "+" : ""}${Math.round(v)}`, 0)),
    h("div", { class: "ph-prop-group" }, h("h4", null, "Colour Space"), space,
      h("p", { class: "ph-empty" }, "Display P3 keeps more of the camera's colours on wide-gamut screens; saved files carry its profile.")),
  ];
}
