import { api, displayRenderSize, fileUrl, previewUrl, thumbUrl } from "../../api";
import { categoryOf, folderGlyph, iconNameFor, iconNode, kindLabel } from "../../modules/files/kinds";
import { videoThumbUrl } from "../../modules/video/api";
import type { ShellContext } from "../../shell/module";
import { formatBytes, formatDateTime, h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { folderItemCount, readText, watchFolderSize } from "./api";
import { renderCode } from "./code-view";
import { isMarkdownExt, languageFor } from "./highlight";
import { renderMarkdown } from "./markdown-view";
import { renderPdf } from "./pdf";
import type { QuickLookItem } from "./types";

/** Text previews read at most this much. */
const TEXT_LIMIT = 512 * 1024;

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
  const rows = [kindLabel(item), item.dir ? "" : formatBytes(item.size), item.mtime ? `Modified ${formatDateTime(item.mtime)}` : ""];
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
  const img = h("img", { class: "ql-image", alt: item.name, draggable: false });
  img.addEventListener("load", () => {
    if (!ctx.isCurrent()) return;
    frame.replaceChildren(img);
    img.classList.add("loaded");
  });
  img.addEventListener("error", () => {
    if (ctx.isCurrent()) frame.replaceChildren(infoCard(item, "This image could not be displayed."));
  });
  // GIFs keep their animation only as the original file.
  img.src = item.ext === "gif" ? fileUrl(item.path, item.mtime) : previewUrl(item.path, item.mtime, displayRenderSize());
  api.photoInfo(item.path).then((info) => {
    if (!ctx.isCurrent()) return;
    const swap = info.orientation >= 5 && info.orientation <= 8;
    const [w, hgt] = swap ? [info.height, info.width] : [info.width, info.height];
    ctx.setMeta(`${w.toLocaleString()} × ${hgt.toLocaleString()}`);
  }).catch(() => {});
  return { el: frame };
}

function videoBody(item: QuickLookItem, ctx: BodyContext): Body {
  const play = () => {
    const siblings = ctx.siblings().filter((s) => categoryOf(s) === "video").map((s) => s.path);
    ctx.shell.open({ kind: "video", path: item.path, siblings: siblings.length ? siblings : undefined });
  };
  const poster = h("img", { class: "ql-image", alt: item.name, draggable: false });
  poster.addEventListener("load", () => poster.classList.add("loaded"));
  poster.src = videoThumbUrl(item.path, item.mtime, 1024);
  const button = h("button", { class: "ql-play", "aria-label": "Play", title: "Play (Enter)", onclick: play }, icon("play", 30));
  return { el: h("div", { class: "ql-video" }, h("div", { class: "ql-poster" }, poster, button)) };
}

function audioBody(item: QuickLookItem): Body {
  const audio = h("audio", { class: "ql-audio", controls: true, preload: "metadata", src: fileUrl(item.path, item.mtime) });
  const card = infoCard(item);
  card.append(audio);
  return {
    el: card,
    dispose() {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
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
  if (category === "archive") return { el: infoCard(item) };
  return textBody(item, ctx);
}

/** A small thumbnail for the item, used by Get Info and anywhere a compact preview is wanted. */
export function previewThumb(item: QuickLookItem, size: number): HTMLElement {
  const category = categoryOf(item);
  if (item.dir) return h("div", { class: "ql-thumb-art" }, folderGlyph());
  if (category === "image" || category === "video") {
    const img = h("img", { class: "ql-thumb-img", alt: "", draggable: false });
    img.addEventListener("load", () => img.classList.add("loaded"));
    img.addEventListener("error", () => img.replaceWith(h("div", { class: "ql-thumb-art" }, iconNode(iconNameFor(category), 40))));
    img.src = category === "image" ? thumbUrl(item.path, item.mtime, size) : videoThumbUrl(item.path, item.mtime, size);
    return h("div", { class: "ql-thumb" }, img);
  }
  return h("div", { class: "ql-thumb-art" }, iconNode(iconNameFor(category), 40));
}
