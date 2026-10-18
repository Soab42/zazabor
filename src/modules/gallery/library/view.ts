import type { Config } from "../../../config";
import { saveConfig } from "../../../config";
import type { SlideshowScope } from "../slideshow/setup";
import { formatDate, h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { openMenu, type MenuItem } from "../../../ui/menu";
import { AlbumGrid } from "./albums";
import { Grid } from "./grid";
import type { Group, Library, Photo, SortMode } from "./model";
import { Sidebar } from "./sidebar";
import type { ThumbLoader } from "../../../shared/thumbs";

export interface LibraryViewHandlers {
  open(photo: Photo, list: Photo[]): void;
  slideshow(scopes: SlideshowScope[]): void;
  addFolder(): void;
  /** Re-checks identity before private (hidden) albums are shown. */
  authorizePrivate(): Promise<boolean>;
  lockSettings(): void;
  appearance(): void;
  lockNow(): void;
}

type Mode = { kind: "albums" } | { kind: "favorites" } | { kind: "photos" } | { kind: "album"; path: string };

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
  private favoriteButton = h("button", { class: "icon-btn album-fav-btn" });
  private hideButton = h("button", { class: "icon-btn" });
  private selectButton = h("button", { class: "btn ghost", title: "Select albums to favorite or hide several at once" }, icon("checkSquare", 16), "Select");
  private selectionBar = h("div", { class: "selection-bar", hidden: true });
  private selectionCount = h("span", { class: "selection-count" });
  private unhideButton = h("button", { class: "btn" }, icon("eye", 15), "Unhide");
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
    this.mode = { kind: config.libraryView };
    this.sidebar = new Sidebar({
      navigate: (target) => this.setMode({ kind: target }),
      selectGroup: (index) => {
        const group = this.groups[index];
        if (!group) return;
        if (this.mode.kind === "photos") this.grid.scrollToGroup(index);
        else this.openAlbum(group.folder.path);
      },
      toggleFavorite: (index) => {
        const group = this.groups[index];
        if (group) this.setFavorite([group.folder.path], !library.favorites.has(group.folder.path));
      },
      menu: (index, x, y) => {
        const group = this.groups[index];
        if (group) this.albumMenu(group, x, y);
      },
      addFolder: () => handlers.addFolder(),
      toggleHidden: async () => {
        if (library.showHidden) library.setShowHidden(false);
        else if (await handlers.authorizePrivate()) library.setShowHidden(true);
      },
      lockSettings: () => handlers.lockSettings(),
      appearance: () => handlers.appearance(),
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
      setHidden: (group, hidden) => this.setHidden([group.folder.path], hidden),
      setFavorite: (group, favorite) => this.setFavorite([group.folder.path], favorite),
      menu: (group, x, y) => this.albumMenu(group, x, y),
      selectionChanged: () => this.updateSelectionBar(),
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
    this.favoriteButton.addEventListener("click", () => {
      const path = this.currentAlbumPath();
      if (path) this.setFavorite([path], !library.favorites.has(path));
    });
    this.hideButton.addEventListener("click", () => {
      const path = this.currentAlbumPath();
      if (path) this.setHidden([path], !library.hidden.has(path));
    });
    this.selectButton.addEventListener("click", () => this.albums.setSelecting(!this.albums.isSelecting));
    this.buildSelectionBar();
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
      this.favoriteButton,
      this.hideButton,
      this.selectButton,
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

    const main = h("main", { class: "lib-main" }, topbar, h("div", { class: "grid-wrap" }, this.grid.el, this.albums.el, this.empty, this.selectionBar), statusbar);
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
    const albumGrid = this.showsAlbumGrid;
    this.albums.el.hidden = !albumGrid;
    this.grid.el.hidden = albumGrid;
    if (albumGrid) {
      this.albums.setGroups(shown, { hidden: this.library.hidden, favorites: this.library.favorites, sections: this.mode.kind === "albums" });
    } else {
      if (this.albums.isSelecting) this.albums.setSelecting(false);
      this.grid.setGroups(shown);
    }

    this.sidebar.update(this.groups, { hidden: this.library.hidden, favorites: this.library.favorites, showingHidden: this.library.showHidden });
    this.sidebar.setNav(this.mode.kind === "album" ? null : this.mode.kind);
    if (this.mode.kind === "album") {
      const path = this.mode.path;
      this.sidebar.setActive(this.groups.findIndex((g) => g.folder.path === path));
    } else if (albumGrid) {
      this.sidebar.setActive(-1);
    }
    this.selectButton.hidden = !albumGrid || !shown.length;
    this.updateSelectionBar();
    this.updateHeading();
    this.updateEmptyState(shown);
    this.updateStatus();
  }

  /** Called when returning from the viewer or a slideshow. */
  reveal(photo: Photo) {
    if (!this.showsAlbumGrid) this.grid.reveal(photo.path);
    this.focusContent();
  }

  focusContent() {
    if (this.showsAlbumGrid) this.albums.focusFirst();
    else this.grid.el.focus();
  }

  private get showsAlbumGrid() {
    return this.mode.kind === "albums" || this.mode.kind === "favorites";
  }

  private currentAlbumPath() {
    return this.mode.kind === "album" ? this.mode.path : null;
  }

  private setFavorite(paths: string[], favorite: boolean) {
    this.library.setFavorite(paths, favorite);
    this.config.favoriteAlbums = [...this.library.favorites];
    saveConfig(this.config);
  }

  private setHidden(paths: string[], hidden: boolean) {
    this.library.setHidden(paths, hidden);
    this.config.hiddenAlbums = [...this.library.hidden];
    saveConfig(this.config);
  }

  private albumMenu(group: Group, x: number, y: number) {
    const path = group.folder.path;
    const favorite = this.library.favorites.has(path);
    const hidden = this.library.hidden.has(path);
    const items: MenuItem[] = [
      { label: "Open", icon: "image", action: () => this.openAlbum(path) },
      { label: "Play slideshow", icon: "play", action: () => this.handlers.slideshow([this.groupScope(group, 0)]) },
      "separator",
      favorite
        ? { label: "Remove from favorites", icon: "star", action: () => this.setFavorite([path], false) }
        : { label: "Add to favorites", icon: "starFilled", action: () => this.setFavorite([path], true) },
      hidden
        ? { label: "Show this album again", icon: "eye", action: () => this.setHidden([path], false) }
        : { label: "Hide this album", icon: "eyeOff", action: () => this.setHidden([path], true) },
    ];
    if (this.showsAlbumGrid) {
      items.push("separator", { label: "Select albums…", icon: "checkSquare", action: () => this.albums.setSelecting(true, [path]) });
    }
    openMenu(x, y, items);
  }

  private buildSelectionBar() {
    const apply = (fn: (paths: string[]) => void) => () => {
      const paths = [...this.albums.selected];
      if (!paths.length) return;
      fn(paths);
      this.albums.setSelecting(false);
    };
    this.unhideButton.addEventListener("click", apply((paths) => this.setHidden(paths, false)));
    this.selectionBar.append(
      this.selectionCount,
      h("button", { class: "btn ghost", onclick: () => this.albums.selectAll() }, "Select all"),
      h("div", { class: "selection-sep" }),
      h("button", { class: "btn", onclick: apply((paths) => this.setFavorite(paths, true)) }, icon("starFilled", 15), "Favorite"),
      h("button", { class: "btn", onclick: apply((paths) => this.setFavorite(paths, false)) }, icon("star", 15), "Unfavorite"),
      h("button", { class: "btn", onclick: apply((paths) => this.setHidden(paths, true)) }, icon("eyeOff", 15), "Hide"),
      this.unhideButton,
      h("button", { class: "btn primary", onclick: () => this.albums.setSelecting(false) }, "Done"),
    );
  }

  private updateSelectionBar() {
    const selecting = this.albums.isSelecting && this.showsAlbumGrid;
    this.selectionBar.hidden = !selecting;
    this.selectButton.classList.toggle("active", selecting);
    if (!selecting) return;
    const count = this.albums.selected.size;
    this.selectionCount.textContent = count ? `${count.toLocaleString()} selected` : "Click albums to select them";
    this.unhideButton.hidden = ![...this.albums.selected].some((p) => this.library.hidden.has(p));
    for (const button of this.selectionBar.querySelectorAll<HTMLButtonElement>(".btn:not(.primary):not(.ghost)")) button.disabled = !count;
  }

  /** Mouse back button: leave an album page for the album list. */
  navigateBack() {
    if (this.mode.kind === "album") this.setMode({ kind: "albums" });
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
    if (this.albums.isSelecting && this.showsAlbumGrid) {
      if (e.key === "Escape") {
        this.albums.setSelecting(false);
        return true;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        this.albums.selectAll();
        return true;
      }
    }
    if (!this.showsAlbumGrid && this.grid.handleKey(e)) return true;
    if (this.mode.kind === "album" && (e.key === "Backspace" || e.key === "Escape")) {
      this.setMode({ kind: "albums" });
      return true;
    }
    return false;
  }

  /** Offers the most specific scope first: the selection, the current album, then everything. */
  playSlideshow() {
    const scopes: SlideshowScope[] = [];
    const selected = this.showsAlbumGrid ? [] : this.grid.selectedPhotos();
    if (selected.length > 1) {
      const sameFolder = selected.every((p) => p.folder === selected[0].folder);
      scopes.push({ label: "Selected photos", title: sameFolder ? selected[0].folder.label : "Selected photos", photos: selected, start: 0 });
    }
    const focused = this.showsAlbumGrid ? undefined : this.grid.focusedPhoto;
    const group = focused ? this.grid.groupOf(focused)
      : this.mode.kind === "album" ? this.shownGroups()[0]
      : this.mode.kind === "photos" ? this.groups[this.grid.activeGroupIndex] : undefined;
    if (group) scopes.push(this.groupScope(group, focused ? Math.max(0, group.photos.indexOf(focused)) : 0));
    if (this.mode.kind === "favorites" && !group) {
      const favorites = this.shownGroups().flatMap((g) => g.photos);
      if (favorites.length) scopes.push({ label: "Favorite albums", title: "Favorites", photos: favorites, start: 0 });
    }
    const all = this.groups.flatMap((g) => g.photos);
    if (all.length && !(this.groups.length === 1 && group)) {
      scopes.push({ label: "All photos", title: "All photos", photos: all, start: 0 });
    }
    if (scopes.length) this.handlers.slideshow(scopes);
  }

  private shownGroups(): Group[] {
    const mode = this.mode;
    if (mode.kind === "album") return this.groups.filter((g) => g.folder.path === mode.path);
    if (mode.kind === "favorites") return this.groups.filter((g) => this.library.favorites.has(g.folder.path));
    return this.groups;
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
      if (this.albums.isSelecting) this.albums.setSelecting(false);
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
    this.favoriteButton.hidden = this.hideButton.hidden = mode.kind !== "album";
    if (mode.kind === "album") {
      const favorite = this.library.favorites.has(mode.path);
      const hidden = this.library.hidden.has(mode.path);
      this.favoriteButton.replaceChildren(icon(favorite ? "starFilled" : "star"));
      this.favoriteButton.title = favorite ? "Remove from favorites" : "Add to favorites";
      this.favoriteButton.classList.toggle("active", favorite);
      this.hideButton.replaceChildren(icon(hidden ? "eye" : "eyeOff"));
      this.hideButton.title = hidden ? "Show this album again" : "Hide this album";
    }
    if (mode.kind === "album") {
      const folder = this.library.folders.find((f) => f.path === mode.path);
      this.title.textContent = folder?.label ?? "";
      this.subtitle.textContent = folder ? `${folder.photos.length.toLocaleString()} photos  ·  ${formatDate(folder.earliest)}${folder.earliest && formatDate(folder.earliest) !== formatDate(folder.latest) ? ` – ${formatDate(folder.latest)}` : ""}` : "";
      this.subtitle.title = mode.path;
    } else {
      this.title.textContent = mode.kind === "albums" ? "Albums" : mode.kind === "favorites" ? "Favorites" : "All photos";
      this.subtitle.textContent = this.library.discovering ? "Looking for photos on this computer…"
        : mode.kind === "favorites" ? "Your starred albums"
        : "Found automatically · right-click an album for options";
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
    } else if (this.mode.kind === "favorites" && this.groups.length) {
      this.empty.append(
        h("div", { class: "empty-icon" }, icon("star", 44)),
        h("h2", null, "No favorites yet"),
        h("p", null, "Star the albums you care about to keep them here, in a clean list of their own. Hover an album and click ☆, right-click it, or use Select on the Albums page to star several at once."),
        h("button", { class: "btn primary large", onclick: () => this.setMode({ kind: "albums" }) }, icon("grid", 17), "Go to albums"),
      );
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
