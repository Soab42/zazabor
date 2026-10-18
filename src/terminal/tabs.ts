import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { TerminalView } from "./view";

interface Tab {
  view: TerminalView;
  button: HTMLElement;
  label: HTMLElement;
}

export interface TerminalTabsOptions {
  /** The folder new terminals start in. */
  cwd(): string | null;
  /** Extra buttons on the right of the tab strip (e.g. close the panel). */
  actions?: HTMLElement[];
  /** The last terminal was closed. */
  onEmpty?(): void;
}

/** Several terminals with a tab strip: + adds one, closing a tab ends its shell. */
export class TerminalTabs {
  readonly el: HTMLElement;
  private readonly strip = h("div", { class: "tt-strip", role: "tablist" });
  private readonly body = h("div", { class: "tt-body" });
  private readonly tabs: Tab[] = [];
  private active: Tab | null = null;
  private shown = false;

  constructor(private readonly opts: TerminalTabsOptions) {
    const add = h("button", { class: "icon-btn small", type: "button", title: "New Terminal (Ctrl+Shift+T)", onclick: () => void this.add() }, icon("plus", 15));
    this.el = h("div", { class: "tt" }, h("div", { class: "tt-bar" }, this.strip, add, ...(opts.actions ?? [])), this.body);
  }

  get count() {
    return this.tabs.length;
  }

  /** The folder the active terminal is in (for a new window or terminal). */
  get cwd(): string | null {
    return this.active?.view.cwd || null;
  }

  /** The terminals are on screen: start one if there are none, fit and focus. */
  async show() {
    this.shown = true;
    if (this.tabs.length === 0) await this.add();
    else {
      await this.active?.view.mount();
      this.active?.view.focus();
    }
  }

  hide() {
    this.shown = false;
  }

  async add(cwd = this.active?.view.cwd || this.opts.cwd()) {
    const label = h("span", { class: "tt-tab-name" }, "Terminal");
    const close = h("button", { class: "tt-tab-close", type: "button", title: "Kill Terminal", tabIndex: -1 }, icon("close", 12));
    const button = h("div", { class: "tt-tab", role: "tab" }, icon("terminal", 13), label, close);
    const view = new TerminalView({
      cwd,
      onTitle: (title) => {
        label.textContent = title;
        button.title = view.cwd;
      },
      onExit: () => undefined,
    });
    const tab: Tab = { view, button, label };
    button.addEventListener("click", () => void this.select(tab));
    button.addEventListener("auxclick", (e) => {
      if (e.button === 1) this.close(tab);
    });
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close(tab);
    });
    this.tabs.push(tab);
    this.strip.append(button);
    this.body.append(view.el);
    await this.select(tab);
  }

  private async select(tab: Tab) {
    this.active = tab;
    for (const t of this.tabs) {
      t.button.classList.toggle("active", t === tab);
      t.view.el.hidden = t !== tab;
    }
    if (this.shown) {
      await tab.view.mount();
      tab.view.focus();
    }
  }

  close(tab = this.active) {
    if (!tab) return;
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    tab.button.remove();
    tab.view.dispose();
    const next = this.tabs[Math.min(i, this.tabs.length - 1)];
    if (next) void this.select(next);
    else {
      this.active = null;
      this.opts.onEmpty?.();
    }
  }

  step(delta: number) {
    if (!this.active || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    void this.select(this.tabs[(i + delta + this.tabs.length) % this.tabs.length]);
  }

  /** Runs a command in the active terminal (opening one if needed). */
  async run(command: string) {
    if (!this.active) await this.add();
    this.active?.view.send(`${command}\r`);
  }

  fit() {
    this.active?.view.fitNow();
  }

  focus() {
    this.active?.view.focus();
  }

  themeChanged() {
    for (const t of this.tabs) t.view.themeChanged();
  }

  /** Keys for the terminals: new, close, next/previous tab. True when handled. */
  handleKey(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || !e.shiftKey || e.altKey) {
      if (mod && !e.altKey && (e.key === "PageDown" || e.key === "PageUp")) {
        this.step(e.key === "PageDown" ? 1 : -1);
        return true;
      }
      return false;
    }
    const key = e.key.toLowerCase();
    if (key === "t") void this.add();
    else if (key === "w") this.close();
    else return false;
    return true;
  }

  dispose() {
    for (const t of this.tabs) t.view.dispose();
    this.tabs.length = 0;
  }
}
