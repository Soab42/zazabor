import { newSel, type Sel } from "./selection";
import { samePath } from "./path";

let nextId = 1;

/** One browsing context: where it is, how it got there, and what was selected and scrolled. */
export class Tab {
  readonly id = nextId++;
  path: string;
  private history: string[];
  private pos = 0;
  sel: Sel = newSel();
  scroll = 0;

  constructor(path: string) {
    this.path = path;
    this.history = path ? [path] : [];
  }

  get canBack() {
    return this.pos > 0;
  }

  get canForward() {
    return this.pos < this.history.length - 1;
  }

  /** Records a visit to `path` (dropping any forward history) and resets the per-folder state. */
  visit(path: string) {
    if (this.path && samePath(this.path, path)) return;
    this.history = this.history.slice(0, this.pos + 1);
    this.history.push(path);
    this.pos = this.history.length - 1;
    this.setPath(path);
  }

  /** Steps through history; returns the new path, or null at either end. */
  step(delta: -1 | 1): string | null {
    const to = this.pos + delta;
    if (to < 0 || to >= this.history.length) return null;
    this.pos = to;
    this.setPath(this.history[to]);
    return this.path;
  }

  private setPath(path: string) {
    this.path = path;
    this.sel = newSel();
    this.scroll = 0;
  }

  /** A copy that starts at the same folder with its own history. */
  fork(): Tab {
    return new Tab(this.path);
  }
}
