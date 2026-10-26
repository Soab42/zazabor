import { normalizeAdjust, type Adjustments } from "./adjust";
import type { OpenedProject } from "./api";
import { isBlendMode, type BlendMode } from "./engine";
import { normalizeSpec, type AdjSpec } from "./layeradjust";
import { normalizeSource, type LayerSource } from "./vector";

/**
 * `document.json` in a `.coreimage` project. Pixel layers and masks point at `layers/<data>.png`;
 * the order is bottom first, as in the editor, and a layer in a group names the group by its
 * index in this list. Version 1 files (no groups, masks or other adjustments) read the same way.
 */
export interface ProjectJson {
  app: "CorePro Photo";
  version: 2;
  width: number;
  height: number;
  active: number;
  layers: ProjectLayerJson[];
}

interface MaskJson {
  x: number;
  y: number;
  fill: number;
  enabled: boolean;
  data: number;
}

interface LayerJsonBase {
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  /** The group's index in `layers`, or null at the top. */
  parent: number | null;
  clip: boolean;
  mask: MaskJson | null;
}

export type ProjectLayerJson =
  | (LayerJsonBase & { kind: "pixel"; x: number; y: number; width: number; height: number; data: number; source: LayerSource | null })
  | (LayerJsonBase & { kind: "adjust"; adjust: Adjustments; spec: AdjSpec })
  | (LayerJsonBase & { kind: "group"; passThrough: boolean; open: boolean });

export interface LoadedMask {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: number;
  enabled: boolean;
  /** Grey as RGBA. */
  rgba: Uint8Array;
}

interface LoadedBase {
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  parent: number | null;
  clip: boolean;
  mask: LoadedMask | null;
}

/** A layer read from a project, checked: names are plain text, numbers in range. */
export type LoadedLayer =
  | (LoadedBase & { kind: "pixel"; x: number; y: number; width: number; height: number; rgba: Uint8Array; source: LayerSource | null })
  | (LoadedBase & { kind: "adjust"; adjust: Adjustments; spec: AdjSpec })
  | (LoadedBase & { kind: "group"; passThrough: boolean; open: boolean });

export interface LoadedProject {
  width: number;
  height: number;
  active: number;
  layers: LoadedLayer[];
  icc: Uint8Array;
}

const MAX_SIDE = 65536;

/** Reads a project's document, refusing anything that doesn't add up. */
export function loadProject(opened: OpenedProject, maxTexture: number): LoadedProject {
  let raw: unknown;
  try {
    raw = JSON.parse(opened.json);
  } catch {
    throw new Error("The project's document is damaged.");
  }
  const doc = raw as Partial<ProjectJson> & { layers?: unknown };
  const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  const width = int(doc.width, 1, MAX_SIDE), height = int(doc.height, 1, MAX_SIDE);
  if (!width || !height || !Array.isArray(doc.layers)) throw new Error("The project's document is damaged.");
  if (width > maxTexture || height > maxTexture) throw new Error(`This project is larger than this computer's graphics can hold (${maxTexture} px).`);
  const entries = (doc.layers as unknown[]).filter((e): e is Record<string, unknown> => !!e && typeof e === "object");
  const pixels = (n: unknown, what: string) => {
    const data = int(n, 0, opened.layers.length - 1);
    if (data === null) throw new Error(`${what} is missing from the project.`);
    const p = opened.layers[data];
    if (p.width > maxTexture || p.height > maxTexture) throw new Error(`${what} is larger than this computer's graphics can hold.`);
    return p;
  };
  const layers: LoadedLayer[] = [];
  // Indices change when unknown entries are skipped; groups are named by their old index.
  const kept = new Map<number, number>();
  entries.forEach((item, at) => {
    const name = typeof item.name === "string" ? item.name.slice(0, 200) : "Layer";
    let mask: LoadedMask | null = null;
    if (item.mask && typeof item.mask === "object") {
      const m = item.mask as Record<string, unknown>;
      const p = pixels(m.data, `The mask of “${name}”`);
      mask = {
        x: int(m.x, -MAX_SIDE, MAX_SIDE) ?? 0,
        y: int(m.y, -MAX_SIDE, MAX_SIDE) ?? 0,
        width: p.width,
        height: p.height,
        fill: typeof m.fill === "number" && m.fill <= 0.5 ? 0 : 1,
        enabled: m.enabled !== false,
        rgba: p.rgba,
      };
    }
    const parentAt = int(item.parent, 0, entries.length - 1);
    const base: LoadedBase = {
      name,
      visible: item.visible !== false,
      opacity: typeof item.opacity === "number" && Number.isFinite(item.opacity) ? Math.min(1, Math.max(0, item.opacity)) : 1,
      blend: isBlendMode(item.blend) ? item.blend : "normal",
      // A group comes after (above) its layers.
      parent: parentAt !== null && parentAt > at ? parentAt : null,
      clip: item.clip === true,
      mask,
    };
    if (item.kind === "adjust") {
      layers.push({ ...base, kind: "adjust", adjust: normalizeAdjust(item.adjust), spec: normalizeSpec(item.spec ?? { type: "basic" }) });
    } else if (item.kind === "group") {
      layers.push({ ...base, kind: "group", passThrough: item.passThrough !== false, open: item.open !== false });
    } else if (item.kind === "pixel") {
      const p = pixels(item.data, `Layer “${name}”`);
      layers.push({
        ...base,
        kind: "pixel",
        x: int(item.x, -MAX_SIDE, MAX_SIDE) ?? 0,
        y: int(item.y, -MAX_SIDE, MAX_SIDE) ?? 0,
        width: p.width,
        height: p.height,
        rgba: p.rgba,
        source: normalizeSource(item.source),
      });
    } else return;
    kept.set(at, layers.length - 1);
  });
  for (const layer of layers) {
    const parent = layer.parent === null ? undefined : kept.get(layer.parent);
    layer.parent = parent !== undefined && layers[parent].kind === "group" ? parent : null;
  }
  if (!layers.length) throw new Error("The project has no layers.");
  return { width, height, active: int(doc.active, 0, layers.length - 1) ?? layers.length - 1, layers, icc: opened.icc };
}
