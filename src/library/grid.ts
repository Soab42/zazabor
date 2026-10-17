import { formatDate, h, rafThrottle } from "../ui/dom";
import { icon } from "../ui/icons";
import type { Group, Photo } from "./model";
import { photoThumbUrl, type ThumbLoader } from "./thumbs";

const PAD = 24;
const GAP = 10;
const HEADER = 62;
const GROUP_GAP = 18;
const OVERSCAN = 700;

interface Row {
  y: number;
  h: number;
  group: number;
  header: boolean;
  /** Index of the first photo in this row, within its group. */
  start: number;
  count: number;
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

/** A virtualized thumbnail grid with one header per folder, in the spirit of Picasa. */
export class Grid {
  readonly el = h("div", { class: "grid-scroll", tabIndex: 0 });
  private content = h("div", { class: "grid-content" });
  private groups: Group[] = [];
  private flat: Photo[] = [];
  private where = new Map<string, Location>();
  private folderIndex = new Map<string, number>();
  private rows: Row[] = [];
  private headerRow: number[] = [];
  private cols = 1;
  private width = 0;
  private nodes = new Map<string, HTMLElement>();
  private activeGroup = -1;
  /** A folder picked in the sidebar stays highlighted until the user scrolls themselves. */
  private pinnedGroup: number | null = null;
  private anchor: string | null = null;
  readonly selection = new Set<string>();
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
    this.el.addEventListener("dblclick", (e) => {
      const photo = this.photoAt(e.target);
      if (photo) this.open(photo);
    });
  }

  get photos(): readonly Photo[] {
    return this.flat;
  }

  get cellSize() {
    return this.cell;
  }

  setGroups(groups: Group[]) {
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
    this.relayout();
  }

  setCellSize(px: number) {
    if (px === this.cell) return;
    this.cell = px;
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
    this.el.scrollTo({ top: Math.max(0, row.y - 6), behavior: "smooth" });
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
    const cols = this.cols;
    const group = this.groups[loc.group];
    const rowStart = Math.floor(loc.index / cols) * cols;
    const col = loc.index - rowStart;
    const flatOf = (g: number, i: number) => this.where.get(this.groups[g].photos[i].path)!.flat;
    switch (key) {
      case "ArrowLeft":
        return Math.max(0, loc.flat - 1);
      case "ArrowRight":
        return Math.min(this.flat.length - 1, loc.flat + 1);
      case "Home":
        return 0;
      case "End":
        return this.flat.length - 1;
      case "ArrowUp": {
        if (rowStart > 0) return flatOf(loc.group, rowStart - cols + col);
        if (loc.group === 0) return loc.flat;
        const prev = this.groups[loc.group - 1].photos.length;
        const lastRow = Math.floor((prev - 1) / cols) * cols;
        return flatOf(loc.group - 1, Math.min(lastRow + col, prev - 1));
      }
      case "ArrowDown": {
        if (rowStart + cols < group.photos.length)
          return flatOf(loc.group, Math.min(rowStart + cols + col, group.photos.length - 1));
        if (loc.group === this.groups.length - 1) return loc.flat;
        return flatOf(loc.group + 1, Math.min(col, this.groups[loc.group + 1].photos.length - 1));
      }
      default:
        return undefined;
    }
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
    const row = this.rows[this.headerRow[loc.group] + 1 + Math.floor(loc.index / this.cols)];
    if (!row) return;
    const top = this.el.scrollTop;
    const height = this.el.clientHeight;
    if (block === "center") {
      this.el.scrollTop = row.y + row.h / 2 - height / 2;
    } else if (row.y < top + 8) {
      this.el.scrollTop = row.y - (row.y === this.rows[this.headerRow[loc.group] + 1].y ? HEADER + 8 : 8);
    } else if (row.y + row.h > top + height - 8) {
      this.el.scrollTop = row.y + row.h - height + 8;
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
  private relayout() {
    const keep = this.topVisiblePhoto();
    this.width = this.el.clientWidth;
    const usable = Math.max(this.cell, this.width - PAD * 2);
    this.cols = Math.max(1, Math.floor((usable + GAP) / (this.cell + GAP)));
    this.rows = [];
    this.headerRow = [];
    let y = 8;
    this.groups.forEach((group, g) => {
      this.headerRow.push(this.rows.length);
      this.rows.push({ y, h: HEADER, group: g, header: true, start: 0, count: 0 });
      y += HEADER;
      for (let start = 0; start < group.photos.length; start += this.cols) {
        const count = Math.min(this.cols, group.photos.length - start);
        this.rows.push({ y, h: this.cell + GAP, group: g, header: false, start, count });
        y += this.cell + GAP;
      }
      y += GROUP_GAP;
    });
    this.content.style.height = `${y + 24}px`;
    if (keep) {
      const loc = this.where.get(keep.path);
      const row = loc && this.rows[this.headerRow[loc.group] + 1 + Math.floor(loc.index / this.cols)];
      if (row) this.el.scrollTop = row.y - keep.offset;
    }
    this.render();
  }

  private topVisiblePhoto(): { path: string; offset: number } | null {
    if (!this.rows.length) return null;
    const top = this.el.scrollTop;
    if (top <= 0) return null;
    for (let i = this.firstRowBelow(top); i < this.rows.length; i++) {
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
    const step = this.cell + GAP;
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
        node.style.transform = `translate(${PAD + k * step}px, ${row.y}px)`;
        node.style.width = node.style.height = `${this.cell}px`;
        this.thumbs.load(node.querySelector("img")!, photoThumbUrl(photo, this.cell));
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
    const row = this.rows[this.firstRowBelow(top + HEADER / 2)];
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
