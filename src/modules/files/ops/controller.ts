import { basename, dirname } from "../../../ui/dom";
import type { MenuItem } from "../../../ui/menu";
import type { FsEntry } from "../api";
import type { BrowserContext, BrowserExtension } from "../browser";
import { opsApi, type JobEvent, type JobKind, type UndoOp } from "../ops-api";
import { samePath } from "../path";
import { doneTitle, jobTitle } from "./format";
import { cutSet } from "./cutset";
import { atTrashRoot, inTrash, pasteTarget, singleTarget } from "./paths";
import { JobsPanel } from "./panel";
import { confirmSheet, conflictSheet, nameSheet, type ConflictSheet } from "./sheets";
import { showToast } from "./toast";
import { JobTracker } from "./tracker";
import { UndoStack } from "./undo";

/** The app's own clipboard: what Copy or Cut collected, and whether Paste moves it. */
interface Clip {
  paths: string[];
  cut: boolean;
}

interface JobOptions {
  paths: string[];
  dest?: string;
  /** Select the resulting items that landed in the folder being shown. */
  select?: boolean;
  /** Label for the undo toast; omit to skip recording. */
  undoLabel?: string;
}

/**
 * File operations as a browser extension: clipboard, trash, rename, new folder, duplicate and
 * undo/redo, with a jobs panel for the long ones. The backend does the work (`ops-api.ts`);
 * this class only decides what to ask for and shows the result.
 */
export class FileOps implements BrowserExtension {
  private clip: Clip | null = null;
  private readonly tracker = new JobTracker();
  private readonly panel = new JobsPanel((id) => void opsApi.cancel(id).catch(() => {}));
  private readonly undo = new UndoStack();
  private ctx: BrowserContext | null = null;
  private busyUndo = false;
  private sheets: Promise<void> = Promise.resolve();
  private waiting = new Map<number, ConflictSheet | null>();

  /** `host` is the Files module's root element; the jobs panel docks inside it. */
  constructor(host: HTMLElement) {
    host.append(this.panel.el);
    this.tracker.watch((event) => this.onEvent(event));
  }

  // ---- extension hooks --------------------------------------------------------------------------

  handleKey(e: KeyboardEvent, ctx: BrowserContext): boolean {
    this.ctx = ctx;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    const key = e.key.toLowerCase();
    if (mod) {
      if (!e.shiftKey) {
        if (key === "c") return this.run(() => this.copy(ctx, false));
        if (key === "x") return this.run(() => this.copy(ctx, true));
        if (key === "v") return this.run(() => this.paste(ctx, pasteTarget(ctx)));
        if (key === "d") return this.run(() => this.duplicate(ctx));
        if (key === "z") return this.run(() => this.undoRedo(false));
        if (key === "y") return this.run(() => this.undoRedo(true));
      } else {
        if (key === "n") return this.run(() => this.newFolder(ctx));
        if (key === "z") return this.run(() => this.undoRedo(true));
      }
      return false;
    }
    if (e.altKey) return false;
    if (e.key === "F2") return this.run(() => this.rename(ctx));
    if (e.key === "Delete") {
      const entries = ctx.selected();
      if (!entries.length) return false;
      const permanent = e.shiftKey || inTrash(ctx.folder);
      return this.run(() => (permanent ? this.deletePermanently(ctx, entries) : this.trash(ctx, entries)));
    }
    return false;
  }

  itemMenu(entries: FsEntry[], ctx: BrowserContext): MenuItem[] {
    this.ctx = ctx;
    if (inTrash(ctx.folder)) {
      const root = atTrashRoot(ctx.folder);
      return [
        ...(root ? [{ label: "Put Back", icon: "back", action: () => void this.restore(ctx, entries) } satisfies MenuItem] : []),
        { label: "Copy", icon: "copy", shortcut: "Ctrl+C", action: () => this.copy(ctx, false, entries) },
        ...(root ? [{ label: "Delete Permanently", icon: "trash", danger: true, shortcut: "Shift+Delete", action: () => void this.deletePermanently(ctx, entries) } satisfies MenuItem] : []),
      ];
    }
    const target = entries.length === 1 && entries[0].dir ? entries[0].path : ctx.folder;
    return [
      { label: "Cut", icon: "cut", shortcut: "Ctrl+X", action: () => this.copy(ctx, true, entries) },
      { label: "Copy", icon: "copy", shortcut: "Ctrl+C", action: () => this.copy(ctx, false, entries) },
      { label: "Paste", icon: "paste", shortcut: "Ctrl+V", disabled: !this.clip, action: () => void this.paste(ctx, target) },
      "separator",
      { label: "Duplicate", icon: "copy", shortcut: "Ctrl+D", action: () => void this.duplicate(ctx, entries) },
      ...(entries.length === 1
        ? [{ label: "Rename…", icon: "pencil", shortcut: "F2", action: () => void this.renameEntry(ctx, entries[0]) } satisfies MenuItem]
        : []),
      { label: "Move to Trash", icon: "trash", shortcut: "Delete", action: () => void this.trash(ctx, entries) },
    ];
  }

  emptyMenu(ctx: BrowserContext): MenuItem[] {
    this.ctx = ctx;
    if (inTrash(ctx.folder)) {
      return atTrashRoot(ctx.folder)
        ? [{ label: "Empty Trash", icon: "trash", danger: true, disabled: ctx.visible().length === 0, action: () => void this.emptyTrash() }]
        : [];
    }
    return [
      { label: "New Folder", icon: "folderPlus", shortcut: "Ctrl+Shift+N", action: () => void this.newFolder(ctx) },
      { label: "Paste", icon: "paste", shortcut: "Ctrl+V", disabled: !this.clip, action: () => void this.paste(ctx, ctx.folder) },
    ];
  }

  dispose() {
    this.tracker.dispose();
    this.panel.dispose();
  }

  private run(fn: () => unknown): true {
    void fn();
    return true;
  }

  // ---- clipboard ------------------------------------------------------------------------------------

  private copy(ctx: BrowserContext, cut: boolean, entries = ctx.selected()) {
    if (!entries.length) return;
    if (cut && inTrash(ctx.folder)) return;
    const paths = entries.map((e) => e.path);
    this.setClip({ paths, cut });
    void navigator.clipboard?.writeText(paths.join("\n")).catch(() => {});
    showToast(`${cut ? "Cut" : "Copied"} ${paths.length === 1 ? `“${basename(paths[0])}”` : `${paths.length} items`}`, undefined, 1800);
  }

  private async paste(ctx: BrowserContext, dest: string) {
    const clip = this.clip;
    if (!clip) return;
    if (inTrash(dest)) {
      showToast("Items can’t be pasted into the Trash. Use Move to Trash instead.");
      return;
    }
    const cut = clip.cut;
    const moving = clip.paths.filter((p) => !(cut && samePath(dirname(p), dest)));
    if (!moving.length) {
      this.setClip(null);
      return;
    }
    const kind: JobKind = cut ? "move" : "copy";
    const done = await this.job(ctx, kind, () => (cut ? opsApi.move(clip.paths, dest) : opsApi.copy(clip.paths, dest)), {
      paths: clip.paths, dest, select: true,
      undoLabel: doneTitle(kind, clip.paths, dest),
    });
    if (cut && done && done.state !== "cancelled") this.setClip(null);
  }

  /** Every change of the clipboard goes through here so views can dim cut items. */
  private setClip(clip: Clip | null) {
    this.clip = clip;
    cutSet.set(clip?.cut ? clip.paths : []);
  }

  // ---- drag and drop ----------------------------------------------------------------------------------

  /** Moves (or copies) dragged items into a folder as a regular job: panel, conflicts and undo. */
  transfer(paths: string[], dest: string, copy: boolean, ctx: BrowserContext): boolean {
    this.ctx = ctx;
    if (inTrash(dest)) {
      showToast("Items can’t be dropped into the Trash. Use Move to Trash instead.");
      return true;
    }
    const moving = copy ? paths : paths.filter((p) => !samePath(dirname(p), dest));
    if (!moving.length) return true;
    const kind: JobKind = copy ? "copy" : "move";
    void this.job(ctx, kind, () => (copy ? opsApi.copy(moving, dest) : opsApi.move(moving, dest)), {
      paths: moving, dest, select: true, undoLabel: doneTitle(kind, moving, dest),
    });
    return true;
  }

  // ---- jobs -----------------------------------------------------------------------------------------

  /** Starts a backend job, follows it in the panel and finishes with selection, undo and a toast. */
  private async job(ctx: BrowserContext, kind: JobKind, start: () => Promise<number>, options: JobOptions): Promise<JobEvent | null> {
    let id: number;
    try {
      id = await start();
    } catch (err) {
      this.fail(err);
      return null;
    }
    this.panel.setTitle(id, jobTitle(kind, options.paths, options.dest));
    const final = await this.tracker.whenDone(id);
    ctx.refresh();
    const here = final.results.filter((p) => samePath(dirname(p), ctx.folder));
    if (options.select && here.length) this.selectLater(ctx, here);
    if (final.undo.length && options.undoLabel) {
      this.undo.push({ label: options.undoLabel, ops: final.undo });
      if (final.state === "done") this.announce(options.undoLabel);
    }
    return final;
  }

  private onEvent(event: JobEvent) {
    this.panel.update(event);
    if (event.state === "waiting" && event.conflict) {
      this.waiting.set(event.id, null);
      const conflict = event.conflict;
      this.sheets = this.sheets.then(() => this.askConflict(event.id, conflict));
    } else if (this.waiting.has(event.id)) {
      this.waiting.get(event.id)?.dismiss();
      this.waiting.delete(event.id);
    }
  }

  private async askConflict(id: number, conflict: NonNullable<JobEvent["conflict"]>) {
    if (!this.waiting.has(id)) return;
    const sheet = conflictSheet(conflict);
    this.waiting.set(id, sheet);
    const answer = await sheet.answer;
    if (!this.waiting.has(id)) return;
    this.waiting.delete(id);
    try {
      if (answer === "cancel") await opsApi.cancel(id);
      else await opsApi.resolve(id, answer.decision, answer.applyToAll);
    } catch {
      // The job ended in the meantime; its final event says how.
    }
  }

  /** Select again once the live refresh had time to list new items. */
  private selectLater(ctx: BrowserContext, paths: string[]) {
    ctx.select(paths);
    window.setTimeout(() => ctx.select(paths), 350);
  }

  private announce(label: string) {
    showToast(label, { label: "Undo", run: () => void this.undoRedo(false) });
  }

  private fail(err: unknown) {
    const message = String(err instanceof Error ? err.message : err);
    if (message !== "locked") showToast(message, undefined, 7000);
  }

  // ---- trash and delete -------------------------------------------------------------------------

  private async trash(ctx: BrowserContext, entries: FsEntry[]) {
    if (!entries.length) return;
    const paths = entries.map((e) => e.path);
    if (ctx.shell.config.files.confirmTrash) {
      const ok = await confirmSheet({
        title: paths.length === 1 ? `Move “${basename(paths[0])}” to the Trash?` : `Move ${paths.length} items to the Trash?`,
        message: "You can put them back from the Trash.",
        confirmLabel: "Move to Trash",
      });
      if (!ok) return;
    }
    await this.job(ctx, "trash", () => opsApi.trash(paths), { paths, undoLabel: doneTitle("trash", paths) });
  }

  private async restore(ctx: BrowserContext, entries: FsEntry[]) {
    const paths = entries.map((e) => e.path);
    const final = await this.job(ctx, "move", () => opsApi.restore(paths), {
      paths, undoLabel: `Put back ${paths.length === 1 ? `“${basename(paths[0])}”` : `${paths.length} items`}`,
    });
    if (final?.state === "failed" && final.error) this.fail(final.error);
  }

  private async deletePermanently(ctx: BrowserContext, entries: FsEntry[]) {
    if (!entries.length) return;
    const paths = entries.map((e) => e.path);
    const what = paths.length === 1 ? `“${basename(paths[0])}”` : `${paths.length} items`;
    const ok = await confirmSheet({
      title: `Delete ${what} permanently?`,
      message: "This can’t be undone. The items won’t go to the Trash.",
      confirmLabel: "Delete Permanently",
      destructive: true,
    });
    if (ok) await this.job(ctx, "delete", () => opsApi.delete(paths), { paths });
  }

  private async emptyTrash() {
    const ctx = this.ctx;
    if (!ctx) return;
    const ok = await confirmSheet({
      title: "Empty the Trash?",
      message: "Everything in the Trash is deleted permanently. This can’t be undone.",
      confirmLabel: "Empty Trash",
      destructive: true,
    });
    if (ok) await this.job(ctx, "delete", () => opsApi.emptyTrash(), { paths: ctx.visible().map((e) => e.path) });
  }

  // ---- rename, new folder, duplicate ------------------------------------------------------------

  private rename(ctx: BrowserContext) {
    const entry = singleTarget(ctx);
    if (entry && !inTrash(ctx.folder)) return this.renameEntry(ctx, entry);
  }

  private async renameEntry(ctx: BrowserContext, entry: { path: string; name: string; dir: boolean }) {
    const taken = new Set(ctx.visible().map((e) => e.name));
    taken.delete(entry.name);
    let renamed = entry.path;
    const ok = await nameSheet({
      title: `Rename “${entry.name}”`,
      name: entry.name,
      isDir: entry.dir,
      submitLabel: "Rename",
      taken,
      apply: async (name) => {
        renamed = await opsApi.rename(entry.path, name);
      },
    });
    if (!ok || renamed === entry.path) return;
    this.undo.push({ label: `Renamed “${entry.name}” to “${basename(renamed)}”`, ops: [{ op: "move", from: entry.path, to: renamed }] });
    ctx.refresh();
    this.selectLater(ctx, [renamed]);
  }

  private async newFolder(ctx: BrowserContext) {
    if (inTrash(ctx.folder)) return;
    let path: string;
    try {
      path = await opsApi.newFolder(ctx.folder, "untitled folder");
    } catch (err) {
      this.fail(err);
      return;
    }
    ctx.refresh();
    this.selectLater(ctx, [path]);
    // Name it right away; the undo record is made once the final name is known.
    let final = path;
    await nameSheet({
      title: "Name the new folder",
      name: basename(path),
      isDir: true,
      submitLabel: "Done",
      taken: new Set(ctx.visible().map((e) => e.name).filter((n) => n !== basename(path))),
      apply: async (name) => {
        final = await opsApi.rename(path, name);
      },
    });
    this.undo.push({ label: `Created folder “${basename(final)}”`, ops: [{ op: "created", path: final }] });
    if (final !== path) {
      ctx.refresh();
      this.selectLater(ctx, [final]);
    }
  }

  private async duplicate(ctx: BrowserContext, entries = ctx.selected()) {
    if (!entries.length || inTrash(ctx.folder)) return;
    let made: string[];
    try {
      made = await opsApi.duplicate(entries.map((e) => e.path));
    } catch (err) {
      this.fail(err);
      return;
    }
    const ops: UndoOp[] = made.map((path) => ({ op: "created", path }));
    const label = `Duplicated ${made.length === 1 ? `“${basename(entries[0].path)}”` : `${made.length} items`}`;
    this.undo.push({ label, ops });
    ctx.refresh();
    this.selectLater(ctx, made.filter((p) => samePath(dirname(p), ctx.folder)));
    this.announce(label);
  }

  // ---- undo and redo ----------------------------------------------------------------------------

  private async undoRedo(redo: boolean) {
    const ctx = this.ctx;
    const entry = redo ? this.undo.peekRedo() : this.undo.peekUndo();
    if (!ctx || this.busyUndo) return;
    if (!entry) {
      showToast(redo ? "Nothing to redo" : "Nothing to undo", undefined, 1500);
      return;
    }
    this.busyUndo = true;
    try {
      const report = await opsApi.undo(entry.ops);
      if (redo) this.undo.redone(report.ops);
      else this.undo.undone(report.ops);
      ctx.refresh();
      const here = report.ops.flatMap(resultPaths).filter((p) => samePath(dirname(p), ctx.folder));
      if (here.length) this.selectLater(ctx, here);
      const verb = redo ? "Redid" : "Undid";
      if (report.errors.length) {
        showToast(`${verb} only part of “${entry.label}”: ${report.errors[0]}`, undefined, 7000);
      } else {
        const other = redo ? this.undo.peekUndo() : this.undo.peekRedo();
        showToast(`${verb}: ${entry.label}`, other ? { label: redo ? "Undo" : "Redo", run: () => void this.undoRedo(!redo) } : undefined);
      }
    } catch (err) {
      this.fail(err);
    } finally {
      this.busyUndo = false;
    }
  }
}

/** Where an undo record left its item (to select it afterwards). */
function resultPaths(op: UndoOp): string[] {
  if (op.op === "move") return [op.to];
  if (op.op === "created") return [op.path];
  return [];
}
