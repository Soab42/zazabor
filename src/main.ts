import "./styles.css";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { api, forwardLogsToTerminal } from "./api";
import { applyAppearance, openAppearanceDialog } from "./appearance";
import { askForAccess, lockApi, openLockSettings, type LockStatus } from "./lock";
import { loadConfig, saveConfig, type Config } from "./config";
import { Library, makeFolder } from "./modules/gallery/library/model";
import { ThumbLoader } from "./shared/thumbs";
import { LibraryView } from "./modules/gallery/library/view";
import { Player } from "./modules/gallery/slideshow/player";
import { openSetupDialog, type SlideshowScope } from "./modules/gallery/slideshow/setup";
import { dirname, isTypingTarget } from "./ui/dom";
import { Viewer } from "./modules/gallery/viewer/viewer";

forwardLogsToTerminal();

class App {
  private library = new Library();
  private thumbs = new ThumbLoader(10);
  private libraryView: LibraryView;
  private viewer: Viewer;
  private player: Player | null = null;
  private choosingSlideshow = false;
  private lock: LockStatus = { mode: "off", locked: false, systemAvailable: false };
  private locking = false;
  private idleTimer = 0;

  constructor(private readonly config: Config) {
    this.library.sort = config.sort;
    this.libraryView = new LibraryView(this.library, config, this.thumbs, {
      open: (photo, list) => this.viewer.open(list, Math.max(0, list.indexOf(photo))),
      slideshow: (scopes) => this.startSlideshow(scopes),
      addFolder: () => this.chooseFolder(),
      authorizePrivate: async () =>
        this.lock.mode === "off" || askForAccess(this.lock.mode, "confirm", "Hidden albums are private."),
      lockSettings: () => this.openLockSettings(),
      appearance: () => openAppearanceDialog(this.config.appearance, () => this.appearanceChanged()),
      lockNow: () => this.lockApp(),
    });
    this.viewer = new Viewer(config, this.thumbs, {
      close: (photo) => {
        if (photo) this.libraryView.reveal(photo);
        else this.libraryView.focusContent();
      },
      slideshow: (scopes) => this.startSlideshow(scopes),
    });
    document.getElementById("app")!.append(this.libraryView.el, this.viewer.el);
    this.applyAppearance();
    // "System" follows the desktop's light or dark setting as it changes.
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (this.config.appearance.mode === "system") this.applyAppearance();
    });
    window.addEventListener("keydown", (e) => this.onKey(e));
    // WebKitGTK reports mouse back/forward buttons only as mouse events, with button 3 and 4.
    window.addEventListener("mouseup", (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      this.onMouseNavigate(e.button === 3 ? -1 : 1);
    });
  }

  async init() {
    this.lock = await lockApi.status().catch(() => this.lock);
    this.libraryView.setLockEnabled(this.lock.mode !== "off");
    if (this.lock.locked) {
      document.body.classList.add("app-locked");
      await askForAccess(this.lock.mode, "unlock");
      document.body.classList.remove("app-locked");
    }
    for (const type of ["pointermove", "pointerdown", "keydown", "wheel"]) {
      window.addEventListener(type, () => this.resetIdleTimer(), { passive: true, capture: true });
    }
    this.resetIdleTimer();
    this.libraryView.refresh();
    this.setupDragDrop().catch((err) => console.warn("Drag and drop unavailable:", err));
    await Promise.all([this.library.load(this.config.roots, this.config.hiddenAlbums, this.config.favoriteAlbums), this.openLaunchPath()]);
  }

  private applyAppearance() {
    const appearance = this.config.appearance;
    applyAppearance(appearance);
    this.libraryView.grid.setLayout(appearance.layout, appearance.gap);
    this.viewer.setZoomCurve(appearance.zoomCurve);
    this.viewer.themeChanged();
  }

  private appearanceChanged() {
    this.applyAppearance();
    saveConfig(this.config);
  }

  private onMouseNavigate(direction: 1 | -1) {
    if (document.body.classList.contains("app-locked")) return;
    if (this.player) this.player.skipBy(direction);
    else if (this.viewer.isOpen) this.viewer.stepBy(direction);
    else if (direction < 0) this.libraryView.navigateBack();
  }

  private onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l" && this.lock.mode !== "off") {
      e.preventDefault();
      void this.lockApp();
      return;
    }
    if (this.player) {
      if (this.player.handleKey(e)) e.preventDefault();
      return;
    }
    if (isTypingTarget(e.target)) return;
    const handled = this.viewer.isOpen ? this.viewer.handleKey(e) : this.libraryView.handleKey(e);
    if (handled) e.preventDefault();
  }

  /** Hides everything and blocks the backend until the user unlocks again. */
  private async lockApp() {
    if (this.lock.mode === "off" || this.locking) return;
    this.locking = true;
    await lockApi.lockNow();
    document.body.classList.add("app-locked");
    if (this.player) await this.player.exit();
    if (this.viewer.isOpen) await this.viewer.close();
    this.library.setShowHidden(false);
    await askForAccess(this.lock.mode, "unlock");
    document.body.classList.remove("app-locked");
    this.locking = false;
    this.resetIdleTimer();
  }

  private resetIdleTimer() {
    clearTimeout(this.idleTimer);
    const minutes = this.config.autoLockMinutes;
    if (this.lock.mode === "off" || !minutes || this.locking) return;
    this.idleTimer = window.setTimeout(() => {
      // Never interrupt a slideshow someone is watching.
      if (this.player) this.resetIdleTimer();
      else void this.lockApp();
    }, minutes * 60_000);
  }

  private async openLockSettings() {
    const result = await openLockSettings(this.lock, this.config.autoLockMinutes);
    if (!result) return;
    this.lock = result.status;
    this.config.autoLockMinutes = result.autoLockMinutes;
    saveConfig(this.config);
    this.libraryView.setLockEnabled(this.lock.mode !== "off");
    this.resetIdleTimer();
  }

  private async chooseFolder() {
    const dir = await open({ directory: true, multiple: false, title: "Add a folder to your library" });
    if (typeof dir === "string") await this.addRoot(dir);
  }

  private async addRoot(dir: string) {
    const scanned = this.library.addRoot(dir);
    this.config.roots = [...this.library.roots];
    saveConfig(this.config);
    await scanned;
  }

  /** Opens a single photo with its siblings, as for "Open with SliderPro" or a dropped file. */
  private async openFile(path: string) {
    const dir = dirname(path);
    const scans = await api.scanFolder(dir, false);
    const scan = scans.find((s) => s.path === dir) ?? scans[0];
    if (!scan) return;
    const folder = makeFolder(scan, dir, this.library.sort);
    const index = folder.photos.findIndex((p) => p.path === path);
    this.viewer.open(folder.photos, Math.max(0, index));
  }

  private async openLaunchPath() {
    const path = await api.launchPath().catch(() => null);
    if (!path) return;
    const kind = await api.pathKind(path);
    if (kind === "dir") await this.addRoot(path);
    else if (kind === "image") await this.openFile(path);
  }

  private async setupDragDrop() {
    await getCurrentWebview().onDragDropEvent(async (event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        document.body.classList.add("dropping");
        return;
      }
      document.body.classList.remove("dropping");
      if (payload.type !== "drop") return;
      for (const path of payload.paths) {
        const kind = await api.pathKind(path);
        if (kind === "dir") await this.addRoot(path);
        else if (kind === "image" && payload.paths.length === 1) await this.openFile(path);
      }
    });
  }

  private async startSlideshow(scopes: SlideshowScope[]) {
    if (this.player || this.choosingSlideshow) return;
    this.choosingSlideshow = true;
    const scope = await openSetupDialog(scopes, this.config.slideshow, () => saveConfig(this.config));
    this.choosingSlideshow = false;
    if (!scope?.photos.length) return;
    this.player = new Player({
      scope,
      settings: this.config.slideshow,
      saveSettings: () => saveConfig(this.config),
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

loadConfig()
  .then((config) => new App(config).init())
  .catch((err) => console.error("SliderPro failed to start:", err));
