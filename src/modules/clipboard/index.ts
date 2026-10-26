import type { UnlistenFn } from "@tauri-apps/api/event";
import { clipboardApi, onClipboardChanged, type ClipItem, type History } from "../../clipboard/api";
import { clipCard } from "../../clipboard/cards";
import "../../clipboard/clipboard.css";
import type { AppModule, ModuleFactory } from "../../shell/module";
import { isMainWindow } from "../../shell/windows";
import { dirname, h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu } from "../../ui/menu";
import "../files/ops/ops.css";
import { showToast } from "../files/ops/toast";

type Filter = "all" | "text" | "image" | "files" | "pinned";

const FILTERS: [Filter, string][] = [["all", "All"], ["text", "Text"], ["image", "Pictures"], ["files", "Files"], ["pinned", "Pinned"]];

/**
 * The Clipboard section: the whole history as cards, searchable and filtered by kind, with Copy,
 * Pin and Delete, Clear all, and the Win+V popup a click away. Recording settings are in
 * Settings → Clipboard.
 */
export const createClipboardModule: ModuleFactory = (shell) => {
  const settings = () => shell.config.clipboard;
  let history: History | null = null;
  let visible = false;
  let dirty = true;
  const unlisten: Promise<UnlistenFn>[] = [];

  const search = h("input", { class: "search-input", type: "search", placeholder: "Search the clipboard", "aria-label": "Search the clipboard", spellcheck: "false" });
  search.addEventListener("input", () => draw());
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.stopPropagation();
      search.value = "";
      draw();
    }
  });
  const filterButtons = FILTERS.map(([id, label]) => [id, h("button", { type: "button", onclick: () => setFilter(id) }, label)] as const);
  const count = h("span", { class: "cm-count" });
  const clear = h("button", { class: "btn small ghost", type: "button", onclick: () => void clipboardApi.clear() }, icon("trash", 14), "Clear All");
  const popup = h("button", { class: "btn small", type: "button", title: "The Win+V popup (also from your desktop shortcut)", onclick: () => void clipboardApi.togglePopup() }, icon("clipboard", 14), "Show Popup");
  const settingsButton = h("button", { class: "icon-btn", type: "button", title: "Clipboard settings", "aria-label": "Clipboard settings", hidden: !isMainWindow, onclick: () => shell.openSettings("clipboard") }, icon("settings", 17));
  const bar = h("header", { class: "cm-bar" },
    h("div", { class: "cm-title" }, h("h1", null, "Clipboard"), count),
    h("label", { class: "search cm-search" }, icon("search", 15), search),
    h("div", { class: "segmented" }, ...filterButtons.map(([, b]) => b)),
    h("div", { class: "spacer" }), clear, popup, settingsButton);
  const content = h("div", { class: "cm-content" });
  const scroll = h("div", { class: "cm-scroll" }, content);
  const el = h("section", { class: "clipboard-module" }, bar, scroll);

  function setFilter(id: Filter) {
    settings().filter = id;
    shell.saveConfig();
    draw();
  }

  async function load() {
    try {
      history = await clipboardApi.list();
    } catch {
      history = null;
    }
    draw();
  }

  function matches(item: ClipItem, terms: string[]): boolean {
    const hay = `${item.text} ${item.source ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  }

  function shown(): ClipItem[] {
    const filter = settings().filter;
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (history?.items ?? []).filter((i) => (filter === "all" ? true : filter === "pinned" ? i.pinned : i.kind === filter) && matches(i, terms));
  }

  async function copy(item: ClipItem) {
    try {
      await clipboardApi.use(item.id, false);
      showToast("Copied", undefined, 1800);
    } catch (err) {
      showToast(String(err));
    }
  }

  function menu(item: ClipItem, x: number, y: number) {
    const folder = item.kind === "files" ? item.text.split("\n")[0] : item.kind === "image" ? item.image : null;
    openMenu(x, y, [
      { label: "Copy", icon: "copy", action: () => void copy(item) },
      { label: item.pinned ? "Unpin" : "Pin", icon: "pin", action: () => void clipboardApi.pin(item.id, !item.pinned) },
      ...(folder ? [{ label: "Show in Files", icon: "folder" as IconName, action: () => shell.open({ kind: "folder", path: dirname(folder) }) }] : []),
      ...(item.source ? [{ label: `Don't Keep Copies from ${item.source}`, icon: "eyeOff" as IconName, action: () => void exclude(item.source!) }] : []),
      "separator",
      { label: "Delete", icon: "trash", danger: true, action: () => void clipboardApi.remove(item.id) },
    ]);
  }

  async function exclude(source: string) {
    if (!history) return;
    const s = history.settings;
    await clipboardApi.setSettings({ ...s, exclude: [...new Set([...s.exclude, source])] });
    showToast(`Copies from ${source} won't be kept`, { label: "Undo", run: () => void clipboardApi.setSettings(s) });
  }

  function draw() {
    if (!visible) {
      dirty = true;
      return;
    }
    dirty = false;
    for (const [id, button] of filterButtons) button.classList.toggle("active", id === settings().filter);
    const items = shown();
    const all = history?.items ?? [];
    count.textContent = all.length ? String(all.length) : "";
    clear.disabled = !all.some((i) => !i.pinned);
    if (!history) {
      content.replaceChildren(empty("lock", "The clipboard is locked", "Unlock CorePro to see what you copied."));
      return;
    }
    const parts: HTMLElement[] = [];
    if (!history.settings.enabled) {
      parts.push(h("div", { class: "cm-banner" }, icon("info", 16), h("p", null, "Clipboard history is off: new copies aren't kept."),
        h("button", { class: "btn small primary", type: "button", onclick: () => void clipboardApi.setSettings({ ...history!.settings, enabled: true }) }, "Turn On")));
    }
    if (!items.length) {
      const query = search.value.trim();
      parts.push(query || settings().filter !== "all"
        ? empty("search", "Nothing matches", query ? `No copies contain “${query}”.` : "No copies of this kind.")
        : empty("clipboard", "Nothing copied yet", "Copy text, a picture or files anywhere on your desktop and they show up here. Press your shortcut to paste one again."));
    } else {
      parts.push(h("p", { class: "cm-hint" }, `Click a card to copy it. The last 25 copies are kept, plus the pinned ones.${history.canPaste ? "" : " Paste with Ctrl+V."}`));
      parts.push(h("div", { class: "cm-grid" }, ...items.map((item) => clipCard(item, { pick: (i) => void copy(i), menu }, 8))));
    }
    content.replaceChildren(...parts);
  }

  function empty(glyph: IconName, title: string, text: string): HTMLElement {
    return h("div", { class: "nm-empty cp-empty" }, h("div", { class: "cp-empty-tile glass" }, icon(glyph, 28)), h("h2", null, title), h("p", null, text));
  }

  unlisten.push(onClipboardChanged(() => void load()));
  void load();

  const module: AppModule = {
    id: "clipboard",
    title: "Clipboard",
    icon: "clipboard",
    el,
    activate() {
      visible = true;
      if (dirty) draw();
      void load();
    },
    deactivate() {
      visible = false;
    },
    handleKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        search.focus();
        search.select();
        return true;
      }
      return false;
    },
    lockChanged: () => void load(),
    dispose() {
      for (const u of unlisten) void u.then((fn) => fn());
      el.remove();
    },
  };
  return module;
};
