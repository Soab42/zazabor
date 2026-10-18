import type { ShellContext } from "../../../shell/module";
import { basename, dirname } from "../../../ui/dom";
import type { MenuItem } from "../../../ui/menu";
import type { FsEntry } from "../api";
import type { BrowserContext, BrowserExtension } from "../browser";
import { showToast } from "../ops/toast";
import { JobTracker } from "../ops/tracker";
import { inTrash } from "../ops/paths";
import { isExtractable, toolsApi } from "../tools-api";
import { closeOpenWith, openOpenWith } from "./openwith";
import "./tools.css";

export interface ToolsExtension extends BrowserExtension {
  dispose(): void;
}

const message = (err: unknown) => String(err instanceof Error ? err.message : err).replace(/^Error: /, "");

/**
 * Compress and Extract Here (as jobs on the shared `fs-job` channel), Open With… and Open Terminal
 * Here (Ctrl+Alt+T). The backend does the work (`tools-api.ts`); this decides what to ask for.
 */
export function createToolsExtension(shell: ShellContext): ToolsExtension {
  const tracker = new JobTracker();
  // Menu actions have no pointer position of their own; the click that chose the item is the anchor.
  let point = { x: 120, y: 120 };
  const track = (e: MouseEvent) => {
    point = { x: e.clientX, y: e.clientY };
  };
  document.addEventListener("click", track, true);

  const fail = (err: unknown) => {
    const text = message(err);
    if (text !== "locked") showToast(text, undefined, 7000);
  };

  /** Selects what a job created, once the live refresh has listed it. */
  const reveal = (ctx: BrowserContext, dir: string, paths: string[]) => {
    if (dir !== ctx.folder) return;
    ctx.select(paths);
    window.setTimeout(() => ctx.select(paths), 350);
  };

  const compress = async (ctx: BrowserContext, entries: FsEntry[]) => {
    if (!entries.length) return;
    const dest = dirname(entries[0].path);
    try {
      const id = await toolsApi.compress(entries.map((e) => e.path), dest);
      const event = await tracker.whenDone(id);
      if (event.state === "failed") {
        showToast(event.error ?? "That didn’t work.", undefined, 7000);
      } else if (event.state === "done" && event.results.length) {
        showToast(`Created “${basename(event.results[0])}”`);
        reveal(ctx, dest, event.results);
      }
    } catch (err) {
      fail(err);
    }
  };

  const extract = async (ctx: BrowserContext, entries: FsEntry[]) => {
    const created: string[] = [];
    let dest = "";
    for (const entry of entries) {
      dest = dirname(entry.path);
      try {
        const id = await toolsApi.extract(entry.path, dest);
        const event = await tracker.whenDone(id);
        if (event.state === "failed") showToast(event.error ?? "That didn’t work.", undefined, 7000);
        else if (event.state === "done") created.push(...event.results);
        else if (event.state === "cancelled") break;
      } catch (err) {
        fail(err);
        break;
      }
    }
    if (created.length) {
      showToast(created.length === 1 ? `Extracted to “${basename(created[0])}”` : `Extracted ${created.length} archives`);
      reveal(ctx, dest, created);
    }
  };

  const terminal = (dir: string) => {
    toolsApi.openTerminal(dir, shell.config.files.terminal).catch(fail);
  };

  return {
    handleKey(e, ctx) {
      if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "t") {
        terminal(ctx.folder);
        return true;
      }
      return false;
    },

    itemMenu(entries, ctx): MenuItem[] {
      if (!entries.length) return [];
      const items: MenuItem[] = [];
      const only = entries.length === 1 ? entries[0] : null;
      if (only && !only.dir) {
        items.push({
          label: "Open With…", icon: "external",
          action: () => openOpenWith(point.x, point.y, { path: only.path, ext: only.ext, onError: fail }),
        });
      }
      if (!inTrash(ctx.folder)) {
        items.push({
          label: only ? `Compress “${only.name.length > 28 ? `${only.name.slice(0, 27)}…` : only.name}”` : `Compress ${entries.length} Items`,
          icon: "fileArchive", action: () => void compress(ctx, entries),
        });
      }
      if (entries.every((e) => !e.dir && isExtractable(e.name))) {
        items.push({ label: only ? "Extract Here" : `Extract ${entries.length} Archives Here`, icon: "download", action: () => void extract(ctx, entries) });
      }
      if (only?.dir) items.push({ label: "Open Terminal Here", icon: "terminal", action: () => terminal(only.path) });
      return items;
    },

    emptyMenu(ctx): MenuItem[] {
      return [{ label: "Open Terminal Here", icon: "terminal", action: () => terminal(ctx.folder) }];
    },

    dispose() {
      document.removeEventListener("click", track, true);
      closeOpenWith();
      tracker.dispose();
    },
  };
}
