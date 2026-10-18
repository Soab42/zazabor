import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../../api";
import { saveConfig } from "../../config";
import type { AppModule, ModuleFactory, OpenRequest, ShellContext } from "../../shell/module";
import { dirname, h, isTypingTarget } from "../../ui/dom";
import type { IconName } from "../../ui/icons";
import { Library, makeFolder } from "./library/model";
import { LibraryView } from "./library/view";
import { Player } from "./slideshow/player";
import { openSetupDialog, type SlideshowScope } from "./slideshow/setup";
import { ThumbLoader } from "../../shared/thumbs";
import { Viewer } from "./viewer/viewer";

/** Albums, the deep-zoom viewer and slideshows: SliderPro's gallery, as a CorePro module. */
class GalleryModule implements AppModule {
  readonly id = "gallery" as const;
  readonly title = "Gallery";
  readonly icon: IconName = "image";
  readonly el = h("div", { class: "gallery-module" });

  private library = new Library();
  private thumbs = new ThumbLoader(10);
  private libraryView: LibraryView;
  private viewer: Viewer;
  private player: Player | null = null;
  private choosingSlideshow = false;
  private active = false;
  private disposed = false;
  private readonly onMouseUp = (e: MouseEvent) => {
    // WebKitGTK reports mouse back/forward buttons only as mouse events, with button 3 and 4.
    if (!this.active || (e.button !== 3 && e.button !== 4)) return;
    e.preventDefault();
    this.onMouseNavigate(e.button === 3 ? -1 : 1);
  };

  constructor(private readonly shell: ShellContext) {
    const config = shell.config;
    this.library.sort = config.sort;
    this.libraryView = new LibraryView(this.library, config, this.thumbs, {
      open: (photo, list) => this.viewer.open(list, Math.max(0, list.indexOf(photo))),
      slideshow: (scopes) => this.startSlideshow(scopes),
      addFolder: () => this.chooseFolder(),
      authorizePrivate: () => shell.lock.authorize("Hidden albums are private."),
      lockSettings: () => shell.lock.openSettings(),
      lockNow: () => shell.lock.lockNow(),
    });
    this.viewer = new Viewer(config, this.thumbs, {
      close: (photo) => {
        if (photo) this.libraryView.reveal(photo);
        else this.libraryView.focusContent();
      },
      slideshow: (scopes) => this.startSlideshow(scopes),
    });
    this.el.append(this.libraryView.el, this.viewer.el);
    this.appearanceChanged();
    this.libraryView.setLockEnabled(shell.lock.enabled);
    this.libraryView.refresh();
    window.addEventListener("mouseup", this.onMouseUp);
    void this.library.load(config.roots, config.hiddenAlbums, config.favoriteAlbums);
  }

  get modal() {
    return this.player !== null;
  }

  activate() {
    this.active = true;
    if (!this.viewer.isOpen) this.libraryView.focusContent();
  }

  deactivate() {
    this.active = false;
  }

  appearanceChanged() {
    const appearance = this.shell.config.appearance;
    this.libraryView.grid.setLayout(appearance.layout, appearance.gap);
    this.viewer.setZoomCurve(appearance.zoomCurve);
    this.viewer.themeChanged();
  }

  configChanged() {
    this.libraryView.syncConfig();
  }

  lockChanged(enabled: boolean) {
    this.libraryView.setLockEnabled(enabled);
  }

  /** Nothing private stays on screen while the app is locked. */
  async onLock() {
    if (this.player) await this.player.exit();
    if (this.viewer.isOpen) await this.viewer.close();
    this.library.setShowHidden(false);
  }

  handleKey(e: KeyboardEvent): boolean {
    if (this.player) {
      this.player.handleKey(e);
      return true;
    }
    if (isTypingTarget(e.target)) return false;
    return this.viewer.isOpen ? this.viewer.handleKey(e) : this.libraryView.handleKey(e);
  }

  open(request: OpenRequest) {
    if (request.kind === "folder") void this.addRoot(request.path);
    else if (request.kind === "image") void this.openFile(request.path);
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener("mouseup", this.onMouseUp);
    void this.onLock();
    this.el.remove();
  }

  private onMouseNavigate(direction: 1 | -1) {
    if (document.body.classList.contains("app-locked")) return;
    if (this.player) this.player.skipBy(direction);
    else if (this.viewer.isOpen) this.viewer.stepBy(direction);
    else if (direction < 0) this.libraryView.navigateBack();
  }

  private async chooseFolder() {
    const dir = await open({ directory: true, multiple: false, title: "Add a folder to your library" });
    if (typeof dir === "string") await this.addRoot(dir);
  }

  private async addRoot(dir: string) {
    const config = this.shell.config;
    const scanned = this.library.addRoot(dir);
    config.roots = [...this.library.roots];
    saveConfig(config);
    await scanned;
  }

  /** Opens a single photo with its siblings, as for "Open with CorePro" or a dropped file. */
  private async openFile(path: string) {
    const dir = dirname(path);
    const scans = await api.scanFolder(dir, false);
    const scan = scans.find((s) => s.path === dir) ?? scans[0];
    if (!scan || this.disposed) return;
    const folder = makeFolder(scan, dir, this.library.sort);
    const index = folder.photos.findIndex((p) => p.path === path);
    this.viewer.open(folder.photos, Math.max(0, index));
  }

  private async startSlideshow(scopes: SlideshowScope[]) {
    const config = this.shell.config;
    if (this.player || this.choosingSlideshow) return;
    this.choosingSlideshow = true;
    const scope = await openSetupDialog(scopes, config.slideshow, () => saveConfig(config));
    this.choosingSlideshow = false;
    if (!scope?.photos.length) return;
    this.player = new Player({
      scope,
      settings: config.slideshow,
      saveSettings: () => saveConfig(config),
      onExit: (photo) => {
        this.player = null;
        if (!photo) return;
        if (this.viewer.isOpen) this.viewer.goTo(photo);
        else this.libraryView.reveal(photo);
      },
    });
    await this.player.start();
  }
}

/** Creates the Gallery module. */
export const createGalleryModule: ModuleFactory = (shell) => new GalleryModule(shell);
