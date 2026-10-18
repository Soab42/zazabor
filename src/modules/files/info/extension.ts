import { QuickLook } from "../../../shared/quicklook/quicklook";
import type { ShellContext } from "../../../shell/module";
import { isTypingTarget } from "../../../ui/dom";
import type { MenuItem } from "../../../ui/menu";
import { fsApi, type FsEntry } from "../api";
import type { BrowserContext, BrowserExtension } from "../browser";
import { InfoPanel } from "./panel";
import { closeTagPopover, openTagPopover } from "./tags";
import "./info.css";

/** The add-on the Files module registers: Quick Look (Space), Get Info (Ctrl+I) and tags. */
export interface InfoExtension extends BrowserExtension {
  dispose(): void;
}

/**
 * Builds the Quick Look / Get Info / tags extension. `host` is the positioned element the
 * overlay and inspector cover (the Files module's root).
 */
export function createInfoExtension(host: HTMLElement, shell: ShellContext): InfoExtension {
  let ctx: BrowserContext | null = null;
  let point = { x: 0, y: 0 };
  // Menu actions run without a pointer position; the click that chose the item is the best anchor.
  const track = (e: MouseEvent) => {
    point = { x: e.clientX, y: e.clientY };
  };
  document.addEventListener("click", track, true);

  const quickLook = new QuickLook({
    host,
    shell,
    items: () => ctx?.visible() ?? [],
    onShow: (item) => ctx?.select([item.path], item.path),
  });
  const info = new InfoPanel(host);

  const target = (c: BrowserContext): FsEntry | undefined => c.selected()[0] ?? c.focused() ?? undefined;
  const toggleInfo = (entry: FsEntry) => {
    if (info.isOpen && info.path === entry.path) info.close();
    else info.show(entry);
  };

  return {
    handleKey(e, c) {
      ctx = c;
      if (quickLook.isOpen) return quickLook.handleKey(e);
      const mod = e.ctrlKey || e.metaKey;
      if (isTypingTarget(e.target)) return false;
      if (e.key === " " && !mod && !e.altKey && !e.shiftKey) {
        const entry = target(c);
        if (!entry) return false;
        quickLook.open(entry);
        return true;
      }
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "i") {
        const entry = target(c);
        if (entry) toggleInfo(entry);
        return true;
      }
      if (e.key === "Escape" && info.isOpen) {
        info.close();
        return true;
      }
      return false;
    },

    itemMenu(entries, c) {
      ctx = c;
      const first = entries[0];
      return [
        { label: "Quick Look", icon: "eye", action: () => quickLook.open(first) },
        { label: "Get Info", icon: "info", action: () => info.show(first) },
        {
          label: entries.length > 1 ? `Tags (${entries.length} items)…` : "Tags…", icon: "tag",
          action: () => openTagPopover(point.x, point.y, entries.map((entry) => entry.path)),
        },
      ] satisfies MenuItem[];
    },

    emptyMenu(c) {
      ctx = c;
      return [{
        label: "Get Info", icon: "info",
        action: () => void fsApi.stat(c.folder).then((entry) => info.show(entry)).catch(() => {}),
      }];
    },

    dispose() {
      document.removeEventListener("click", track, true);
      closeTagPopover();
      quickLook.dispose();
      info.dispose();
    },
  };
}
