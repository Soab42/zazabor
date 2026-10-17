import { clear, h } from "../ui/dom";
import { icon, type IconName } from "../ui/icons";
import type { Group } from "./model";

export type NavTarget = "albums" | "photos";

export interface SidebarHandlers {
  navigate(target: NavTarget): void;
  selectGroup(index: number): void;
  addFolder(): void;
  toggleHidden(): void;
  lockSettings(): void;
}

export class Sidebar {
  readonly el = h("aside", { class: "sidebar" });
  private nav = new Map<NavTarget, HTMLButtonElement>();
  private heading = h("span");
  private list = h("nav", { class: "sb-list" });
  private hiddenButton = h("button", { class: "sb-foot-btn" });
  private items = new Map<number, HTMLElement>();
  private active = -1;

  constructor(private readonly handlers: SidebarHandlers) {
    const brand = h("div", { class: "sb-brand" }, h("img", { src: "/logo.svg", alt: "", width: 26, height: 26 }), h("span", null, "SliderPro"));
    const navList = h("div", { class: "sb-nav" });
    for (const [target, label, glyph] of [["albums", "Albums", "grid"], ["photos", "All photos", "image"]] as [NavTarget, string, IconName][]) {
      const button = h("button", { class: "sb-nav-item", onclick: () => handlers.navigate(target) }, icon(glyph, 17), label);
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
    this.el.append(brand, navList, h("div", { class: "sb-head" }, this.heading), this.list, foot);
  }

  setNav(target: NavTarget | null) {
    for (const [key, button] of this.nav) button.classList.toggle("active", key === target);
  }

  update(groups: Group[], hiddenCount: number, showingHidden: boolean, hidden: ReadonlySet<string>) {
    clear(this.list);
    this.items.clear();
    this.heading.textContent = `Albums · ${groups.length.toLocaleString()}`;
    groups.forEach((group, index) => {
      const item = h(
        "button",
        { class: `sb-item${hidden.has(group.folder.path) ? " hidden-album" : ""}`, title: group.folder.path, onclick: () => this.handlers.selectGroup(index) },
        h("span", { class: "sb-name" }, group.folder.label),
        h("span", { class: "sb-count" }, group.photos.length.toLocaleString()),
      );
      this.items.set(index, item);
      this.list.append(item);
    });
    this.hiddenButton.hidden = hiddenCount === 0;
    this.hiddenButton.replaceChildren(icon(showingHidden ? "eyeOff" : "eye", 15), showingHidden ? "Hide hidden albums" : `Show hidden albums (${hiddenCount})`);
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
}
