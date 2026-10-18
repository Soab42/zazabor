import { photoThumbUrl } from "../../shared/thumbs";
import { h } from "../../ui/dom";
import type { FsEntry } from "./api";
import { categoryOf, folderGlyph, iconNameFor, iconNode } from "./kinds";
import { isInside, parentOf, samePath } from "./path";
import "./dnd.css";

/** What a drop does; the browser supplies these (views and the tab bar know nothing of jobs). */
export interface DragHooks {
  /** Move (or, with `copy`, copy) the paths into the folder. */
  transfer(paths: string[], dest: string, copy: boolean): void;
  /** Spring-loading: the pointer rested on a tab. */
  switchTab(index: number): void;
  /** Spring-loading: the pointer rested on a folder in a view. */
  open(path: string): void;
}

let hooks: DragHooks | null = null;

export function setDragHooks(next: DragHooks | null) {
  hooks = next;
}

const THRESHOLD = 5;
const FOLDER_DELAY = 800;
const TAB_DELAY = 600;
const EDGE_ZONE = 44;
const EDGE_SPEED = 16;

// ---- pure rules --------------------------------------------------------------------------------

/**
 * The dragged paths a drop on `dest` would act on: dropping an item onto itself, onto its own
 * folder (nothing would change) or into its own descendant is ignored. Empty means "not a target".
 */
export function dropPaths(paths: string[], dest: string): string[] {
  return paths.filter((p) => !isInside(dest, p) && !samePath(parentOf(p), dest));
}

/** Pixels per frame to scroll when the pointer is within `zone` of either end of `start..end` (negative = backwards). */
export function edgeScroll(pos: number, start: number, end: number, zone = EDGE_ZONE, max = EDGE_SPEED): number {
  if (end - start < zone * 2) return 0;
  if (pos < start + zone) return -Math.ceil(max * Math.min(1, (start + zone - pos) / zone));
  if (pos > end - zone) return Math.ceil(max * Math.min(1, (pos - (end - zone)) / zone));
  return 0;
}

/** Swallows the click the browser fires after a drag or rubber band that ended over the same element. */
export function swallowClick() {
  const stop = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", stop, true), 80);
}

// ---- drag sessions -----------------------------------------------------------------------------

export interface DragSourceOptions {
  /** The entry the pointer went down on, or null for empty space. */
  entryAt(target: HTMLElement): FsEntry | null;
  isSelected(path: string): boolean;
  /** Dragging an unselected item makes it the selection first. */
  select(entry: FsEntry): void;
  /** The selected paths: what travels with the drag. */
  paths(): string[];
}

interface Session {
  paths: string[];
  x: number;
  y: number;
  copy: boolean;
  ghost: HTMLElement;
  target: HTMLElement | null;
  timer: number | undefined;
  frame: number;
}

let session: Session | null = null;

/** Makes the items under `root` drag sources. Returns a function that detaches it. */
export function attachDragSource(root: HTMLElement, opts: DragSourceOptions): () => void {
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || session || !(e.target instanceof HTMLElement)) return;
    const entry = opts.entryAt(e.target);
    if (!entry) return;
    track(e, entry, opts);
  };
  root.addEventListener("pointerdown", onDown);
  return () => root.removeEventListener("pointerdown", onDown);
}

/** Waits for the pointer to travel past the threshold, then runs the drag until release. */
function track(down: PointerEvent, entry: FsEntry, opts: DragSourceOptions) {
  const sx = down.clientX;
  const sy = down.clientY;
  let started = false;

  const move = (e: PointerEvent) => {
    if (!started) {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) < THRESHOLD) return;
      started = true;
      if (!opts.isSelected(entry.path)) opts.select(entry);
      const paths = opts.paths();
      begin(paths.length ? paths : [entry.path], entry, e);
    }
    update(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
  };
  const stop = () => {
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("blur", cancel);
  };
  const up = () => {
    stop();
    if (started) finish(true);
  };
  const cancel = () => {
    stop();
    document.removeEventListener("pointerup", swallowClick, true);
    if (started) finish(false);
  };
  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", cancel, true);
  window.addEventListener("blur", cancel);
  // Esc during the drag cancels it; `finish` removes this listener.
  cancelHook = () => {
    stop();
    finish(false);
  };
}

let cancelHook: (() => void) | null = null;

const onKey = (e: KeyboardEvent) => {
  if (!session) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    cancelHook?.();
  } else if (e.key === "Control" || e.key === "Meta") {
    setCopy(e.type === "keydown");
  }
};

function begin(paths: string[], entry: FsEntry, e: PointerEvent) {
  const ghost = buildGhost(entry, paths.length);
  document.body.append(ghost);
  document.body.classList.add("dnd-active");
  session = { paths, x: e.clientX, y: e.clientY, copy: false, ghost, target: null, timer: undefined, frame: 0 };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  document.addEventListener("pointerup", swallowClick, { capture: true, once: true });
  session.frame = requestAnimationFrame(tick);
}

function buildGhost(entry: FsEntry, count: number): HTMLElement {
  const category = categoryOf(entry);
  const art = h("span", { class: `dnd-art ${category}` });
  if (category === "folder") {
    art.append(folderGlyph());
  } else if (category === "image") {
    const img = h("img", { alt: "", draggable: false, decoding: "async", src: photoThumbUrl(entry, 64) });
    img.addEventListener("error", () => img.remove());
    art.append(iconNode("image", 18), img);
  } else {
    art.append(iconNode(iconNameFor(category), 18));
  }
  const ghost = h("div", { class: `dnd-ghost${count > 1 ? " multi" : ""}`, "aria-hidden": "true" },
    art, h("span", { class: "dnd-name" }, entry.name),
    ...(count > 1 ? [h("span", { class: "dnd-count" }, String(count))] : []),
    h("span", { class: "dnd-plus" }, "+"));
  return ghost;
}

function setCopy(copy: boolean) {
  if (!session || session.copy === copy) return;
  session.copy = copy;
  session.ghost.classList.toggle("copy", copy);
  document.body.classList.toggle("dnd-copy", copy);
}

function update(x: number, y: number, copy: boolean) {
  const s = session;
  if (!s) return;
  s.x = x;
  s.y = y;
  s.ghost.style.transform = `translate3d(${x + 14}px, ${y + 14}px, 0)`;
  setCopy(copy);
  resolve();
}

/** Finds the nearest drop target under the pointer and highlights it when the drop would do something. */
function resolve() {
  const s = session;
  if (!s) return;
  const under = document.elementFromPoint(s.x, s.y);
  let target = under instanceof HTMLElement ? under.closest<HTMLElement>("[data-drop-path]") : null;
  if (target && dropPaths(s.paths, target.dataset.dropPath ?? "").length === 0) target = null;
  if (target === s.target) return;
  s.target?.classList.remove("drop-target");
  clearTimeout(s.timer);
  s.target = target;
  if (!target) return;
  target.classList.add("drop-target");
  const tab = target.dataset.tabIndex;
  const delay = tab !== undefined ? TAB_DELAY : target.dataset.spring === "open" ? FOLDER_DELAY : 0;
  if (!delay) return;
  s.timer = window.setTimeout(() => {
    if (session !== s || s.target !== target) return;
    if (tab !== undefined) hooks?.switchTab(Number(tab));
    else hooks?.open(target.dataset.dropPath ?? "");
    // The view re-rendered; look again from scratch on the next frame.
    target.classList.remove("drop-target");
    s.target = null;
  }, delay);
}

/** Per-frame work: scroll the list under the pointer when it nears an edge, then re-hit-test. */
function tick() {
  const s = session;
  if (!s) return;
  const under = document.elementFromPoint(s.x, s.y);
  const list = under instanceof HTMLElement ? under.closest<HTMLElement>(".vl") : null;
  if (list) {
    const r = list.getBoundingClientRect();
    const vertical = list.classList.contains("vl-y");
    const delta = vertical ? edgeScroll(s.y, r.top, r.bottom) : edgeScroll(s.x, r.left, r.right);
    if (delta) {
      if (vertical) list.scrollTop += delta;
      else list.scrollLeft += delta;
      resolve();
    }
  }
  s.frame = requestAnimationFrame(tick);
}

function finish(drop: boolean) {
  const s = session;
  if (!s) return;
  session = null;
  cancelHook = null;
  cancelAnimationFrame(s.frame);
  clearTimeout(s.timer);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("keyup", onKey, true);
  s.target?.classList.remove("drop-target");
  s.ghost.remove();
  document.body.classList.remove("dnd-active", "dnd-copy");
  const dest = s.target?.dataset.dropPath;
  if (drop && dest) {
    const paths = dropPaths(s.paths, dest);
    if (paths.length) hooks?.transfer(paths, dest, s.copy);
  }
}
