import { invoke } from "@tauri-apps/api/core";
import { photoApi } from "../../photo/api";
import { safeSvgText } from "./svgsafe";

/**
 * Motion's files: SVG logos, `.zazkit` Brand Kits (JSON) and `.zaztemplate` packages (a zip the
 * backend writes and reads, src-tauri/src/motion), and the pictures saved templates keep.
 */

const headerValue = (text: string) => encodeURIComponent(text);

/** An SVG file (at most 4 MB) cut down to its geometry (svgsafe.ts): the only form logos are used in. */
export async function readSvg(path: string): Promise<string> {
  const bytes = await photoApi.readFile(path);
  if (bytes.length > 4 * 1024 * 1024) throw new Error("That SVG file is too big for a logo.");
  const safe = safeSvgText(new TextDecoder().decode(bytes));
  if (!safe) throw new Error("That SVG file can't be read as a logo.");
  return safe;
}

export const readBytes = (path: string) => photoApi.readFile(path);

/** `.zazkit` Brand Kits (JSON): read and written only as `.zazkit` files. */
export const readKitText = (path: string) => invoke<string>("motion_kit_read", { path });
export const writeKitText = (path: string, text: string) => invoke<void>("motion_kit_write", { path, text });

/** Writes a `.zaztemplate`: its document and pictures (name → bytes). */
export async function packTemplate(path: string, doc: unknown, assets: [string, Uint8Array][]): Promise<void> {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const parts = [json, ...assets.map(([, b]) => b)];
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    body.set(p, at);
    at += p.length;
  }
  const meta = { doc_len: json.length, assets: assets.map(([name, b]) => [name, b.length]) };
  await invoke<void>("motion_pack", body, { headers: { "x-path": headerValue(path), "x-meta": headerValue(JSON.stringify(meta)) } });
}

/** Reads a `.zaztemplate`: its document (parsed) and pictures. */
export async function unpackTemplate(path: string): Promise<{ doc: unknown; assets: Map<string, Uint8Array> }> {
  const raw = await invoke<ArrayBuffer | number[]>("motion_unpack", { path });
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : Uint8Array.from(raw);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "ZTPK") throw new Error("This isn't a motion template (.zaztemplate).");
  let at = 4;
  const u32 = () => {
    const v = view.getUint32(at, true);
    at += 4;
    return v;
  };
  const docLen = u32();
  const doc = JSON.parse(new TextDecoder().decode(bytes.subarray(at, at + docLen))) as unknown;
  at += docLen;
  const count = u32();
  const assets = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const nameLen = u32();
    const name = new TextDecoder().decode(bytes.subarray(at, at + nameLen));
    at += nameLen;
    const len = u32();
    assets.set(name, bytes.slice(at, at + len));
    at += len;
  }
  return { doc, assets };
}

/** Keeps a saved template's picture in the app's data folder; returns its path. */
export const storeAsset = (owner: string, name: string, bytes: Uint8Array) =>
  invoke<string>("motion_asset_store", bytes, { headers: { "x-owner": headerValue(owner), "x-name": headerValue(name) } });

export const deleteAssets = (owner: string) => invoke<void>("motion_assets_delete", { owner });
