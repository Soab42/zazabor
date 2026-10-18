import { tagDot } from "../info/tags";
import type { FsEntry } from "../api";
import type { ViewContext } from "./types";

/** Repaints the dots in `slot`, but only when the tags differ from what it already shows. */
export function paintTags(slot: HTMLElement, tags: string[]) {
  const key = tags.join("|");
  if (slot.dataset.tags === key) return;
  slot.dataset.tags = key;
  slot.replaceChildren(...tags.slice(0, 4).map((name) => tagDot(name, 8)));
  slot.title = tags.join(", ");
}

/** Dims an item that Cut marked. */
export function paintCut(el: HTMLElement, ctx: ViewContext, path: string) {
  el.classList.toggle("cut", ctx.isCut(path));
}

/** Makes a folder item a drop target (spring-loaded in the view), and a file item not one. */
export function markDrop(el: HTMLElement, entry: FsEntry, spring: boolean) {
  if (entry.dir) {
    el.dataset.dropPath = entry.path;
    if (spring) el.dataset.spring = "open";
    else delete el.dataset.spring;
  } else {
    delete el.dataset.dropPath;
    delete el.dataset.spring;
  }
}
