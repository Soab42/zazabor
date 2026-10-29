import type { TerminalSettings } from "../config";
import { TerminalTabs } from "../terminal/tabs";
import { isTerminalTarget } from "../terminal/target";
import { h } from "../ui/dom";
import { icon, type IconName } from "../ui/icons";

/**
 * The terminal drawer: terminals under every section, for a shell or an agent (Claude Code, say)
 * to run beside your work. Ctrl+` or the rail's button shows and hides it; it folds down to its
 * tab strip (the terminals keep running, and a tab whose command finishes while you aren't
 * looking gets a dot), opens to the height you drag its top edge to, and can take most of the
 * window. New terminals start in the folder of the section in front (Files' folder, say).
 */
export interface DrawerHost {
  settings(): TerminalSettings;
  saveSettings(): void;
  /** The folder new terminals start in: the section in front's, when it has one. */
  cwd(): string | null;
  /** The drawer shows or hides, or a command finished out of sight (the rail's button follows). */
  changed(open: boolean, notice: "ok" | "failed" | null): void;
}

/** The drawer is never shorter than this when open, and leaves the section at least this much. */
const MIN_HEIGHT = 120;
const MIN_ABOVE = 140;

export class TerminalDrawer {
  readonly el = h("section", { class: "drawer", hidden: true, "aria-label": "Terminal drawer" });
  private tabs: TerminalTabs | null = null;
  private readonly foldButton: HTMLButtonElement;
  private readonly maxButton: HTMLButtonElement;
  private maximized = false;
  private notice: "ok" | "failed" | null = null;

  constructor(private readonly host: DrawerHost) {
    const button = (name: IconName, title: string, run: () => void) =>
      h("button", { class: "icon-btn small", type: "button", title, "aria-label": title, onclick: (e: MouseEvent) => (e.stopPropagation(), run()) }, icon(name, 15));
    this.foldButton = button("chevronDown", "Fold (double-click the edge)", () => this.setState(this.state === "folded" ? "open" : "folded"));
    this.maxButton = button("fullscreen", "Maximize", () => this.toggleMaximized());
    const hide = button("close", "Hide (Ctrl+`)", () => this.setState("hidden"));
    this.actions = [this.foldButton, this.maxButton, hide];
    const edge = h("div", { class: "drawer-edge", title: "Drag to resize · double-click to fold" });
    edge.addEventListener("pointerdown", (e) => this.resize(e, edge));
    edge.addEventListener("dblclick", () => this.setState(this.state === "folded" ? "open" : "folded"));
    this.el.append(edge);
    // Coming back to a window where it was left open or folded.
    const saved = host.settings().drawer.state;
    if (saved !== "hidden") void this.setState(saved, false);
  }

  private readonly actions: HTMLButtonElement[];

  get state() {
    return this.host.settings().drawer.state;
  }

  get open() {
    return this.state !== "hidden";
  }

  /** Ctrl+`: shows it and goes to its terminal; from its terminal, hides it. Ctrl+Shift+`: a new terminal. */
  async toggleKey(e: KeyboardEvent) {
    if (e.shiftKey) {
      await this.setState("open");
      await this.tabs?.add(this.host.cwd());
      return;
    }
    const inside = isTerminalTarget(e.target) && this.el.contains(e.target as Node);
    if (this.state === "open" && inside) await this.setState("hidden");
    else await this.setState("open");
  }

  /** The rail's button: shows or hides it. */
  toggle() {
    void this.setState(this.open ? "hidden" : "open");
  }

  async setState(state: "hidden" | "folded" | "open", focus = true) {
    const settings = this.host.settings();
    if (settings.drawer.state !== state) {
      settings.drawer.state = state;
      this.host.saveSettings();
    }
    this.el.hidden = state === "hidden";
    this.el.classList.toggle("folded", state === "folded");
    if (state !== "open") this.setMaximized(false);
    this.foldButton.replaceChildren(icon(state === "folded" ? "chevronUp" : "chevronDown", 15));
    this.foldButton.title = state === "folded" ? "Unfold (double-click the edge)" : "Fold (double-click the edge)";
    this.applyHeight();
    if (state === "hidden") {
      this.tabs?.hide();
    } else {
      const tabs = this.ensureTabs();
      if (state === "open") {
        this.notice = null;
        await tabs.show();
        tabs.fit();
        if (focus) tabs.focus();
      } else {
        // Folded: the strip shows, the terminals keep running out of sight.
        if (tabs.count === 0) await tabs.show();
        tabs.hide();
      }
    }
    this.host.changed(this.open, this.notice);
  }

  private ensureTabs(): TerminalTabs {
    if (!this.tabs) {
      this.tabs = new TerminalTabs({
        cwd: () => this.host.cwd(),
        settings: () => this.host.settings(),
        saveSettings: () => this.host.saveSettings(),
        actions: this.actions,
        onEmpty: () => void this.setState("hidden"),
        onNotice: (failed) => {
          this.notice = failed ? "failed" : this.notice ?? "ok";
          this.host.changed(this.open, this.notice);
        },
      });
      // A click on the folded strip (a tab, or between them) unfolds it.
      this.tabs.el.addEventListener("click", (e) => {
        if (this.state === "folded" && !(e.target as Element).closest?.(".icon-btn, .tt-tab-close")) void this.setState("open");
      });
      this.el.append(this.tabs.el);
    }
    return this.tabs;
  }

  private applyHeight() {
    if (this.state !== "open") {
      this.el.style.height = "";
      return;
    }
    const room = this.room();
    this.el.style.height = `${this.maximized ? room : Math.min(room, this.host.settings().drawer.height)}px`;
  }

  /** The most the drawer can take, leaving the section some room. */
  private room(): number {
    const column = this.el.parentElement?.clientHeight ?? window.innerHeight;
    return Math.max(MIN_HEIGHT, column - MIN_ABOVE);
  }

  private toggleMaximized() {
    if (this.state !== "open") void this.setState("open");
    this.setMaximized(!this.maximized);
  }

  private setMaximized(on: boolean) {
    this.maximized = on;
    this.el.classList.toggle("maximized", on);
    this.maxButton.title = on ? "Restore" : "Maximize";
    this.maxButton.replaceChildren(icon(on ? "fullscreenExit" : "fullscreen", 15));
    this.applyHeight();
    this.tabs?.fit();
  }

  /** Dragging the top edge: the height follows; dragged right down, it folds. */
  private resize(e: PointerEvent, edge: HTMLElement) {
    if (e.button !== 0) return;
    e.preventDefault();
    edge.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const start = this.el.getBoundingClientRect().height;
    let height = start;
    const move = (ev: PointerEvent) => {
      height = Math.min(this.room(), Math.max(0, start + startY - ev.clientY));
      if (this.state === "folded" && height > MIN_HEIGHT / 2) void this.setState("open", false);
      if (this.state !== "open") return;
      this.setMaximized(false);
      this.el.style.height = `${Math.max(MIN_HEIGHT, height)}px`;
      this.tabs?.fit();
    };
    const up = () => {
      edge.removeEventListener("pointermove", move);
      edge.removeEventListener("pointerup", up);
      if (this.state !== "open") return;
      if (height < MIN_HEIGHT / 2) return void this.setState("folded");
      this.host.settings().drawer.height = Math.round(Math.max(MIN_HEIGHT, height));
      this.host.saveSettings();
    };
    edge.addEventListener("pointermove", move);
    edge.addEventListener("pointerup", up);
  }

  /** The window changed size: keep it within the room there is. */
  fit() {
    if (this.state !== "open") return;
    this.applyHeight();
    this.tabs?.fit();
  }

  themeChanged() {
    this.tabs?.themeChanged();
  }

  dispose() {
    this.tabs?.dispose();
  }
}
