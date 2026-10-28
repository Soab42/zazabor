/** The note editor's text and selection at one moment. */
export interface Snapshot {
  /** A copy of the editor (its children are the text), with its text nodes merged. */
  content: HTMLElement;
  /** Where the selection starts and ends (see `positionOf`), or null when it is outside the editor. */
  selection: [number, number] | null;
}

const MAX_STEPS = 200;

/** Typing that pauses this long starts a new step. */
const PAUSE_MS = 1000;

/**
 * Undo and redo for the note editor: each step is a snapshot of how the text was before a change.
 * Typing runs together into one step until it pauses, the caret moves, a new line starts or the
 * typing turns from inserting to deleting; any other change is a step of its own.
 */
export class History {
  private undos: Snapshot[] = [];
  private redos: Snapshot[] = [];
  /** The kind of typing ("insert" or "delete") going into the last step, while it goes on. */
  private run: string | null = null;
  private timer = 0;

  /** `changed` runs whenever there comes to be something (or nothing) to undo or redo. */
  constructor(private readonly changed: () => void) {}

  get canUndo() {
    return this.undos.length > 0;
  }

  get canRedo() {
    return this.redos.length > 0;
  }

  /**
   * A change was made; `before` is how things were. Typing of the same `run` as the change before
   * goes into that change's step, unless it is `fresh` (a new line of it).
   */
  record(before: Snapshot, run: string | null = null, fresh = false) {
    if (!run || run !== this.run || fresh) {
      this.undos.push(before);
      if (this.undos.length > MAX_STEPS) this.undos.shift();
    }
    this.redos = [];
    this.endRun();
    if (run) {
      this.run = run;
      this.timer = window.setTimeout(() => (this.run = null), PAUSE_MS);
    }
    this.changed();
  }

  /** Typing from here on is a step of its own (the caret has moved). */
  endRun() {
    clearTimeout(this.timer);
    this.run = null;
  }

  /** The snapshot to go back to, or null; `now` is the one redo comes back to. */
  undo(now: Snapshot): Snapshot | null {
    return this.move(this.undos, this.redos, now);
  }

  /** The snapshot to go forward to, or null; `now` is the one undo goes back to. */
  redo(now: Snapshot): Snapshot | null {
    return this.move(this.redos, this.undos, now);
  }

  /** Forgets every step (the text was replaced from elsewhere). */
  clear() {
    this.endRun();
    this.undos = [];
    this.redos = [];
    this.changed();
  }

  private move(from: Snapshot[], to: Snapshot[], now: Snapshot): Snapshot | null {
    this.endRun();
    const step = from.pop();
    if (!step) return null;
    to.push(now);
    this.changed();
    return step;
  }
}

/** A snapshot of `root`'s text and selection. */
export function snapshot(root: HTMLElement): Snapshot {
  const content = root.cloneNode(true) as HTMLElement;
  content.normalize();
  return { content, selection: selectionIn(root) };
}

/** Whether two snapshots hold the same text (whatever the selection). */
export function sameText(a: Snapshot, b: Snapshot): boolean {
  const x = a.content.childNodes;
  const y = b.content.childNodes;
  return x.length === y.length && Array.from(x).every((node, i) => node.isEqualNode(y[i]));
}

/** Puts a snapshot's text into `root` (a copy, so the snapshot can be used again) and its selection. */
export function restore(root: HTMLElement, to: Snapshot) {
  root.replaceChildren(...Array.from((to.content.cloneNode(true) as HTMLElement).childNodes));
  if (!to.selection) return;
  const range = document.createRange();
  range.setStart(...pointAt(root, to.selection[0]));
  range.setEnd(...pointAt(root, to.selection[1]));
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
}

/** Where the selection starts and ends in `root`, or null when it isn't in it. */
export function selectionIn(root: HTMLElement): [number, number] | null {
  const selection = getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  return [positionOf(root, range.startContainer, range.startOffset), positionOf(root, range.endContainer, range.endOffset)];
}

/*
 * A position counts what comes before it in `root`: one for each character, and one for each
 * start and each end of an element. That is the same however the text is split into text nodes,
 * and tells an empty line (a <div><br></div>) from the end of the line before it.
 */

function positionOf(root: Node, container: Node, offset: number): number {
  let units = 0;
  if (container.nodeType === Node.TEXT_NODE) units += offset;
  else for (let i = 0; i < offset; i++) units += size(container.childNodes[i]);
  for (let node = container; node !== root; node = node.parentNode!) {
    if (node.nodeType === Node.ELEMENT_NODE) units += 1;
    for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) units += size(sibling);
  }
  return units;
}

/** The point `units` into `root` (its end when there aren't that many). */
function pointAt(root: Node, units: number): [Node, number] {
  let left = units;
  let parent = root;
  descend: for (;;) {
    const kids = parent.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      if (kid.nodeType === Node.TEXT_NODE) {
        const length = (kid as Text).length;
        if (left <= length) return [kid, left];
        left -= length;
        continue;
      }
      if (left === 0) return [parent, i];
      const n = size(kid);
      if (kid.nodeType === Node.ELEMENT_NODE && left < n) {
        left -= 1;
        parent = kid;
        continue descend;
      }
      left -= n;
    }
    return [parent, kids.length];
  }
}

function size(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).length;
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  let units = 2;
  for (let kid = node.firstChild; kid; kid = kid.nextSibling) units += size(kid);
  return units;
}
