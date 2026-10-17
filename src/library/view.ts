import type { Config } from "../config";
import { saveConfig } from "../config";
import type { SlideshowScope } from "../slideshow/setup";
import { formatDate, h } from "../ui/dom";
import { icon } from "../ui/icons";
import { AlbumGrid } from "./albums";
import { Grid } from "./grid";
import type { Group, Library, Photo, SortMode } from "./model";
import { Sidebar } from "./sidebar";
import type { ThumbLoader } from "./thumbs";

export interface LibraryViewHandlers {
  open(photo: Photo, list: Photo[]): void;
  slideshow(scopes: SlideshowScope[]): void;
  addFolder(): void;
  /** Re-checks identity before private (hidden) albums are shown. */
  authorizePrivate(): Promise<boolean>;
  lockSettings(): void;
  lockNow(): void;
}

type Mode = { kind: "albums" } | { kind: "photos" } | { kind: "album"; path: string };

/** The gallery: albums found on this computer, each album's photos, and all photos at once. */
export class LibraryView {
  readonly el = h("div", { class: "library" });
  readonly grid: Grid;
  private albums: AlbumGrid;
  private sidebar: Sidebar;
  private mode: Mode;
  private groups: Group[] = [];
  private title = h("h1", { class: "lib-title" });
  private subtitle = h("div", { class: "lib-subtitle" });
  private back = h("button", { class: "icon-btn", title: "Back to albums (Backspace)" }, icon("back"));
  private lockButton = h("button", { class: "icon-btn", title: "Lock now (Ctrl+L)", hidden: true }, icon("lock"));
  private search = h("input", { class: "search-input", type: "search", placeholder: "Search albums and photos", spellcheck: false });
  private sortButtons = new Map<SortMode, HTMLButtonElement>();
  private status = h("span", { class: "status-text" });
  private empty = h("div", { class: "empty-state" });
  private filterTimer: number | undefined;

  constructor(
    private readonly library: Library,
    private readonly config: Config,
    thumbs: ThumbLoader,
    private readonly handlers: LibraryViewHandlers,
  ) {
    this.mode = config.libraryView === "photos" ? { kind: "photos" } : { kind: "albums" };
    this.sidebar = new Sidebar({
      navigate: (target) => this.setMode({ kind: target }),
      selectGroup: (index) => {
        const group = this.groups[index];
        if (!group) return;
        if (this.mode.kind === "photos") this.grid.scrollToGroup(index);
        else this.openAlbum(group.folder.path);
      },
      addFolder: () => handlers.addFolder(),
      toggleHidden: async () => {
        if (library.showHidden) library.setShowHidden(false);
        else if (await handlers.authorizePrivate()) library.setShowHidden(true);
      },
      lockSettings: () => handlers.lockSettings(),
    });

    this.grid = new Grid(thumbs, config.thumbSize, {
      open: (photo, group) => handlers.open(photo, group.photos),
      playGroup: (group) => handlers.slideshow([this.groupScope(group, 0)]),
      selectionChanged: () => this.updateStatus(),
      activeGroupChanged: (index) => {
        if (this.mode.kind === "photos") this.sidebar.setActive(index);
      },
    });

    this.albums = new AlbumGrid(thumbs, {
      open: (group) => this.openAlbum(group.folder.path),
      play: (group) => handlers.slideshow([this.groupScope(group, 0)]),
      setHidden: (group, hidden) => {
        library.setHidden(group.folder.path, hidden);
        config.hiddenAlbums = [...library.hidden];
        saveConfig(config);
      },
    });
    this.albums.setCardSize(this.cardSize());

    this.search.addEventListener("input", () => {
      clearTimeout(this.filterTimer);
      this.filterTimer = window.setTimeout(() => this.refresh(), 120);
    });
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.search.value = "";
        this.refresh();
        this.focusContent();
      } else if (e.key === "Enter" || e.key === "ArrowDown") {
        e.preventDefault();
        this.focusContent();
      }
    });
    this.back.addEventListener("click", () => this.setMode({ kind: "albums" }));
    this.lockButton.addEventListener("click", () => handlers.lockNow());

    const sort = h("div", { class: "segmented", title: "Sort" });
    for (const [mode, label] of [["date", "Recent"], ["name", "Name"]] as const) {
      const button = h("button", { onclick: () => this.setSort(mode) }, label);
      this.sortButtons.set(mode, button);
      sort.append(button);
    }

    const topbar = h(
      "header",
      { class: "topbar" },
      this.back,
      h("div", { class: "lib-heading" }, this.title, this.subtitle),
      h("label", { class: "search" }, icon("search", 16), this.search),
      sort,
      h("button", { class: "icon-btn", title: "Look for new photos", onclick: () => library.rescan() }, icon("refresh")),
      this.lockButton,
      h("button", { class: "btn primary", title: "Play slideshow (F5)", onclick: () => this.playSlideshow() }, icon("play", 15), "Slideshow"),
    );

    const slider = h("input", {
      type: "range", class: "size-slider", min: 96, max: 320, step: 8, value: String(config.thumbSize), title: "Thumbnail size",
    });
    slider.addEventListener("input", () => {
      config.thumbSize = Number(slider.value);
      this.grid.setCellSize(config.thumbSize);
      this.albums.setCardSize(this.cardSize());
      saveConfig(config);
    });

    const statusbar = h(
      "footer",
      { class: "statusbar" },
      this.status,
      h("div", { class: "spacer" }),
      h("span", { class: "slider-icon small" }, icon("image", 13)),
      slider,
      h("span", { class: "slider-icon" }, icon("image", 18)),
    );

    const main = h("main", { class: "lib-main" }, topbar, h("div", { class: "grid-wrap" }, this.grid.el, this.albums.el, this.empty), statusbar);
    this.el.append(this.sidebar.el, main);
    this.updateSortButtons();
    library.onChange(() => this.refresh());
  }

  setLockEnabled(enabled: boolean) {
    this.lockButton.hidden = !enabled;
  }

  refresh() {
    this.groups = this.library.groups(this.search.value);
    const mode = this.mode;
    if (mode.kind === "album" && !this.library.folders.some((f) => f.path === mode.path)) this.mode = { kind: "albums" };

    const shown = this.shownGroups();
    this.albums.el.hidden = this.mode.kind !== "albums";
    this.grid.el.hidden = this.mode.kind === "albums";
    if (this.mode.kind === "albums") this.albums.setGroups(shown, this.library.hidden);
    else this.grid.setGroups(shown);

    this.sidebar.update(this.groups, this.library.hidden.size, this.library.showHidden, this.library.hidden);
    this.sidebar.setNav(this.mode.kind === "album" ? null : this.mode.kind);
    if (this.mode.kind === "album") {
      const path = this.mode.path;
      this.sidebar.setActive(this.groups.findIndex((g) => g.folder.path === path));
    } else if (this.mode.kind === "albums") {
      this.sidebar.setActive(-1);
    }
    this.updateHeading();
    this.updateEmptyState(shown);
    this.updateStatus();
  }

  /** Called when returning from the viewer or a slideshow. */
  reveal(photo: Photo) {
    if (this.mode.kind !== "albums") this.grid.reveal(photo.path);
    this.focusContent();
  }

  focusContent() {
    if (this.mode.kind === "albums") this.albums.focusFirst();
    else this.grid.el.focus();
  }

  handleKey(e: KeyboardEvent): boolean {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      this.search.focus();
      this.search.select();
      return true;
    }
    if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) {
      this.playSlideshow();
      return true;
    }
    if (this.mode.kind !== "albums" && this.grid.handleKey(e)) return true;
    if (this.mode.kind === "album" && (e.key === "Backspace" || e.key === "Escape")) {
      this.setMode({ kind: "albums" });
      return true;
    }
    return false;
  }

  /** Offers the most specific scope first: the selection, the current album, then everything. */
  playSlideshow() {
    const scopes: SlideshowScope[] = [];
    const selected = this.mode.kind === "albums" ? [] : this.grid.selectedPhotos();
    if (selected.length > 1) {
      const sameFolder = selected.every((p) => p.folder === selected[0].folder);
      scopes.push({ label: "Selected photos", title: sameFolder ? selected[0].folder.label : "Selected photos", photos: selected, start: 0 });
    }
    const focused = this.mode.kind === "albums" ? undefined : this.grid.focusedPhoto;
    const group = focused ? this.grid.groupOf(focused)
      : this.mode.kind === "album" ? this.shownGroups()[0]
      : this.mode.kind === "photos" ? this.groups[this.grid.activeGroupIndex] : undefined;
    if (group) scopes.push(this.groupScope(group, focused ? Math.max(0, group.photos.indexOf(focused)) : 0));
    const all = this.groups.flatMap((g) => g.photos);
    if (all.length && !(this.groups.length === 1 && group)) {
      scopes.push({ label: "All photos", title: "All photos", photos: all, start: 0 });
    }
    if (scopes.length) this.handlers.slideshow(scopes);
  }

  private shownGroups(): Group[] {
    const mode = this.mode;
    return mode.kind === "album" ? this.groups.filter((g) => g.folder.path === mode.path) : this.groups;
  }

  private openAlbum(path: string) {
    this.setMode({ kind: "album", path });
  }

  private setMode(mode: Mode) {
    const changed = JSON.stringify(mode) !== JSON.stringify(this.mode);
    this.mode = mode;
    if (mode.kind !== "album") {
      this.config.libraryView = mode.kind;
      saveConfig(this.config);
    }
    if (changed) {
      this.grid.selection.clear();
      this.grid.focus = null;
    }
    this.refresh();
    if (changed) {
      this.grid.el.scrollTop = 0;
      this.albums.el.scrollTop = 0;
    }
    this.focusContent();
  }

  private groupScope(group: Group, start: number): SlideshowScope {
    return { label: `Album “${group.folder.label}”`, title: group.folder.label, photos: group.photos, start };
  }

  private cardSize() {
    return Math.round(this.config.thumbSize * 1.15);
  }

  private setSort(mode: SortMode) {
    this.config.sort = mode;
    saveConfig(this.config);
    this.library.setSort(mode);
    this.updateSortButtons();
  }

  private updateSortButtons() {
    for (const [mode, button] of this.sortButtons) button.classList.toggle("active", mode === this.library.sort);
  }

  private updateHeading() {
    const mode = this.mode;
    this.back.hidden = mode.kind !== "album";
    if (mode.kind === "album") {
      const folder = this.library.folders.find((f) => f.path === mode.path);
      this.title.textContent = folder?.label ?? "";
      this.subtitle.textContent = folder ? `${folder.photos.length.toLocaleString()} photos  ·  ${formatDate(folder.earliest)}${folder.earliest && formatDate(folder.earliest) !== formatDate(folder.latest) ? ` – ${formatDate(folder.latest)}` : ""}` : "";
      this.subtitle.title = mode.path;
    } else {
      this.title.textContent = mode.kind === "albums" ? "Albums" : "All photos";
      this.subtitle.textContent = this.library.discovering ? "Looking for photos on this computer…" : "Found automatically on this computer";
      this.subtitle.title = "";
    }
  }

  private updateStatus() {
    const photos = this.groups.reduce((sum, g) => sum + g.photos.length, 0);
    const parts = [`${photos.toLocaleString()} ${photos === 1 ? "photo" : "photos"} in ${this.groups.length.toLocaleString()} ${this.groups.length === 1 ? "album" : "albums"}`];
    if (this.mode.kind !== "albums") {
      const selected = this.grid.selection.size;
      if (selected > 1) parts.push(`${selected.toLocaleString()} selected`);
      else if (selected === 1 && this.grid.focusedPhoto) parts.push(this.grid.focusedPhoto.name);
    }
    if (this.library.scanning.size) parts.push("Looking for photos…");
    this.status.textContent = parts.join("   ·   ");
  }

  private updateEmptyState(shown: Group[]) {
    this.empty.replaceChildren();
    this.empty.hidden = shown.length > 0;
    if (shown.length) return;
    if (this.search.value.trim()) {
      this.empty.append(h("h2", null, "No matches"), h("p", { class: "muted" }, `Nothing matches “${this.search.value.trim()}”.`));
    } else if (this.library.scanning.size) {
      this.empty.append(
        h("div", { class: "spinner large" }),
        h("h2", null, "Looking for photos…"),
        h("p", { class: "muted" }, "SliderPro is searching your home folder and connected drives. Albums appear here automatically."),
      );
    } else {
      this.empty.append(
        h("div", { class: "empty-icon" }, icon("image", 44)),
        h("h2", null, "No photos found"),
        h("p", null, "SliderPro looked through your home folder and connected drives, skipping app data and code projects. If your photos live somewhere else, add that folder."),
        h("button", { class: "btn primary large", onclick: () => this.handlers.addFolder() }, icon("folderPlus", 18), "Add a folder"),
      );
    }
  }
}
