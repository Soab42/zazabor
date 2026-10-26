import { listen } from "@tauri-apps/api/event";
import { applyAppearance } from "../appearance";
import { adoptConfig, CONFIG_SAVED, parseConfig, saveConfig, type Config } from "../config";
import { followLock } from "../lock";
import { onOthers } from "../shell/windows";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { openMenu } from "../ui/menu";
import { clipboardApi, onClipboardChanged, type ClipItem, type History } from "./api";
import { clipCard } from "./cards";
import { EMOJI, KAOMOJI, SYMBOLS, type PickGroup } from "./emoji";
import "./clipboard.css";

type Tab = "clipboard" | "emoji" | "kaomoji" | "symbols";

const TABS: { id: Tab; title: string; mark: () => Node }[] = [
  { id: "clipboard", title: "Clipboard history", mark: () => icon("clipboard", 17) },
  { id: "emoji", title: "Emoji", mark: () => icon("smiley", 17) },
  { id: "kaomoji", title: "Kaomoji", mark: () => h("span", { class: "cp-tab-glyph" }, ";-)") },
  { id: "symbols", title: "Symbols", mark: () => h("span", { class: "cp-tab-glyph" }, "Ω") },
];

const DATA: Record<Exclude<Tab, "clipboard">, PickGroup[]> = { emoji: EMOJI, kaomoji: KAOMOJI, symbols: SYMBOLS };

/**
 * The Win+V popup, as Windows 11 has it: clipboard history first (Enter or a click pastes into
 * the app that had the keyboard), then Emoji, Kaomoji and Symbols with search and the ones used
 * lately. Esc, or clicking anywhere else, puts it away; it stays loaded for the next time.
 */
export async function startClipboardPopup(config: Config) {
  document.body.classList.add("clip-popup-window");
  applyAppearance(config.appearance);
  void onOthers<string>(CONFIG_SAVED, (json) => {
    try {
      adoptConfig(config, parseConfig(json));
    } catch {
      return;
    }
    applyAppearance(config.appearance);
  });
  await followLock();

  let tab: Tab = "clipboard";
  let history: History = { items: [], settings: { enabled: true, clearOnExit: false, exclude: [], tookSuperV: false }, canPaste: true };
  let active = 0;
  let notice = 0;

  const tabButtons = TABS.map((t) => h("button", { class: "cp-tab", type: "button", title: t.title, "aria-label": t.title, role: "tab", onclick: () => setTab(t.id) }, t.mark()));
  const close = h("button", { class: "icon-btn small", type: "button", title: "Close (Esc)", "aria-label": "Close", onclick: () => hide() }, icon("close", 14));
  const head = h("div", { class: "cp-head", "data-tauri-drag-region": "" }, h("div", { class: "cp-tabs", role: "tablist" }, ...tabButtons), h("span", { class: "spacer", "data-tauri-drag-region": "" }), close);
  const body = h("div", { class: "cp-body" });
  const status = h("div", { class: "cp-notice", role: "status", "aria-live": "polite" });
  const root = h("div", { class: "cp" }, head, body, status);
  document.getElementById("app")!.append(root);

  async function load() {
    try {
      history = await clipboardApi.list();
    } catch {
      // Locked: the lock screen covers the popup.
    }
    if (tab === "clipboard") drawClipboard();
  }

  function hide() {
    status.textContent = "";
    void clipboardApi.hidePopup();
  }

  function say(text: string, then?: () => void) {
    status.textContent = text;
    clearTimeout(notice);
    notice = window.setTimeout(() => {
      status.textContent = "";
      then?.();
    }, 1500);
  }

  function setTab(next: Tab) {
    tab = next;
    tabButtons.forEach((b, i) => {
      b.classList.toggle("active", TABS[i].id === tab);
      b.setAttribute("aria-selected", String(TABS[i].id === tab));
    });
    active = 0;
    if (tab === "clipboard") drawClipboard();
    else drawPicker(tab);
  }

  // ---- clipboard history

  function cards(): HTMLElement[] {
    return [...body.querySelectorAll<HTMLElement>(".clip-card")];
  }

  function highlight(index: number) {
    const list = cards();
    if (!list.length) return;
    active = Math.max(0, Math.min(list.length - 1, index));
    list.forEach((c, i) => c.classList.toggle("active", i === active));
    list[active].scrollIntoView({ block: "nearest" });
    list[active].focus({ preventScroll: true });
  }

  async function pick(item: ClipItem) {
    try {
      const pasted = await clipboardApi.use(item.id, true);
      if (!pasted) say("Copied. Press Ctrl+V to paste.", hide);
    } catch (err) {
      say(String(err));
    }
  }

  function menu(item: ClipItem, x: number, y: number) {
    openMenu(x, y, [
      { label: item.pinned ? "Unpin" : "Pin", icon: "pin", action: () => void clipboardApi.pin(item.id, !item.pinned) },
      { label: "Delete", icon: "trash", danger: true, shortcut: "Delete", action: () => void clipboardApi.remove(item.id) },
    ]);
  }

  function drawClipboard() {
    const { items, settings } = history;
    const clear = h("button", { class: "text-btn", type: "button", disabled: !items.some((i) => !i.pinned), onclick: () => void clipboardApi.clear() }, "Clear all");
    const top = h("div", { class: "cp-section-head" }, h("span", null, "Clipboard history"), h("span", { class: "spacer" }), clear);
    if (!settings.enabled) {
      body.replaceChildren(h("div", { class: "cp-empty" },
        h("div", { class: "cp-empty-tile glass" }, icon("clipboard", 26)),
        h("h2", null, "Clipboard history is off"),
        h("p", null, "Turn it on to keep the things you copy and paste them again from here."),
        h("button", { class: "btn primary small", type: "button", onclick: () => void clipboardApi.setSettings({ ...settings, enabled: true }).then(load) }, "Turn On")));
      return;
    }
    if (!items.length) {
      body.replaceChildren(top, h("div", { class: "cp-empty" },
        h("div", { class: "cp-empty-tile glass" }, icon("clipboard", 26)),
        h("h2", null, "Nothing here yet"),
        h("p", null, "Copy text, a picture or files and they show up here, newest first.")));
      return;
    }
    const list = h("div", { class: "cp-list", role: "listbox", "aria-label": "Clipboard history" }, ...items.map((item) => clipCard(item, { pick: (i) => void pick(i), menu }, 3)));
    body.replaceChildren(top, list);
    highlight(Math.min(active, items.length - 1));
  }

  // ---- emoji, kaomoji, symbols

  function remember(glyph: string) {
    config.clipboard.recent = [glyph, ...config.clipboard.recent.filter((g) => g !== glyph)].slice(0, 24);
    saveConfig(config);
  }

  async function type(glyph: string) {
    remember(glyph);
    try {
      const pasted = await clipboardApi.type(glyph);
      if (!pasted) say("Copied. Press Ctrl+V to paste.", hide);
    } catch (err) {
      say(String(err));
    }
  }

  function drawPicker(kind: Exclude<Tab, "clipboard">) {
    const groups = DATA[kind];
    const search = h("input", { class: "search-input", type: "search", placeholder: `Search ${kind}`, "aria-label": `Search ${kind}`, spellcheck: "false" });
    const results = h("div", { class: "cp-picks" });
    const chips = h("div", { class: "cp-groups" }, ...groups.map((g) => h("button", {
      class: "cp-group", type: "button", title: g.name, "aria-label": g.name,
      onclick: () => results.querySelector(`[data-group="${g.id}"]`)?.scrollIntoView({ block: "start" }),
    }, g.mark)));
    const known = new Set(groups.flatMap((g) => g.items.map((i) => i.glyph)));
    const glyph = (g: string, words = "") => h("button", { class: `cp-glyph${kind === "kaomoji" ? " wide" : ""}`, type: "button", title: words || g, onclick: () => void type(g) }, g);
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      if (q) {
        const found = groups.flatMap((g) => g.items).filter((i) => i.words.includes(q) || i.glyph.includes(q));
        results.replaceChildren(found.length ? h("div", { class: `cp-grid ${kind}` }, ...found.map((i) => glyph(i.glyph, i.words))) : h("p", { class: "cp-none" }, "Nothing found"));
      } else {
        const recent = config.clipboard.recent.filter((g) => known.has(g));
        results.replaceChildren(
          ...(recent.length ? [h("div", { class: "cp-group-name" }, "Recently used"), h("div", { class: `cp-grid ${kind}` }, ...recent.map((g) => glyph(g)))] : []),
          ...groups.flatMap((g) => [h("div", { class: "cp-group-name", "data-group": g.id }, g.name), h("div", { class: `cp-grid ${kind}` }, ...g.items.map((i) => glyph(i.glyph, i.words)))]));
      }
      active = 0;
      highlightGlyph(0);
    };
    search.addEventListener("input", draw);
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        glyphs()[active]?.click();
      }
    });
    body.replaceChildren(h("label", { class: "search cp-search" }, icon("search", 14), search), ...(kind === "kaomoji" ? [] : [chips]), results);
    draw();
    requestAnimationFrame(() => search.focus());
  }

  function glyphs(): HTMLElement[] {
    return [...body.querySelectorAll<HTMLElement>(".cp-glyph")];
  }

  function highlightGlyph(index: number) {
    const list = glyphs();
    if (!list.length) return;
    active = Math.max(0, Math.min(list.length - 1, index));
    list.forEach((g, i) => g.classList.toggle("active", i === active));
    list[active].scrollIntoView({ block: "nearest" });
  }

  /** Glyphs per row of the grid the active one is in (for up and down). */
  function perRow(): number {
    const list = glyphs();
    const first = list[active];
    if (!first) return 1;
    const top = first.offsetTop;
    const row = list.filter((g) => g.parentElement === first.parentElement && Math.abs(g.offsetTop - top) < 4);
    return Math.max(1, row.length);
  }

  // ---- keys

  window.addEventListener("keydown", (e) => {
    if (document.body.classList.contains("app-locked")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      return hide();
    }
    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault();
      const at = TABS.findIndex((t) => t.id === tab);
      return setTab(TABS[(at + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length].id);
    }
    if (tab === "clipboard") {
      const item = history.items[active];
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        highlight(active + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        highlight(e.key === "Home" ? 0 : history.items.length - 1);
      } else if (e.key === "Enter" && item) {
        e.preventDefault();
        void pick(item);
      } else if (e.key === "Delete" && item) {
        e.preventDefault();
        void clipboardApi.remove(item.id);
      } else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && item) {
        e.preventDefault();
        const r = cards()[active]?.getBoundingClientRect();
        if (r) menu(item, r.right - 160, r.top + 24);
      }
      return;
    }
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow(), ArrowUp: -perRow() };
    if (steps[e.key] && !(e.target instanceof HTMLInputElement && (e.key === "ArrowLeft" || e.key === "ArrowRight"))) {
      e.preventDefault();
      highlightGlyph(active + steps[e.key]);
    } else if (e.key === "Enter" && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      glyphs()[active]?.click();
    }
  });

  // Clicking anywhere else puts it away, as Win+V does.
  window.addEventListener("blur", () => {
    if (!document.querySelector(".menu")) hide();
  });

  void onClipboardChanged(() => void load());
  void listen("clipboard-popup-shown", () => {
    status.textContent = "";
    setTab("clipboard");
    active = 0;
    void load().then(() => highlight(0));
  });
  setTab("clipboard");
  await load();
  highlight(0);
}
