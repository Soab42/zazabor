import { thumbUrl } from "../api";
import { ago } from "../notes/api";
import { basename, h } from "../ui/dom";
import { icon } from "../ui/icons";
import { appName, describe, KIND_ICON, preview, type ClipItem } from "./api";

export interface CardHooks {
  /** Click or Enter: use the item. */
  pick(item: ClipItem): void;
  /** The ⋯ button or a right click, at screen point (x, y). */
  menu(item: ClipItem, x: number, y: number): void;
}

/**
 * One copy as a card, as Win+V shows it: the text's first lines, the picture, or the files; a pin
 * when pinned and ⋯ for Pin and Delete. `lines` is how much text shows.
 */
export function clipCard(item: ClipItem, hooks: CardHooks, lines = 4): HTMLElement {
  let body: HTMLElement;
  if (item.kind === "image" && item.image) {
    const img = h("img", { class: "clip-thumb", alt: describe(item), draggable: false, src: thumbUrl(item.image, item.created / 1000, 480) });
    img.addEventListener("load", () => img.classList.add("loaded"));
    body = h("div", { class: "clip-image" }, img);
  } else if (item.kind === "files") {
    const paths = item.text.split("\n").filter(Boolean);
    body = h("div", { class: "clip-files" },
      ...paths.slice(0, 3).map((p) => h("div", { class: "clip-file", title: p }, icon("file", 14), h("span", null, basename(p) || p))),
      paths.length > 3 ? h("div", { class: "clip-more" }, `and ${paths.length - 3} more`) : null);
  } else {
    body = h("div", { class: `clip-text${/^\s*https?:\/\/\S+\s*$/.test(item.text) ? " link" : ""}` }, preview(item, lines));
  }
  const more = h("button", {
    class: "icon-btn small clip-more-btn", type: "button", title: "More", "aria-label": "More",
    onclick: (e: MouseEvent) => {
      e.stopPropagation();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      hooks.menu(item, r.left, r.bottom + 4);
    },
  }, icon("more", 16));
  const meta = [describe(item), appName(item.source), ago(item.created)].filter(Boolean).join(" · ");
  const card = h("div", {
    class: `clip-card kind-${item.kind}${item.pinned ? " pinned" : ""}`, role: "option", tabindex: "-1",
    "data-id": item.id, title: item.kind === "text" ? item.text.slice(0, 600) : "",
    onclick: () => hooks.pick(item),
  },
  h("div", { class: "clip-card-top" },
    h("span", { class: "clip-kind" }, icon(KIND_ICON[item.kind], 13)),
    h("span", { class: "clip-meta" }, meta),
    item.pinned ? h("span", { class: "clip-pin", title: "Pinned" }, icon("pin", 13)) : null,
    more),
  body);
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    hooks.menu(item, e.clientX, e.clientY);
  });
  return card;
}
