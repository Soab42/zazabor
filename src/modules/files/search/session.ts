import type { UnlistenFn } from "@tauri-apps/api/event";
import type { FsEntry } from "../api";
import type { FilesSettings } from "../../../config";
import { entryComparator } from "../sort";
import { onSearch, toolsApi, type SearchEvent, type SearchOptions } from "../tools-api";

/** How long typing must pause before a recursive search starts. */
export const SEARCH_DEBOUNCE_MS = 150;

interface Hit {
  entry: FsEntry;
  score: number;
}

/**
 * One recursive search at a time: starting another cancels the running one. Results stream in
 * from `fs-search`; events that arrive before `fs_search` has answered with its id are held back.
 */
export class SearchSession {
  private hits = new Map<string, Hit>();
  private id: number | null = null;
  private token = 0;
  private held: SearchEvent[] = [];
  private unlisten: UnlistenFn | null = null;
  private disposed = false;
  scanned = 0;
  /** A search was started and has not reported its end yet. */
  running = false;
  truncated = false;
  failed: string | null = null;

  constructor(private readonly onUpdate: () => void) {
    void onSearch((event) => this.handle(event)).then((fn) => {
      if (this.disposed) fn();
      else this.unlisten = fn;
    }, () => {});
  }

  get count() {
    return this.hits.size;
  }

  /** Cancels any running search and starts a new one. */
  start(root: string, query: string, options: SearchOptions) {
    this.cancelRunning();
    this.hits = new Map();
    this.held = [];
    this.scanned = 0;
    this.truncated = false;
    this.failed = null;
    this.running = true;
    const token = ++this.token;
    toolsApi.search(root, query, options).then(
      (id) => {
        if (token !== this.token || this.disposed) {
          void toolsApi.searchCancel(id).catch(() => {});
          return;
        }
        this.id = id;
        const held = this.held;
        this.held = [];
        for (const event of held) if (event.id === id) this.apply(event);
      },
      (err) => {
        if (token !== this.token) return;
        this.running = false;
        this.failed = String(err instanceof Error ? err.message : err);
        this.onUpdate();
      },
    );
    this.onUpdate();
  }

  /** Cancels the running search and forgets its results. */
  stop() {
    this.cancelRunning();
    this.token++;
    this.hits = new Map();
    this.held = [];
    this.running = false;
    this.failed = null;
  }

  private cancelRunning() {
    if (this.id !== null) void toolsApi.searchCancel(this.id).catch(() => {});
    this.id = null;
  }

  private handle(event: SearchEvent) {
    if (this.id === null) {
      // Not known yet: keep it only while a search is waiting for its id.
      if (this.running) this.held.push(event);
      return;
    }
    if (event.id === this.id) this.apply(event);
  }

  private apply(event: SearchEvent) {
    event.results.forEach((entry, i) => this.hits.set(entry.path, { entry, score: event.scores[i] ?? 0 }));
    this.scanned = event.scanned;
    if (event.done) {
      this.running = false;
      this.truncated = event.truncated;
    }
    this.onUpdate();
  }

  /** Results best match first, or in the chosen column order. */
  entries(sort: FilesSettings["sort"] | null): FsEntry[] {
    const hits = [...this.hits.values()];
    if (sort) return hits.map((h) => h.entry).sort(entryComparator(sort, false));
    return hits
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name, undefined, { numeric: true, sensitivity: "base" }))
      .map((h) => h.entry);
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.unlisten?.();
    this.unlisten = null;
  }
}
