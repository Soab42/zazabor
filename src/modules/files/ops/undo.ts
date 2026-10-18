import type { UndoOp } from "../ops-api";

/** One step the user can undo: a readable label and the backend records that reverse it. */
export interface UndoEntry {
  label: string;
  ops: UndoOp[];
}

const LIMIT = 50;

/** Session-only undo/redo history. Redo records replace undo ones as they are applied. */
export class UndoStack {
  private undoable: UndoEntry[] = [];
  private redoable: UndoEntry[] = [];

  /** Records a finished operation; a new operation clears what could be redone. */
  push(entry: UndoEntry) {
    if (!entry.ops.length) return;
    this.undoable.push(entry);
    if (this.undoable.length > LIMIT) this.undoable.shift();
    this.redoable = [];
  }

  peekUndo(): UndoEntry | undefined {
    return this.undoable[this.undoable.length - 1];
  }

  peekRedo(): UndoEntry | undefined {
    return this.redoable[this.redoable.length - 1];
  }

  /** The undone entry moves to the redo side with the records the backend returned. */
  undone(ops: UndoOp[]) {
    const entry = this.undoable.pop();
    if (entry && ops.length) this.redoable.push({ label: entry.label, ops });
  }

  redone(ops: UndoOp[]) {
    const entry = this.redoable.pop();
    if (entry && ops.length) this.undoable.push({ label: entry.label, ops });
  }
}
