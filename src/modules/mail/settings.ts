import { invoke } from "@tauri-apps/api/core";
import type { SettingsRow } from "../../appearance";
import type { Config } from "../../config";
import type { Category } from "../../shell/settings";
import { h } from "../../ui/dom";

/**
 * Settings → Mail: new mail on the desktop, checking for it with no window open (Zazabor's
 * background mode, shared with the clipboard history), and pictures from the web.
 */
export function mailCategory(host: { readonly config: Config; configChanged(): void }): Category {
  const toggle = (label: string, hint: string, set: (on: boolean) => void) => {
    const input = h("input", { type: "checkbox", class: "switch", role: "switch" });
    input.addEventListener("change", () => set(input.checked));
    return { input, row: { label, el: h("label", { class: "sf-row sf-toggle" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), h("p", { class: "sf-hint" }, hint)), input) } satisfies SettingsRow };
  };
  const notify = toggle("Show new mail on the desktop", "A notification with who wrote and the subject when mail arrives in an inbox. Clicking it opens the inbox. While Zazabor Home is locked it only says that mail came.",
    (on) => ((host.config.mail.notify = on), host.configChanged()));
  const background = toggle("Check for mail in the background", "Zazabor Home starts when you log in and keeps running after its window closes, so new mail is announced as it arrives. The clipboard history uses the same setting.",
    (on) => void invoke("app_set_background", { on }).catch((err) => {
      background.input.checked = !on;
      console.warn("Couldn't change the background mode:", err);
    }));
  const images = toggle("Always show pictures", "Pictures a message loads from the web can tell the sender you opened it. Off: each message asks first.",
    (on) => ((host.config.mail.images = on ? "always" : "ask"), host.configChanged()));

  return {
    id: "mail", title: "Mail", icon: "mail", section: "Modules",
    groups: [
      { title: "New mail", rows: [notify.row, background.row] },
      { title: "Reading", rows: [images.row] },
    ],
    refresh() {
      notify.input.checked = host.config.mail.notify;
      images.input.checked = host.config.mail.images === "always";
      void invoke<boolean>("app_background").then((on) => (background.input.checked = on), () => undefined);
    },
  };
}
