import { previewUrl } from "../../../../api";
import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { MenuItem } from "../../../../ui/menu";
import { empty, popover, searchField, selectRow, switchRow, type Syncs } from "../controls";
import type { Aspect } from "../../app";
import { OWN_LOOK, type Theme } from "./brand";
import { CATEGORIES, type Category, type Template } from "./format";
import { loadFamily } from "./fonts";
import { SHAPES, type Shape } from "./layout";
import type { MyTemplates } from "./mine";
import { drawScene, newMemory, type Memory, type Picture, type Scene } from "./player";
import { allKits, defaultKit, setDefaultKit, themeFor, usesOwnLook, type SavedTemplate } from "./settings";
import { TEMPLATES } from "./templates";
import type { MotionTools } from "./tools";

/**
 * The Templates tab: shipped templates by category and My Templates, as cards that play when
 * pointed at, in the project's shape and the default Brand Kit. Its head (pinned in the left
 * panel) has search and the categories; shape and length, the Brand Kit for new templates, the
 * Bangla preview and whether using one adds its suggested sounds are under its options button.
 */

type Lengths = "any" | "short" | "medium" | "long";
const LENGTHS: [Lengths, string, (s: number) => boolean][] = [
  ["any", "Any length", () => true],
  ["short", "Up to 5 s", (s) => s <= 5.01],
  ["medium", "5–7 s", (s) => s > 5.01 && s <= 7.01],
  ["long", "Over 7 s", (s) => s > 7.01],
];

/** Card previews: canvas width in pixels (they're shown about half as wide). */
const CARD_PX = 280;

interface Card {
  canvas: HTMLCanvasElement;
  template: Template;
  values: Record<string, string>;
  theme: Theme;
  pictures: Map<string, Picture | null>;
  mem: Memory;
  playing: boolean;
  started: number;
}

export class TemplateBrowser {
  private category: Category | "mine" | "all" = "all";
  private query = "";
  private length: Lengths = "any";
  private shape: Shape | "project" = "project";
  private grid = h("div", { class: "mo-grid" });
  private cards: Card[] = [];
  private search: HTMLElement | null = null;

  constructor(private tools: MotionTools, private mine: MyTemplates, private aspect: () => Aspect, private openKits: () => void) {}

  /** The pane's pinned head: search with an options button, then the categories on one line. */
  head(): Node[] {
    const s = this.tools.settings();
    const kinds = [{ id: "all" as const, label: "All" }, ...CATEGORIES];
    const chipButtons = kinds.map((c) => h("button", {
      class: `vc-chip${this.category === c.id ? " active" : ""}`, type: "button", role: "tab", "aria-selected": String(this.category === c.id),
      onclick: () => {
        this.category = c.id;
        chipButtons.forEach((b, i) => {
          b.classList.toggle("active", kinds[i].id === c.id);
          b.setAttribute("aria-selected", String(kinds[i].id === c.id));
        });
        this.drawGrid();
      },
    }, c.label));
    const filtered = () => this.shape !== "project" || this.length !== "any";
    const options: HTMLButtonElement = h("button", {
      class: "icon-btn small vc-options", type: "button", title: "Shape, length, Brand Kit and preview options", "aria-label": "Template options", "aria-expanded": "false",
      onclick: () => {
        const syncs: Syncs = [];
        const changed = () => {
          options.classList.toggle("on", filtered());
          this.drawGrid();
        };
        popover(options, "Templates",
          selectRow(syncs, "Shape", [["project", "Project's shape"], ...SHAPES.map((x) => [x, x] as [string, string])], () => this.shape, (v) => {
            this.shape = v as Shape | "project";
            changed();
          }),
          selectRow(syncs, "Length", LENGTHS.map(([id, label]) => [id, label] as [Lengths, string]), () => this.length, (v) => {
            this.length = v;
            changed();
          }),
          selectRow(syncs, "Brand Kit", [[OWN_LOOK, "Template's own look"], ...allKits(s).map((k) => [k.id, k.name] as [string, string])],
            () => (usesOwnLook(s) ? OWN_LOOK : defaultKit(s).id), (v) => {
              setDefaultKit(s, v);
              this.tools.saveSettings();
              this.drawGrid();
            }),
          switchRow(syncs, "Bangla preview", () => s.bangla, (v) => {
            s.bangla = v;
            this.tools.saveSettings();
            this.drawGrid();
          }),
          switchRow(syncs, "Add sounds", () => s.sounds, (v) => {
            s.sounds = v;
            this.tools.saveSettings();
          }),
          h("button", { class: "btn small vc-pop-action", type: "button", onclick: () => this.openKits() }, icon("palette", 14), "Brand Kits…"),
        );
      },
    }, icon("filter", 16));
    options.classList.toggle("on", filtered());
    this.search = searchField("Search templates", this.query, (v) => {
      this.query = v;
      this.drawGrid();
    });
    return [
      h("div", { class: "vp-search-row" }, this.search, options),
      h("div", { class: "vc-chips", role: "tablist", "aria-label": "Categories" }, ...chipButtons),
    ];
  }

  /** The cards. */
  body(): Node[] {
    this.drawGrid();
    return [this.grid];
  }

  /** The pane's ⋯ menu. */
  menu(): MenuItem[] {
    return [
      { label: "Brand Kits…", icon: "palette", action: () => this.openKits() },
      { label: "Import .zaztemplate…", icon: "download", action: () => void this.mine.importFiles() },
    ];
  }

  focusSearch() {
    this.search?.querySelector("input")?.focus();
  }

  private shapeNow(): Shape {
    return this.shape === "project" ? (this.aspect() as Shape) : this.shape;
  }

  private matches(t: Template, name = t.name): boolean {
    const q = this.query.trim().toLowerCase();
    const lengthOk = LENGTHS.find(([id]) => id === this.length)![2](t.length);
    if (!lengthOk || !t.shapes.includes(this.shapeNow())) return false;
    if (!q) return true;
    const label = CATEGORIES.find((c) => c.id === t.category)?.label ?? "";
    return [name, t.description, label, ...t.tags].some((x) => x.toLowerCase().includes(q));
  }

  private drawGrid() {
    const s = this.tools.settings();
    const shown = TEMPLATES.filter((t) => this.category !== "mine" && (this.category === "all" || t.category === this.category) && this.matches(t));
    const themes = new Map(shown.map((t) => [t.id, themeFor(t, s).theme]));
    const families = new Set([...themes.values()].flatMap((x) => [x.heading.family, x.body.family, x.bangla.family]));
    void Promise.allSettled([...families].map(loadFamily)).then(() => {
      // Text measured with a stand-in font is measured again.
      for (const c of this.cards) c.mem = newMemory();
      this.redrawAll();
    });
    this.cards = [];
    const items: Node[] = [];
    if (this.category === "mine" || this.category === "all") {
      const mine = this.mine.list().filter((e) => this.matches(e.doc, e.name));
      if (this.category === "mine" && !mine.length) {
        items.push(h("div", { class: "mo-wide" }, empty("template", "Nothing saved yet", "Select a template on the timeline, then choose Save to My Templates from its ⋯ menu.",
          h("button", { class: "btn small", type: "button", onclick: () => void this.mine.importFiles() }, "Import .zaztemplate…"))));
      }
      for (const e of this.category === "mine" ? mine : mine.slice(0, 4)) items.push(this.mineCard(e));
    }
    for (const t of shown) items.push(this.card(t, t.name, {}, themes.get(t.id)!, () => void this.tools.use(t)));
    if (!items.length) {
      items.push(h("div", { class: "mo-wide vc-none" }, `No templates match${this.query.trim() ? ` “${this.query.trim()}”` : ""}.`,
        this.query || this.shape !== "project" || this.length !== "any"
          ? h("button", { class: "text-btn", type: "button", onclick: () => {
            this.query = "";
            this.shape = "project";
            this.length = "any";
            this.category = "all";
            const input = this.search?.querySelector("input");
            if (input) input.value = "";
            this.drawGrid();
          } }, "Clear filters")
          : null));
    }
    this.grid.replaceChildren(...items);
  }

  private card(template: Template, name: string, values: Record<string, string>, theme: Theme, use: () => void, extra?: Node, pictures = new Map<string, Picture | null>()): HTMLElement {
    const shape = this.shapeNow();
    const [a, b] = shape.split(":").map(Number);
    const canvas = h("canvas", { class: "mo-card-canvas", width: CARD_PX, height: Math.round((CARD_PX * b) / a) });
    const card: Card = { canvas, template, values, theme, pictures, mem: newMemory(), playing: false, started: 0 };
    this.cards.push(card);
    this.drawCard(card, (template.hold[0] + template.hold[1]) / 2);
    const play = () => {
      if (card.playing) return;
      card.playing = true;
      card.started = performance.now();
      const step = () => {
        if (!card.playing || !canvas.isConnected) {
          card.playing = false;
          return;
        }
        const t = ((performance.now() - card.started) / 1000) % (template.length + 0.4);
        this.drawCard(card, Math.min(t, template.length));
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    const stop = () => {
      card.playing = false;
      this.drawCard(card, (template.hold[0] + template.hold[1]) / 2);
    };
    const el = h("div", { class: "mo-card", title: template.description },
      h("button", { class: "mo-card-play", type: "button", "aria-label": `Use ${name}`, onclick: use, onpointerenter: play, onpointerleave: stop, onfocus: play, onblur: stop },
        canvas,
        h("span", { class: "mo-card-len" }, `${template.length.toFixed(1).replace(/\.0$/, "")} s`),
        h("span", { class: "mo-card-add" }, icon("plus", 14))),
      h("div", { class: "mo-card-foot" }, h("span", { class: "mo-card-name" }, name), extra ?? null));
    return el;
  }

  private mineCard(e: SavedTemplate): HTMLElement {
    const pictures = new Map<string, Picture | null>();
    const tools = h("span", { class: "mo-card-tools" },
      h("button", { class: "icon-btn small", type: "button", title: "Rename", onclick: () => void this.mine.rename(e) }, icon("pencil", 13)),
      h("button", { class: "icon-btn small", type: "button", title: "Export .zaztemplate", onclick: () => void this.mine.exportEntry(e) }, icon("download", 13)),
      h("button", { class: "icon-btn small", type: "button", title: "Delete", onclick: () => void this.mine.remove(e) }, icon("trash", 13)));
    const el = this.card(e.doc, e.name, e.values, e.theme, () => void this.mine.use(e), tools, pictures);
    const card = this.cards[this.cards.length - 1];
    for (const [field, path] of Object.entries(e.pictures)) {
      if (/\.svg$/i.test(path)) continue;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        pictures.set(field, img);
        if (!card.playing) this.drawCard(card, (e.doc.hold[0] + e.doc.hold[1]) / 2);
      };
      img.src = previewUrl(path, 0, 512);
    }
    return el;
  }

  private redrawAll() {
    for (const c of this.cards) if (!c.playing && c.canvas.isConnected) this.drawCard(c, (c.template.hold[0] + c.template.hold[1]) / 2);
  }

  private drawCard(card: Card, t: number) {
    const { canvas, template } = card;
    const g = canvas.getContext("2d");
    if (!g) return;
    const W = canvas.width, H = canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (template.overlay) {
      // Lower thirds go over video: a stand-in picture behind them.
      const bg = g.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, "#3b4a5c");
      bg.addColorStop(1, "#151b24");
      g.fillStyle = bg;
      g.fillRect(0, 0, W, H);
    }
    const scene: Scene = {
      template, values: card.values, theme: card.theme, pictures: card.pictures, outlines: new Map(),
      bangla: this.tools.settings().bangla, placeholders: false,
    };
    drawScene(g, W, H, t, t / Math.max(0.1, template.length), scene, card.mem);
  }
}
