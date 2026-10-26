import { invoke } from "@tauri-apps/api/core";
import { basename } from "../../../ui/dom";

/** A picture as Rust decoded it: upright 8-bit RGBA, with what to write back when saving. */
export interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** The embedded colour profile; empty when there was none (sRGB). */
  icc: Uint8Array;
  exif: Uint8Array;
  /** Scaled down to fit the GPU. */
  scaled: boolean;
}

/** Formats Photo saves pictures in. JPEG and BMP keep no transparency (see `hasAlpha`). */
export type SaveFormat = "jpeg" | "png" | "webp" | "tiff" | "bmp";

export const SAVE_FORMATS: { id: SaveFormat; name: string; extension: string }[] = [
  { id: "jpeg", name: "JPEG", extension: "jpg" },
  { id: "png", name: "PNG", extension: "png" },
  { id: "webp", name: "WebP (lossless)", extension: "webp" },
  { id: "tiff", name: "TIFF", extension: "tiff" },
  { id: "bmp", name: "BMP", extension: "bmp" },
];

/** Whether a format keeps transparency; pictures for the others are flattened onto white first. */
export const hasAlpha = (format: SaveFormat) => format !== "jpeg" && format !== "bmp";

/** Pictures Photo and Quick Edit can open (decoded in Rust). */
export const EDITABLE = ["png", "jpg", "jpeg", "jpe", "jfif", "webp", "bmp", "gif", "tif", "tiff"];

export function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export const canEdit = (path: string) => EDITABLE.includes(extensionOf(path));

/** The format a picture is saved back in: its own, or PNG for a GIF (animation can't be kept). */
export function formatFor(path: string): SaveFormat {
  const ext = extensionOf(path);
  if (["jpg", "jpeg", "jpe", "jfif"].includes(ext)) return "jpeg";
  if (ext === "webp") return "webp";
  if (ext === "tif" || ext === "tiff") return "tiff";
  if (ext === "bmp") return "bmp";
  return "png";
}

function bytesOf(result: unknown): Uint8Array {
  return result instanceof ArrayBuffer ? new Uint8Array(result) : result instanceof Uint8Array ? result : new Uint8Array(result as number[]);
}

const headerValue = (text: string) => encodeURIComponent(text).replace(/%2F/g, "/");

const u32 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A pixel layer as it goes into a project file. */
export interface ProjectLayer {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface OpenedProject {
  json: string;
  icc: Uint8Array;
  layers: ProjectLayer[];
}

export const photoApi = {
  /** Decodes a picture; `maxDim` (the GPU's texture limit) scales larger ones down. */
  async decode(path: string, maxDim: number): Promise<Decoded> {
    const bytes = bytesOf(await invoke("photo_decode", { path, maxDim }));
    if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(0, 4)) !== "CPIM") throw new Error(`Couldn’t read ${basename(path)}.`);
    const [width, height, iccLen, exifLen, flags] = [4, 8, 12, 16, 20].map((at) => u32(bytes, at));
    let at = 24;
    const icc = bytes.subarray(at, (at += iccLen));
    const exif = bytes.subarray(at, (at += exifLen));
    const rgba = bytes.subarray(at, at + width * height * 4);
    if (rgba.length !== width * height * 4) throw new Error(`Couldn’t read ${basename(path)}.`);
    return { width, height, rgba, icc, exif, scaled: (flags & 1) === 1 };
  },

  /** Saves RGBA pixels as a picture with its profile and EXIF data. Returns the new mtime. */
  encode(path: string, o: { rgba: Uint8Array; width: number; height: number; format: SaveFormat; quality?: number; icc?: Uint8Array; exif?: Uint8Array }) {
    const icc = o.icc ?? new Uint8Array(0);
    const exif = o.format === "jpeg" || o.format === "png" || o.format === "webp" ? o.exif ?? new Uint8Array(0) : new Uint8Array(0);
    const meta = { width: o.width, height: o.height, format: o.format, quality: Math.round(o.quality ?? 92), iccLen: icc.length, exifLen: exif.length };
    return invoke<number>("photo_encode", concat([o.rgba, icc, exif]), { headers: { "x-path": headerValue(path), "x-meta": headerValue(JSON.stringify(meta)) } });
  },

  /** "IMG_1234 (edited).jpg" next to the picture, numbered when that exists. */
  copyPath: (path: string, ext?: string) => invoke<string>("photo_copy_path", { path, ext: ext ?? null }),

  saveProject(path: string, o: { json: string; layers: ProjectLayer[]; preview: ProjectLayer; icc: Uint8Array }) {
    const json = new TextEncoder().encode(o.json);
    const meta = { jsonLen: json.length, layers: o.layers.map((l) => [l.width, l.height]), preview: [o.preview.width, o.preview.height], iccLen: o.icc.length };
    return invoke<number>("photo_project_save", concat([json, ...o.layers.map((l) => l.rgba), o.preview.rgba, o.icc]), {
      headers: { "x-path": headerValue(path), "x-meta": headerValue(JSON.stringify(meta)) },
    });
  },

  async openProject(path: string): Promise<OpenedProject> {
    const bytes = bytesOf(await invoke("photo_project_open", { path }));
    if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(0, 4)) !== "CPPJ") throw new Error(`${basename(path)} isn’t a Photo project.`);
    const [jsonLen, iccLen, count] = [4, 8, 12].map((at) => u32(bytes, at));
    let at = 16;
    const json = new TextDecoder().decode(bytes.subarray(at, (at += jsonLen)));
    const icc = bytes.subarray(at, (at += iccLen));
    const layers: ProjectLayer[] = [];
    for (let i = 0; i < count; i++) {
      const width = u32(bytes, at), height = u32(bytes, at + 4);
      at += 8;
      layers.push({ width, height, rgba: bytes.subarray(at, (at += width * height * 4)) });
    }
    return { json, icc, layers };
  },
};
