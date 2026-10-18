import type { ShellContext } from "../../shell/module";
import { dirname, h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { openMenu } from "../../ui/menu";
import { CompactLibrary } from "./features/library/compact";
import { QueueDock, QueueView } from "./features/library/queue-view";
import { Library } from "./features/library/store";
import type { Player } from "./player";

export { trail } from "./features/library/compact";

export interface VideoSidebarHooks {
  /** Plays a file with `queue` as the list to continue through. */
  play(path: string, queue: string[]): void;
  openFolder(): void;
}

type Tab = "queue" | "library";

/**
 * The sidebar while playing: the queue (what plays next, drag to reorder, remove) and a compact
 * library to drag items into it without stopping playback.
 */
export class VideoSidebar {
  readonly el = h("aside", { class: "vp-sidebar" });
  private readonly library: CompactLibrary;
  private readonly queue: QueueView;
  private readonly dock: QueueDock;
  private readonly tabsEl = h("div", { class: "segmented lib-side-tabs", role: "tablist" });
  private readonly queuePane = h("div", { class: "lib-pane" });
  private readonly libraryPane = h("div", { class: "lib-pane" });
  private tab: Tab = "queue";

  constructor(shell: ShellContext, private readonly hooks: VideoSidebarHooks, private readonly player: Player) {
    const lib = Library.of(shell, player);
    this.library = new CompactLibrary(lib, hooks);
    this.queue = new QueueView(lib, player);
    this.dock = new QueueDock(lib, player, () => this.setTab("queue"));
    this.queuePane.append(this.queue.el);
    this.libraryPane.append(this.library.el, this.dock.el);

    const more = h("button", { class: "icon-btn small", type: "button", title: "More", "aria-label": "More" }, icon("more", 16));
    more.addEventListener("click", () => {
      const r = more.getBoundingClientRect();
      openMenu(r.left, r.bottom + 4, [
        { label: "Open Folder…", icon: "folder", action: () => this.hooks.openFolder() },
        { label: "Rescan Library", icon: "refresh", action: () => { lib.ensureVideos(true); lib.ensureMusic(true); } },
      ]);
    });
    this.el.append(h("div", { class: "lib-side-head" }, this.tabsEl, more), this.queuePane, this.libraryPane);
    player.subscribe(() => this.queue.sync());
    this.setTab("queue");
  }

  private setTab(tab: Tab) {
    this.tab = tab;
    this.tabsEl.replaceChildren(...(["queue", "library"] as const).map((id) => {
      const b = h("button", { type: "button", role: "tab", class: id === tab ? "active" : "", "aria-selected": String(id === tab) },
        icon(id === "queue" ? "playlist" : "folder", 14), h("span", null, id === "queue" ? "Queue" : "Library"));
      b.addEventListener("click", () => this.setTab(id));
      return b;
    }));
    this.queuePane.hidden = tab !== "queue";
    this.libraryPane.hidden = tab !== "library";
    if (tab === "queue") this.queue.render();
    else this.library.render(true);
  }

  /** Reveals a folder in the Library tab. Called when the playing file changes (its folder, kept quiet) or by "Open Folder". */
  async browse(folder: string) {
    const automatic = folder === dirname(this.player.current ?? "");
    this.library.browse(folder, !automatic);
    if (!automatic) this.setTab("library");
  }

  get browsing(): string {
    return this.library.browsing;
  }

  /** Highlights the playing file. */
  setCurrent(path: string | null) {
    this.library.setCurrent(path);
    this.queue.render(true);
  }

  /** Redraws progress bars and names after resume points changed. */
  refresh() {
    this.library.render(true);
    this.queue.render(true);
  }

  get activeTab(): Tab {
    return this.tab;
  }

  dispose() {
    this.queue.dispose();
    this.dock.dispose();
  }
}
