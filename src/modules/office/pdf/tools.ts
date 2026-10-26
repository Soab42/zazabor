import { invoke } from "@tauri-apps/api/core";

/**
 * The PDF tools that run in Rust on lopdf (src-tauri/src/office/pdf_tools): annotation kinds
 * pdf.js doesn't make, page content, flattening, passwords, hidden information, redaction and
 * compression. Each call sends the whole file and gets the whole new file back.
 */

export type Rgb = [number, number, number];
export type Face = "helvetica" | "helveticaBold" | "times" | "timesBold" | "courier";
export type AnnotKind = "underline" | "strikeOut" | "squiggly" | "note" | "square" | "circle" | "line" | "arrow" | "polygon";

/** Points and rectangles in the page's own space (PDF points); pages from 1. */
export interface NewAnnot {
  kind: AnnotKind;
  /** Text markup: 8 numbers per piece of text (upper left, upper right, lower left, lower right). */
  quads?: number[];
  /** Lines: x1 y1 x2 y2. Polygons: the corners. */
  points?: number[];
  rect?: [number, number, number, number];
  color: Rgb;
  fill?: Rgb | null;
  width?: number;
  opacity?: number;
  contents?: string;
  author?: string;
}

export interface Bates {
  prefix: string;
  suffix: string;
  start: number;
  digits: number;
}

export type Op =
  | { op: "annotate"; page: number; annot: NewAnnot }
  | { op: "removeAnnots"; refs: [number, number][] }
  | { op: "addText"; page: number; x: number; y: number; text: string; size: number; face: Face; color: Rgb }
  | { op: "addImage"; page: number; x: number; y: number; width: number; height: number; blob: number }
  | { op: "watermark"; pages: number[]; text?: string; face: Face; size: number; color: Rgb; opacity: number; rotation: number; blob?: number; scale: number; behind: boolean }
  | { op: "headerFooter"; pages: number[]; slots: string[]; face: Face; size: number; color: Rgb; margin: number; bates?: Bates; date: string; file: string }
  | { op: "flatten"; comments: boolean; forms: boolean }
  | { op: "protect"; open: string; owner: string; print: boolean; copy: boolean; edit: boolean; comment: boolean }
  | { op: "unprotect"; owner?: string }
  | { op: "sanitize"; metadata: boolean; attachments: boolean; scripts: boolean; comments: boolean }
  | { op: "redact"; pages: { page: number; blob: number; view: number[] }[] }
  | { op: "compress"; dpi: number; quality: number };

function bytesOf(result: unknown): Uint8Array {
  return result instanceof ArrayBuffer ? new Uint8Array(result) : result instanceof Uint8Array ? result : new Uint8Array(result as number[]);
}

/**
 * Runs `ops` on `pdf`. `blobs` are pictures, numbered from 1 in the order given (blob 0 is the
 * file). `password` is the one that opened the file.
 */
export async function pdfEdit(pdf: Uint8Array, password: string | null, ops: Op[], blobs: Uint8Array[] = []): Promise<Uint8Array> {
  const job = new TextEncoder().encode(JSON.stringify({ password, ops }));
  const parts = [pdf, ...blobs];
  const size = 8 + job.length + parts.reduce((n, p) => n + 4 + p.length, 0);
  const body = new Uint8Array(size);
  const view = new DataView(body.buffer);
  let at = 0;
  view.setUint32(at, job.length, true);
  body.set(job, (at += 4));
  at += job.length;
  view.setUint32(at, parts.length, true);
  at += 4;
  for (const p of parts) {
    view.setUint32(at, p.length, true);
    body.set(p, (at += 4));
    at += p.length;
  }
  return bytesOf(await invoke("pdf_edit", body));
}

/** Whether Ghostscript is installed, for "Maximum compression". */
export const hasGhostscript = () => invoke<boolean>("pdf_ghostscript").catch(() => false);

/** Ghostscript's pdfwrite on `pdf` (a file without a password). */
export async function ghostscript(pdf: Uint8Array, preset: "screen" | "ebook" | "printer"): Promise<Uint8Array> {
  return bytesOf(await invoke("pdf_compress_ghostscript", pdf, { headers: { "x-preset": preset } }));
}

/** "#rrggbb" as 0–1 RGB. */
export function rgbOf(hex: string): Rgb {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/** Characters the standard PDF fonts can show (Windows-1252); others go on the page as a picture. */
export function standardText(text: string): boolean {
  const extra = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
  for (const c of text) {
    const code = c.codePointAt(0)!;
    if (c === "\n" || c === "\t" || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || extra.includes(c)) continue;
    return false;
  }
  return true;
}

/** pdf.js annotation ids ("12R", "12R3") as [number, generation]. */
export function refOf(id: string): [number, number] | null {
  const m = id.match(/^(\d+)R(\d*)$/);
  return m ? [Number(m[1]), Number(m[2] || 0)] : null;
}
