import { clear, h } from "../ui/dom";
import { icon, type IconName } from "../ui/icons";
import type { Group } from "./model";

export type NavTarget = "albums" | "favorites" | "photos";

export interface SidebarHandlers {
  navigate(target: NavTarget): void;
  selectGroup(index: number): void;
  toggleFavorite(index: number): void;
  menu(index: number, x: number, y: number): void;
  addFolder(): void;
  toggleHidden(): void;
  lockSettings(): void;
}

export interface SidebarState {
  hidden: ReadonlySet<string>;
  favorites: ReadonlySet<string>;
  showingHidden: boolean;
}

export class Sidebar {
  readonly el = h("aside", { class: "sidebar" });
  private nav = new Map<NavTarget, HTMLButtonElement>();
  private favoriteCount = h("span", { class: "sb-count" });
  private list = h("nav", { class: "sb-list" });
  private hiddenButton = h("button", { class: "sb-foot-btn" });
  private items = new Map<number, HTMLElement>();
  private active = -1;

  constructor(private readonly handlers: SidebarHandlers) {
    const brand = h("div", { class: "sb-brand" }, h("img", { src: "/logo.svg", alt: "", width: 26, height: 26 }), h("span", null, "SliderPro"));
    const navList = h("div", { class: "sb-nav" });
    const entries: [NavTarget, string, IconName][] = [["albums", "Albums", "grid"], ["favorites", "Favorites", "star"], ["photos", "All photos", "image"]];
    for (const [target, label, glyph] of entries) {
      const button = h("button", { class: "sb-nav-item", onclick: () => handlers.navigate(target) }, icon(glyph, 17), h("span", { class: "sb-name" }, label));
      if (target === "favorites") button.append(this.favoriteCount);
      this.nav.set(target, button);
      navList.append(button);
    }
    this.hiddenButton.addEventListener("click", () => handlers.toggleHidden());
    const foot = h(
      "div",
      { class: "sb-foot" },
      h("button", { class: "sb-foot-btn", title: "Include a folder SliderPro didn't find on its own", onclick: () => handlers.addFolder() }, icon("folderPlus", 15), "Add a folder"),
      this.hiddenButton,
      h("button", { class: "sb-foot-btn", title: "Lock SliderPro with a password", onclick: () => handlers.lockSettings() }, icon("lock", 15), "Privacy lock"),
    );
    this.list.addEventListener("click", (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const item = target?.closest<HTMLElement>(".sb-item");
      if (!item) return;
      const index = Number(item.dataset.index);
      if (target?.closest(".sb-star")) this.handlers.toggleFavorite(index);
      else this.handlers.selectGroup(index);
    });
    this.list.addEventListener("keydown", (e) => {
      const item = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>(".sb-item") : null;
      if (item && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        this.handlers.selectGroup(Number(item.dataset.index));
      }
    });
    this.list.addEventListener("contextmenu", (e) => {
      const item = e.target instanceof Element ? e.target.closest<HTMLElement>(".sb-item") : null;
      if (!item) return;
      e.preventDefault();
      this.handlers.menu(Number(item.dataset.index), e.clientX, e.clientY);
    });
    this.el.append(brand, navList, this.list, foot);
  }

  setNav(target: NavTarget | null) {
    for (const [key, button] of this.nav) button.classList.toggle("active", key === target);
  }

  /** `groups` arrive favorites first; a heading is placed before each part. */
  update(groups: Group[], state: SidebarState) {
    clear(this.list);
    this.items.clear();
    const favorites = groups.filter((g) => state.favorites.has(g.folder.path)).length;
    this.favoriteCount.textContent = favorites ? favorites.toLocaleString() : "";
    groups.forEach((group, index) => {
      if (index === 0 && favorites) this.list.append(this.heading("Favorites", favorites));
      if (index === favorites) this.list.append(this.heading("Albums", groups.length - favorites));
      const path = group.folder.path;
      const favorite = state.favorites.has(path);
      const star = h("button", { class: "sb-star", title: favorite ? "Remove from favorites" : "Add to favorites", tabIndex: -1 }, icon(favorite ? "starFilled" : "star", 13));
      const item = h(
        "div",
        { class: `sb-item${state.hidden.has(path) ? " hidden-album" : ""}${favorite ? " favorite" : ""}`, title: path, role: "button", tabIndex: 0 },
        h("span", { class: "sb-name" }, group.folder.label),
        star,
        h("span", { class: "sb-count" }, group.photos.length.toLocaleString()),
      );
      item.dataset.index = String(index);
      this.items.set(index, item);
      this.list.append(item);
    });
    const hiddenCount = state.hidden.size;
    this.hiddenButton.hidden = hiddenCount === 0;
    this.hiddenButton.replaceChildren(icon(state.showingHidden ? "eyeOff" : "eye", 15), state.showingHidden ? "Hide hidden albums" : `Show hidden albums (${hiddenCount})`);
    const previous = this.active;
    this.active = -1;
    this.setActive(previous);
  }

  setActive(index: number) {
    if (index === this.active) return;
    this.items.get(this.active)?.classList.remove("active");
    this.active = index;
    const item = this.items.get(index);
    if (item) {
      item.classList.add("active");
      item.scrollIntoView({ block: "nearest" });
    }
  }

  private heading(label: string, count: number) {
    return h("div", { class: "sb-head" }, h("span", null, `${label} · ${count.toLocaleString()}`));
  }
}
