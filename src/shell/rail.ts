import { clear, h } from "../ui/dom";
import { icon } from "../ui/icons";
import { openMenu } from "../ui/menu";
import type { ModuleId, RailStatus } from "./module";
import { MODULES } from "./registry";

export interface RailHandlers {
  select(id: ModuleId): void;
  settings(): void;
  /** Opens the module in a new window (right-click → Open in New Window, or a middle click). */
  openWindow(id: ModuleId): void;
}

/** The slim glass rail on the far left: one button per enabled module, Settings at the bottom. */
export class Rail {
  readonly el = h("nav", { class: "rail", "aria-label": "Modules" });
  private items = h("div", { class: "rail-items" });
  private buttons = new Map<ModuleId, HTMLButtonElement>();
  private statuses = new Map<ModuleId, RailStatus>();
  private settingsButton = h("button", { class: "rail-btn", title: "Settings (Ctrl+,)", "aria-label": "Settings" }, icon("settings", 20));

  constructor(private readonly handlers: RailHandlers) {
    const mark = h("div", { class: "rail-mark", title: "CorePro" }, h("img", { src: "/logo.svg", alt: "CorePro", width: 30, height: 30, draggable: false }));
    this.settingsButton.append(h("span", { class: "rail-pill" }));
    this.settingsButton.addEventListener("click", () => handlers.settings());
    this.el.append(mark, this.items, h("div", { class: "spacer" }), this.settingsButton);
  }

  /** Rebuilds the buttons for the enabled modules, in order (Ctrl+1 is the first). */
  setItems(ids: ModuleId[]) {
    clear(this.items);
    this.buttons.clear();
    ids.forEach((id, i) => {
      const meta = MODULES[id];
      const button = h(
        "button",
        { class: "rail-btn", title: `${meta.title}  Ctrl+${i + 1}`, "aria-label": meta.title, onclick: () => this.handlers.select(id) },
        icon(meta.icon, 20),
        h("span", { class: "rail-pill" }),
      );
      button.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [{ label: meta.newWindow?.label ?? "Open in New Window", icon: meta.newWindow ? "plus" : "external", action: () => this.handlers.openWindow(id) }]);
      });
      button.addEventListener("auxclick", (e) => {
        if (e.button === 1) this.handlers.openWindow(id);
      });
      this.buttons.set(id, button);
      this.items.append(button);
      this.showStatus(id);
    });
  }

  /** Puts a dot on a module's button (or takes it off), with a line for its tooltip. */
  setStatus(id: ModuleId, status: RailStatus | null) {
    if (status) this.statuses.set(id, status);
    else this.statuses.delete(id);
    this.showStatus(id);
  }

  private showStatus(id: ModuleId) {
    const button = this.buttons.get(id);
    if (!button) return;
    const status = this.statuses.get(id);
    const index = [...this.buttons.keys()].indexOf(id);
    button.title = `${MODULES[id].title}  Ctrl+${index + 1}${status ? `\n${status.title}` : ""}`;
    button.querySelector(".rail-dot")?.remove();
    if (status) button.append(h("span", { class: `rail-dot ${status.tone}` }));
  }

  /** Marks the module whose workspace is showing; `null` while Settings has the workspace. */
  setActive(id: ModuleId | null) {
    for (const [key, button] of this.buttons) button.classList.toggle("active", key === id);
  }

  setSettingsActive(on: boolean) {
    this.settingsButton.classList.toggle("active", on);
  }
}
