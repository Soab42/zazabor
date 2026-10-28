import { api, type BuiltinTrack } from "../../../api";
import { ensureLocal, extraSounds, formatBytes, isLocal } from "../../../content";
import { listening, onListening, stopListening, toggleListening } from "../../../shared/listen";
import { h } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import { openMenu, type MenuItem } from "../../../ui/menu";
import { LOOKS, TRANSITION_GROUPS, type LookId, type TransitionKind } from "../../gallery/slideshow/settings";
import { editApi, type SoundEffect } from "./api";
import type { CaptionsPanel } from "./captions";
import { callout, empty, menuAt, mini, row, scrub, searchField, seg, type Syncs } from "./controls";
import { EFFECTS } from "./inspector";
import type { MediaStore } from "./media";
import type { Clip, EffectId, Media, Project, Track } from "./model";
import { LAYER_TRANSITION_GROUPS } from "./overlays";
import { MEDIA_DRAG, TEXT_DRAG, formatTime } from "./timeline";
import { TEXT_PRESETS } from "./text";
import { STICKERS } from "./stickers";
import { faceCss } from "./motion/fonts";

/**
 * The left panel, as in CapCut: a strip of eight categories (Media, Audio, Text, Templates,
 * Stickers, then Effects, Transitions and Captions, which apply to clips), a pinned header with
 * the category's name, actions, search and filters, and its items as tiles or rows. Items are
 * added with their + button, Enter or a double-click, or dragged onto the timeline; the arrow
 * keys move between them. See docs/plans/video-editor-ui.md §6.
 */

export type PanelTab = "media" | "audio" | "text" | "templates" | "stickers" | "effects" | "transitions" | "captions";

/**
 * Where a transition goes: on a cut ("cut", into `clip` from the one before: any cut on the main
 * track; off it, only while `touching`), or a layer's own way on ("in") or off ("out").
 */
export type TransitionSlot = "cut" | "in" | "out";

export interface TransitionTarget {
  clip: Clip;
  track: Track;
  /** Off the main track: the clip before on its track ends where this one starts. */
  touching: boolean;
}

export interface PanelHost {
  project(): Project;
  store: MediaStore;
  importFiles(kind: "any" | "audio"): void;
  /** Starts (or stops) a voice-over at the playhead. */
  record(): void;
  importSrt(): void;
  exportSrt(): void;
  addMedia(id: string): void;
  addMusic(path: string): void;
  removeMedia(id: string): void;
  addText(presetId: string): void;
  addSticker(id: string): void;
  /** Adds a sound effect at the playhead. */
  addSound(path: string): void;
  captions: CaptionsPanel;
  /** Offers to install the codecs clips need, then checks those clips again. */
  installCodecs(): void;
  /**
   * What the Transitions tab sets: the selected clip off the main track (a layer), else the
   * selected main clip's cut, or the main track's cut nearest the playhead.
   */
  transitionTarget(): TransitionTarget | null;
  /** Sets (or with null removes) a transition on the target; `all`: on every cut, or every clip, of its track. */
  applyTransition(slot: TransitionSlot, kind: TransitionKind | null, duration: number, all: boolean): void;
  toast(text: string): void;
  /** The look of the selected clips (null when mixed or nothing is selected). */
  currentLook(): LookId | "none" | null;
  applyLook(look: LookId | "none", all: boolean): void;
  /** The effect on the selected clips with a picture: null when none is selected, "mixed" when they differ. */
  currentEffect(): EffectId | "mixed" | null;
  applyEffect(effect: EffectId): void;
  /** The Templates tab (motion/browser.ts). */
  templates?: { head(): Node[]; body(): Node[]; menu(): MenuItem[]; focusSearch(): void };
  /** Remembered choices: the category, and sub-tabs ("audio", "effects"). */
  prefs: { get(key: string): string | undefined; set(key: string, value: string): void };
}

const TABS: [PanelTab, string, IconName][] = [
  ["media", "Media", "film"],
  ["audio", "Audio", "music"],
  ["text", "Text", "textBox"],
  ["templates", "Templates", "template"],
  ["stickers", "Stickers", "veSticker"],
  ["effects", "Effects", "sparkles"],
  ["transitions", "Transitions", "veTransition"],
  ["captions", "Captions", "subtitles"],
];
/** The categories after this many are applied to clips (a divider before them). */
const ADD_GROUP = 5;

/** Swatches standing in for each look in the Filters tab. */
const LOOK_SWATCH: Record<string, string> = {
  none: "linear-gradient(135deg, #5b6b7d, #9aa9b8)",
  natural: "linear-gradient(135deg, #3f7d4e, #d9c38a)",
  film: "linear-gradient(135deg, #3d3a33, #c7a77a)",
  tealorange: "linear-gradient(135deg, #0f5e6b, #f08a3c)",
  golden: "linear-gradient(135deg, #8a4b12, #ffd27a)",
  faded: "linear-gradient(135deg, #8d8a99, #e6dfd2)",
  noir: "linear-gradient(135deg, #111111, #bbbbbb)",
};

/** Swatches and marks standing in for each effect. */
const EFFECT_LOOK: Record<string, [string, IconName]> = {
  none: ["linear-gradient(135deg, #3a3f4a, #5b6170)", "close"],
  shake: ["linear-gradient(135deg, #47306b, #c25d9c)", "repeat"],
  pulse: ["radial-gradient(circle at 50% 50%, #ffb27a 0, #a33f2f 70%)", "zoomIn"],
  glitch: ["linear-gradient(90deg, #12c2e9 0 30%, #c471ed 30% 62%, #f64f59 62%)", "bolt"],
  rgb: ["linear-gradient(90deg, #ff4b4b, #44d07b 50%, #4b7bff)", "columns"],
  vhs: ["repeating-linear-gradient(0deg, #2b2f3a 0 3px, #3e4454 3px 6px)", "film"],
  mirror: ["linear-gradient(90deg, #355c7d, #6c5b7b 50%, #355c7d)", "splitRight"],
  flash: ["radial-gradient(circle at 50% 40%, #ffffff 0, #ffd56b 35%, #e0862e 80%)", "sparkles"],
  blurin: ["radial-gradient(circle at 50% 50%, #9fb4c7 0, #44556a 80%)", "eye"],
};

type MediaFilter = "all" | "video" | "image" | "unused";
type MediaSort = "added" | "name" | "length";

export class Panel {
  readonly el: HTMLElement;
  private cats: HTMLElement;
  private head = h("div", { class: "vp-head" });
  private body = h("div", { class: "vp-body" });
  private tab: PanelTab;
  private tracks: BuiltinTrack[] | null = null;
  private sounds: SoundEffect[] | null = null;
  private transitionLength = 0.6;
  /** Which of a layer's transitions the Transitions tab sets. */
  private slot: TransitionSlot = "in";
  /** The file this panel started playing (listening before adding). */
  private listened: string | null = null;
  private readonly stopWatching: () => void;
  private queries = new Map<PanelTab, string>();
  private scrolls = new Map<string, number>();
  private mediaFilter: MediaFilter = "all";
  private mediaSort: MediaSort = "added";
  private syncs: Syncs = [];

  constructor(private host: PanelHost) {
    const saved = host.prefs.get("panelTab");
    this.tab = saved === "filters" ? "effects" : TABS.some(([id]) => id === saved) ? (saved as PanelTab) : "media";
    this.cats = h("div", { class: "vp-cats", role: "tablist", "aria-label": "Media panel" });
    this.cats.addEventListener("keydown", (e) => this.catKeys(e));
    this.body.addEventListener("scroll", () => this.head.classList.toggle("scrolled", this.body.scrollTop > 2), { passive: true });
    this.el = h("aside", { class: "ve-panel", "aria-label": "Media panel" }, this.cats, this.head, this.body);
    this.stopWatching = onListening(() => this.drawListenButtons());
    this.drawCats();
    this.refresh();
  }

  show(tab: PanelTab | "filters", sub?: string) {
    const next: PanelTab = tab === "filters" ? "effects" : tab;
    if (tab === "filters") sub = "filters";
    if (sub) this.host.prefs.set(`sub:${next}`, sub);
    if (next !== "audio") this.stopListening();
    if (next !== this.tab) this.scrolls.set(this.tab, this.body.scrollTop);
    this.tab = next;
    this.host.prefs.set("panelTab", next);
    this.drawCats();
    this.refresh();
  }

  /** Alt+1…8. */
  showIndex(i: number) {
    const t = TABS[i];
    if (t) this.show(t[0]);
    this.cats.querySelector<HTMLButtonElement>(".vp-cat.active")?.focus();
  }

  /** The Transitions tab, on a layer's in, out or the cut before it. */
  showTransition(slot: TransitionSlot) {
    this.slot = slot;
    this.show("transitions");
  }

  /** Ctrl+F: the search of the category showing (Media's when it has none). */
  focusSearch() {
    if (this.tab === "templates" && this.host.templates) return this.host.templates.focusSearch();
    if (!this.head.querySelector(".vc-search input")) this.show("media");
    this.head.querySelector<HTMLInputElement>(".vc-search input")?.focus();
  }

  /** Stops what this panel plays (the editor plays, the panel closes). */
  stopListening() {
    if (this.listened && listening() === this.listened) stopListening();
    this.listened = null;
  }

  dispose() {
    this.stopListening();
    this.stopWatching();
  }

  /** The Transitions and Effects tabs show what's selected. */
  selectionChanged() {
    if (this.tab === "transitions" || this.tab === "effects") this.refresh();
  }

  refresh() {
    const scroll = this.scrolls.get(this.tab) ?? this.body.scrollTop;
    this.scrolls.delete(this.tab);
    this.syncs = [];
    const parts: Record<PanelTab, () => [Node[], Node[]]> = {
      media: () => this.mediaTab(),
      audio: () => this.audioTab(),
      text: () => this.textTab(),
      templates: () => this.templatesTab(),
      stickers: () => this.stickersTab(),
      effects: () => this.effectsTab(),
      transitions: () => this.transitionsTab(),
      captions: () => this.captionsTab(),
    };
    const [head, body] = parts[this.tab]();
    this.head.replaceChildren(...head);
    this.body.replaceChildren(...body);
    this.body.scrollTop = scroll;
    this.head.classList.toggle("scrolled", this.body.scrollTop > 2);
    this.el.dataset.tab = this.tab;
  }

  // ---- the category strip

  private drawCats() {
    this.cats.replaceChildren(...TABS.flatMap(([id, label, ic], i) => {
      const on = id === this.tab;
      const b = h("button", {
        class: `vp-cat${on ? " active" : ""}`, type: "button", role: "tab", "aria-selected": String(on), tabindex: on ? "0" : "-1",
        title: `${label} (Alt+${i + 1})`, "aria-label": label, onclick: () => this.show(id),
      }, icon(ic, 18));
      return i === ADD_GROUP ? [h("span", { class: "vp-cat-sep", "aria-hidden": "true" }), b] : [b];
    }));
  }

  private catKeys(e: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(e.key)) return;
    const buttons = [...this.cats.querySelectorAll<HTMLButtonElement>(".vp-cat")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Enter" || e.key === " ") return buttons[i].click();
    const n = buttons.length;
    const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
    this.show(TABS[next][0]);
    this.cats.querySelectorAll<HTMLButtonElement>(".vp-cat")[next]?.focus();
  }

  // ---- pieces

  private titleRow(title: string, count: string | null, ...actions: (Node | null)[]): HTMLElement {
    return h("div", { class: "vp-title-row" },
      h("h2", { class: "vp-title" }, title),
      count ? h("span", { class: "vp-count" }, count) : null,
      h("span", { class: "spacer" }),
      ...actions);
  }

  private headButton(label: string, ic: IconName, run: () => void, title?: string): HTMLButtonElement {
    return h("button", { class: "vc-head-btn", type: "button", title: title ?? label, onclick: run }, icon(ic, 14), label);
  }

  private moreButton(title: string, items: () => MenuItem[]): HTMLButtonElement {
    return mini("more", title, (e) => menuAt(e.currentTarget as HTMLElement, items()));
  }

  private search(placeholder: string): HTMLElement {
    return searchField(placeholder, this.queries.get(this.tab) ?? "", (v) => {
      this.queries.set(this.tab, v);
      const tab = this.tab;
      // Only the items change; the field keeps the keyboard.
      const [, body] = tab === "media" ? this.mediaTab() : tab === "audio" ? this.audioTab() : tab === "stickers" ? this.stickersTab() : [[], []];
      if (this.tab === tab) this.body.replaceChildren(...body);
    });
  }

  private query(): string {
    return (this.queries.get(this.tab) ?? "").trim().toLowerCase();
  }

  private noMatches(): HTMLElement {
    return h("div", { class: "vc-none" }, `No matches for “${this.queries.get(this.tab)?.trim() ?? ""}”.`,
      h("button", { class: "text-btn", type: "button", onclick: () => {
        this.queries.set(this.tab, "");
        this.refresh();
      } }, "Clear search"));
  }

  /** A grid (or list) of focusable items: the arrow keys move between them, Enter adds, Space previews, Delete removes. */
  private grid(cls: string, items: HTMLElement[], label: string): HTMLElement {
    items.forEach((el, i) => (el.tabIndex = i === 0 ? 0 : -1));
    const el = h("div", { class: cls, role: "list", "aria-label": label }, ...items);
    el.addEventListener("keydown", (e) => {
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      const cols = Math.max(1, getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length);
      let next = -1;
      if (e.key === "ArrowRight") next = i + 1;
      else if (e.key === "ArrowLeft") next = i - 1;
      else if (e.key === "ArrowDown") next = i + cols;
      else if (e.key === "ArrowUp") next = i - cols;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      else if (e.key === "Enter") items[i].dispatchEvent(new CustomEvent("vp-add"));
      else if (e.key === " ") items[i].dispatchEvent(new CustomEvent("vp-preview"));
      else if (e.key === "Delete" || e.key === "Backspace") items[i].dispatchEvent(new CustomEvent("vp-remove"));
      else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
        const r = items[i].getBoundingClientRect();
        items[i].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 12, clientY: r.top + 12 }));
      } else return;
      e.preventDefault();
      e.stopPropagation();
      if (next >= 0 && next < items.length) {
        items[i].tabIndex = -1;
        items[next].tabIndex = 0;
        items[next].focus();
        items[next].scrollIntoView({ block: "nearest" });
      }
    });
    return el;
  }

  /** A tile: thumbnail (with chips and a + button on it) and a name. */
  private tile(o: {
    thumb: Node; name: string; title?: string; meta?: string; badge?: Node | null; used?: boolean; active?: boolean; cls?: string;
    click?: () => void; add?: () => void; addLabel?: string; preview?: () => void; remove?: () => void; menu?: () => MenuItem[];
    drag?: (e: DragEvent) => void; disabled?: boolean;
  }): HTMLElement {
    const el = h("div", {
      class: `vp-tile${o.active ? " active" : ""}${o.disabled ? " disabled" : ""}${o.cls ? ` ${o.cls}` : ""}`, role: "listitem", title: o.title ?? o.name,
      "aria-label": o.name, draggable: o.drag && !o.disabled ? "true" : "false",
      ondragstart: (e: DragEvent) => o.drag?.(e),
      onclick: () => (o.click ? o.click() : el.focus()),
      ondblclick: () => !o.disabled && o.add?.(),
      oncontextmenu: (e: MouseEvent) => {
        if (!o.menu) return;
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, o.menu());
      },
    },
    h("div", { class: "vp-thumb" },
      o.thumb,
      o.badge ?? null,
      o.meta || o.used ? h("span", { class: "vp-chip" }, o.used ? h("span", { class: "vp-used", title: "On the timeline" }) : null, o.meta ?? "") : null,
      o.add && !o.disabled ? h("button", {
        class: "vp-add", type: "button", title: o.addLabel ?? "Add at the playhead", "aria-label": `${o.addLabel ?? "Add"} ${o.name}`, tabindex: "-1",
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          o.add!();
        },
        ondblclick: (e: MouseEvent) => e.stopPropagation(),
      }, icon("plus", 14)) : null),
    h("div", { class: "vp-name" }, o.name));
    el.addEventListener("vp-add", () => !o.disabled && (o.add ?? o.click)?.());
    el.addEventListener("vp-preview", () => o.preview?.());
    el.addEventListener("vp-remove", () => o.remove?.());
    return el;
  }

  /** A play/stop button for listening to `path` before adding it; `idle` is its icon while silent. */
  private listenButton(path: string, name: string, cls: string, idle: IconName = "play", size = 14): HTMLButtonElement {
    const b = h("button", {
      class: cls, type: "button", draggable: "false", tabindex: "-1",
      onclick: (e: Event) => {
        e.stopPropagation();
        this.listen(path, name);
      },
      // Not the row's double-click (which adds the file).
      ondblclick: (e: Event) => e.stopPropagation(),
    });
    b.dataset.listen = path;
    b.dataset.name = name;
    b.dataset.idle = idle;
    b.dataset.size = String(size);
    this.drawListenButton(b);
    return b;
  }

  private listen(path: string, name: string) {
    this.listened = path;
    // A soundtrack from the library downloads first (stopping needs no file).
    const ready = listening() === path ? Promise.resolve() : ensureLocal(path);
    ready.then(() => toggleListening(path)).catch(() => this.host.toast(`${name} can't be played here.`));
  }

  private drawListenButton(b: HTMLButtonElement) {
    const on = listening() === b.dataset.listen;
    const name = b.dataset.name ?? "";
    b.classList.toggle("playing", on);
    b.title = on ? `Stop ${name}` : `Listen to ${name}`;
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-pressed", String(on));
    b.replaceChildren(icon(on ? "stop" : (b.dataset.idle as IconName), Number(b.dataset.size)));
  }

  private drawListenButtons() {
    for (const b of this.body.querySelectorAll<HTMLButtonElement>("button[data-listen]")) this.drawListenButton(b);
  }

  // ---- Media

  private mediaThumb(m: Media): HTMLElement {
    const W = 256, H = 160;
    const canvas = h("canvas", { class: "vp-canvas", width: W, height: H });
    if (m.kind === "audio" || m.missing) return canvas;
    let strip: { img: HTMLImageElement; w: number; h: number; count: number } | null = null;
    const draw = (frame: number) => {
      if (!strip) return;
      const g = canvas.getContext("2d")!;
      const scale = Math.max(W / strip.w, H / strip.h);
      const dw = strip.w * scale, dh = strip.h * scale;
      g.clearRect(0, 0, W, H);
      g.drawImage(strip.img, frame * strip.w, 0, strip.w, strip.h, (W - dw) / 2, (H - dh) / 2, dw, dh);
    };
    void this.host.store.strip(m).then((s) => {
      if (!s) return;
      const img = new Image();
      img.onload = () => {
        strip = { img, w: s.thumbWidth, h: s.thumbHeight, count: Math.max(1, Math.min(s.count, Math.floor(img.naturalWidth / s.thumbWidth) || 1)) };
        draw(0);
        canvas.classList.add("loaded");
      };
      img.src = s.url;
    });
    // Pointing along a clip runs through it.
    canvas.addEventListener("pointermove", (e) => {
      if (!strip || strip.count < 2) return;
      const r = canvas.getBoundingClientRect();
      draw(Math.min(strip.count - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * strip.count))));
    });
    canvas.addEventListener("pointerleave", () => draw(0));
    return canvas;
  }

  private usedMedia(): Set<string> {
    const used = new Set<string>();
    for (const t of this.host.project().tracks) for (const c of t.clips) if (c.type === "media") used.add(c.media);
    return used;
  }

  private mediaTile(m: Media, used: Set<string>): HTMLElement {
    const badge = m.missing
      ? h("span", { class: "vp-badge danger" }, "Missing")
      : m.note ? h("span", { class: "vp-badge warn", title: m.note }, "!") : null;
    return this.tile({
      thumb: this.mediaThumb(m), name: m.name, title: m.note ? `${m.name}\n${m.note}` : m.name, badge, used: used.has(m.id),
      meta: m.kind === "image" ? undefined : formatTime(m.duration, 30, false), disabled: !!m.missing,
      add: () => this.host.addMedia(m.id), addLabel: "Add at the playhead",
      remove: () => this.host.removeMedia(m.id),
      drag: (e) => {
        e.dataTransfer?.setData(MEDIA_DRAG, m.id);
        if (m.kind === "audio") e.dataTransfer?.setData(`${MEDIA_DRAG}-audio`, "1");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
      },
      menu: () => [
        { label: "Add at Playhead", icon: "plus", shortcut: "Enter", disabled: !!m.missing, action: () => this.host.addMedia(m.id) },
        ...(m.note && !m.missing ? [{ label: "Install Codecs…", icon: "download", action: () => this.host.installCodecs() } as MenuItem] : []),
        "separator",
        { label: "Remove from Project", icon: "trash", shortcut: "Delete", danger: true, action: () => this.host.removeMedia(m.id) },
      ],
    });
  }

  private mediaTab(): [Node[], Node[]] {
    const all = this.host.project().media.filter((m) => m.kind !== "audio");
    const used = this.usedMedia();
    const q = this.query();
    let media = all.filter((m) => (this.mediaFilter === "all" || (this.mediaFilter === "unused" ? !used.has(m.id) : m.kind === this.mediaFilter)) && (!q || m.name.toLowerCase().includes(q)));
    if (this.mediaSort === "name") media = [...media].sort((a, b) => a.name.localeCompare(b.name));
    else if (this.mediaSort === "length") media = [...media].sort((a, b) => b.duration - a.duration);
    const needsCodecs = this.host.project().media.some((m) => m.note && !m.missing);
    const sortItem = (v: MediaSort, label: string): MenuItem => ({ label: `${this.mediaSort === v ? "✓ " : ""}Sort by ${label}`, action: () => {
      this.mediaSort = v;
      this.refresh();
    } });
    const head = [
      this.titleRow("Media", all.length ? String(all.length) : null,
        this.headButton("Import", "plus", () => this.host.importFiles("any"), "Import clips and pictures"),
        this.moreButton("Media options", () => [
          sortItem("added", "Date Added"), sortItem("name", "Name"), sortItem("length", "Length"),
          ...(needsCodecs ? ["separator", { label: "Install Codecs…", icon: "download", action: () => this.host.installCodecs() }] as MenuItem[] : []),
        ])),
      all.length ? this.search("Search media") : null,
      all.length ? h("div", { class: "vc-chips" }, ...([["all", "All"], ["video", "Video"], ["image", "Photos"], ["unused", "Unused"]] as const).map(([v, label]) =>
        h("button", { class: `vc-chip${this.mediaFilter === v ? " active" : ""}`, type: "button", "aria-pressed": String(this.mediaFilter === v), onclick: () => {
          this.mediaFilter = v;
          this.refresh();
        } }, label))) : null,
    ].filter((n): n is HTMLElement => !!n);
    const body: Node[] = [];
    if (needsCodecs) body.push(callout("Some files need codecs this system lacks (marked !).", "warn", ["Install…", () => this.host.installCodecs()]));
    if (!all.length) {
      body.push(h("div", { class: "vp-drop" }, empty("film", "Import media", "Add videos and photos, then drag them onto the timeline or press +.",
        h("button", { class: "btn small primary", type: "button", onclick: () => this.host.importFiles("any") }, icon("plus", 14), "Import…"))));
    } else if (!media.length) {
      body.push(q ? this.noMatches() : h("div", { class: "vc-none" }, this.mediaFilter === "unused" ? "Every file is on the timeline." : "Nothing of this kind yet."));
    } else body.push(this.grid("vp-grid", media.map((m) => this.mediaTile(m, used)), "Media"));
    return [head, body];
  }

  // ---- Audio

  private audioRow(o: { path: string; title: string; sub: string; add: () => void; idle?: IconName; drag?: (e: DragEvent) => void; remove?: () => void; missing?: boolean; menu?: () => MenuItem[] }): HTMLElement {
    const el = h("div", {
      class: `vp-row${o.missing ? " disabled" : ""}`, role: "listitem", "aria-label": o.title, draggable: o.drag ? "true" : "false",
      ondragstart: (e: DragEvent) => o.drag?.(e),
      ondblclick: () => !o.missing && o.add(),
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, o.menu?.() ?? [{ label: "Add at Playhead", icon: "plus", shortcut: "Enter", action: o.add }]);
      },
    },
    o.missing ? h("span", { class: "vp-listen" }, icon("music", 14)) : this.listenButton(o.path, o.title, "vp-listen", o.idle ?? "play"),
    h("div", { class: "vp-row-text" }, h("div", { class: "vp-row-title" }, o.title), h("div", { class: "vp-row-sub" }, o.sub)),
    o.missing ? null : mini("plus", `Add ${o.title} at the playhead`, o.add, "vp-row-add"));
    el.addEventListener("vp-add", () => !o.missing && o.add());
    el.addEventListener("vp-preview", () => !o.missing && this.listen(o.path, o.title));
    el.addEventListener("vp-remove", () => o.remove?.());
    return el;
  }

  private audioTab(): [Node[], Node[]] {
    if (!this.tracks) {
      this.tracks = [];
      void api.builtinTracks().then((t) => {
        this.tracks = t;
        if (this.tab === "audio") this.refresh();
      }).catch(() => undefined);
    }
    if (!this.sounds) {
      this.sounds = [];
      void Promise.all([editApi.sounds(), extraSounds().catch(() => [])]).then(([s, extra]) => {
        this.sounds = [...s, ...extra.filter((x) => !s.some((b) => b.id === x.id))];
        if (this.tab === "audio") this.refresh();
      }).catch(() => undefined);
    }
    const project = this.host.project().media.filter((m) => m.kind === "audio");
    const sub = (this.host.prefs.get("sub:audio") ?? "music") as "music" | "sounds" | "project";
    const q = this.query();
    const head = [
      this.titleRow("Audio", null,
        this.headButton("Import", "plus", () => this.host.importFiles("audio"), "Import music and sounds"),
        mini("veMic", "Record a voice-over at the playhead (R)", () => this.host.record(), "vp-record")),
      h("div", { class: "vp-seg-row" }, seg(this.syncs, "Audio", [["music", "Music"], ["sounds", "Sound effects"], ["project", "In project"]] as const, () => sub, (v) => {
        this.host.prefs.set("sub:audio", v);
        this.refresh();
      }, "vp-sub")),
      this.search(sub === "sounds" ? "Search sound effects" : sub === "project" ? "Search project audio" : "Search music"),
    ];
    let rows: HTMLElement[] = [];
    if (sub === "music") {
      rows = this.tracks.filter((t) => !q || `${t.title} ${t.vibe}`.toLowerCase().includes(q)).map((t) => this.audioRow({
        path: t.path, title: t.title, sub: `${t.vibe} · ${t.bpm} BPM · ${formatTime(t.seconds, 30, false)}${isLocal(t.file) ? "" : ` · ${formatBytes(t.bytes)}`}`, add: () => this.host.addMusic(t.path),
      }));
    } else if (sub === "sounds") {
      rows = this.sounds.filter((s) => !q || s.title.toLowerCase().includes(q)).map((s) => this.audioRow({
        path: s.path, title: s.title, sub: "Sound effect", idle: "veSound", add: () => this.host.addSound(s.path),
      }));
    } else {
      rows = project.filter((m) => !q || m.name.toLowerCase().includes(q)).map((m) => this.audioRow({
        path: m.path, title: m.name, sub: m.missing ? "Missing" : formatTime(m.duration, 30, false), missing: m.missing, add: () => this.host.addMedia(m.id),
        remove: () => this.host.removeMedia(m.id),
        drag: (e) => {
          e.dataTransfer?.setData(MEDIA_DRAG, m.id);
          e.dataTransfer?.setData(`${MEDIA_DRAG}-audio`, "1");
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
        },
        menu: () => [
          { label: "Add at Playhead", icon: "plus", shortcut: "Enter", disabled: !!m.missing, action: () => this.host.addMedia(m.id) },
          "separator",
          { label: "Remove from Project", icon: "trash", shortcut: "Delete", danger: true, action: () => this.host.removeMedia(m.id) },
        ],
      }));
    }
    let body: Node[];
    if (rows.length) body = [this.grid("vp-list", rows, "Audio")];
    else if (q) body = [this.noMatches()];
    else if (sub === "project") {
      body = [empty("music", "No audio yet", "Import music or record a voice-over at the playhead.",
        h("button", { class: "btn small primary", type: "button", onclick: () => this.host.importFiles("audio") }, icon("plus", 14), "Import…"),
        h("button", { class: "btn small", type: "button", onclick: () => this.host.record() }, icon("veMic", 14), "Record"))];
    } else body = [h("div", { class: "vc-none" }, "Loading…")];
    return [head, body];
  }

  // ---- Text

  private textTab(): [Node[], Node[]] {
    const head = [this.titleRow("Text", null, this.headButton("Add text", "plus", () => this.host.addText("classic"), "Add a text at the playhead"))];
    const tiles = TEXT_PRESETS.map((preset) => {
      const s = preset.style;
      const sample = h("span", {
        class: "vp-text-sample",
        style: {
          fontFamily: faceCss(s.font), fontWeight: s.bold ? "700" : "400", fontStyle: s.italic ? "italic" : "normal", color: s.color,
          background: s.box ?? "transparent",
          textShadow: s.stroke ? `0 0 2px ${s.stroke}, 0 0 2px ${s.stroke}, 0 0 1px ${s.stroke}` : s.shadow ? `0 0 8px ${s.color === "#ffffff" ? "rgba(0,0,0,.8)" : s.color}` : "none",
        },
      }, "Aa");
      return this.tile({
        thumb: h("div", { class: "vp-board" }, sample), name: preset.label, title: `Add “${preset.label}” at the playhead`, cls: "vp-text-tile",
        click: () => this.host.addText(preset.id), add: () => this.host.addText(preset.id),
        drag: (e) => {
          e.dataTransfer?.setData(TEXT_DRAG, preset.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
        },
      });
    });
    return [head, [h("h3", { class: "vc-group-h" }, "Styles"), this.grid("vp-grid vp-grid-3", tiles, "Text styles")]];
  }

  // ---- Templates

  private templatesTab(): [Node[], Node[]] {
    const t = this.host.templates;
    const head = [this.titleRow("Templates", null, t ? this.moreButton("Templates options", () => t.menu()) : null), ...(t?.head() ?? [])];
    return [head, t?.body() ?? []];
  }

  // ---- Stickers

  private stickersTab(): [Node[], Node[]] {
    const q = this.query();
    const shown = STICKERS.filter((s) => !q || s.label.toLowerCase().includes(q));
    const head = [this.titleRow("Stickers", String(STICKERS.length)), this.search("Search stickers")];
    const tiles = shown.map((s) => {
      const img = h("img", { class: "vp-sticker-img", alt: "", draggable: "false", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s.svg("#ffb020"))}` });
      const el = h("button", {
        class: "vp-sticker", type: "button", role: "listitem", title: `${s.label}: add at the playhead`, "aria-label": s.label,
        onclick: () => this.host.addSticker(s.id),
      }, img);
      el.addEventListener("vp-add", () => this.host.addSticker(s.id));
      return el;
    });
    return [head, [tiles.length ? this.grid("vp-stickers", tiles, "Stickers") : this.noMatches()]];
  }

  // ---- Effects and Filters

  private effectsTab(): [Node[], Node[]] {
    const sub = (this.host.prefs.get("sub:effects") ?? "effects") as "effects" | "filters";
    const head = [
      this.titleRow("Effects", null, sub === "filters" ? this.moreButton("Filter options", () => [
        { label: "Apply to All Main Clips", icon: "film", disabled: !this.host.currentLook(), action: () => {
          const look = this.host.currentLook();
          if (look) this.host.applyLook(look, true);
        } },
      ]) : null),
      h("div", { class: "vp-seg-row" }, seg(this.syncs, "Effects or filters", [["effects", "Effects"], ["filters", "Filters"]] as const, () => sub, (v) => {
        this.host.prefs.set("sub:effects", v);
        this.refresh();
      }, "vp-sub")),
    ];
    const body: Node[] = [];
    if (sub === "effects") {
      const current = this.host.currentEffect();
      if (current === null) body.push(callout("Select a clip to give it an effect.", "info"));
      body.push(this.grid("vp-grid vp-grid-3", EFFECTS.map(([id, label]) => {
        const [bg, ic] = EFFECT_LOOK[id] ?? EFFECT_LOOK.none;
        return this.tile({
          thumb: h("div", { class: "vp-swatch", style: { background: bg } }, icon(ic, 18)), name: label, active: current === id, disabled: current === null,
          click: () => current !== null && this.host.applyEffect(id),
        });
      }), "Effects"));
      if (current !== null) body.push(h("p", { class: "vc-note vc-hint" }, "Its amount is in the inspector's Adjust tab."));
    } else {
      const current = this.host.currentLook();
      const items: [LookId | "none", string][] = [["none", "None"], ...LOOKS.map((l) => [l.id, l.label] as [LookId, string])];
      body.push(h("p", { class: "vc-note" }, "On the selected clips, or every main clip when none is selected."));
      body.push(this.grid("vp-grid vp-grid-3", items.map(([id, label]) => this.tile({
        thumb: h("div", { class: "vp-swatch", style: { background: LOOK_SWATCH[id] ?? LOOK_SWATCH.none } }), name: label, active: current === id,
        click: () => this.host.applyLook(id, false),
      })), "Filters"));
    }
    return [head, body];
  }

  // ---- Transitions

  private transitionsTab(): [Node[], Node[]] {
    const target = this.host.transitionTarget();
    const layer = !!target && target.track.kind !== "main";
    if (layer && this.slot === "cut" && !target.touching) this.slot = "in";
    const slot: TransitionSlot = layer ? this.slot : "cut";
    const c = target?.clip;
    const now = (slot === "in" ? c?.transIn : slot === "out" ? c?.transOut : c?.transition) ?? null;
    const current = now?.kind ?? null;
    if (now) this.transitionLength = now.duration;
    const apply = (kind: TransitionKind | null, all = false) => this.host.applyTransition(slot, kind, this.transitionLength, all);
    const allLabel = !layer ? "Apply to All Cuts" : slot === "cut" ? "Apply to All Cuts on This Layer" : "Apply to the Whole Layer";
    const project = this.host.project();
    const nameOf = (x: Clip | undefined) => {
      if (!x) return "";
      if (x.type === "media") return project.media.find((m) => m.id === x.media)?.name ?? "Clip";
      if (x.type === "template") return x.name;
      return x.sticker ? "Sticker" : x.text.split("\n")[0].slice(0, 24) || "Text";
    };
    let line = "Select a clip, or put two clips next to each other on the main track.";
    if (target && !layer) {
      const main = target.track.clips;
      const i = main.findIndex((x) => x.id === target.clip.id);
      line = `Cut ${i} · ${nameOf(main[i - 1])} → ${nameOf(target.clip)}`;
    } else if (layer) line = `${target.clip.type === "text" ? (target.clip.sticker ? "Sticker" : "Text") : target.clip.type === "template" ? "Template" : "Overlay"} · ${nameOf(target.clip)}`;
    const slots: [TransitionSlot, string][] = [["in", "In"], ["out", "Out"], ...(target?.touching && layer ? [["cut", "Between"] as [TransitionSlot, string]] : [])];
    const length = scrub(this.syncs, {
      label: "Transition length", min: 0.2, max: 2, step: 0.1, decimals: 1, unit: "s",
      get: () => this.transitionLength,
      set: (v) => {
        this.transitionLength = v;
        if (current) apply(current);
      },
    });
    const head = [
      this.titleRow("Transitions", null, this.moreButton("Transition options", () => [
        { label: "Remove", icon: "close", disabled: !current, action: () => apply(null) },
        { label: allLabel, icon: "checkSquare", disabled: !current, action: () => current && apply(current, true) },
      ])),
      h("div", { class: `vp-target${target ? "" : " none"}`, title: line }, icon(layer ? "phLayers" : "veTransition", 14), h("span", null, line)),
      layer ? h("div", { class: "vp-seg-row" }, seg(this.syncs, "Which transition", slots.map(([s, label]) => [s, label] as const), () => slot, (v) => {
        this.slot = v;
        this.refresh();
      }, "vp-sub")) : null,
      row("Length", length, { cls: "vp-length" }),
    ].filter((n): n is HTMLElement => !!n);
    const groups = layer ? LAYER_TRANSITION_GROUPS : TRANSITION_GROUPS;
    const body: Node[] = [];
    if (!target) body.push(callout("Transitions go on a cut between two clips, or on an overlay, text or template's way in and out.", "info"));
    for (const group of groups) {
      body.push(h("h3", { class: "vc-group-h" }, group.label));
      body.push(this.grid("vp-grid vp-grid-3", group.items.map(([kind, label]) => this.tile({
        thumb: h("div", { class: `vp-trans g-${group.label.toLowerCase()}` }, h("span", { class: "a" }), h("span", { class: "b" })),
        name: label, title: `${label}${kind === current ? " (on it now)" : ""}`, active: kind === current, disabled: !target,
        click: () => target && apply(kind),
      })), group.label));
    }
    return [head, body];
  }

  // ---- Captions

  private captionsTab(): [Node[], Node[]] {
    return [[this.titleRow("Captions", null)], [
      ...this.host.captions.render(),
      h("section", { class: "vp-section" },
        h("h3", { class: "vc-group-h" }, "Subtitle files"),
        h("p", { class: "vc-note" }, "An .srt file comes in as texts on a track of their own; your texts go out as one."),
        h("div", { class: "vc-buttons" },
          h("button", { class: "btn small", type: "button", onclick: () => this.host.importSrt() }, icon("subtitles", 14), "Import .srt…"),
          h("button", { class: "btn small", type: "button", onclick: () => this.host.exportSrt() }, icon("download", 14), "Export .srt…"))),
    ]];
  }
}
