import type { AdjustmentLayer, BlendMode as PsdBlend, Layer as PsdLayer, LayerMaskData, Psd } from "ag-psd";
import { DEFAULT_ADJUST } from "./adjust";
import { isBlendMode, layerTree, type BlendMode, type Doc, type Layer, type Surface } from "./engine";
import { defaultSpec, normalizeSpec, type AdjSpec, type Channel, type HueRange } from "./layeradjust";
import type { LoadedLayer, LoadedMask, LoadedProject } from "./project";

/**
 * Photoshop documents through ag-psd (MIT), loaded only when a .psd is opened or saved: pixel
 * layers, groups, masks, clipping, blend modes and the adjustment layers both apps have. Text
 * layers come in as their pixels; Light & Colour layers have no Photoshop equivalent and are left
 * out (the caller is told).
 */

const BLEND_TO_PSD: Record<BlendMode, PsdBlend> = {
  normal: "normal", dissolve: "dissolve", darken: "darken", multiply: "multiply", colorBurn: "color burn",
  linearBurn: "linear burn", darkerColor: "darker color", lighten: "lighten", screen: "screen",
  colorDodge: "color dodge", linearDodge: "linear dodge", lighterColor: "lighter color", overlay: "overlay",
  softLight: "soft light", hardLight: "hard light", vividLight: "vivid light", linearLight: "linear light",
  pinLight: "pin light", hardMix: "hard mix", difference: "difference", exclusion: "exclusion",
  subtract: "subtract", divide: "divide", hue: "hue", saturation: "saturation", color: "color", luminosity: "luminosity",
};
const BLEND_FROM_PSD = new Map(Object.entries(BLEND_TO_PSD).map(([ours, theirs]) => [theirs, ours as BlendMode]));

const CHANNEL_KEYS: [Channel, "rgb" | "red" | "green" | "blue"][] = [["rgb", "rgb"], ["r", "red"], ["g", "green"], ["b", "blue"]];
/** Photoshop's default hue ranges (degrees): fully on from b to c, fading out to a and d. */
const HUE_BANDS: Record<Exclude<HueRange, "master">, [number, number, number, number]> = {
  reds: [315, 345, 15, 45], yellows: [15, 45, 75, 105], greens: [75, 105, 135, 165],
  cyans: [135, 165, 195, 225], blues: [195, 225, 255, 285], magentas: [255, 285, 315, 345],
};

const hex = (c: { r?: number; g?: number; b?: number } | undefined, d: string) => {
  if (!c || typeof c.r !== "number") return d;
  const v = (n: number | undefined) => Math.round(Math.min(255, Math.max(0, n ?? 0))).toString(16).padStart(2, "0");
  return `#${v(c.r)}${v(c.g)}${v(c.b)}`;
};
const rgb = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

/** Our adjustment from Photoshop's; null for kinds Photo doesn't have. */
function specFromPsd(a: AdjustmentLayer): AdjSpec | null {
  switch (a.type) {
    case "levels": {
      const spec = defaultSpec("levels") as Extract<AdjSpec, { type: "levels" }>;
      for (const [ours, theirs] of CHANNEL_KEYS) {
        const c = a[theirs];
        if (c) spec.levels[ours] = { inBlack: c.shadowInput, inWhite: c.highlightInput, gamma: c.midtoneInput || 1, outBlack: c.shadowOutput, outWhite: c.highlightOutput };
      }
      return normalizeSpec(spec);
    }
    case "curves": {
      const spec = defaultSpec("curves") as Extract<AdjSpec, { type: "curves" }>;
      for (const [ours, theirs] of CHANNEL_KEYS) {
        const c = a[theirs];
        if (c && c.length >= 2) spec.curves[ours] = c.map((p) => [p.input, p.output] as [number, number]);
      }
      return normalizeSpec(spec);
    }
    case "exposure":
      return normalizeSpec({ type: "exposure", exposure: a.exposure ?? 0, offset: a.offset ?? 0, gamma: a.gamma ?? 1 });
    case "vibrance":
      return normalizeSpec({ type: "vibrance", vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 });
    case "hue/saturation": {
      const spec = defaultSpec("hueSat") as Extract<AdjSpec, { type: "hueSat" }>;
      for (const key of ["master", "reds", "yellows", "greens", "cyans", "blues", "magentas"] as HueRange[]) {
        const c = a[key];
        if (c) spec.ranges[key] = { hue: c.hue, sat: c.saturation, light: c.lightness };
      }
      return normalizeSpec(spec);
    }
    case "color balance": {
      const t = (v: { cyanRed: number; magentaGreen: number; yellowBlue: number } | undefined): [number, number, number] => (v ? [v.cyanRed, v.magentaGreen, v.yellowBlue] : [0, 0, 0]);
      return normalizeSpec({ type: "colorBalance", tones: { shadows: t(a.shadows), midtones: t(a.midtones), highlights: t(a.highlights) }, preserve: a.preserveLuminosity !== false });
    }
    case "black & white": {
      const tint = hex(a.tintColor as { r?: number; g?: number; b?: number } | undefined, "#e1d3b3");
      const { r, g, b } = rgb(tint);
      const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
      let hue = 0;
      if (mx > mn) {
        const d = mx - mn, R = r / 255, G = g / 255, B = b / 255;
        hue = mx === R ? ((G - B) / d + (G < B ? 6 : 0)) * 60 : mx === G ? ((B - R) / d + 2) * 60 : ((R - G) / d + 4) * 60;
      }
      return normalizeSpec({ type: "blackWhite", reds: a.reds ?? 40, yellows: a.yellows ?? 60, greens: a.greens ?? 40, cyans: a.cyans ?? 60, blues: a.blues ?? 20, magentas: a.magentas ?? 80, tint: !!a.useTint, tintHue: hue, tintSat: mx > 0 ? Math.round(((mx - mn) / Math.max(mx + mn, 1e-6)) * 100) : 0 });
    }
    case "photo filter":
      return normalizeSpec({ type: "photoFilter", color: hex(a.color as { r?: number; g?: number; b?: number } | undefined, "#ec8a00"), density: a.density ?? 25, preserve: a.preserveLuminosity !== false });
    case "invert":
      return { type: "invert" };
    case "posterize":
      return normalizeSpec({ type: "posterize", levels: a.levels ?? 4 });
    case "threshold":
      return normalizeSpec({ type: "threshold", level: a.level ?? 128 });
    case "gradient map": {
      const stops = [...(a.colorStops ?? [])].sort((x, y) => x.location - y.location);
      const first = stops[0]?.color as { r?: number; g?: number; b?: number } | undefined;
      const last = stops[stops.length - 1]?.color as { r?: number; g?: number; b?: number } | undefined;
      return normalizeSpec({ type: "gradientMap", from: hex(first, "#000000"), to: hex(last, "#ffffff"), reverse: !!a.reverse });
    }
    default:
      return null;
  }
}

/** Photoshop's adjustment for ours; null for Light & Colour. */
function specToPsd(spec: AdjSpec): AdjustmentLayer | null {
  switch (spec.type) {
    case "levels": {
      const out: AdjustmentLayer = { type: "levels" };
      for (const [ours, theirs] of CHANNEL_KEYS) {
        const l = spec.levels[ours];
        out[theirs] = { shadowInput: Math.round(l.inBlack), highlightInput: Math.round(l.inWhite), midtoneInput: l.gamma, shadowOutput: Math.round(l.outBlack), highlightOutput: Math.round(l.outWhite) };
      }
      return out;
    }
    case "curves": {
      const out: AdjustmentLayer = { type: "curves" };
      for (const [ours, theirs] of CHANNEL_KEYS) out[theirs] = spec.curves[ours].map(([x, y]) => ({ input: Math.round(x), output: Math.round(y) }));
      return out;
    }
    case "exposure":
      return { type: "exposure", exposure: spec.exposure, offset: spec.offset, gamma: spec.gamma };
    case "vibrance":
      return { type: "vibrance", vibrance: Math.round(spec.vibrance), saturation: Math.round(spec.saturation) };
    case "hueSat": {
      const band = (key: HueRange) => {
        const [a, b, c, d] = key === "master" ? [0, 0, 0, 0] : HUE_BANDS[key];
        const v = spec.ranges[key];
        return { a, b, c, d, hue: Math.round(v.hue), saturation: Math.round(v.sat), lightness: Math.round(v.light) };
      };
      return { type: "hue/saturation", master: band("master"), reds: band("reds"), yellows: band("yellows"), greens: band("greens"), cyans: band("cyans"), blues: band("blues"), magentas: band("magentas") };
    }
    case "colorBalance": {
      const t = (v: [number, number, number]) => ({ cyanRed: Math.round(v[0]), magentaGreen: Math.round(v[1]), yellowBlue: Math.round(v[2]) });
      return { type: "color balance", shadows: t(spec.tones.shadows), midtones: t(spec.tones.midtones), highlights: t(spec.tones.highlights), preserveLuminosity: spec.preserve };
    }
    case "blackWhite": {
      // The tint as a colour: its hue and saturation at middle lightness.
      const h = spec.tintHue / 360, s = spec.tintSat / 100, l = 0.5;
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      const f = (t: number) => {
        t = ((t % 1) + 1) % 1;
        const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
        return Math.round(v * 255);
      };
      return { type: "black & white", reds: Math.round(spec.reds), yellows: Math.round(spec.yellows), greens: Math.round(spec.greens), cyans: Math.round(spec.cyans), blues: Math.round(spec.blues), magentas: Math.round(spec.magentas), useTint: spec.tint, tintColor: { r: f(h + 1 / 3), g: f(h), b: f(h - 1 / 3) } };
    }
    case "photoFilter":
      return { type: "photo filter", color: rgb(spec.color), density: Math.round(spec.density), preserveLuminosity: spec.preserve };
    case "invert":
      return { type: "invert" };
    case "posterize":
      return { type: "posterize", levels: Math.round(spec.levels) };
    case "threshold":
      return { type: "threshold", level: Math.round(spec.level) };
    case "gradientMap":
      return {
        type: "gradient map",
        gradientType: "solid",
        reverse: spec.reverse,
        colorStops: [{ color: rgb(spec.from), location: 0, midpoint: 50 }, { color: rgb(spec.to), location: 4096, midpoint: 50 }],
        opacityStops: [{ opacity: 1, location: 0, midpoint: 50 }, { opacity: 1, location: 4096, midpoint: 50 }],
      } as AdjustmentLayer;
    default:
      return null;
  }
}

const rgbaOf = (data: ArrayLike<number>) => (data instanceof Uint8Array ? data : Uint8Array.from(data as ArrayLike<number>));

/** Reads a .psd into the same shape as a project. Returns what had to be left out too. */
export async function readPsdFile(bytes: Uint8Array, maxTexture: number): Promise<{ project: LoadedProject; skipped: string[] }> {
  const { readPsd } = await import("ag-psd");
  const psd: Psd = readPsd({ buffer: bytes.buffer as ArrayBuffer, byteOffset: bytes.byteOffset, byteLength: bytes.byteLength }, { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true, skipCompositeImageData: true });
  if (psd.width > maxTexture || psd.height > maxTexture) throw new Error(`This document is larger than this computer's graphics can hold (${maxTexture} px).`);
  if ((psd.bitsPerChannel ?? 8) !== 8) throw new Error("Photo opens 8-bit Photoshop documents; this one has more bits per channel.");
  const layers: LoadedLayer[] = [];
  const skipped: string[] = [];
  const mask = (m: LayerMaskData | undefined): LoadedMask | null => {
    if (!m?.imageData || m.right === undefined || m.left === undefined) return null;
    const { width, height, data } = m.imageData;
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i * 4], out[i * 4 + 3] = 255;
    return { x: m.left, y: m.top ?? 0, width, height, fill: (m.defaultColor ?? 0) > 127 ? 1 : 0, enabled: !m.disabled, rgba: out };
  };
  // Each group's layers go in first, then the group (above them); returns the entries' indices.
  const walk = (list: PsdLayer[]): number[] => {
    const direct: number[] = [];
    for (const l of list) {
      const base = {
        name: (l.name ?? "Layer").slice(0, 200),
        visible: !l.hidden,
        opacity: typeof l.opacity === "number" ? Math.min(1, Math.max(0, l.opacity)) : 1,
        blend: BLEND_FROM_PSD.get(l.blendMode ?? "normal") ?? "normal",
        parent: null as number | null,
        clip: !!l.clipping,
        mask: mask(l.mask),
      };
      if (l.children) {
        const kids = walk(l.children);
        layers.push({ ...base, kind: "group", passThrough: l.blendMode === "pass through", open: l.opened !== false });
        for (const k of kids) layers[k].parent = layers.length - 1;
        direct.push(layers.length - 1);
        continue;
      }
      if (l.adjustment) {
        const spec = specFromPsd(l.adjustment);
        if (!spec) {
          skipped.push(base.name);
          continue;
        }
        layers.push({ ...base, kind: "adjust", adjust: { ...DEFAULT_ADJUST }, spec });
      } else {
        const img = l.imageData;
        if (!img || !img.width || !img.height) {
          layers.push({ ...base, kind: "pixel", x: l.left ?? 0, y: l.top ?? 0, width: 1, height: 1, rgba: new Uint8Array(4), source: null });
        } else {
          if (img.width > maxTexture || img.height > maxTexture) throw new Error(`Layer “${base.name}” is larger than this computer's graphics can hold.`);
          layers.push({ ...base, kind: "pixel", x: l.left ?? 0, y: l.top ?? 0, width: img.width, height: img.height, rgba: rgbaOf(img.data), source: null });
        }
      }
      direct.push(layers.length - 1);
    }
    return direct;
  };
  walk(psd.children ?? []);
  if (!layers.length) throw new Error("This Photoshop document has no layers Photo can show.");
  for (const l of layers) if (!isBlendMode(l.blend)) l.blend = "normal";
  return { project: { width: psd.width, height: psd.height, active: layers.length - 1, layers, icc: new Uint8Array(0) }, skipped };
}

/** Writes the document as a .psd: layers (with their masks), groups and adjustments, plus the composite. */
export async function writePsdFile(doc: Doc, read: (s: Surface) => Uint8Array, composite: Uint8Array, _icc: Uint8Array): Promise<Uint8Array> {
  const { writePsdUint8Array } = await import("ag-psd");
  const tree = layerTree(doc.layers);
  const maskOf = (l: Layer): LayerMaskData | undefined => {
    const m = l.mask;
    if (!m) return undefined;
    const rgba = read(m);
    return { left: m.x, top: m.y, right: m.x + m.width, bottom: m.y + m.height, defaultColor: m.fill >= 0.5 ? 255 : 0, disabled: !m.enabled, imageData: { width: m.width, height: m.height, data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength) } };
  };
  const convert = (list: Layer[]): PsdLayer[] => {
    const out: PsdLayer[] = [];
    for (const l of list) {
      const base: PsdLayer = { name: l.name, opacity: l.opacity, blendMode: BLEND_TO_PSD[l.blend], hidden: !l.visible, clipping: l.clip, mask: maskOf(l) };
      if (l.kind === "group") {
        out.push({ ...base, blendMode: l.passThrough ? "pass through" : BLEND_TO_PSD[l.blend], opened: l.open, children: convert(tree.get(l.id) ?? []) });
      } else if (l.kind === "adjust") {
        const adjustment = specToPsd(l.spec);
        if (adjustment) out.push({ ...base, adjustment });
      } else {
        const rgba = read(l);
        out.push({ ...base, left: l.x, top: l.y, right: l.x + l.width, bottom: l.y + l.height, imageData: { width: l.width, height: l.height, data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength) } });
      }
    }
    return out;
  };
  const psd: Psd = {
    width: doc.width,
    height: doc.height,
    children: convert(tree.get(null) ?? []),
    imageData: { width: doc.width, height: doc.height, data: new Uint8ClampedArray(composite.buffer, composite.byteOffset, composite.byteLength) },
  };
  return writePsdUint8Array(psd, { noBackground: true, generateThumbnail: false });
}

/** How many layers Photoshop won't get (Light & Colour adjustments). */
export function unsupportedInPsd(doc: Doc): number {
  return doc.layers.filter((l) => l.kind === "adjust" && l.spec.type === "basic").length;
}
