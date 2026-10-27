import type { SettingsRow } from "../../../appearance";
import type { Category, SettingsHost } from "../../../shell/settings";
import { open } from "../../../shared/dialog";
import { h } from "../../../ui/dom";
import { recApi, recordPrefs, type Shortcut } from "./api";
import "./record.css";

const BINDINGS: [string, string][] = [["<Super><Shift>r", "Super+Shift+R"], ["<Primary><Alt>r", "Ctrl+Alt+R"], ["<Super><Alt>r", "Super+Alt+R"]];

/**
 * Settings → Screen Recorder: the desktop shortcut that opens the recorder from anywhere (and
 * stops a recording), where recordings go, and the countdown and control bar defaults.
 */
export function recorderCategory(host: Pick<SettingsHost, "config" | "configChanged">): Category {
  const prefs = () => recordPrefs(host.config);
  const wide = (label: string, hint: string, control: HTMLElement): SettingsRow => ({
    label: `${label} ${hint}`,
    el: h("div", { class: "sf-row plain wide" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), h("p", { class: "sf-hint" }, hint)), control),
  });
  const button = (label: string, onclick: () => void, cls = "btn small") => h("button", { type: "button", class: cls, onclick }, label);
  const toggle = (label: string, hint: string, get: () => boolean, set: (on: boolean) => void) => {
    const input = h("input", { type: "checkbox", class: "switch", role: "switch" });
    input.addEventListener("change", () => (set(input.checked), host.configChanged()));
    return { input, get, row: { label, el: h("label", { class: "sf-row sf-toggle" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), h("p", { class: "sf-hint" }, hint)), input) } satisfies SettingsRow };
  };

  // The shortcut.
  const keys = h("select", { "aria-label": "Shortcut" }, ...BINDINGS.map(([value, label]) => h("option", { value }, label)));
  const state = h("span", { class: "st-value" });
  const set = button("Add Shortcut", () => void setShortcut(keys.value));
  const remove = button("Remove", () => void setShortcut(null), "btn small ghost");
  const show = (s: Shortcut) => {
    if (!BINDINGS.some(([v]) => v === s.binding)) keys.append(h("option", { value: s.binding }, s.binding));
    keys.value = s.binding;
    keys.hidden = set.hidden = !s.supported;
    remove.hidden = s.state === "none";
    set.textContent = s.state === "installed" ? "Update" : s.state === "other" ? "Use This Zazabor" : "Add Shortcut";
    state.textContent = !s.supported ? `Add a shortcut in your desktop's keyboard settings that runs: ${s.command}` : s.state === "installed" ? "On" : "";
    state.classList.remove("st-error");
  };
  async function setShortcut(binding: string | null) {
    try {
      show(await recApi.setShortcut(binding));
    } catch (err) {
      state.textContent = String(err);
      state.classList.add("st-error");
    }
  }

  // Where recordings go.
  const folderText = h("span", { class: "st-value" });
  const drawFolder = () => (folderText.textContent = prefs().folder?.replace(/^\/home\/[^/]+/, "~") ?? "~/Videos/Recordings");
  const change = button("Change…", () => void (async () => {
    const picked = await open({ title: "Save Recordings In", directory: true }).catch(() => null);
    const folder = Array.isArray(picked) ? picked[0] : picked;
    if (!folder) return;
    prefs().folder = folder;
    host.configChanged();
    drawFolder();
  })());
  const reset = button("Use Videos", () => ((prefs().folder = null), host.configChanged(), drawFolder()), "btn small ghost");

  const countdown = toggle("Countdown before recording", "3, 2, 1 on the control bar, so you can get ready.", () => prefs().countdown, (on) => (prefs().countdown = on));
  const hideBar = toggle("Hide the control bar while recording", "It isn't recorded then; stop with the shortcut, or open the recorder again.", () => prefs().hideBar, (on) => (prefs().hideBar = on));

  return {
    id: "screen-recorder", title: "Screen Recorder", icon: "recRecord", section: "Modules",
    groups: [
      {
        title: "Shortcut",
        rows: [wide("Keyboard shortcut", "Opens the recorder from anywhere; while recording, the same keys stop and save. It runs “zazabor --record”.", h("div", { class: "st-inline" }, state, keys, remove, set))],
      },
      {
        title: "Recordings",
        rows: [
          wide("Save recordings in", "Each recording is named by its date and time, like “Recording 2026-10-27 15.30”.", h("div", { class: "st-inline" }, folderText, reset, change)),
          countdown.row,
          hideBar.row,
        ],
      },
    ],
    refresh() {
      drawFolder();
      countdown.input.checked = countdown.get();
      hideBar.input.checked = hideBar.get();
      void recApi.shortcut().then(show, () => undefined);
    },
  };
}
