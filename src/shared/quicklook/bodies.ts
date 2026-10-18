import { api, displayRenderSize, fileUrl, previewUrl, thumbUrl } from "../../api";
import { categoryOf, folderGlyph, iconNameFor, iconNode, kindLabel, sizeText as entrySize } from "../../modules/files/kinds";
import { videoThumbUrl } from "../../modules/video/api";
import { fileThumb } from "../file-thumbs";
import { resolveThumb } from "../thumbs";
import type { ShellContext } from "../../shell/module";
import { formatBytes, formatDateTime, h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { folderItemCount, readBinary, readText, watchFolderSize } from "./api";
import { renderCode } from "./code-view";
import { isMarkdownExt, languageFor } from "./highlight";
import { renderMarkdown } from "./markdown-view";
import { renderPdf } from "./pdf";
import type { QuickLookItem } from "./types";

/** Text previews read at most this much. */
const TEXT_LIMIT = 512 * 1024;
/** The placeholder shown while a photo renders: the thumbnail size the icon views load. */
const PLACEHOLDER_PX = 256;
/** Photos shown closer together than this are being flicked through with the arrows... */
const FLICK_MS = 400;
/** ...and wait this long before asking for their sharp render. */
const SETTLE_MS = 140;
let lastImageAt = 0;

/** What a body can ask of the overlay that shows it. */
export interface BodyContext {
  readonly shell: ShellContext;
  /** The items being browsed (for the video player's playlist). */
  siblings(): QuickLookItem[];
  /** False once the user has moved to another item; late results must be dropped. */
  isCurrent(): boolean;
  /** Extra text for the header's "Kind · Size" line (dimensions, item counts). */
  setMeta(text: string): void;
  /** Width in CSS pixels available to the body. */
  width(): number;
  /** Opens the item the way the overlay's Open does (e.g. a video in its player window). */
  open?(): void;
}

/** The preview of one item; `dispose` stops whatever it started (audio, folder size jobs). */
export interface Body {
  el: HTMLElement;
  dispose?: () => void;
}

/** A large type icon with the item's name and key facts: the fallback for everything else. */
export function infoCard(item: QuickLookItem, note?: string): HTMLElement {
  const category = categoryOf(item);
  const art = item.dir ? folderGlyph() : iconNode(iconNameFor(category), 56);
  const rows = [kindLabel(item), item.dir || item.url ? "" : entrySize(item), item.mtime ? `Modified ${formatDateTime(item.mtime)}` : ""];
  return h("div", { class: "ql-card" },
    h("div", { class: "ql-card-art" }, art),
    h("div", { class: "ql-card-name", title: item.name }, item.name),
    ...rows.filter(Boolean).map((text) => h("div", { class: "ql-card-line" }, text)),
    note ? h("div", { class: "ql-card-note" }, note) : null);
}

const loading = () => h("div", { class: "ql-loading" }, h("span", { class: "spinner large" }));

/** A body whose element is filled in later; shows a spinner meanwhile. */
function deferred(fill: (host: HTMLElement) => Promise<void>, ctx: BodyContext, item: QuickLookItem): Body {
  const el = h("div", { class: "ql-fill" }, loading());
  fill(el).catch((e) => {
    if (!ctx.isCurrent()) return;
    el.replaceChildren(infoCard(item, e instanceof Error ? e.message : String(e)));
  });
  return { el };
}

function imageBody(item: QuickLookItem, ctx: BodyContext): Body {
  const frame = h("div", { class: "ql-image-frame" }, loading());
  let sharpShown = false;
  // The photo's upright size, once known.
  let upright: [number, number] | null = null;
  const place = (img: HTMLImageElement) => {
    if (upright) {
      img.style.setProperty("--w", String(upright[0]));
      img.style.setProperty("--h", String(upright[1]));
      img.classList.add("fitted");
    }
    frame.replaceChildren(img);
    img.classList.add("loaded");
  };
  const picture = (src: string, onLoad: (img: HTMLImageElement) => void, onError?: () => void) => {
    const img = h("img", { class: "ql-image", alt: item.name, draggable: false });
    img.addEventListener("load", () => ctx.isCurrent() && onLoad(img));
    if (onError) img.addEventListener("error", () => ctx.isCurrent() && onError());
    img.src = src;
  };

  const info = api.photoInfo(item.path).then((info) => {
    if (!ctx.isCurrent()) return;
    const swap = info.orientation >= 5 && info.orientation <= 8;
    const [w, hgt] = swap ? [info.height, info.width] : [info.width, info.height];
    if (w > 0 && hgt > 0) upright = [w, hgt];
    ctx.setMeta(`${w.toLocaleString()} × ${hgt.toLocaleString()}`);
  }).catch(() => {});
  // The small thumbnail the file views have usually loaded already stands in at once; it waits
  // for the photo's size so it is drawn as large as the render that replaces it.
  picture(thumbUrl(item.path, item.mtime, PLACEHOLDER_PX), (img) => {
    void info.then(() => {
      if (ctx.isCurrent() && !sharpShown) place(img);
    });
  });

  const now = performance.now();
  const flicking = now - lastImageAt < FLICK_MS;
  lastImageAt = now;
  const loadSharp = () => {
    // GIFs keep their animation only as the original file.
    const src = item.ext === "gif" ? fileUrl(item.path, item.mtime) : previewUrl(item.path, item.mtime, displayRenderSize());
    picture(src, (img) => {
      sharpShown = true;
      place(img);
    }, () => frame.replaceChildren(infoCard(item, "This image could not be displayed.")));
  };
  // Renders queue on the backend whether or not anyone still wants them, so while the arrows
  // flick from photo to photo only the one settled on is rendered.
  const timer = flicking ? window.setTimeout(loadSharp, SETTLE_MS) : undefined;
  if (!flicking) loadSharp();
  return { el: frame, dispose: () => window.clearTimeout(timer) };
}

function videoBody(item: QuickLookItem, ctx: BodyContext): Body {
  const play = () => {
    if (ctx.open) return ctx.open();
    const siblings = ctx.siblings().filter((s) => categoryOf(s) === "video").map((s) => s.path);
    ctx.shell.open({ kind: "video", path: item.path, siblings: siblings.length ? siblings : undefined });
  };
  const poster = h("img", { class: "ql-image", alt: item.name, draggable: false });
  poster.addEventListener("load", () => poster.classList.add("loaded"));
  poster.src = videoThumbUrl(item.path, item.mtime, 1024);
  const button = h("button", { class: "ql-play", "aria-label": "Play", title: "Play (Enter)", onclick: play }, icon("play", 30));
  return { el: h("div", { class: "ql-video" }, h("div", { class: "ql-poster" }, poster, button)) };
}

/** Audio files are played from memory up to this size. */
const AUDIO_BYTES = 256 * 1024 * 1024;

const AUDIO_TYPES: Record<string, string> = {
  mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", wav: "audio/wav",
  m4a: "audio/mp4", aac: "audio/mp4",
};

function audioBody(item: QuickLookItem): Body {
  const audio = h("audio", { class: "ql-audio", controls: true, preload: "metadata" });
  const card = infoCard(item);
  card.append(audio);
  // The webview's player (GStreamer on Linux) refuses the app's own cs: addresses, so the file
  // is handed to it as a blob.
  let url: string | null = null;
  let disposed = false;
  readBinary(item.path, AUDIO_BYTES).then((bytes) => {
    if (disposed) return;
    url = URL.createObjectURL(new Blob([bytes], { type: AUDIO_TYPES[item.ext] ?? "" }));
    audio.src = url;
  }, () => {
    if (disposed) return;
    const why = item.size > AUDIO_BYTES ? "This file is too large to play here." : "This file could not be read.";
    audio.replaceWith(h("div", { class: "ql-card-note" }, why));
  });
  return {
    el: card,
    dispose() {
      disposed = true;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (url) URL.revokeObjectURL(url);
    },
  };
}

function folderBody(item: QuickLookItem, ctx: BodyContext): Body {
  const sizeText = h("span", { class: "ql-live" }, "Calculating size");
  const countText = h("span", null, "");
  const card = h("div", { class: "ql-card" },
    h("div", { class: "ql-card-art" }, folderGlyph()),
    h("div", { class: "ql-card-name", title: item.name }, item.name),
    h("div", { class: "ql-card-line" }, countText),
    h("div", { class: "ql-card-line" }, sizeText));
  let items = "";
  folderItemCount(item.path).then((count) => {
    if (!ctx.isCurrent()) return;
    items = `${count.toLocaleString()} ${count === 1 ? "item" : "items"}`;
    countText.textContent = items;
    ctx.setMeta(items);
  }).catch(() => {});
  const stop = watchFolderSize(item.path, (size) => {
    sizeText.textContent = `${formatBytes(size.bytes)}${size.done ? "" : " so far"}`;
    sizeText.classList.toggle("done", size.done);
    if (size.done) ctx.setMeta([items, formatBytes(size.bytes)].filter(Boolean).join(" · "));
  }, () => {
    sizeText.textContent = "Size unavailable";
  });
  return { el: card, dispose: stop };
}

function textBody(item: QuickLookItem, ctx: BodyContext): Body {
  const markdown = isMarkdownExt(item.ext);
  const language = languageFor(item.name, item.ext);
  return deferred(async (host) => {
    const preview = await readText(item.path, TEXT_LIMIT);
    if (!ctx.isCurrent()) return;
    if (preview.binary) {
      host.replaceChildren(infoCard(item, "No preview available for this file type."));
      return;
    }
    if (!preview.text.trim()) {
      host.replaceChildren(infoCard(item, "This file is empty."));
      return;
    }
    const view = markdown ? h("div", { class: "ql-doc" }, renderMarkdown(preview.text)) : renderCode(preview.text, language);
    host.replaceChildren(view);
    if (preview.truncated) host.append(h("div", { class: "ql-truncated" }, `Showing the first ${formatBytes(TEXT_LIMIT)}. Open the file to read all of it.`));
    host.classList.add("ready");
  }, ctx, item);
}

function pdfBody(item: QuickLookItem, ctx: BodyContext): Body {
  return deferred(async (host) => {
    const pages = await renderPdf(item.path, Math.min(760, Math.max(320, ctx.width() - 64)), ctx.isCurrent);
    if (!ctx.isCurrent()) return;
    host.replaceChildren(pages);
    host.classList.add("ready");
  }, ctx, item);
}

/** Builds the preview for an item according to its kind. */
export function buildBody(item: QuickLookItem, ctx: BodyContext): Body {
  if (item.dir) return folderBody(item, ctx);
  const category = categoryOf(item);
  if (category === "image") return imageBody(item, ctx);
  if (category === "video") return videoBody(item, ctx);
  if (category === "audio") return audioBody(item);
  if (item.ext === "pdf") return pdfBody(item, ctx);
  // Archives aren't read here; a Google Doc has nothing on disk to read.
  if (category === "archive" || item.url) return { el: infoCard(item) };
  return textBody(item, ctx);
}

/** A small thumbnail for the item, used by Get Info and anywhere a compact preview is wanted. */
export function previewThumb(item: QuickLookItem, size: number): HTMLElement {
  const category = categoryOf(item);
  if (item.dir) return h("div", { class: "ql-thumb-art" }, folderGlyph());
  const typeArt = () => h("div", { class: "ql-thumb-art" }, iconNode(iconNameFor(category), 40));
  const thumb = fileThumb(item, size);
  if (!thumb) return typeArt();
  const img = h("img", { class: `ql-thumb-img ${thumb.look}`, alt: "", draggable: false });
  img.addEventListener("load", () => img.classList.add("loaded"));
  img.addEventListener("error", () => img.replaceWith(typeArt()));
  resolveThumb(thumb.source).then((url) => (img.src = url), () => img.replaceWith(typeArt()));
  return h("div", { class: "ql-thumb" }, img);
}
