import { invoke } from "@tauri-apps/api/core";
import type { PDFWorker } from "pdfjs-dist";
import { thumbUrl } from "../api";
import { categoryOf, isImageExt, webKind } from "../modules/files/kinds";
import { videoThumbUrl } from "../modules/video/api";
import { readBinary, readText } from "./quicklook/api";
import { isMarkdownExt, languageFor, tokenize, toLines } from "./quicklook/highlight";
import { renderMarkdown } from "./quicklook/markdown-view";
import { loadPdfjs } from "./quicklook/pdf";
import { photoThumbUrl, type ThumbSource } from "./thumbs";

/**
 * Thumbnails for every kind of file that has something to show: a photo, a frame of a video, a
 * PDF's first page, and the start of a web page, Markdown document, text or source file drawn as
 * a page. Pages are drawn here, in the webview: HTML and text as an SVG image of the laid-out
 * markup (an image can neither run scripts nor fetch anything), a PDF with pdf.js, kept in the
 * backend's render cache so it is drawn only once.
 */

/** How a thumbnail is framed: a photo or video frame fills a square, a document is a page, a
 * drawing (SVG) sits on white paper. */
export type ThumbLook = "photo" | "video" | "page" | "drawing";

export interface FileThumb {
  source: ThumbSource;
  look: ThumbLook;
}

/** What a thumbnail needs to know about a file; `FsEntry` and Quick Look items fit. */
export interface ThumbEntry {
  name: string;
  path: string;
  dir: boolean;
  ext: string;
  mtime: number;
  size?: number;
  mime?: string;
  url?: string;
}

type Drawn = "pdf" | "html" | "markdown" | "text" | "svg";

const TEXT = new Set("txt text log csv tsv ini cfg conf env properties rst tex srt vtt diff patch".split(" "));
/** Files with no extension (README, Makefile) are drawn as text when they are this small. */
const BARE_TEXT_BYTES = 1 << 20;

function drawnKind(entry: ThumbEntry): Drawn | null {
  const { ext } = entry;
  if (ext === "pdf") return "pdf";
  if (ext === "html" || ext === "htm" || ext === "xhtml") return "html";
  if (isMarkdownExt(ext)) return "markdown";
  if (ext === "svg") return "svg";
  if (categoryOf(entry) === "code" || TEXT.has(ext)) return "text";
  const size = entry.size ?? 0;
  if (!ext && size > 0 && size <= BARE_TEXT_BYTES) return "text";
  return null;
}

/** Network and cloud drives (GVFS mounts): drawing their files would download every one. */
const remote = (path: string) => path.includes("/gvfs/");

/** Raster sizes for frames and PDF pages, like the photo buckets but up to a large stage. */
function rasterSize(displayPx: number) {
  const px = displayPx * (window.devicePixelRatio || 1);
  return px <= 256 ? 256 : px <= 512 ? 512 : 1024;
}

/** The thumbnail of a file shown `displayPx` CSS pixels large, or null when it has none. */
export function fileThumb(entry: ThumbEntry, displayPx: number): FileThumb | null {
  if (entry.dir || entry.url || webKind(entry)) return null;
  const category = categoryOf(entry);
  if (category === "image") return { source: photoThumbUrl(entry, displayPx), look: "photo" };
  if (remote(entry.path)) return null;
  if (category === "video") return { source: videoThumbUrl(entry.path, entry.mtime, rasterSize(displayPx)), look: "video" };
  const kind = drawnKind(entry);
  if (!kind) return null;
  // Only a PDF page is a raster; the others are drawn as vector images, good at any size.
  const size = kind === "pdf" ? rasterSize(displayPx) : 0;
  const key = `${kind}|${size}|${entry.mtime}|${entry.path}`;
  return { source: { key, make: () => remember(key, () => DRAW[kind](entry, size)) }, look: kind === "svg" ? "drawing" : "page" };
}

const DRAW: Record<Drawn, (entry: ThumbEntry, size: number) => Promise<string>> = {
  pdf: drawPdf,
  html: drawHtml,
  markdown: drawMarkdown,
  text: drawText,
  svg: drawSvg,
};

// ---- memory --------------------------------------------------------------------------------

/** Drawn pages kept as blob URLs; the least recently used are let go past this many. */
const KEEP = 600;
const drawn = new Map<string, Promise<string>>();

/** The page drawn for `key`, drawing it on first use. A failure is remembered too (binary data
 * is not text, a broken PDF stays broken) unless the app was only locked. */
function remember(key: string, draw: () => Promise<string>): Promise<string> {
  const known = drawn.get(key);
  if (known) {
    drawn.delete(key);
    drawn.set(key, known);
    return known;
  }
  const url = draw();
  drawn.set(key, url);
  url.catch((e) => {
    if (String(e).includes("locked") && drawn.get(key) === url) drawn.delete(key);
  });
  for (const [old, oldUrl] of drawn) {
    if (drawn.size <= KEEP) break;
    drawn.delete(old);
    void oldUrl.then((u) => u.startsWith("blob:") && URL.revokeObjectURL(u), () => {});
  }
  return url;
}

/** Runs at most `n` tasks at once, the rest in turn. */
function lane(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((go) => waiting.push(go));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

const loads = (url: string) =>
  new Promise<boolean>((done) => {
    const img = new Image();
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = url;
  });

// ---- PDF -----------------------------------------------------------------------------------

/** Larger PDFs keep their icon: the whole file is read to draw a page. */
const PDF_BYTES = 48 << 20;
const pdfLane = lane(2);
let pdfWorker: PDFWorker | null = null;

async function drawPdf(entry: ThumbEntry, size: number): Promise<string> {
  const stored = thumbUrl(entry.path, entry.mtime, size);
  if (await loads(stored)) return stored;
  return pdfLane(async () => {
    const pdfjs = await loadPdfjs();
    // One worker for every thumbnail, not one started per document.
    pdfWorker ??= new pdfjs.PDFWorker();
    const data = new Uint8Array(await readBinary(entry.path, PDF_BYTES));
    const task = pdfjs.getDocument({ data, worker: pdfWorker });
    try {
      const doc = await task.promise;
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: size / Math.max(base.width, base.height) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      await page.render({ canvas, viewport, background: "#fff" }).promise;
      const blob = await new Promise<Blob>((done, fail) =>
        canvas.toBlob((b) => (b ? done(b) : fail(new Error("PDF page not drawn"))), "image/jpeg", 0.86));
      const headers = { thumb: `p=${encodeURIComponent(entry.path)}&s=${size}` };
      void invoke("thumb_store", new Uint8Array(await blob.arrayBuffer()), { headers }).catch(() => {});
      return URL.createObjectURL(blob);
    } finally {
      void task.destroy();
    }
  });
}

// ---- pages ---------------------------------------------------------------------------------

/** Text and Markdown are laid out on a page this large (4:5, like the icon sheet)... */
const PAGE_W = 480;
const PAGE_H = 600;
/** ...web pages at a narrow desktop width. */
const WEB_W = 1024;
const WEB_H = 1280;

/** Characters XML does not allow; a page carrying one would not draw at all. */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** An SVG image of XHTML markup laid out `w` × `h` on white. */
function pageImage(xhtml: string, w: number, h: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    `<foreignObject width="100%" height="100%">${xhtml.replace(NOT_XML, "")}</foreignObject></svg>`;
  return URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
}

const serialize = (node: Node) => new XMLSerializer().serializeToString(node);

/** A page of our own markup with its stylesheet. */
function sheet(css: string, content: HTMLElement): string {
  const page = document.createElement("div");
  page.className = "page";
  const style = document.createElement("style");
  style.textContent = css;
  page.append(style, content);
  return pageImage(serialize(page), PAGE_W, PAGE_H);
}

/** The start of a text file; rejects for binary data and empty files, which keep their icon. */
async function readStart(path: string, bytes: number): Promise<string> {
  const start = await readText(path, bytes);
  if (start.binary) throw new Error("not text");
  if (!start.text.trim()) throw new Error("empty");
  return start.text;
}

/** Light-theme colours for highlighted code, like a printed page. */
const CODE_CSS =
  ".hl-kw,.hl-tag{color:#9b2393}.hl-str{color:#c41a16}.hl-com{color:#707f8c;font-style:italic}.hl-num{color:#1c00cf}" +
  ".hl-fn{color:#326d74}.hl-type{color:#0b4f79}.hl-attr{color:#836c28}.hl-var{color:#3e6d74}";

const PAGE_CSS = `.page{box-sizing:border-box;width:${PAGE_W}px;height:${PAGE_H}px;overflow:hidden;background:#fff;color:#1d1d1f}`;

/** Enough of a text file to fill a page. */
const TEXT_BYTES = 12 * 1024;
const TEXT_LINES = 40;

const TEXT_CSS = PAGE_CSS + CODE_CSS +
  ".page{padding:24px 26px}" +
  `pre{margin:0;font:14px/1.45 "JetBrains Mono","DejaVu Sans Mono","Liberation Mono",ui-monospace,monospace;white-space:pre;tab-size:4}`;

async function drawText(entry: ThumbEntry): Promise<string> {
  const text = await readStart(entry.path, TEXT_BYTES);
  const lines = toLines(tokenize(text, languageFor(entry.name, entry.ext))).slice(0, TEXT_LINES);
  const pre = document.createElement("pre");
  for (const line of lines) {
    for (const token of line) {
      if (!token.cls) {
        pre.append(token.text);
        continue;
      }
      const span = document.createElement("span");
      span.className = `hl-${token.cls}`;
      span.textContent = token.text;
      pre.append(span);
    }
    pre.append("\n");
  }
  return sheet(TEXT_CSS, pre);
}

/** Enough Markdown to fill a page. */
const MARKDOWN_BYTES = 16 * 1024;

const MARKDOWN_CSS = PAGE_CSS + CODE_CSS +
  `.page{padding:28px 30px;font:15px/1.5 Inter,"Noto Sans",Cantarell,"DejaVu Sans",system-ui,sans-serif}` +
  ".md>:first-child{margin-top:0}" +
  "h1,h2,h3,h4,h5,h6{margin:22px 0 10px;line-height:1.25;font-weight:700}" +
  "h1{font-size:28px}h2{font-size:22px;padding-bottom:4px;border-bottom:1px solid #e3e3e8}h3{font-size:18px}h4,h5,h6{font-size:15px}" +
  "p,ul,ol,blockquote,.md-table-wrap,.md-pre{margin:0 0 12px}ul,ol{padding-left:26px}" +
  ".md-code{font:0.86em ui-monospace,monospace;background:#efeff3;border-radius:4px;padding:1px 4px}" +
  ".md-pre{background:#f5f5f7;border-radius:8px;padding:12px 14px;overflow:hidden}.ql-gutter{display:none}" +
  ".ql-pre{margin:0;font:12px/1.45 ui-monospace,monospace;white-space:pre}" +
  ".md-link{color:#0a66d8}.md-image{padding:1px 6px;border-radius:4px;background:#ececf0;color:#6e6e73}" +
  "blockquote{border-left:4px solid #d2d2d7;padding-left:14px;color:#55555a}hr{border:0;border-top:1px solid #d2d2d7;margin:18px 0}" +
  "table{border-collapse:collapse}th,td{border:1px solid #d2d2d7;padding:4px 8px}th{background:#f5f5f7}";

async function drawMarkdown(entry: ThumbEntry): Promise<string> {
  return sheet(MARKDOWN_CSS, renderMarkdown(await readStart(entry.path, MARKDOWN_BYTES)));
}

/** Web pages read this much; their own local stylesheets and pictures are inlined. */
const HTML_BYTES = 256 * 1024;
const CSS_BYTES = 256 * 1024;
const STYLESHEETS = 4;
const PICTURES = 8;
/** Nothing of these shows in a still picture of a page, or it would need fetching. */
const DROP = "script,noscript,template,iframe,frame,frameset,object,embed,applet,video,audio,canvas,base,meta,link,source,track,input[type=image]";
/** Attribute names an XML parser accepts; framework syntax (`@click`, `:class`) would break the page. */
const XML_NAME = /^[A-Za-z_][\w.-]*$/;

/** The file a page's relative or file: link points to, or null for anything on the web. */
function localFile(href: string, folder: string): string | null {
  try {
    const url = new URL(href, `file://${folder.split("/").map(encodeURIComponent).join("/")}/`);
    return url.protocol === "file:" ? decodeURIComponent(url.pathname) : null;
  } catch {
    return null;
  }
}

const dataUrl = (blob: Blob) =>
  new Promise<string>((done, fail) => {
    const reader = new FileReader();
    reader.onload = () => done(String(reader.result));
    reader.onerror = () => fail(reader.error);
    reader.readAsDataURL(blob);
  });

async function drawHtml(entry: ThumbEntry): Promise<string> {
  const doc = new DOMParser().parseFromString(await readStart(entry.path, HTML_BYTES), "text/html");
  const folder = entry.path.slice(0, entry.path.lastIndexOf("/"));

  const sheets = Array.from(doc.querySelectorAll("link[rel~=stylesheet][href]")).slice(0, STYLESHEETS);
  await Promise.all(sheets.map(async (link) => {
    const file = localFile(link.getAttribute("href") ?? "", folder);
    const css = file ? await readText(file, CSS_BYTES).then((t) => (t.binary ? "" : t.text), () => "") : "";
    const style = doc.createElement("style");
    style.textContent = css;
    link.replaceWith(style);
  }));
  // The page is no longer the document's root, so what it gives `:root` goes to its <html>.
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    style.textContent = (style.textContent ?? "").replace(/:root\b/g, "html");
  }

  const pictures = Array.from(doc.querySelectorAll("img"));
  await Promise.all(pictures.map(async (img, i) => {
    const file = i < PICTURES ? localFile(img.getAttribute("src") ?? "", folder) : null;
    img.removeAttribute("srcset");
    img.removeAttribute("src");
    if (!file || !isImageExt(file.slice(file.lastIndexOf(".") + 1).toLowerCase())) return;
    try {
      const response = await fetch(thumbUrl(file, 0, 512));
      if (response.ok) img.setAttribute("src", await dataUrl(await response.blob()));
    } catch {
      // Left blank.
    }
  }));

  doc.querySelectorAll(DROP).forEach((node) => node.remove());
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (!attr.namespaceURI && !XML_NAME.test(attr.name)) el.removeAttribute(attr.name);
    }
  }
  const frame = `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${WEB_W}px;height:${WEB_H}px;overflow:hidden;background:#fff;color:#000">`;
  return pageImage(`${frame}${serialize(doc.documentElement)}</div>`, WEB_W, WEB_H);
}

/** SVG drawings are read whole; larger ones keep their icon. */
const SVG_BYTES = 2 << 20;

async function drawSvg(entry: ThumbEntry): Promise<string> {
  const text = await readStart(entry.path, SVG_BYTES);
  if (!/<svg[\s>]/i.test(text)) throw new Error("not an SVG drawing");
  return URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
}
