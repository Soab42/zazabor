import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { folderName } from "./path";
import type { Tab } from "./tabs";

export interface TabBarHooks {
  select(index: number): void;
  close(index: number): void;
  add(): void;
}

/** The strip of tabs under the toolbar; hidden while only one tab is open. */
export class TabBar {
  readonly el = h("div", { class: "fs-tabbar", role: "tablist" });

  constructor(private readonly hooks: TabBarHooks) {
    this.el.hidden = true;
  }

  render(tabs: Tab[], active: number) {
    this.el.hidden = tabs.length < 2;
    const nodes: Node[] = tabs.map((tab, i) => {
      const title = tab.path ? folderName(tab.path) : "Files";
      const close = h("button", { class: "fs-tab-close", type: "button", title: "Close Tab (Ctrl+W)", tabIndex: -1 }, icon("close", 11));
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hooks.close(i);
      });
      const el = h("div", { class: `fs-tab${i === active ? " active" : ""}`, role: "tab", title: tab.path || title, "aria-selected": String(i === active) },
        icon("folder", 14), h("span", { class: "fs-tab-title" }, title), close);
      // Drop targets: dropping on a tab moves into its folder; hovering switches to it (see dnd.ts).
      el.dataset.tabIndex = String(i);
      if (tab.path) el.dataset.dropPath = tab.path;
      el.addEventListener("click", () => this.hooks.select(i));
      // Middle-click closes, and must not start the browser's autoscroll.
      el.addEventListener("mousedown", (e) => {
        if (e.button === 1) e.preventDefault();
      });
      el.addEventListener("auxclick", (e) => {
        if (e.button === 1) this.hooks.close(i);
      });
      return el;
    });
    const add = h("button", { class: "icon-btn small fs-tab-add", type: "button", title: "New Tab (Ctrl+T)" }, icon("plus", 14));
    add.addEventListener("click", () => this.hooks.add());
    this.el.replaceChildren(...nodes, add);
  }
}
