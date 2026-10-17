import { thumbUrl } from "../api";
import { formatDate, h } from "../ui/dom";
import { icon } from "../ui/icons";
import type { Group } from "./model";
import type { ThumbLoader } from "./thumbs";

export interface AlbumHandlers {
  open(group: Group): void;
  play(group: Group): void;
  setHidden(group: Group, hidden: boolean): void;
}

/** The gallery home: one card per folder, with its newest photo as the cover. */
export class AlbumGrid {
  readonly el = h("div", { class: "albums-scroll" });
  private list = h("div", { class: "albums" });
  private cards = new Map<string, HTMLElement>();
  private groups = new Map<string, Group>();
  private observer: IntersectionObserver;

  constructor(private readonly thumbs: ThumbLoader, private readonly handlers: AlbumHandlers) {
    this.el.append(this.list);
    // Covers load only as cards approach the viewport.
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const card = entry.target as HTMLElement;
        const group = this.groups.get(card.dataset.path ?? "");
        const cover = group?.photos.reduce((a, b) => (b.mtime > a.mtime ? b : a));
        if (cover) this.thumbs.load(card.querySelector("img")!, thumbUrl(cover.path, cover.mtime, 512));
        this.observer.unobserve(card);
      }
    }, { root: this.el, rootMargin: "600px" });

    this.list.addEventListener("click", (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const card = target?.closest<HTMLElement>(".album");
      const group = card ? this.groups.get(card.dataset.path ?? "") : undefined;
      if (!group) return;
      if (target?.closest(".album-play")) this.handlers.play(group);
      else if (target?.closest(".album-hide")) this.handlers.setHidden(group, !card!.classList.contains("hidden-album"));
      else this.handlers.open(group);
    });
    this.list.addEventListener("keydown", (e) => {
      const card = e.target instanceof HTMLElement && e.target.classList.contains("album") ? e.target : null;
      const group = card ? this.groups.get(card.dataset.path ?? "") : undefined;
      if (group && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.handlers.open(group);
      }
    });
  }

  setCardSize(px: number) {
    this.list.style.setProperty("--card", `${px}px`);
  }

  setGroups(groups: Group[], hidden: ReadonlySet<string>) {
    this.groups = new Map(groups.map((g) => [g.folder.path, g]));
    const next = new Map<string, HTMLElement>();
    for (const group of groups) {
      const path = group.folder.path;
      const card = this.cards.get(path) ?? this.createCard();
      this.fill(card, group, hidden.has(path));
      next.set(path, card);
    }
    for (const [path, card] of this.cards) {
      if (next.has(path)) continue;
      this.thumbs.cancel(card.querySelector("img")!);
      this.observer.unobserve(card);
    }
    this.cards = next;
    this.list.replaceChildren(...next.values());
  }

  focusFirst() {
    this.list.querySelector<HTMLElement>(".album")?.focus();
  }

  private createCard() {
    const card = h(
      "div",
      { class: "album", tabIndex: 0 },
      h("div", { class: "album-cover" }, h("img", { alt: "", draggable: false })),
      h("div", { class: "album-meta" }, h("div", { class: "album-name" }), h("div", { class: "album-count" })),
      h(
        "div",
        { class: "album-actions" },
        h("button", { class: "album-play", title: "Play slideshow" }, icon("play", 15)),
        h("button", { class: "album-hide" }, icon("eyeOff", 15)),
      ),
    );
    return card;
  }

  private fill(card: HTMLElement, group: Group, hidden: boolean) {
    const { folder, photos } = group;
    const fresh = card.dataset.path !== folder.path || card.dataset.count !== String(photos.length);
    card.dataset.path = folder.path;
    card.dataset.count = String(photos.length);
    card.title = folder.path;
    card.classList.toggle("hidden-album", hidden);
    card.querySelector(".album-name")!.textContent = folder.label;
    card.querySelector(".album-count")!.textContent =
      `${photos.length.toLocaleString()} ${photos.length === 1 ? "photo" : "photos"}  ·  ${formatDate(folder.latest)}`;
    const hide = card.querySelector<HTMLButtonElement>(".album-hide")!;
    hide.title = hidden ? "Show this album again" : "Hide this album";
    hide.replaceChildren(icon(hidden ? "eye" : "eyeOff", 15));
    if (fresh) this.observer.observe(card);
  }
}
