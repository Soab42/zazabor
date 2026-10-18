import type { VideoSection } from "../../config";
import type { ShellContext } from "../../shell/module";
import { basename, dirname, h, stripExtension } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu } from "../../ui/menu";
import { videoApi, videoThumbUrl, type VideoFile } from "./api";
import { formatRemaining } from "./format";
import { continueWatching, isFinished, isInProgress, progressOf, sortVideos } from "./queue";

export interface SectionsHooks {
  /** Plays a file; `queue` is what to continue through. */
  play(path: string, queue?: string[]): void;
  openFile(): void;
  openFolder(): void;
  /** Removes a file from the history lists. */
  forget(path: string): void;
}

interface CardOptions {
  mtime?: number;
  subtitle?: string;
  /** 0–1 progress bar along the thumbnail. */
  progress?: number;
  dim?: boolean;
  onOpen: () => void;
  onMenu?: (x: number, y: number) => void;
}

const SECTION_TITLES: Record<VideoSection, string> = { home: "Home", videos: "Videos", recent: "Recent" };

/** The pages shown when nothing is playing: Home, Videos and Recent. */
export class Sections {
  readonly el = h("div", { class: "vp-sections" });
  private section: VideoSection = "home";
  private folder: string | null = null;
  private folderFiles: VideoFile[] = [];
  private token = 0;
  private loading = false;

  constructor(private readonly shell: ShellContext, private readonly hooks: SectionsHooks) {}

  /** The title of what is on screen, for the top bar. */
  get title(): string {
    return this.section === "videos" && this.folder ? basename(this.folder) : SECTION_TITLES[this.section];
  }

  show(section: VideoSection) {
    this.section = section;
    this.folder = null;
    this.render();
    this.el.scrollTop = 0;
  }

  /** Lists a folder's videos on the Videos page. */
  async showFolder(path: string) {
    this.section = "videos";
    this.folder = path;
    this.folderFiles = [];
    this.loading = true;
    const token = ++this.token;
    this.render();
    this.el.scrollTop = 0;
    try {
      const files = await videoApi.listVideos(path);
      if (token !== this.token) return;
      this.folderFiles = sortVideos(files, "name", true);
    } catch (err) {
      console.warn("Could not list videos:", err);
    }
    if (token !== this.token) return;
    this.loading = false;
    this.render();
  }

  render() {
    const page = this.section === "home" ? this.home() : this.section === "videos" ? (this.folder ? this.folderPage(this.folder) : this.videos()) : this.recent();
    this.el.replaceChildren(page);
  }

  // ---- pages -------------------------------------------------------------------------------

  private home(): HTMLElement {
    const { positions, recent } = this.shell.config.video;
    const watching = continueWatching(positions).slice(0, 12);
    const watchingPaths = new Set(watching.map((w) => w.path));
    const played = recent.filter((p) => !watchingPaths.has(p)).slice(0, 12);
    if (watching.length === 0 && played.length === 0) {
      return this.empty("video", "Nothing to watch yet", "Open a video to start. CorePro remembers where you stopped, so you can pick up right where you left off.", "Open a Video", () => this.hooks.openFile());
    }
    const page = h("div", { class: "vp-page" }, h("h1", null, "Home"));
    if (watching.length > 0) {
      page.append(this.group("Continue watching", watching.map(({ path, position }) => this.card(path, {
        progress: progressOf(position),
        subtitle: formatRemaining(position.time, position.length),
        onOpen: () => this.hooks.play(path),
        onMenu: (x, y) => this.cardMenu(x, y, path),
      }))));
    }
    if (played.length > 0) {
      page.append(this.group("Recently played", played.map((path) => this.recentCard(path))));
    }
    return page;
  }

  private videos(): HTMLElement {
    const folders = this.recentFolders();
    const page = h("div", { class: "vp-page" }, h("h1", null, "Videos"),
      h("div", { class: "vp-hero" },
        h("div", { class: "empty-icon" }, icon("folder", 38)),
        h("div", { class: "vp-hero-text" },
          h("h2", null, "Open a Folder"),
          h("p", null, "Browse a folder of videos and play them one after another. A library that finds your videos automatically comes later."),
        ),
        h("button", { class: "btn primary large", type: "button", onclick: () => this.hooks.openFolder() }, icon("folderPlus", 16), "Open a Folder"),
      ),
    );
    if (folders.length > 0) {
      page.append(h("section", { class: "vp-group" }, h("h3", null, "Recent folders"),
        h("div", { class: "vp-rows" }, ...folders.map((folder) => {
          const row = h("button", { class: "vp-row", type: "button", title: folder },
            icon("folder", 18), h("span", { class: "vp-row-name" }, basename(folder)), h("span", { class: "vp-row-path" }, folder));
          row.addEventListener("click", () => void this.showFolder(folder));
          return row;
        }))));
    }
    return page;
  }

  private folderPage(folder: string): HTMLElement {
    const back = h("button", { class: "icon-btn", type: "button", title: "Back to Videos", "aria-label": "Back to Videos" }, icon("chevronLeft", 18));
    back.addEventListener("click", () => this.show("videos"));
    const head = h("div", { class: "vp-folder-head" }, back, h("h1", null, basename(folder)),
      h("span", { class: "vp-count" }, `${this.folderFiles.length} ${this.folderFiles.length === 1 ? "video" : "videos"}`));
    if (this.folderFiles.length === 0) {
      return h("div", { class: "vp-page" }, head, h("p", { class: "vp-note" }, this.loading ? "" : "No videos in this folder."));
    }
    const queue = this.folderFiles.map((f) => f.path);
    const positions = this.shell.config.video.positions;
    return h("div", { class: "vp-page" }, head, h("div", { class: "vp-grid" }, ...this.folderFiles.map((file) => {
      const position = positions[file.path];
      return this.card(file.path, {
        mtime: file.mtime,
        progress: isInProgress(position) ? progressOf(position) : undefined,
        dim: isFinished(position),
        onOpen: () => this.hooks.play(file.path, queue),
      });
    })));
  }

  private recent(): HTMLElement {
    const { recent } = this.shell.config.video;
    if (recent.length === 0) {
      return this.empty("clock", "No recent videos", "Videos you play show up here so you can get back to them quickly.", "Open a Video", () => this.hooks.openFile());
    }
    return h("div", { class: "vp-page" }, h("h1", null, "Recent"), h("div", { class: "vp-grid" }, ...recent.map((path) => this.recentCard(path))));
  }

  // ---- pieces ------------------------------------------------------------------------------

  private recentFolders(): string[] {
    const folders: string[] = [];
    for (const path of this.shell.config.video.recent) {
      const folder = dirname(path);
      if (folder && !folders.includes(folder)) folders.push(folder);
      if (folders.length >= 8) break;
    }
    return folders;
  }

  private recentCard(path: string): HTMLElement {
    const position = this.shell.config.video.positions[path];
    return this.card(path, {
      progress: isInProgress(position) ? progressOf(position) : undefined,
      dim: isFinished(position),
      subtitle: basename(dirname(path)),
      onOpen: () => this.hooks.play(path),
      onMenu: (x, y) => this.cardMenu(x, y, path),
    });
  }

  private cardMenu(x: number, y: number, path: string) {
    openMenu(x, y, [
      { label: "Play", icon: "play", action: () => this.hooks.play(path) },
      "separator",
      { label: "Remove from History", icon: "close", action: () => { this.hooks.forget(path); this.render(); } },
    ]);
  }

  private group(title: string, cards: HTMLElement[]): HTMLElement {
    return h("section", { class: "vp-group" }, h("h3", null, title), h("div", { class: "vp-grid" }, ...cards));
  }

  private card(path: string, options: CardOptions): HTMLElement {
    const img = h("img", { alt: "", loading: "lazy", draggable: false, src: videoThumbUrl(path, options.mtime ?? 0, 400) });
    img.addEventListener("load", () => img.classList.add("loaded"));
    img.addEventListener("error", () => img.remove());
    const thumb = h("div", { class: "vp-card-thumb" }, h("span", { class: "vp-card-ph" }, icon("film", 26)), img,
      options.progress !== undefined ? h("div", { class: "vp-prog", style: { width: `${Math.round(options.progress * 100)}%` } }) : null);
    const name = stripExtension(basename(path));
    const card = h("button", { class: `vp-card${options.dim ? " done" : ""}`, type: "button", title: path },
      thumb, h("span", { class: "vp-card-name" }, name), options.subtitle ? h("span", { class: "vp-card-sub" }, options.subtitle) : null);
    card.addEventListener("click", options.onOpen);
    if (options.onMenu) {
      const onMenu = options.onMenu;
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      });
    }
    return card;
  }

  private empty(iconName: IconName, title: string, text: string, action: string, onAction: () => void): HTMLElement {
    return h("div", { class: "vp-empty" },
      h("div", { class: "empty-icon" }, icon(iconName, 38)),
      h("h2", null, title),
      h("p", null, text),
      h("button", { class: "btn primary large", type: "button", onclick: onAction }, action));
  }
}
