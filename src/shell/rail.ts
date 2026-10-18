import { clear, h } from "../ui/dom";
import { icon } from "../ui/icons";
import type { ModuleId } from "./module";
import { MODULES } from "./registry";

export interface RailHandlers {
  select(id: ModuleId): void;
  settings(): void;
}

/** The slim glass rail on the far left: one button per enabled module, Settings at the bottom. */
export class Rail {
  readonly el = h("nav", { class: "rail", "aria-label": "Modules" });
  private items = h("div", { class: "rail-items" });
  private buttons = new Map<ModuleId, HTMLButtonElement>();
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
      this.buttons.set(id, button);
      this.items.append(button);
    });
  }

  /** Marks the module whose workspace is showing; `null` while Settings has the workspace. */
  setActive(id: ModuleId | null) {
    for (const [key, button] of this.buttons) button.classList.toggle("active", key === id);
  }

  setSettingsActive(on: boolean) {
    this.settingsButton.classList.toggle("active", on);
  }
}
