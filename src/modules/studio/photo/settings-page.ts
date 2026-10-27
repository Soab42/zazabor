import type { SettingsRow } from "../../../appearance";
import type { Config } from "../../../config";
import type { Category } from "../../../shell/settings";
import { h } from "../../../ui/dom";
import { modelsPanel } from "./aimodels";
import { normalizePhotoSettings } from "./settings";
import "./photo.css";

/**
 * Settings → Photo: which subject finder Remove Background and Select Subject use, and the AI
 * models on this computer (each downloads on first use; Remove frees the space).
 */
export function photoCategory(host: { readonly config: Config; configChanged(): void }): Category {
  const wide = (label: string, hint: string, control: HTMLElement): SettingsRow => ({
    label: `${label} ${hint}`,
    el: h("div", { class: "sf-row plain wide st-notes-row" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), h("p", { class: "sf-hint" }, hint)), control),
  });
  const choice = h("div", { class: "segmented" });
  const drawChoice = () => {
    const current = normalizePhotoSettings(host.config.studio.apps.photo).ai.subject;
    choice.replaceChildren(...(["best", "fast"] as const).map((id) =>
      h("button", { type: "button", class: id === current ? "active" : "", onclick: () => {
        const settings = normalizePhotoSettings(host.config.studio.apps.photo);
        settings.ai.subject = id;
        host.config.studio.apps.photo = settings;
        host.configChanged();
        drawChoice();
      } }, id === "best" ? "Best (IS-Net)" : "Faster (U²-Netp)")));
  };
  drawChoice();
  const models = modelsPanel();
  return {
    id: "photo", title: "Photo", icon: "photoEdit", section: "Modules",
    groups: [
      {
        title: "AI tools",
        rows: [
          wide("Subject finder", "For Remove Background and Select Subject. IS-Net (170 MB) finds edges better; U²-Netp (4.4 MB) is quicker and smaller.", choice),
          wide("Models on this computer", "Each tool downloads its model the first time you use it, after asking. They run here: your pictures never leave this computer.", models.el),
        ],
      },
    ],
    refresh: () => {
      drawChoice();
      models.refresh();
    },
  };
}
