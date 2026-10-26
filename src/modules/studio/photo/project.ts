import { normalizeAdjust, type Adjustments } from "./adjust";
import type { OpenedProject } from "./api";
import { isBlendMode, type BlendMode } from "./engine";

/**
 * `document.json` in a `.coreimage` project. Pixel layers point at `layers/<data>.png`; the order
 * is bottom first, as in the editor.
 */
export interface ProjectJson {
  app: "CorePro Photo";
  version: 1;
  width: number;
  height: number;
  active: number;
  layers: ProjectLayerJson[];
}

interface LayerJsonBase {
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
}

export type ProjectLayerJson =
  | (LayerJsonBase & { kind: "pixel"; x: number; y: number; width: number; height: number; data: number })
  | (LayerJsonBase & { kind: "adjust"; adjust: Adjustments });

/** A layer read from a project, checked: names are plain text, numbers in range. */
export type LoadedLayer =
  | (LayerJsonBase & { kind: "pixel"; x: number; y: number; width: number; height: number; rgba: Uint8Array })
  | (LayerJsonBase & { kind: "adjust"; adjust: Adjustments });

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
  const layers: LoadedLayer[] = [];
  for (const entry of doc.layers as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const base: LayerJsonBase = {
      name: typeof item.name === "string" ? item.name.slice(0, 200) : "Layer",
      visible: item.visible !== false,
      opacity: typeof item.opacity === "number" && Number.isFinite(item.opacity) ? Math.min(1, Math.max(0, item.opacity)) : 1,
      blend: isBlendMode(item.blend) ? item.blend : "normal",
    };
    if (item.kind === "adjust") {
      layers.push({ ...base, kind: "adjust", adjust: normalizeAdjust(item.adjust) });
      continue;
    }
    if (item.kind !== "pixel") continue;
    const data = int(item.data, 0, opened.layers.length - 1);
    if (data === null) throw new Error(`Layer “${base.name}” is missing from the project.`);
    const pixels = opened.layers[data];
    if (pixels.width > maxTexture || pixels.height > maxTexture) throw new Error(`Layer “${base.name}” is larger than this computer's graphics can hold.`);
    layers.push({
      ...base,
      kind: "pixel",
      x: int(item.x, -MAX_SIDE, MAX_SIDE) ?? 0,
      y: int(item.y, -MAX_SIDE, MAX_SIDE) ?? 0,
      width: pixels.width,
      height: pixels.height,
      rgba: pixels.rgba,
    });
  }
  if (!layers.length) throw new Error("The project has no layers.");
  return { width, height, active: int(doc.active, 0, layers.length - 1) ?? layers.length - 1, layers, icc: opened.icc };
}
