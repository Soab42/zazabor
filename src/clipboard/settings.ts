import type { SettingsRow } from "../appearance";
import type { Category } from "../shell/settings";
import { invoke } from "@tauri-apps/api/core";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { clipboardApi, type ClipSettings, type ClipShortcut } from "./api";

const BINDINGS: [string, string][] = [["<Super>v", "Super+V"], ["<Super><Shift>v", "Super+Shift+V"], ["<Primary><Alt>v", "Ctrl+Alt+V"], ["<Primary><Shift><Alt>v", "Ctrl+Shift+Alt+V"]];

/**
 * Settings → Clipboard: history on/off, clearing it when CorePro quits, apps whose copies aren't
 * kept, and the desktop shortcut for the popup (Super+V, taken from GNOME only when asked).
 */
export function clipboardCategory(): Category {
  let settings: ClipSettings = { enabled: true, clearOnExit: false, exclude: [], tookSuperV: false };
  let sources: string[] = [];

  const toggle = (label: string, hint: string, set: (on: boolean) => void) => {
    const input = h("input", { type: "checkbox", class: "switch", role: "switch" });
    input.addEventListener("change", () => set(input.checked));
    return { input, row: { label, el: h("label", { class: "sf-row sf-toggle" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), h("p", { class: "sf-hint" }, hint)), input) } satisfies SettingsRow };
  };
  const wide = (label: string, hint: string, control: HTMLElement): SettingsRow => ({
    label: `${label} ${hint}`,
    el: h("div", { class: "sf-row plain wide st-notes-row" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), h("p", { class: "sf-hint" }, hint)), control),
  });
  const button = (label: string, onclick: () => void, cls = "btn small") => h("button", { type: "button", class: cls, onclick }, label);
  const save = (patch: Partial<ClipSettings>) => {
    settings = { ...settings, ...patch };
    void clipboardApi.setSettings(settings).catch((err) => console.warn("Couldn't change the clipboard settings:", err));
  };

  const enabled = toggle("Clipboard history", "Keeps what you copy (the last 25, plus what you pin) to paste again from the popup. It pauses while CorePro is locked, and skips what password managers mark as secret.", (on) => save({ enabled: on }));
  const clearOnExit = toggle("Clear when CorePro quits", "Pinned items stay, as they do on Windows after a restart.", (on) => save({ clearOnExit: on }));
  const background = toggle("Run in the background", "CorePro starts when you log in and keeps running after its window closes, so the history records everything you copy and Super+V answers at once. Opening CorePro shows its window again.",
    (on) => void invoke("app_set_background", { on }).catch((err) => {
      background.input.checked = !on;
      console.warn("Couldn't change starting at login:", err);
    }));

  // Apps whose copies aren't kept.
  const chips = h("div", { class: "st-clip-excludes" });
  const listId = "st-clip-sources";
  const add = h("input", { class: "st-clip-input", placeholder: "App (window class)", "aria-label": "App to leave out", list: listId, spellcheck: "false" });
  const datalist = h("datalist", { id: listId });
  const addApp = () => {
    const v = add.value.trim();
    if (!v) return;
    save({ exclude: [...new Set([...settings.exclude, v])] });
    add.value = "";
    drawChips();
  };
  add.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") addApp();
  });
  const drawChips = () => {
    chips.replaceChildren(
      ...settings.exclude.map((app) => h("span", { class: "st-clip-chip" }, app, h("button", { type: "button", title: `Keep copies from ${app} again`, "aria-label": `Remove ${app}`, onclick: () => (save({ exclude: settings.exclude.filter((a) => a !== app) }), drawChips()) }, icon("close", 11)))),
      add, datalist, button("Add", addApp));
    datalist.replaceChildren(...sources.filter((s) => !settings.exclude.includes(s)).map((s) => h("option", { value: s })));
  };

  // The shortcut.
  const keys = h("select", { "aria-label": "Shortcut" }, ...BINDINGS.map(([value, label]) => h("option", { value }, label)));
  const shortcutState = h("span", { class: "st-value" });
  const setButton = button("Add Shortcut", () => void setShortcut(keys.value, false));
  const remove = button("Remove", () => void setShortcut(null, false), "btn small ghost");
  const copyCommand = button("Copy Command", () => void navigator.clipboard.writeText(command).catch(() => undefined));
  const conflict = h("p", { class: "st-clip-note" });
  const takeOver = button("Take Over Super+V", () => void setShortcut("<Super>v", true));
  const instead = button("Use Super+Shift+V", () => ((keys.value = "<Super><Shift>v"), void setShortcut(keys.value, false)), "btn small ghost");
  const conflictRow = h("div", { class: "st-inline" }, conflict, instead, takeOver);
  let command = "";
  let last: ClipShortcut | null = null;
  const showShortcut = (s: ClipShortcut) => {
    last = s;
    command = s.command;
    if (!BINDINGS.some(([v]) => v === s.binding)) keys.append(h("option", { value: s.binding }, s.binding));
    keys.value = s.binding;
    keys.hidden = setButton.hidden = !s.supported;
    copyCommand.hidden = s.supported;
    remove.hidden = s.state === "none";
    setButton.textContent = s.state === "installed" ? "Update" : s.state === "other" ? "Use This CorePro" : "Add Shortcut";
    shortcutState.textContent = !s.supported ? "" : s.state === "installed" ? "On" : s.state === "other" ? "Opens another CorePro" : "";
    shortcutState.classList.remove("st-error");
    drawConflict();
  };
  const drawConflict = () => {
    const superV = keys.value === "<Super>v";
    const clash = !!last?.gnomeSuperV && superV && last.state !== "installed";
    conflictRow.hidden = !clash && !last?.tookSuperV;
    takeOver.hidden = instead.hidden = !clash;
    conflict.textContent = clash
      ? "GNOME opens its notification list with Super+V (Super+M opens it too). Take Super+V over, or use another key."
      : last?.tookSuperV ? "Super+V was taken from GNOME's notification list. Removing this shortcut, or picking another key, gives it back." : "";
  };
  keys.addEventListener("change", drawConflict);
  const setShortcut = async (binding: string | null, take: boolean) => {
    if (binding === "<Super>v" && !take && last?.gnomeSuperV) return drawConflict();
    try {
      showShortcut(await clipboardApi.setShortcut(binding, take));
    } catch (err) {
      shortcutState.textContent = String(err);
      shortcutState.classList.add("st-error");
    }
  };

  const refresh = () => {
    void clipboardApi.list().then((hst) => {
      settings = hst.settings;
      sources = [...new Set(hst.items.map((i) => i.source).filter((s): s is string => !!s))].sort();
      enabled.input.checked = settings.enabled;
      void invoke<boolean>("app_background").then((on) => (background.input.checked = on), () => undefined);
      clearOnExit.input.checked = settings.clearOnExit;
      drawChips();
    }, () => undefined);
    void clipboardApi.shortcut().then(showShortcut, () => undefined);
  };
  drawChips();

  return {
    id: "clipboard", title: "Clipboard", icon: "clipboard", section: "Modules",
    groups: [
      {
        title: "History",
        rows: [
          enabled.row,
          background.row,
          clearOnExit.row,
          wide("Don't keep copies from", "Copies made in these apps never enter the history (a password manager, a banking app). Right-click an item in the Clipboard section to add its app.", chips),
          wide("Clear history", "Removes everything but the pinned items.", h("div", { class: "st-inline" }, button("Clear All", () => void clipboardApi.clear(), "btn small ghost"))),
        ],
      },
      {
        title: "Popup",
        rows: [
          wide("Keyboard shortcut", "Opens the clipboard popup from anywhere, like Win+V, and starts CorePro when it isn't running. It runs “corepro --clipboard”, which you can also bind yourself.",
            h("div", { class: "st-inline" }, shortcutState, keys, remove, setButton, copyCommand)),
          { label: "Super+V GNOME", el: h("div", { class: "sf-row plain wide st-notes-row" }, conflictRow) },
          wide("Open the popup now", "Shows it next to the pointer.", h("div", { class: "st-inline" }, button("Show Popup", () => void clipboardApi.togglePopup()))),
        ],
      },
    ],
    refresh,
  };
}
