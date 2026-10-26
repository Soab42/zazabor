import type { IconName } from "../../../ui/icons";

/** One step of Photo's history: what changed, and how to take it back and do it again. */
export interface Step {
  label: string;
  icon?: IconName;
  /** Memory the step keeps (pixels from before, textures of removed layers). */
  bytes: number;
  undo(): void;
  redo(): void;
  /** The step leaves the history; `applied` says whether its change is in the document now. */
  drop?(applied: boolean): void;
}

/** At most this many steps, and this much memory, are kept; the oldest go first. */
const MAX_STEPS = 200;
const MAX_BYTES = 1024 * 1024 * 1024;

interface Entry {
  id: number;
  step: Step;
}

/**
 * Undo and redo, as Photoshop's History panel shows them: the opening state, then each step;
 * clicking one goes back (or forward) to it.
 */
export class History {
  private entries: Entry[] = [];
  /** How many entries are applied. */
  private applied = 0;
  private nextId = 1;
  /** The id of the step the document was last saved at (0: the opening state). */
  private savedId = 0;
  onChange: () => void = () => {};

  constructor(readonly baseLabel: string, private readonly baseIcon: IconName = "image") {}

  get steps(): readonly { label: string; icon: IconName }[] {
    return [{ label: this.baseLabel, icon: this.baseIcon }, ...this.entries.map((e) => ({ label: e.step.label, icon: e.step.icon ?? "phHistory" }))];
  }

  /** The step showing in the panel (0 is the opening state). */
  get position() {
    return this.applied;
  }

  get canUndo() {
    return this.applied > 0;
  }

  get canRedo() {
    return this.applied < this.entries.length;
  }

  get undoLabel() {
    return this.canUndo ? this.entries[this.applied - 1].step.label : "";
  }

  get redoLabel() {
    return this.canRedo ? this.entries[this.applied].step.label : "";
  }

  get bytes() {
    return this.entries.reduce((n, e) => n + e.step.bytes, 0);
  }

  /** Records a change that's already in the document. Steps that were undone are dropped. */
  push(step: Step) {
    for (const e of this.entries.splice(this.applied)) e.step.drop?.(false);
    this.entries.push({ id: this.nextId++, step });
    this.applied = this.entries.length;
    // The oldest steps go when there are too many or they hold too much.
    while (this.entries.length > 1 && (this.entries.length > MAX_STEPS || this.bytes > MAX_BYTES)) {
      const old = this.entries.shift()!;
      old.step.drop?.(true);
      this.applied--;
      // The saved state can no longer be reached by undoing.
      if (this.savedId === 0 || this.savedId === old.id) this.savedId = -1;
    }
    this.onChange();
  }

  /**
   * The newest step, when it's the one showing (nothing undone after it): a quick run of the same
   * change (a slider moved with the arrow keys) can fold into it instead of adding steps.
   */
  get last(): Step | null {
    return this.applied && this.applied === this.entries.length ? this.entries[this.applied - 1].step : null;
  }

  undo() {
    if (!this.canUndo) return;
    this.entries[--this.applied].step.undo();
    this.onChange();
  }

  redo() {
    if (!this.canRedo) return;
    this.entries[this.applied++].step.redo();
    this.onChange();
  }

  /** Goes back or forward to a step (0 is the opening state). */
  goTo(position: number) {
    const target = Math.max(0, Math.min(this.entries.length, position));
    if (target === this.applied) return;
    while (this.applied > target) this.entries[--this.applied].step.undo();
    while (this.applied < target) this.entries[this.applied++].step.redo();
    this.onChange();
  }

  private get currentId() {
    return this.applied ? this.entries[this.applied - 1].id : 0;
  }

  markSaved() {
    this.savedId = this.currentId;
    this.onChange();
  }

  /** The document differs from its file from the start (Quick Edit's settings were applied). */
  markUnsaved() {
    this.savedId = -1;
    this.onChange();
  }

  get dirty() {
    return this.currentId !== this.savedId;
  }

  /** Drops every step, e.g. when the document closes. */
  clear() {
    this.entries.forEach((e, i) => e.step.drop?.(i < this.applied));
    this.entries = [];
    this.applied = 0;
  }
}
