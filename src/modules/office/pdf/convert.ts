import { invoke } from "@tauri-apps/api/core";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { h } from "../../../ui/dom";
import { openDialog } from "../../time/dialog";
import type { PdfLib } from "./engine";

/**
 * PDF → Word (docs/plans/pdf.md §4.10): the text pdf.js reads, with its positions, becomes lines,
 * then paragraphs; bigger type becomes headings, bullets and numbers become lists, and pictures
 * come along where they were. The Docs app writes the .docx (`writeDocx`). Approximate, and it
 * says so. LibreOffice, when installed, is offered for keeping the layout instead (positioned
 * boxes, as its PDF import makes them).
 */

interface Line {
  y: number;
  x0: number;
  x1: number;
  size: number;
  bold: boolean;
  text: string;
}

interface Block {
  /** Top of the block in page space (bigger is higher), for ordering pictures among lines. */
  y: number;
  html: string;
}

const BULLET = /^\s*([•◦▪▫●○■□‣⁃∙·\-–—*])\s+/;
const NUMBER = /^\s*((\d{1,3}|[a-zA-Z]|[ivxlcdm]{1,6})[.)])\s+/;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The page's text as lines, top to bottom. */
async function linesOf(page: PDFPageProxy): Promise<Line[]> {
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, { fontFamily?: string }>;
  type Item = { str: string; transform: number[]; width: number; fontName: string; hasEOL?: boolean };
  const items = (content.items as Item[]).filter((i) => "str" in i && i.str.length > 0);
  const lines: Line[] = [];
  let cur: (Line & { right: number }) | null = null;
  for (const it of items) {
    const [a, b, , , e, f] = it.transform;
    const size = Math.hypot(a, b) || 10;
    // Rotated text (a, b not upright) is read as it comes.
    const bold = /bold|black|heavy|semibold|demi/i.test(`${it.fontName} ${styles[it.fontName]?.fontFamily ?? ""}`);
    if (cur && Math.abs(f - cur.y) < size * 0.5 && e >= cur.x0 - size) {
      const gap = e - cur.right;
      cur.text += gap > size * 0.2 && !cur.text.endsWith(" ") && !it.str.startsWith(" ") ? ` ${it.str}` : it.str;
      cur.right = e + it.width;
      cur.x1 = Math.max(cur.x1, cur.right);
      cur.size = Math.max(cur.size, size);
      cur.bold = cur.bold && bold;
    } else {
      if (cur && cur.text.trim()) lines.push(cur);
      cur = { y: f, x0: e, x1: e + it.width, right: e + it.width, size, bold, text: it.str };
    }
    if (it.hasEOL) {
      if (cur.text.trim()) lines.push(cur);
      cur = null;
    }
  }
  if (cur && cur.text.trim()) lines.push(cur);
  lines.sort((p, q) => q.y - p.y || p.x0 - q.x0);
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() }));
}

/** The pictures on a page, as PNG data URLs with where they sit (top edge, in page space). */
async function picturesOf(lib: PdfLib, page: PDFPageProxy): Promise<{ y: number; width: number; src: string }[]> {
  const ops = await page.getOperatorList();
  const OPS = lib.OPS;
  const out: { y: number; width: number; src: string }[] = [];
  const stack: number[][] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const mul = (m: number[], n: number[]) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args as number[]);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const shown = Math.hypot(ctm[0], ctm[1]);
      const tall = Math.hypot(ctm[2], ctm[3]);
      if (shown < 24 || tall < 24) continue;
      const obj = fn === OPS.paintInlineImageXObject ? args[0] : await new Promise<unknown>((resolve) => {
        const id = args[0] as string;
        const objs = (id.startsWith("g_") ? page.commonObjs : page.objs) as { get(id: string, cb: (o: unknown) => void): void };
        objs.get(id, resolve);
      });
      const src = imageUrl(obj as ImageObject);
      if (src) out.push({ y: ctm[5] + Math.max(ctm[3], 0) + Math.max(ctm[1], 0), width: shown, src });
    }
  }
  return out;
}

interface ImageObject {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8ClampedArray | Uint8Array;
  bitmap?: ImageBitmap;
}

/** A decoded pdf.js image as a PNG data URL (kind 1: grey bits, 2: RGB, 3: RGBA). */
function imageUrl(img: ImageObject | null): string | null {
  if (!img?.width || !img.height || img.width * img.height > 40_000_000) return null;
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
  else if (img.data) {
    const out = ctx.createImageData(img.width, img.height);
    const d = img.data;
    const n = img.width * img.height;
    if (img.kind === 3 || d.length === n * 4) out.data.set(d.subarray(0, n * 4));
    else if (img.kind === 2 || d.length === n * 3) {
      for (let i = 0, j = 0; i < n; i++, j += 3) out.data.set([d[j], d[j + 1], d[j + 2], 255], i * 4);
    } else {
      // One bit per pixel, rows padded to bytes.
      const row = (img.width + 7) >> 3;
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const v = (d[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
          out.data.set([v, v, v, 255], (y * img.width + x) * 4);
        }
      }
    }
    ctx.putImageData(out, 0, 0);
  } else return null;
  const url = canvas.toDataURL("image/png");
  canvas.width = canvas.height = 0;
  return url;
}

/** The body text size: the size most characters are set in. */
function bodySize(lines: Line[]): number {
  const count = new Map<number, number>();
  for (const l of lines) {
    const k = Math.round(l.size * 2) / 2;
    count.set(k, (count.get(k) ?? 0) + l.text.length);
  }
  let best = 11;
  let most = 0;
  for (const [k, n] of count) if (n > most) (most = n), (best = k);
  return best;
}

/** One page's lines and pictures as blocks of HTML. */
function blocksOf(lines: Line[], pictures: { y: number; width: number; src: string }[], body: number): Block[] {
  const blocks: Block[] = [];
  let para: { y: number; lines: Line[]; tag: string } | null = null;
  let list: { y: number; ordered: boolean; items: string[] } | null = null;
  const flushPara = () => {
    if (!para) return;
    let text = "";
    for (const l of para.lines) {
      if (!text) text = l.text;
      else if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(l.text)) text = text.slice(0, -1) + l.text;
      else text += ` ${l.text}`;
    }
    const bold = para.tag === "p" && para.lines.every((l) => l.bold);
    blocks.push({ y: para.y, html: `<${para.tag}>${bold ? `<strong>${esc(text)}</strong>` : esc(text)}</${para.tag}>` });
    para = null;
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    blocks.push({ y: list.y, html: `<${tag}>${list.items.map((t) => `<li><p>${esc(t)}</p></li>`).join("")}</${tag}>` });
    list = null;
  };
  let prev: Line | null = null;
  for (const l of lines) {
    const tag = l.size >= body * 1.6 ? "h1" : l.size >= body * 1.3 ? "h2" : l.size >= body * 1.12 && l.text.length < 120 ? "h3" : "p";
    const gap = prev ? prev.y - l.y : 0;
    const bullet = l.text.match(BULLET);
    const number = !bullet ? l.text.match(NUMBER) : null;
    if (tag === "p" && (bullet || number)) {
      flushPara();
      const ordered = !!number;
      if (!list || list.ordered !== ordered || gap > l.size * 2.2) {
        flushList();
        list = { y: l.y, ordered, items: [] };
      }
      list.items.push(l.text.slice((bullet ?? number)![0].length));
      prev = l;
      continue;
    }
    // A line under a list item, indented: it continues the item.
    if (list && tag === "p" && prev && gap < l.size * 1.8 && l.x0 > prev.x0 - 2) {
      list.items[list.items.length - 1] += ` ${l.text}`;
      prev = l;
      continue;
    }
    flushList();
    const joins = para && para.tag === tag && tag === "p" && prev && gap < Math.max(l.size, prev.size) * 1.7
      && Math.abs(l.size - prev.size) < 0.6 && Math.abs(l.x0 - para.lines[0].x0) < l.size * 3;
    const joinsHeading = para && para.tag === tag && tag !== "p" && prev && gap < l.size * 1.4;
    if (!joins && !joinsHeading) {
      flushPara();
      para = { y: l.y, lines: [], tag };
    }
    para!.lines.push(l);
    prev = l;
  }
  flushPara();
  flushList();
  for (const p of pictures) blocks.push({ y: p.y, html: `<p><img src="${p.src}" width="${Math.round(p.width / 0.75)}"></p>` });
  // Top to bottom (pictures between the paragraphs they sat between).
  blocks.sort((a, b) => b.y - a.y);
  return blocks;
}

/** The document as Docs HTML, with the first page's size; `progress` hears pages done. */
export async function pdfToHtml(lib: PdfLib, doc: PDFDocumentProxy, progress: (done: number) => void, signal: AbortSignal): Promise<{ html: string; width: number; height: number; pictures: number; textPages: number }> {
  const pages: { lines: Line[]; pictures: { y: number; width: number; src: string }[] }[] = [];
  let width = 595.3, height = 841.9, pictures = 0, textPages = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    if (signal.aborted) throw Object.assign(new Error("Cancelled"), { name: "Cancelled" });
    const page = await doc.getPage(i);
    if (i === 1) {
      const v = page.getViewport({ scale: 1 });
      width = v.width;
      height = v.height;
    }
    const lines = await linesOf(page);
    const pics = await picturesOf(lib, page).catch(() => []);
    if (lines.length) textPages++;
    pictures += pics.length;
    pages.push({ lines, pictures: pics });
    page.cleanup();
    progress(i);
  }
  const body = bodySize(pages.flatMap((p) => p.lines));
  const html = pages.map((p) => blocksOf(p.lines, p.pictures, body).map((b) => b.html).join("")).join("");
  return { html: html || "<p></p>", width, height, pictures, textPages };
}

export const convertApi = {
  libreOffice: () => invoke<boolean>("pdf_libreoffice").catch(() => false),
  /** LibreOffice's own conversion of the PDF (no password) to .docx. */
  async withLibreOffice(pdf: Uint8Array): Promise<Uint8Array> {
    const r = await invoke<ArrayBuffer | Uint8Array | number[]>("pdf_convert_libreoffice", pdf);
    return r instanceof ArrayBuffer ? new Uint8Array(r) : r instanceof Uint8Array ? r : new Uint8Array(r);
  },
};

/** Asks how to convert: Zazabor's editable text, or LibreOffice keeping the layout. */
export function toWordDialog(libreOffice: boolean): Promise<"text" | "layout" | null> {
  return new Promise((resolve) => {
    let answer: "text" | "layout" | null = null;
    const name = `pf-word-${Math.random()}`;
    const text = h("input", { type: "radio", name, checked: true });
    const layout = h("input", { type: "radio", name, disabled: !libreOffice });
    const ok = () => {
      answer = layout.checked ? "layout" : "text";
      dialog.close();
    };
    const dialog = openDialog({
      title: "Convert to Word",
      subtitle: "Makes a .docx you can edit in Docs or Word. PDFs don't keep paragraphs, so they're rebuilt from where the text sits: check the result.",
      icon: "pfToWord",
      tone: "work",
      body: [
        h("label", { class: "pf-check" }, text, h("span", null, h("b", null, "Flowing text"), " — paragraphs, headings, lists and pictures, easy to edit")),
        h("label", { class: "pf-check" }, layout, h("span", null, h("b", null, "Keep the layout"), libreOffice ? " — LibreOffice places each piece where it was (harder to edit)" : " — needs LibreOffice, which isn't installed")),
        h("p", { class: "tt-dialog-text pf-note" }, "Scanned pages have no text to convert: use Recognize Text first, or they come over as pictures."),
      ],
      foot: [
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: ok }, "Convert"),
      ],
      submit: ok,
      onClose: () => resolve(answer),
    });
  });
}
