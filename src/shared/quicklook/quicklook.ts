import { categoryOf, iconNameFor, iconNode, kindLabel, sizeText } from "../../modules/files/kinds";
import type { ShellContext } from "../../shell/module";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { buildBody, type Body } from "./bodies";
import type { QuickLookItem } from "./types";
import "./quicklook.css";

export interface QuickLookOptions {
  /** The element the overlay covers (must be positioned); it is centred over this. */
  host: HTMLElement;
  shell: ShellContext;
  /** The items to browse with the arrow keys, in order; read afresh on every move. */
  items: () => QuickLookItem[];
  /** The shown item changed (opened or moved to); e.g. to move the selection with it. */
  onShow?: (item: QuickLookItem) => void;
  onClose?: () => void;
}

const CLOSE_MS = 140;

/**
 * A Finder-style Quick Look: a large glass overlay that previews the item by kind (images, text
 * and code with highlighting, Markdown, PDF, video poster, audio, folders) and steps through its
 * neighbours with the arrow keys. Reusable by any module that can list `QuickLookItem`s.
 */
export class QuickLook {
  private overlay: HTMLElement | null = null;
  private item: QuickLookItem | null = null;
  private body: Body | null = null;
  private token = 0;
  private extra = "";
  private closeTimer: number | undefined;
  private title!: HTMLElement;
  private sub!: HTMLElement;
  private externalLabel!: HTMLElement;
  private glyph!: HTMLElement;
  private stage!: HTMLElement;
  private panel!: HTMLElement;
  private prev!: HTMLButtonElement;
  private next!: HTMLButtonElement;
  private openBtn!: HTMLButtonElement;

  constructor(private readonly opts: QuickLookOptions) {}

  get isOpen() {
    return this.overlay !== null;
  }

  /** The item on show, if any. */
  get current() {
    return this.item;
  }

  /** Opens on an item, or closes when it is already open. */
  toggle(item: QuickLookItem) {
    if (this.isOpen) this.close();
    else this.open(item);
  }

  open(item: QuickLookItem) {
    if (!this.overlay) this.build();
    this.show(item);
  }

  close() {
    const overlay = this.overlay;
    if (!overlay) return;
    this.overlay = null;
    this.release();
    this.item = null;
    overlay.classList.add("closing");
    window.clearTimeout(this.closeTimer);
    this.closeTimer = window.setTimeout(() => overlay.remove(), CLOSE_MS);
    this.opts.onClose?.();
  }

  dispose() {
    window.clearTimeout(this.closeTimer);
    this.overlay?.remove();
    this.overlay = null;
    this.release();
  }

  /** Keys while open: arrows browse, Space or Esc close, Enter opens. Returns whether handled. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.overlay || e.ctrlKey || e.metaKey || e.altKey) return false;
    const target = e.target as HTMLElement | null;
    // Native controls (audio, focused buttons) keep Space and Enter.
    if ((e.key === " " || e.key === "Enter") && target && (target instanceof HTMLMediaElement || target instanceof HTMLButtonElement)) return false;
    switch (e.key) {
      case " ":
      case "Escape":
        this.close();
        return true;
      case "Enter":
        this.openItem();
        return true;
      case "ArrowLeft":
      case "ArrowUp":
        this.step(-1);
        return true;
      case "ArrowRight":
      case "ArrowDown":
        this.step(1);
        return true;
    }
    return false;
  }

  // ---- building -------------------------------------------------------------------------------

  private build() {
    window.clearTimeout(this.closeTimer);
    this.glyph = h("span", { class: "ql-glyph" });
    this.title = h("div", { class: "ql-title" });
    this.sub = h("div", { class: "ql-sub" });
    this.prev = this.iconButton("chevronLeft", "Previous (←)", () => this.step(-1));
    this.next = this.iconButton("chevronRight", "Next (→)", () => this.step(1));
    this.openBtn = h("button", { class: "btn small ql-open", title: "Open (Enter)", onclick: () => this.openItem() }, "Open");
    this.externalLabel = h("span", null, "Open with Default App");
    const external = h("button", {
      class: "btn small ghost ql-external", title: "Open with Default App",
      onclick: () => this.item && this.opts.shell.openExternally(this.item.url ?? this.item.path),
    }, icon("external", 14), this.externalLabel);
    const close = this.iconButton("close", "Close (Esc)", () => this.close());
    const header = h("header", { class: "ql-head" },
      this.glyph,
      h("div", { class: "ql-heading" }, this.title, this.sub),
      h("div", { class: "ql-actions" }, this.prev, this.next, h("span", { class: "ql-sep" }), external, this.openBtn, close));
    this.stage = h("div", { class: "ql-body" });
    this.panel = h("div", { class: "ql-panel glass-strong", role: "dialog", "aria-modal": "true", "aria-label": "Quick Look" }, header, this.stage);
    this.overlay = h("div", { class: "ql-overlay" }, this.panel);
    this.overlay.addEventListener("pointerdown", (e) => {
      if (e.target === this.overlay) this.close();
    });
    this.opts.host.append(this.overlay);
  }

  private iconButton(name: "chevronLeft" | "chevronRight" | "close", label: string, onClick: () => void) {
    return h("button", { class: "icon-btn ql-icon", title: label, "aria-label": label, onclick: onClick }, icon(name, 16));
  }

  // ---- showing --------------------------------------------------------------------------------

  private release() {
    this.token++;
    this.body?.dispose?.();
    this.body = null;
  }

  private show(item: QuickLookItem) {
    this.release();
    this.item = item;
    this.extra = "";
    const token = this.token;
    this.glyph.replaceChildren(iconNode(iconNameFor(categoryOf(item)), 20));
    this.title.textContent = item.name;
    this.title.title = item.name;
    this.updateSub();
    this.updateNav();
    const external = !item.dir && !["image", "video"].includes(categoryOf(item));
    this.openBtn.hidden = external;
    // A Google Doc opens on the web.
    this.externalLabel.textContent = item.url ? "Open in Browser" : "Open with Default App";
    this.body = buildBody(item, {
      shell: this.opts.shell,
      siblings: this.opts.items,
      isCurrent: () => token === this.token,
      setMeta: (text) => {
        if (token !== this.token) return;
        this.extra = text;
        this.updateSub();
      },
      width: () => this.stage.clientWidth,
    });
    const fresh = h("div", { class: "ql-stage" }, this.body.el);
    this.stage.replaceChildren(fresh);
    this.stage.scrollTop = 0;
    this.opts.onShow?.(item);
  }

  private updateSub() {
    const item = this.item;
    if (!item) return;
    const list = this.opts.items();
    const index = list.findIndex((i) => i.path === item.path);
    const parts = [kindLabel(item), item.dir ? "" : sizeText(item), this.extra,
      index >= 0 && list.length > 1 ? `${index + 1} of ${list.length}` : ""];
    this.sub.textContent = parts.filter(Boolean).join(" · ");
  }

  private updateNav() {
    const item = this.item;
    const list = this.opts.items();
    const index = item ? list.findIndex((i) => i.path === item.path) : -1;
    this.prev.disabled = index <= 0;
    this.next.disabled = index < 0 || index >= list.length - 1;
  }

  private step(delta: number) {
    const item = this.item;
    if (!item) return;
    const list = this.opts.items();
    const index = list.findIndex((i) => i.path === item.path);
    const target = list[index + delta];
    if (index >= 0 && target) this.show(target);
  }

  private openItem() {
    const item = this.item;
    if (!item) return;
    const { shell } = this.opts;
    const category = categoryOf(item);
    this.close();
    if (item.dir) shell.open({ kind: "folder", path: item.path });
    else if (category === "image" || category === "video") {
      const siblings = this.opts.items().filter((i) => categoryOf(i) === category).map((i) => i.path);
      shell.open({ kind: category, path: item.path, siblings });
    } else shell.openExternally(item.url ?? item.path);
  }
}
