import { formatDate, h, rafThrottle } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import type { GridLayout } from "../../../appearance";
import type { Group, Photo } from "./model";
import { photoThumbUrl, type ThumbLoader } from "../../../shared/thumbs";

const PAD = 24;
const HEADER = 62;
const GROUP_GAP = 18;
const OVERSCAN = 700;
/** Very tall or wide photos are cropped to these proportions so one cannot flatten a row. */
const MIN_ASPECT = 0.5;
const MAX_ASPECT = 3;

interface Row {
  y: number;
  h: number;
  group: number;
  header: boolean;
  /** Index of the first photo in this row, within its group. */
  start: number;
  count: number;
  /**
   * Left edge of each photo, from the left padding, then the row's right edge plus a gap;
   * photo `k` is `edges[k + 1] - edges[k] - gap` wide.
   */
  edges: number[];
}

/** Width over height as displayed; photos of unknown size are laid out square. */
function aspectOf(photo: Photo) {
  return photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 1;
}

/** Long edge of a photo scaled to cover a w×h cell, which its thumbnail must match. */
function coverLongEdge(photo: Photo, w: number, h: number) {
  const aspect = aspectOf(photo);
  return aspect >= 1 ? Math.max(w, h * aspect) : Math.max(h, w / aspect);
}

type RowShape = { start: number; count: number; h: number; edges: number[] };

/**
 * Packs photos into rows that fill `width` exactly, gaps included, each as close to `target`
 * tall as the photos allow. The last row keeps the target height rather than stretching.
 * Edges and heights are whole pixels so every gap is exactly `gap` wide.
 */
function justify(aspects: number[], width: number, target: number, gap: number) {
  const rows: RowShape[] = [];
  let start = 0;
  while (start < aspects.length) {
    let end = start;
    let sum = 0;
    while (end < aspects.length) {
      const next = sum + aspects[end];
      // The gaps in the row if this photo joins it.
      const gaps = (end - start) * gap;
      if (end > start && next * target + gaps > width) {
        // Squeeze the photo in if that strays less from the target than a taller row without it.
        if ((target * next) / (width - gaps) < (width - gaps + gap) / (sum * target)) {
          sum = next;
          end++;
        }
        break;
      }
      sum = next;
      end++;
    }
    const count = end - start;
    const h = Math.min((width - (count - 1) * gap) / sum, end === aspects.length ? target : Infinity);
    const edges = [0];
    let x = 0;
    for (let i = 1; i <= count; i++) edges.push(Math.round((x += aspects[start + i - 1]) * h) + i * gap);
    rows.push({ start, count, h: Math.round(h), edges });
    start = end;
  }
  return rows;
}

/** Equal square tiles, as many across as come closest to `target`, filling `width` exactly. */
function squares(count: number, width: number, target: number, gap: number) {
  const cols = Math.max(1, Math.round((width + gap) / (target + gap)));
  const size = (width - (cols - 1) * gap) / cols;
  const rows: RowShape[] = [];
  for (let start = 0; start < count; start += cols) {
    const edges = [0];
    for (let i = 1; i <= Math.min(cols, count - start); i++) edges.push(Math.round(i * size) + i * gap);
    rows.push({ start, count: edges.length - 1, h: Math.round(size), edges });
  }
  return rows;
}

interface Location {
  group: number;
  index: number;
  flat: number;
}

export interface GridHandlers {
  open(photo: Photo, group: Group): void;
  playGroup(group: Group): void;
  selectionChanged(): void;
  activeGroupChanged(index: number): void;
}

/**
 * A virtualized photo grid with one header per folder. Like Google Photos, photos keep their
 * proportions in rows that fill the width, or sit in square tiles; `cell` is the row height.
 */
export class Grid {
  readonly el = h("div", { class: "grid-scroll", tabIndex: 0 });
  private content = h("div", { class: "grid-content" });
  private groups: Group[] = [];
  private flat: Photo[] = [];
  private where = new Map<string, Location>();
  private folderIndex = new Map<string, number>();
  private rows: Row[] = [];
  private headerRow: number[] = [];
  /** The row each photo sits in, by flat index. */
  private rowOf = new Int32Array(0);
  private layout: GridLayout = "justified";
  private gap = 2;
  /** Space kept clear under the frosted toolbar and above the status bar (from CSS). */
  private insetTop = 0;
  private insetBottom = 0;
  private width = 0;
  private nodes = new Map<string, HTMLElement>();
  private activeGroup = -1;
  /** A folder picked in the sidebar stays highlighted until the user scrolls themselves. */
  private pinnedGroup: number | null = null;
  private anchor: string | null = null;
  readonly selection = new Set<string>();
  private lastClick: { path: string; time: number } | null = null;
  focus: string | null = null;

  constructor(
    private readonly thumbs: ThumbLoader,
    private cell: number,
    private readonly handlers: GridHandlers,
  ) {
    this.el.append(this.content);
    this.el.addEventListener("scroll", rafThrottle(() => this.render()), { passive: true });
    new ResizeObserver(() => {
      if (this.el.clientWidth !== this.width) this.relayout();
      else this.render();
    }).observe(this.el);
    for (const type of ["wheel", "pointerdown", "keydown"]) {
      this.el.addEventListener(type, () => (this.pinnedGroup = null), { passive: true });
    }
    this.el.addEventListener("click", (e) => this.onClick(e));

  }

  get photos(): readonly Photo[] {
    return this.flat;
  }

  get cellSize() {
    return this.cell;
  }

  setGroups(groups: Group[]) {
    // Found while the rows still describe the old groups, so the view can stay on that photo.
    const keep = this.topVisiblePhoto();
    this.groups = groups;
    this.flat = [];
    this.where.clear();
    this.folderIndex.clear();
    groups.forEach((group, g) => {
      this.folderIndex.set(group.folder.path, g);
      group.photos.forEach((photo, index) => {
        this.where.set(photo.path, { group: g, index, flat: this.flat.length });
        this.flat.push(photo);
      });
    });
    for (const path of [...this.selection]) if (!this.where.has(path)) this.selection.delete(path);
    if (this.focus && !this.where.has(this.focus)) this.focus = null;
    // Header text (counts, dates) depends on the filter, so headers are always rebuilt.
    for (const [key, node] of this.nodes) {
      if (key.startsWith("\u0000header:")) {
        node.remove();
        this.nodes.delete(key);
      }
    }
    this.activeGroup = -1;
    this.pinnedGroup = null;
    this.relayout(keep);
  }

  setCellSize(px: number) {
    if (px === this.cell) return;
    this.cell = px;
    this.relayout();
  }

  /** Justified rows or square tiles, with `gap` pixels between photos. */
  setLayout(layout: GridLayout, gap: number) {
    if (layout === this.layout && gap === this.gap) return;
    this.layout = layout;
    this.gap = gap;
    this.relayout();
  }

  selectedPhotos(): Photo[] {
    return this.flat.filter((p) => this.selection.has(p.path));
  }

  groupOf(photo: Photo): Group | undefined {
    const loc = this.where.get(photo.path);
    return loc ? this.groups[loc.group] : undefined;
  }

  get focusedPhoto(): Photo | undefined {
    const loc = this.focus ? this.where.get(this.focus) : undefined;
    return loc ? this.flat[loc.flat] : undefined;
  }

  get activeGroupIndex() {
    return this.activeGroup;
  }

  scrollToGroup(index: number) {
    const row = this.rows[this.headerRow[index]];
    if (!row) return;
    this.pinnedGroup = index;
    this.setActiveGroup(index);
    this.el.scrollTo({ top: Math.max(0, row.y - this.insetTop - 6), behavior: "smooth" });
  }

  /** Focuses and selects a photo, scrolling it into view (used when returning from the viewer). */
  reveal(path: string) {
    if (!this.where.has(path)) return;
    this.focus = this.anchor = path;
    this.selection.clear();
    this.selection.add(path);
    this.ensureVisible(path, "center");
    this.updateSelectionClasses();
    this.handlers.selectionChanged();
  }

  handleKey(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "a") {
      for (const p of this.flat) this.selection.add(p.path);
      this.updateSelectionClasses();
      this.handlers.selectionChanged();
      return true;
    }
    if (e.key === "Escape" && this.selection.size) {
      this.selection.clear();
      this.updateSelectionClasses();
      this.handlers.selectionChanged();
      return true;
    }
    if (e.key === "Enter") {
      const photo = this.focusedPhoto;
      if (photo) this.open(photo);
      return !!photo;
    }
    const target = this.navigate(e.key);
    if (target === undefined) return false;
    if (target !== null) this.moveFocus(target, e.shiftKey);
    return true;
  }

  private navigate(key: string): number | null | undefined {
    if (!this.flat.length) return ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key) ? null : undefined;
    const loc = this.focus ? this.where.get(this.focus) : undefined;
    if (!loc) {
      return ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(key) ? 0 : undefined;
    }
    switch (key) {
      case "ArrowLeft":
        return Math.max(0, loc.flat - 1);
      case "ArrowRight":
        return Math.min(this.flat.length - 1, loc.flat + 1);
      case "Home":
        return 0;
      case "End":
        return this.flat.length - 1;
      case "ArrowUp":
        return this.verticalNeighbour(loc, -1);
      case "ArrowDown":
        return this.verticalNeighbour(loc, 1);
      default:
        return undefined;
    }
  }

  /** The photo above or below the middle of this one, across folders; itself at either end. */
  private verticalNeighbour(loc: Location, step: -1 | 1) {
    const from = this.rows[this.rowOf[loc.flat]];
    let r = this.rowOf[loc.flat] + step;
    while (this.rows[r]?.header) r += step;
    const row = this.rows[r];
    if (!row) return loc.flat;
    const k = loc.index - from.start;
    const mid = (from.edges[k] + from.edges[k + 1] - this.gap) / 2;
    let best = 0;
    while (best < row.count - 1 && row.edges[best + 1] <= mid) best++;
    return this.where.get(this.groups[row.group].photos[row.start + best].path)!.flat;
  }

  private moveFocus(flatIndex: number, extend: boolean) {
    const photo = this.flat[flatIndex];
    if (!photo) return;
    this.focus = photo.path;
    if (extend && this.anchor) {
      this.selectRange(this.anchor, photo.path, false);
    } else {
      this.anchor = photo.path;
      this.selection.clear();
      this.selection.add(photo.path);
    }
    this.ensureVisible(photo.path, "nearest");
    this.updateSelectionClasses();
    this.handlers.selectionChanged();
  }

  private selectRange(from: string, to: string, additive: boolean) {
    const a = this.where.get(from)?.flat ?? 0;
    const b = this.where.get(to)?.flat ?? 0;
    if (!additive) this.selection.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selection.add(this.flat[i].path);
  }

  private ensureVisible(path: string, block: "nearest" | "center") {
    const loc = this.where.get(path);
    if (!loc) return;
    const index = this.rowOf[loc.flat];
    const row = this.rows[index];
    if (!row) return;
    // The visible band lies between the bars.
    const top = this.el.scrollTop + this.insetTop;
    const height = this.el.clientHeight - this.insetTop - this.insetBottom;
    if (block === "center") {
      this.el.scrollTop = row.y + row.h / 2 - height / 2 - this.insetTop;
    } else if (row.y < top + 8) {
      this.el.scrollTop = row.y - this.insetTop - (this.rows[index - 1]?.header ? HEADER + 8 : 8);
    } else if (row.y + row.h > top + height - 8) {
      this.el.scrollTop = row.y + row.h - height + 8 - this.insetTop;
    }
    this.render();
  }

  private open(photo: Photo) {
    const group = this.groupOf(photo);
    if (group) this.handlers.open(photo, group);
  }

  private photoAt(target: EventTarget | null): Photo | undefined {
    const cell = target instanceof Element ? target.closest<HTMLElement>(".cell") : null;
    const loc = cell?.dataset.path ? this.where.get(cell.dataset.path) : undefined;
    return loc ? this.flat[loc.flat] : undefined;
  }

  private onClick(e: MouseEvent) {
    const target = e.target instanceof Element ? e.target : null;
    const play = target?.closest<HTMLElement>(".gh-play");
    if (play) {
      const group = this.groups[this.folderIndex.get(play.dataset.folder ?? "") ?? -1];
      if (group) this.handlers.playGroup(group);
      return;
    }
    const photo = this.photoAt(target);
    // A second click on the same photo opens it. WebKit's own dblclick is unreliable right
    // after the page under the pointer changes, so the timing is tracked here.
    const now = performance.now();
    if (photo && !e.shiftKey && !e.ctrlKey && !e.metaKey && this.lastClick?.path === photo.path && now - this.lastClick.time < 450) {
      this.lastClick = null;
      this.open(photo);
      return;
    }
    this.lastClick = photo ? { path: photo.path, time: now } : null;
    if (!photo) {
      if (!target?.closest(".group-header") && this.selection.size && !e.ctrlKey && !e.shiftKey) {
        this.selection.clear();
        this.updateSelectionClasses();
        this.handlers.selectionChanged();
      }
      return;
    }
    if (e.shiftKey && this.anchor) {
      this.selectRange(this.anchor, photo.path, e.ctrlKey || e.metaKey);
    } else if (e.ctrlKey || e.metaKey) {
      if (this.selection.has(photo.path)) this.selection.delete(photo.path);
      else this.selection.add(photo.path);
      this.anchor = photo.path;
    } else {
      this.selection.clear();
      this.selection.add(photo.path);
      this.anchor = photo.path;
    }
    this.focus = photo.path;
    this.updateSelectionClasses();
    this.handlers.selectionChanged();
  }

  private updateSelectionClasses() {
    for (const [key, node] of this.nodes) {
      if (!node.classList.contains("cell")) continue;
      node.classList.toggle("selected", this.selection.has(key));
      node.classList.toggle("focused", this.focus === key);
    }
  }

  /** Recomputes rows for the current width, keeping the photo at the top of the view in place. */
  private relayout(keep = this.topVisiblePhoto()) {
    this.width = this.el.clientWidth;
    const style = getComputedStyle(this.el);
    this.insetTop = parseFloat(style.getPropertyValue("--inset-top")) || 0;
    this.insetBottom = parseFloat(style.getPropertyValue("--inset-bottom")) || 0;
    const usable = Math.max(this.cell, this.width - PAD * 2);
    this.rows = [];
    this.headerRow = [];
    this.rowOf = new Int32Array(this.flat.length);
    let y = this.insetTop + 8;
    let first = 0;
    this.groups.forEach((group, g) => {
      this.headerRow.push(this.rows.length);
      this.rows.push({ y, h: HEADER, group: g, header: true, start: 0, count: 0, edges: [] });
      y += HEADER;
      const shapes = this.layout === "square"
        ? squares(group.photos.length, usable, this.cell, this.gap)
        : justify(group.photos.map((p) => Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspectOf(p)))), usable, this.cell, this.gap);
      for (const { start, count, h, edges } of shapes) {
        this.rowOf.fill(this.rows.length, first + start, first + start + count);
        this.rows.push({ y, h, group: g, header: false, start, count, edges });
        y += h + this.gap;
      }
      first += group.photos.length;
      y += GROUP_GAP;
    });
    this.content.style.height = `${y + 24 + this.insetBottom}px`;
    if (keep) {
      const loc = this.where.get(keep.path);
      const row = loc && this.rows[this.rowOf[loc.flat]];
      if (row) this.el.scrollTop = row.y - keep.offset;
    }
    this.render();
  }

  private topVisiblePhoto(): { path: string; offset: number } | null {
    if (!this.rows.length) return null;
    const top = this.el.scrollTop;
    if (top <= 0) return null;
    for (let i = this.firstRowBelow(top + this.insetTop); i < this.rows.length; i++) {
      const row = this.rows[i];
      if (!row.header) return { path: this.groups[row.group].photos[row.start].path, offset: row.y - top };
    }
    return null;
  }

  /** Index of the first row whose bottom edge is below `y`. */
  private firstRowBelow(y: number) {
    let lo = 0;
    let hi = this.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const row = this.rows[mid];
      if (row.y + row.h <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private render() {
    const top = this.el.scrollTop;
    const bottom = top + this.el.clientHeight;
    const used = new Set<string>();
    for (let i = this.firstRowBelow(top - OVERSCAN); i < this.rows.length; i++) {
      const row = this.rows[i];
      if (row.y > bottom + OVERSCAN) break;
      const group = this.groups[row.group];
      if (row.header) {
        const key = `\u0000header:${group.folder.path}`;
        used.add(key);
        let node = this.nodes.get(key);
        if (!node) {
          node = this.createHeader(group);
          this.nodes.set(key, node);
          this.content.append(node);
        }
        node.style.transform = `translate(${PAD}px, ${row.y}px)`;
        node.style.width = `${this.width - PAD * 2}px`;
        continue;
      }
      for (let k = 0; k < row.count; k++) {
        const photo = group.photos[row.start + k];
        used.add(photo.path);
        let node = this.nodes.get(photo.path);
        if (!node) {
          node = this.createCell(photo);
          this.nodes.set(photo.path, node);
          this.content.append(node);
        }
        const x = row.edges[k];
        const w = row.edges[k + 1] - x - this.gap;
        node.style.transform = `translate(${PAD + x}px, ${row.y}px)`;
        node.style.width = `${w}px`;
        node.style.height = `${row.h}px`;
        this.thumbs.load(node.querySelector("img")!, photoThumbUrl(photo, coverLongEdge(photo, w, row.h)));
      }
    }
    for (const [key, node] of this.nodes) {
      if (used.has(key)) continue;
      const img = node.querySelector("img");
      if (img) this.thumbs.cancel(img);
      node.remove();
      this.nodes.delete(key);
    }
    this.updateActiveGroup(top);
  }

  private updateActiveGroup(top: number) {
    if (this.pinnedGroup !== null) return;
    const row = this.rows[this.firstRowBelow(top + this.insetTop + HEADER / 2)];
    this.setActiveGroup(row ? row.group : -1);
  }

  private setActiveGroup(index: number) {
    if (index === this.activeGroup) return;
    this.activeGroup = index;
    this.handlers.activeGroupChanged(index);
  }

  private createCell(photo: Photo) {
    const img = h("img", { alt: "", draggable: false, decoding: "async" });
    const node = h("div", { class: "cell", title: photo.name }, h("div", { class: "thumb" }, img));
    node.dataset.path = photo.path;
    if (this.selection.has(photo.path)) node.classList.add("selected");
    if (this.focus === photo.path) node.classList.add("focused");
    return node;
  }

  private createHeader(group: Group) {
    const { folder, photos } = group;
    const count = `${photos.length.toLocaleString()} ${photos.length === 1 ? "photo" : "photos"}`;
    const date = formatDate(folder.latest);
    const play = h("button", { class: "gh-play", title: "Play this folder as a slideshow" }, icon("play", 14), "Play");
    play.dataset.folder = folder.path;
    return h(
      "div",
      { class: "group-header" },
      h(
        "div",
        { class: "gh-text" },
        h("div", { class: "gh-title" }, h("span", { class: "gh-name" }, folder.name), h("span", { class: "gh-meta" }, [date, count].filter(Boolean).join("  ·  "))),
        // The path is truncated from the left (rtl); the LRM mark keeps its leading "/" in place.
        h("div", { class: "gh-path", title: folder.path }, `‎${folder.path}`),
      ),
      play,
    );
  }
}
