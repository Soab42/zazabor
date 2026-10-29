import type { TerminalSettings } from "../config";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { openMenu, type MenuItem } from "../ui/menu";
import { termApi } from "./api";
import { duration, TerminalView, type Block } from "./view";

type Leaf = { kind: "leaf"; view: TerminalView; el: HTMLElement };
type Split = { kind: "split"; dir: "row" | "col"; a: Pane; b: Pane; ratio: number; el: HTMLElement };
type Pane = Leaf | Split;

interface Tab {
  root: Pane;
  focused: TerminalView;
  body: HTMLElement;
  button: HTMLElement;
  label: HTMLElement;
}

export interface TerminalTabsOptions {
  /** The folder new terminals start in. */
  cwd(): string | null;
  settings(): TerminalSettings;
  /** Settings changed here (font size): save them. */
  saveSettings(): void;
  /** Extra buttons on the right of the tab strip (e.g. close the panel). */
  actions?: HTMLElement[];
  /** The last terminal was closed. */
  onEmpty?(): void;
  /** A command finished in a tab nobody was looking at (it gets a dot). */
  onNotice?(failed: boolean): void;
}

const MIN_FONT = 8;
const MAX_FONT = 28;

/**
 * Terminals in tabs, each tab split into panes (right or down, dividers to drag, Alt+arrows to
 * move between them). A tab whose command finishes while you look elsewhere gets a dot, green or
 * red. The + menu picks a shell.
 */
export class TerminalTabs {
  readonly el: HTMLElement;
  private readonly strip = h("div", { class: "tt-strip", role: "tablist" });
  private readonly body = h("div", { class: "tt-body" });
  private readonly tabs: Tab[] = [];
  private active: Tab | null = null;
  private shown = false;
  private shells: { name: string; path: string; default: boolean }[] | null = null;

  constructor(private readonly opts: TerminalTabsOptions) {
    const button = (name: Parameters<typeof icon>[0], title: string, fn: (e: MouseEvent) => void) =>
      h("button", { class: "icon-btn small", type: "button", title, onclick: fn }, icon(name, 15));
    const add = h("div", { class: "tt-add" },
      button("plus", "New Terminal (Ctrl+Shift+T)", () => void this.add()),
      button("chevronDown", "Choose a Shell…", (e) => void this.shellMenu(e)));
    this.el = h("div", { class: "tt" },
      h("div", { class: "tt-bar" }, this.strip, add,
        h("span", { class: "tt-sep" }),
        button("splitRight", "Split Right (Ctrl+Shift+D)", () => void this.split("row")),
        button("splitDown", "Split Down (Ctrl+Shift+O)", () => void this.split("col")),
        button("search", "Find (Ctrl+Shift+F)", () => this.focusedView()?.openFind()),
        button("trash", "Clear", () => this.focusedView()?.clear()),
        ...(opts.actions ?? [])),
      this.body);
  }

  get count() {
    return this.tabs.length;
  }

  /** The folder the focused terminal is in (for a new window or terminal). */
  get cwd(): string | null {
    return this.active?.focused.cwd || null;
  }

  private focusedView(): TerminalView | null {
    return this.active?.focused ?? null;
  }

  /** The terminals are on screen: start one if there are none, fit and focus. */
  async show() {
    this.shown = true;
    if (this.tabs.length === 0) await this.add();
    else {
      await this.mountAll(this.active);
      this.active?.focused.focus();
    }
  }

  hide() {
    this.shown = false;
  }

  // ---- terminals and panes -------------------------------------------------------------------

  private makeView(tab: () => Tab | undefined, cwd: string | null, shell: string | null): TerminalView {
    const view: TerminalView = new TerminalView({
      cwd,
      shell,
      settings: () => this.opts.settings(),
      onTitle: () => this.paintTab(tab()),
      onExit: () => undefined,
      onCommandDone: (block) => this.commandDone(tab(), view, block),
      onAppKey: (e) => this.handleKey(e),
      onFocus: () => {
        const t = tab();
        if (!t) return;
        t.focused = view;
        this.paintFocus(t);
        this.paintTab(t);
      },
    });
    return view;
  }

  async add(cwd = this.active?.focused.cwd || this.opts.cwd(), shell: string | null = null) {
    const label = h("span", { class: "tt-tab-name" }, "Terminal");
    const close = h("button", { class: "tt-tab-close", type: "button", title: "Close Tab", tabIndex: -1 }, icon("close", 12));
    const button = h("div", { class: "tt-tab", role: "tab" }, h("span", { class: "tt-dot" }), icon("terminal", 13), label, close);
    let tab: Tab | undefined;
    const view = this.makeView(() => tab, cwd, shell);
    const leaf: Leaf = { kind: "leaf", view, el: h("div", { class: "tp-leaf" }, view.el) };
    tab = { root: leaf, focused: view, body: h("div", { class: "tt-tab-body" }, leaf.el), button, label };
    const self = tab;
    button.addEventListener("click", () => void this.select(self));
    button.addEventListener("auxclick", (e) => {
      if (e.button === 1) this.closeTab(self);
    });
    button.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        { label: "Split Right", icon: "splitRight", action: () => void this.select(self).then(() => this.split("row")) },
        { label: "Split Down", icon: "splitDown", action: () => void this.select(self).then(() => this.split("col")) },
        "separator",
        { label: "Close Tab", icon: "close", action: () => this.closeTab(self) },
        { label: "Close Other Tabs", disabled: this.tabs.length < 2, action: () => this.tabs.filter((t) => t !== self).forEach((t) => this.closeTab(t)) },
      ]);
    });
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(self);
    });
    this.tabs.push(tab);
    this.strip.append(button);
    this.body.append(tab.body);
    await this.select(tab);
  }

  private async select(tab: Tab) {
    this.active = tab;
    for (const t of this.tabs) {
      t.button.classList.toggle("active", t === tab);
      t.body.hidden = t !== tab;
    }
    tab.button.classList.remove("done", "ok", "failed");
    if (this.shown) {
      await this.mountAll(tab);
      tab.focused.focus();
    }
  }

  private async mountAll(tab: Tab | null) {
    if (!tab) return;
    for (const leaf of leaves(tab.root)) await leaf.view.mount();
  }

  /** Splits the focused pane: "row" puts the new terminal on the right, "col" below. */
  async split(dir: "row" | "col") {
    const tab = this.active;
    if (!tab) return void this.add();
    const target = findLeaf(tab.root, tab.focused);
    if (!target) return;
    const view = this.makeView(() => tab, tab.focused.cwd || this.opts.cwd(), null);
    const leaf: Leaf = { kind: "leaf", view, el: h("div", { class: "tp-leaf" }, view.el) };
    const split: Split = { kind: "split", dir, a: target, b: leaf, ratio: 0.5, el: h("div", { class: `tp-split ${dir}` }) };
    tab.root = replace(tab.root, target, split);
    tab.focused = view;
    this.layout(tab);
    await view.mount();
    view.focus();
    this.paintFocus(tab);
  }

  /** Closes the focused pane (the tab with its last one). */
  closePane(tab = this.active) {
    if (!tab) return;
    const target = findLeaf(tab.root, tab.focused);
    if (!target || tab.root === target) return this.closeTab(tab);
    const parent = parentOf(tab.root, target);
    if (!parent) return;
    const sibling = parent.a === target ? parent.b : parent.a;
    tab.root = replace(tab.root, parent, sibling);
    target.view.dispose();
    tab.focused = leaves(sibling)[0].view;
    this.layout(tab);
    tab.focused.focus();
    this.paintFocus(tab);
    this.paintTab(tab);
  }

  closeTab(tab = this.active) {
    if (!tab) return;
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    tab.button.remove();
    tab.body.remove();
    for (const leaf of leaves(tab.root)) leaf.view.dispose();
    const next = this.tabs[Math.min(i, this.tabs.length - 1)];
    if (next) void this.select(next);
    else {
      this.active = null;
      this.opts.onEmpty?.();
    }
  }

  /** Rebuilds a tab's pane layout (after a split or close). */
  private layout(tab: Tab) {
    const build = (pane: Pane): HTMLElement => {
      if (pane.kind === "leaf") return pane.el;
      const a = build(pane.a);
      const b = build(pane.b);
      a.style.flex = `${pane.ratio} 1 0`;
      b.style.flex = `${1 - pane.ratio} 1 0`;
      const divider = h("div", { class: "tp-divider" });
      divider.addEventListener("pointerdown", (e) => this.drag(e, pane, a, b, tab));
      pane.el.replaceChildren(a, divider, b);
      return pane.el;
    };
    const root = build(tab.root);
    root.style.flex = "1 1 0";
    tab.body.replaceChildren(root);
    tab.body.classList.toggle("split", tab.root.kind === "split");
  }

  private drag(e: PointerEvent, pane: Split, a: HTMLElement, b: HTMLElement, tab: Tab) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const rect = pane.el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const ratio = pane.dir === "row" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      pane.ratio = Math.min(0.85, Math.max(0.15, ratio));
      a.style.flex = `${pane.ratio} 1 0`;
      b.style.flex = `${1 - pane.ratio} 1 0`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      for (const leaf of leaves(tab.root)) leaf.view.fitNow();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  /** Moves focus to the pane in a direction (Alt+arrows). */
  private moveFocus(dx: number, dy: number) {
    const tab = this.active;
    if (!tab) return;
    const from = tab.focused.el.getBoundingClientRect();
    const cx = from.left + from.width / 2;
    const cy = from.top + from.height / 2;
    let best: TerminalView | null = null;
    let bestScore = Infinity;
    for (const leaf of leaves(tab.root)) {
      if (leaf.view === tab.focused) continue;
      const r = leaf.view.el.getBoundingClientRect();
      const x = r.left + r.width / 2 - cx;
      const y = r.top + r.height / 2 - cy;
      if ((dx && Math.sign(x) !== dx) || (dy && Math.sign(y) !== dy)) continue;
      const score = Math.abs(dx ? x : y) + Math.abs(dx ? y : x) * 2;
      if (score < bestScore) {
        bestScore = score;
        best = leaf.view;
      }
    }
    best?.focus();
  }

  private paintFocus(tab: Tab) {
    for (const leaf of leaves(tab.root)) leaf.el.classList.toggle("focused", leaf.view === tab.focused);
  }

  /** Tab title: the focused pane's program or folder, with a count when split. */
  private paintTab(tab: Tab | undefined) {
    if (!tab) return;
    const panes = leaves(tab.root).length;
    tab.label.textContent = panes > 1 ? `${tab.focused.title} · ${panes}` : tab.focused.title;
    tab.button.title = tab.focused.cwd;
  }

  private commandDone(tab: Tab | undefined, view: TerminalView, block: Block) {
    if (!tab) return;
    const failed = block.exit !== null && block.exit !== 0;
    const visible = tab === this.active && this.shown && document.hasFocus();
    if (!visible && block.finished - block.started > 1500) {
      tab.button.classList.add("done");
      tab.button.classList.toggle("failed", failed);
      tab.button.classList.toggle("ok", !failed);
      tab.button.title = `${block.command} ${failed ? `failed (exit ${block.exit})` : "finished"} in ${duration(block.finished - block.started)}`;
      this.opts.onNotice?.(failed);
    }
    void view;
  }

  private async shellMenu(e: MouseEvent) {
    this.shells ??= await termApi.shells().catch(() => []);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const current = this.opts.settings().shell;
    const items: MenuItem[] = [
      ...this.shells.map((s) => ({
        label: `${s.name}${s.default ? " (login shell)" : ""}`, icon: "terminal" as const,
        action: () => void this.add(undefined, s.path),
      })),
      "separator",
      { label: "Split Right", icon: "splitRight", shortcut: "Ctrl+Shift+D", action: () => void this.split("row") },
      { label: "Split Down", icon: "splitDown", shortcut: "Ctrl+Shift+O", action: () => void this.split("col") },
      "separator",
      ...this.shells.map((s) => ({
        label: `Default: ${s.name}`, icon: (current ? current === s.path : s.default) ? ("check" as const) : undefined,
        action: () => {
          this.opts.settings().shell = s.default ? "" : s.path;
          this.opts.saveSettings();
        },
      })),
    ];
    openMenu(r.left, r.bottom + 4, items);
  }

  private zoom(delta: number | null) {
    const settings = this.opts.settings();
    settings.fontSize = delta === null ? 13 : Math.min(MAX_FONT, Math.max(MIN_FONT, settings.fontSize + delta));
    this.opts.saveSettings();
    for (const tab of this.tabs) for (const leaf of leaves(tab.root)) leaf.view.setFontSize(settings.fontSize);
  }

  step(delta: number) {
    if (!this.active || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    void this.select(this.tabs[(i + delta + this.tabs.length) % this.tabs.length]);
  }

  /** Runs a command in the focused terminal (opening one if needed). */
  async run(command: string) {
    if (!this.active) await this.add();
    this.active?.focused.send(`${command}\r`);
  }

  fit() {
    if (this.active) for (const leaf of leaves(this.active.root)) leaf.view.fitNow();
  }

  focus() {
    this.active?.focused.focus();
  }

  themeChanged() {
    for (const tab of this.tabs) for (const leaf of leaves(tab.root)) leaf.view.themeChanged();
  }

  /**
   * The terminal app's keys: Ctrl+Shift+T new tab, Ctrl+Shift+W close pane, Ctrl+Shift+D / O
   * split right / down, Alt+arrows between panes, Ctrl+Shift+F find, Ctrl+Up / Down between
   * commands, Ctrl+= / - / 0 zoom, Ctrl+PageUp / PageDown between tabs. True when handled.
   */
  handleKey(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.altKey && !mod && !e.shiftKey && key.startsWith("arrow")) {
      if (!this.active || leaves(this.active.root).length < 2) return false;
      this.moveFocus(key === "arrowleft" ? -1 : key === "arrowright" ? 1 : 0, key === "arrowup" ? -1 : key === "arrowdown" ? 1 : 0);
      return true;
    }
    if (!mod || e.altKey) return false;
    if (e.shiftKey) {
      switch (key) {
        case "t": void this.add(); return true;
        case "w": this.closePane(); return true;
        case "d": void this.split("row"); return true;
        case "o": void this.split("col"); return true;
        case "f": this.focusedView()?.openFind(); return true;
        default: return false;
      }
    }
    switch (e.key) {
      case "ArrowUp": this.focusedView()?.jump(-1); return true;
      case "ArrowDown": this.focusedView()?.jump(1); return true;
      case "=": case "+": this.zoom(1); return true;
      case "-": this.zoom(-1); return true;
      case "0": this.zoom(null); return true;
      case "PageDown": this.step(1); return true;
      case "PageUp": this.step(-1); return true;
      default: return false;
    }
  }

  dispose() {
    for (const tab of this.tabs) for (const leaf of leaves(tab.root)) leaf.view.dispose();
    this.tabs.length = 0;
  }
}

function leaves(pane: Pane): Leaf[] {
  return pane.kind === "leaf" ? [pane] : [...leaves(pane.a), ...leaves(pane.b)];
}

function findLeaf(pane: Pane, view: TerminalView): Leaf | null {
  return leaves(pane).find((l) => l.view === view) ?? null;
}

function parentOf(root: Pane, child: Pane): Split | null {
  if (root.kind === "leaf") return null;
  if (root.a === child || root.b === child) return root;
  return parentOf(root.a, child) ?? parentOf(root.b, child);
}

/** The tree with `from` replaced by `to`. */
function replace(root: Pane, from: Pane, to: Pane): Pane {
  if (root === from) return to;
  if (root.kind === "split") {
    root.a = replace(root.a, from, to);
    root.b = replace(root.b, from, to);
  }
  return root;
}
