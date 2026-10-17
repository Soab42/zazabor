import { thumbUrl } from "../api";
import { formatDate, h } from "../ui/dom";
import { icon } from "../ui/icons";
import type { Group } from "./model";
import type { ThumbLoader } from "./thumbs";

export interface AlbumHandlers {
  open(group: Group): void;
  play(group: Group): void;
  setHidden(group: Group, hidden: boolean): void;
  setFavorite(group: Group, favorite: boolean): void;
  menu(group: Group, x: number, y: number): void;
  selectionChanged(): void;
}

export interface AlbumState {
  hidden: ReadonlySet<string>;
  favorites: ReadonlySet<string>;
  /** Show "Favorites" and "Albums" headings when both kinds are present. */
  sections: boolean;
}

/** The gallery home: one card per folder, with its newest photo as the cover. */
export class AlbumGrid {
  readonly el = h("div", { class: "albums-scroll" });
  private list = h("div", { class: "albums" });
  private cards = new Map<string, HTMLElement>();
  private groups = new Map<string, Group>();
  private order: string[] = [];
  private observer: IntersectionObserver;
  private selecting = false;
  readonly selected = new Set<string>();

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
      if (!card || !group) return;
      if (this.selecting) {
        this.toggleSelected(group.folder.path, e.shiftKey);
        return;
      }
      if (target?.closest(".album-play")) this.handlers.play(group);
      else if (target?.closest(".album-hide")) this.handlers.setHidden(group, !card.classList.contains("hidden-album"));
      else if (target?.closest(".album-star")) this.handlers.setFavorite(group, !card.classList.contains("favorite"));
      else this.handlers.open(group);
    });
    this.list.addEventListener("contextmenu", (e) => {
      const card = e.target instanceof Element ? e.target.closest<HTMLElement>(".album") : null;
      const group = card ? this.groups.get(card.dataset.path ?? "") : undefined;
      if (!group) return;
      e.preventDefault();
      this.handlers.menu(group, e.clientX, e.clientY);
    });
    this.list.addEventListener("keydown", (e) => {
      const card = e.target instanceof HTMLElement && e.target.classList.contains("album") ? e.target : null;
      const group = card ? this.groups.get(card.dataset.path ?? "") : undefined;
      if (!group) return;
      if (e.key === "Enter" || (e.key === " " && this.selecting)) {
        e.preventDefault();
        e.stopPropagation();
        if (this.selecting) this.toggleSelected(group.folder.path, false);
        else this.handlers.open(group);
      } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        const rect = card!.getBoundingClientRect();
        this.handlers.menu(group, rect.left + 24, rect.top + 24);
      }
    });
  }

  get isSelecting() {
    return this.selecting;
  }

  setCardSize(px: number) {
    this.list.style.setProperty("--card", `${px}px`);
  }

  setSelecting(on: boolean, initial: string[] = []) {
    this.selecting = on;
    this.selected.clear();
    for (const path of initial) this.selected.add(path);
    this.list.classList.toggle("selecting", on);
    this.updateSelection();
    this.handlers.selectionChanged();
  }

  selectAll() {
    for (const path of this.order) this.selected.add(path);
    this.updateSelection();
    this.handlers.selectionChanged();
  }

  setGroups(groups: Group[], state: AlbumState) {
    this.groups = new Map(groups.map((g) => [g.folder.path, g]));
    this.order = groups.map((g) => g.folder.path);
    for (const path of [...this.selected]) if (!this.groups.has(path)) this.selected.delete(path);
    const next = new Map<string, HTMLElement>();
    const children: HTMLElement[] = [];
    const favoriteCount = groups.filter((g) => state.favorites.has(g.folder.path)).length;
    const sectioned = state.sections && favoriteCount > 0 && favoriteCount < groups.length;
    groups.forEach((group, i) => {
      const path = group.folder.path;
      if (sectioned && i === 0) children.push(this.heading("Favorites", favoriteCount));
      if (sectioned && i === favoriteCount) children.push(this.heading("All albums", groups.length - favoriteCount));
      const card = this.cards.get(path) ?? this.createCard();
      this.fill(card, group, state.hidden.has(path), state.favorites.has(path));
      next.set(path, card);
      children.push(card);
    });
    for (const [path, card] of this.cards) {
      if (next.has(path)) continue;
      this.thumbs.cancel(card.querySelector("img")!);
      this.observer.unobserve(card);
    }
    this.cards = next;
    this.list.replaceChildren(...children);
    this.updateSelection();
  }

  focusFirst() {
    this.list.querySelector<HTMLElement>(".album")?.focus();
  }

  private toggleSelected(path: string, range: boolean) {
    if (range && this.selected.size) {
      // Shift-click selects everything between the last selected album and this one.
      const last = [...this.selected].pop()!;
      const a = this.order.indexOf(last);
      const b = this.order.indexOf(path);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selected.add(this.order[i]);
    } else if (this.selected.has(path)) {
      this.selected.delete(path);
    } else {
      this.selected.add(path);
    }
    this.updateSelection();
    this.handlers.selectionChanged();
  }

  private updateSelection() {
    for (const [path, card] of this.cards) card.classList.toggle("selected", this.selecting && this.selected.has(path));
  }

  private heading(label: string, count: number) {
    return h("div", { class: "albums-heading" }, h("span", null, label), h("span", { class: "albums-heading-count" }, count.toLocaleString()));
  }

  private createCard() {
    return h(
      "div",
      { class: "album", tabIndex: 0 },
      h("div", { class: "album-cover" }, h("img", { alt: "", draggable: false })),
      h("div", { class: "album-meta" }, h("div", { class: "album-name" }), h("div", { class: "album-count" })),
      h("button", { class: "album-star" }),
      h(
        "div",
        { class: "album-actions" },
        h("button", { class: "album-play", title: "Play slideshow" }, icon("play", 15)),
        h("button", { class: "album-hide" }),
      ),
      h("div", { class: "album-check" }, icon("check", 16)),
    );
  }

  private fill(card: HTMLElement, group: Group, hidden: boolean, favorite: boolean) {
    const { folder, photos } = group;
    const fresh = card.dataset.path !== folder.path || card.dataset.count !== String(photos.length);
    card.dataset.path = folder.path;
    card.dataset.count = String(photos.length);
    card.classList.toggle("hidden-album", hidden);
    (card.querySelector(".album-name") as HTMLElement).title = folder.path;
    card.classList.toggle("favorite", favorite);
    card.querySelector(".album-name")!.textContent = folder.label;
    card.querySelector(".album-count")!.textContent =
      `${photos.length.toLocaleString()} ${photos.length === 1 ? "photo" : "photos"}  ·  ${formatDate(folder.latest)}`;
    const star = card.querySelector<HTMLButtonElement>(".album-star")!;
    star.title = favorite ? "Remove from favorites" : "Add to favorites";
    star.replaceChildren(icon(favorite ? "starFilled" : "star", 16));
    const hide = card.querySelector<HTMLButtonElement>(".album-hide")!;
    hide.title = hidden ? "Show this album again" : "Hide this album";
    hide.replaceChildren(icon(hidden ? "eye" : "eyeOff", 15));
    if (fresh) this.observer.observe(card);
  }
}
