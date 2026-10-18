import { infoApi } from "../info-api";

const BATCH = 200;
const NONE: string[] = [];

const cache = new Map<string, string[]>();
/** Paths already requested (or answered), so each is fetched once per folder. */
const asked = new Set<string>();
const listeners = new Set<() => void>();
let queue: string[] = [];
let timer: number | undefined;

function flush() {
  timer = undefined;
  const batch = queue.splice(0, BATCH);
  if (queue.length) timer = window.setTimeout(flush, 0);
  if (!batch.length) return;
  infoApi.tagsGet(batch).then((found) => {
    let changed = false;
    for (const path of batch) {
      const tags = found[path];
      if (tags?.length) {
        cache.set(path, tags);
        changed = true;
      }
    }
    if (changed) notify();
  }).catch(() => {
    // Locked or no xattr support: the items simply show no dots.
  });
}

function notify() {
  for (const fn of listeners) fn();
}

/** The tags the views show as dots: fetched lazily in batches, cached, updated on every change. */
export const tagStore = {
  /** The path's tags; unknown paths are queued for the next batch and read as untagged meanwhile. */
  get(path: string): string[] {
    if (!asked.has(path)) {
      asked.add(path);
      queue.push(path);
      timer ??= window.setTimeout(flush, 30);
    }
    return cache.get(path) ?? NONE;
  },
  /** A tag edit happened (Get Info, the tag popover). */
  set(path: string, tags: string[]) {
    asked.add(path);
    if (tags.length) cache.set(path, tags);
    else cache.delete(path);
    notify();
  },
  /** Drops everything cached; the folder on screen changed. */
  forget() {
    cache.clear();
    asked.clear();
    queue = [];
  },
  onChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};
