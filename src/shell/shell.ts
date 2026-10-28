import "./shell.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "../api";
import { applyAppearance } from "../appearance";
import { isKeptAwake } from "../shared/awake";
import { adoptConfig, CONFIG_SAVED, parseConfig, saveConfig, type Config } from "../config";
import { askForAccess, dismissUnlockPrompt, lockApi, openLockSettings, type LockStatus } from "../lock";
import { h, isTypingTarget } from "../ui/dom";
import { MODULE_IDS, type AppModule, type ModuleId, type OpenRequest, type ShellContext, type ShellLock } from "./module";
import { Onboarding } from "./onboarding";
import { Rail } from "./rail";
import { MODULES } from "./registry";
import { kindOf } from "../modules/office/api";
import { studioProjectKind } from "../modules/studio/app";
import { classifyPath } from "./router";
import { Settings } from "./settings";
import { articleFor, Guide } from "../guide";
import { isTerminalTarget } from "../terminal/target";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { closeThisWindow, isFileWindow, isMainWindow, onOthers, openWindow, tellOthers, windowStart } from "./windows";
import { startUpdateChecks } from "./updates";

/** Activity in one window resets the auto-lock in the others, at most this often. */
const ACTIVITY_EVERY_MS = 20_000;
const ACTIVITY = "app-activity";

/**
 * The app around the modules: the rail, the workspace, Settings and the first-run wizard, plus
 * everything that belongs to the whole window (privacy lock, key and drop routing, appearance).
 */
export class Shell implements ShellContext {
  private rail = new Rail({
    select: (id) => this.showModule(id),
    settings: () => this.toggleSettings(),
    help: () => this.toggleGuide(),
    openWindow: (id) => this.openModuleWindow(id),
  });
  private guide: Guide;
  private workspace = h("main", { class: "workspace" });
  private settings: Settings;
  private modules = new Map<ModuleId, AppModule>();
  private loading = new Map<ModuleId, Promise<AppModule | null>>();
  private active: ModuleId | null = null;
  private onboarding: Onboarding | null = null;
  private lockStatus: LockStatus = { mode: "off", locked: false, systemAvailable: false };
  private locking = false;
  private idleTimer = 0;
  private lastActivityTold = 0;
  /** Stops the rail-dot watchers of the modules that have one, by module. */
  private statusWatchers = new Map<ModuleId, () => void>();

  readonly lock: ShellLock = this.makeLock();

  constructor(readonly config: Config) {
    this.guide = new Guide({
      config,
      saveConfig: () => this.saveConfig(),
      openTarget: (module, target) => void this.openFromGuide(module, target),
      enabled: (module) => this.config.features[module],
      close: () => this.closeGuide(),
    });
    this.settings = new Settings({
      config,
      appearanceChanged: () => this.appearanceChanged(),
      configChanged: () => this.configChanged(),
      setFeature: (id, on) => this.setFeature(id, on),
      lockMode: () => this.lockStatus.mode,
      openLockSettings: () => void this.openLockSettings(),
      lockNow: () => void this.lockApp(),
      close: () => this.closeSettings(),
      openGuide: () => this.openGuide("getting-started"),
    });
    this.workspace.append(this.settings.el, this.guide.el);
    // An extra window is one section on its own: no app rail, no Settings, no switching.
    if (isMainWindow) document.getElementById("app")!.append(this.rail.el, this.workspace);
    else {
      document.body.classList.add("solo-window");
      document.getElementById("app")!.append(this.workspace);
    }
    this.rail.setItems(this.enabledModules());
    this.watchStatuses();
    this.applyAppearance();

    // "System" follows the desktop's light or dark setting as it changes.
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (config.appearance.mode === "system") this.appearanceChanged(false);
    });
    window.addEventListener("keydown", (e) => this.onKey(e));
    // F1 before anything else gets it: editors (a Sheets cell, a Docs page) keep their own keys.
    window.addEventListener("keydown", (e) => this.onHelpKey(e), true);
    this.followOtherWindows();
  }

  /** Unlocks, runs the first-run wizard if needed, then shows the last module and handles a launch path. */
  async start() {
    this.lockStatus = await lockApi.status().catch(() => this.lockStatus);
    if (this.lockStatus.locked) {
      document.body.classList.add("app-locked");
      await askForAccess(this.lockStatus.mode, "unlock");
      document.body.classList.remove("app-locked");
    }
    for (const type of ["pointermove", "pointerdown", "keydown", "wheel"]) {
      window.addEventListener(type, () => this.userActive(), { passive: true, capture: true });
    }
    this.resetIdleTimer();
    this.setupDragDrop().catch((err) => console.warn("Drag and drop unavailable:", err));

    if (!this.config.onboarded && isMainWindow) {
      this.onboarding = new Onboarding({
        config: this.config,
        appearanceChanged: () => this.appearanceChanged(),
        applyFeatures: (features) => this.applyFeatures(features),
      });
      await this.onboarding.run();
      this.onboarding = null;
    }
    // An extra window starts where it was asked to; the main window where it was left.
    const own = (m: string): m is ModuleId => (MODULE_IDS as readonly string[]).includes(m);
    const wanted = windowStart && own(windowStart.module) ? windowStart.module : this.config.module;
    const first = this.config.features[wanted] ? wanted : this.enabledModules()[0];
    // A Terminal window starts its first shell in the folder it was opened for.
    if (first === "terminal" && windowStart?.path) (await this.ensure("terminal"))?.open?.({ kind: "folder", path: windowStart.path });
    await this.activate(first);
    const path = windowStart?.path;
    if (path && first === wanted) {
      const siblings = (windowStart && "siblings" in windowStart && windowStart.siblings) || undefined;
      if (first === "files") this.open({ kind: "folder", path });
      else if (first === "gallery") this.open({ kind: "image", path, siblings, alone: isFileWindow });
      else if (first === "video") this.open({ kind: "video", path, siblings, alone: isFileWindow });
      else if (first === "office") this.open({ kind: "office", path, alone: true });
      else if (first === "studio") {
        // A project opens as itself; a clip (the screen recorder's "Open in Video Editor") starts a project.
        const app = studioProjectKind(path) ?? (/\.(mp4|m4v|mov|mkv|webm)$/i.test(path) ? "video" : null);
        if (app) this.open({ kind: "studio", app, path });
      }
    }
    if (isMainWindow) {
      startUpdateChecks(this.config, () => this.openSettings("about"));
      // Notes that were on the desktop when Zazabor last ran come back.
      if (this.config.features.notes && this.config.notes.reopen) invoke("notes_reopen").catch(() => undefined);
      await this.openLaunchPath();
    }
  }

  // ---- other windows

  /** Opens a module in a new window, at the place it's showing (Files: the same folder). */
  private openModuleWindow(id: ModuleId) {
    const custom = MODULES[id].newWindow;
    if (custom) return custom.open();
    openWindow(id, this.modules.get(id)?.windowPath?.() ?? undefined);
  }

  /** Settings saved and the lock changed in another window apply here too. */
  private followOtherWindows() {
    void onOthers<string>(CONFIG_SAVED, (json) => this.configFromElsewhere(json));
    void onOthers<null>(ACTIVITY, () => this.resetIdleTimer());
    // A note's "Notes List" brings the main window to the Notes section.
    if (isMainWindow) void listen("notes-show-list", () => this.config.features.notes && this.showModule("notes"));
    // Zazabor launched again ("Open with" while it runs, or in the background): open what it was given.
    if (isMainWindow) void listen<string>("open-path", (e) => void this.openPath(e.payload, 1));
    // The clipboard popup's "Open Clipboard" brings the main window to the Clipboard section.
    if (isMainWindow) void listen("clipboard-show-section", () => this.config.features.clipboard && this.showModule("clipboard"));
    void listen<boolean>("lock-changed", (e) => {
      if (e.payload) void this.lockApp(false);
      else dismissUnlockPrompt();
    });
  }

  private configFromElsewhere(json: string) {
    let incoming: Config;
    try {
      incoming = parseConfig(json);
    } catch {
      return;
    }
    const before = { appearance: JSON.stringify(this.config.appearance), features: JSON.stringify(this.config.features) };
    adoptConfig(this.config, incoming);
    if (JSON.stringify(this.config.appearance) !== before.appearance) this.appearanceChanged(false);
    if (JSON.stringify(this.config.features) !== before.features) {
      // A window for a section that was turned off has nothing left to show.
      if (!isMainWindow && this.active && !this.config.features[this.active]) return closeThisWindow();
      for (const id of MODULE_IDS) if (!this.config.features[id] && this.modules.has(id)) this.dropModule(id);
      this.rail.setItems(this.enabledModules());
      this.watchStatuses();
      if (!this.active || !this.config.features[this.active]) void this.activate(this.enabledModules()[0]);
      this.revealActive();
    }
    if (this.settings.isOpen) this.settings.refresh();
  }

  /** Local activity: resets the auto-lock here and, now and then, in the other windows. */
  private userActive() {
    this.resetIdleTimer();
    const now = Date.now();
    if (now - this.lastActivityTold >= ACTIVITY_EVERY_MS) {
      this.lastActivityTold = now;
      tellOthers(ACTIVITY, null);
    }
  }

  private makeLock(): ShellLock {
    const status = () => this.lockStatus;
    return {
      get enabled() {
        return status().mode !== "off";
      },
      lockNow: () => void this.lockApp(),
      authorize: async (reason) => status().mode === "off" || askForAccess(status().mode, "confirm", reason),
      openSettings: () => void this.openLockSettings(),
    };
  }

  // ---- ShellContext

  saveConfig() {
    saveConfig(this.config);
  }

  showModule(id: ModuleId) {
    this.closeGuide(false);
    this.closeSettings(false);
    void this.activate(id);
  }

  open(request: OpenRequest) {
    const target: ModuleId = request.kind === "folder" ? "files" : request.kind === "image" ? "gallery" : request.kind === "office" ? "office" : request.kind === "studio" ? "studio" : "video";
    if (!this.config.features[target]) {
      const path = "path" in request ? request.path : undefined;
      if (path) this.openExternally(path);
      return;
    }
    this.closeSettings(false);
    void this.activate(target).then(() => this.modules.get(target)?.open?.(request));
  }

  openExternally(path: string) {
    invoke("fs_open_default", { path }).catch((err) => console.warn("Could not open", path, err));
  }

  // ---- modules

  private enabledModules() {
    return MODULE_IDS.filter((id) => this.config.features[id]);
  }

  /** Builds a module on first use; null when it was turned off while loading. */
  private ensure(id: ModuleId): Promise<AppModule | null> {
    const existing = this.modules.get(id);
    if (existing) return Promise.resolve(existing);
    let pending = this.loading.get(id);
    if (!pending) {
      pending = (async () => {
        const factory = await MODULES[id].load();
        const mod = await factory(this);
        this.loading.delete(id);
        if (!this.config.features[id]) {
          mod.dispose?.();
          return null;
        }
        mod.el.classList.add("module");
        mod.el.hidden = true;
        this.workspace.append(mod.el);
        this.modules.set(id, mod);
        return mod;
      })();
      this.loading.set(id, pending);
    }
    return pending;
  }

  /** Brings a module to the workspace (building it first), leaving Settings alone. */
  private async activate(id: ModuleId) {
    if (!this.config.features[id]) return;
    const mod = await this.ensure(id);
    if (!mod || !this.config.features[id]) return;
    if (this.active !== id) {
      const previous = this.active ? this.modules.get(this.active) : undefined;
      if (previous) {
        previous.deactivate();
        previous.el.hidden = true;
      }
      this.active = id;
      if (isMainWindow) {
        // Which module comes back at the next start is the main window's.
        this.config.module = id;
        this.saveConfig();
      } else {
        void getCurrentWindow().setTitle(`${MODULES[id].title} — Zazabor`).catch(() => undefined);
      }
    }
    this.revealActive();
    mod.activate();
  }

  /** Shows the active module's workspace, unless Settings has it. */
  private revealActive() {
    const mod = this.active ? this.modules.get(this.active) : undefined;
    const settingsOpen = this.settings.isOpen;
    if (mod) mod.el.hidden = settingsOpen;
    this.rail.setActive(settingsOpen ? null : this.active);
    this.rail.setSettingsActive(settingsOpen);
  }

  setFeature(id: ModuleId, on: boolean) {
    if (!on && this.enabledModules().filter((m) => m !== id).length === 0) return;
    this.config.features[id] = on;
    if (!on) {
      this.dropModule(id);
      if (this.active === id) {
        this.active = null;
        void this.activate(this.enabledModules()[0]);
      }
    }
    this.rail.setItems(this.enabledModules());
    this.watchStatuses();
    this.revealActive();
    this.saveConfig();
  }

  /** Keeps the rail dots of the enabled modules that have one (main window only: it has the rail). */
  private watchStatuses() {
    if (!isMainWindow) return;
    for (const id of MODULE_IDS) {
      const watch = MODULES[id].status;
      const unwatch = this.statusWatchers.get(id);
      if (watch && this.config.features[id] && !unwatch) {
        this.statusWatchers.set(id, watch((status) => this.rail.setStatus(id, status)));
      } else if (unwatch && !this.config.features[id]) {
        unwatch();
        this.statusWatchers.delete(id);
        this.rail.setStatus(id, null);
      }
    }
  }

  private dropModule(id: ModuleId) {
    const mod = this.modules.get(id);
    if (!mod) return;
    mod.dispose?.();
    mod.el.remove();
    this.modules.delete(id);
    if (this.active === id) this.active = null;
  }

  private applyFeatures(features: Record<ModuleId, boolean>) {
    for (const id of MODULE_IDS) if (features[id]) this.setFeature(id, true);
    for (const id of MODULE_IDS) if (!features[id]) this.setFeature(id, false);
  }

  // ---- appearance and settings

  private applyAppearance() {
    applyAppearance(this.config.appearance);
  }

  private appearanceChanged(save = true) {
    this.applyAppearance();
    for (const mod of this.modules.values()) mod.appearanceChanged?.();
    if (save) this.saveConfig();
  }

  private configChanged() {
    for (const mod of this.modules.values()) mod.configChanged?.();
    this.saveConfig();
  }

  private toggleSettings() {
    if (this.settings.isOpen) this.closeSettings();
    else this.openSettings();
  }

  // ---- the user guide

  private toggleGuide() {
    if (this.guide.isOpen) this.closeGuide();
    else this.openGuide();
  }

  /** Opens the guide on `article`, or on the one for what shows (F1). */
  private openGuide(article?: string) {
    if (this.onboarding) return;
    const mod = this.active ? this.modules.get(this.active) : undefined;
    this.guide.open(article ?? articleFor(this.active, mod?.guideTopic?.(), this.settings.isOpen));
    mod?.deactivate();
    this.rail.setHelpActive(true);
  }

  private closeGuide(refocus = true) {
    if (!this.guide.isOpen) return;
    this.guide.close();
    this.rail.setHelpActive(false);
    if (refocus && !this.settings.isOpen && this.active) this.modules.get(this.active)?.activate();
  }

  /** The guide's Open button: the section (in this window, or a new one from a section window). */
  private async openFromGuide(module: ModuleId, target?: string) {
    this.closeGuide(false);
    if (!isMainWindow && module !== this.active) return this.openModuleWindow(module);
    this.closeSettings(false);
    await this.activate(module);
    if (target) this.modules.get(module)?.showGuideTarget?.(target);
  }

  openSettings(category?: string) {
    if (this.onboarding || !isMainWindow) return;
    this.closeGuide(false);
    if (this.settings.isOpen && !category) return;
    this.settings.open(category);
    this.revealActive();
  }

  /** Leaves Settings; `refocus` hands the keyboard back to the module that was showing. */
  private closeSettings(refocus = true) {
    if (!this.settings.isOpen) return;
    this.settings.close();
    this.revealActive();
    if (refocus && this.active) this.modules.get(this.active)?.activate();
  }

  // ---- keys

  private onKey(e: KeyboardEvent) {
    if (document.body.classList.contains("app-locked")) return;
    // Keys typed into a terminal are the shell's (Ctrl+L clears the screen, Ctrl+N is history…);
    // only the terminal's own shortcuts apply there.
    if (isTerminalTarget(e.target)) {
      const active = this.active ? this.modules.get(this.active) : undefined;
      if (active?.handleKey(e)) e.preventDefault();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "l" && this.lock.enabled) {
      e.preventDefault();
      void this.lockApp();
      return;
    }
    if (this.onboarding) return;
    // While the guide is open it has the keys (F1 itself is onHelpKey's).
    if (this.guide.isOpen) {
      if (this.guide.handleKey(e)) e.preventDefault();
      return;
    }
    const active = this.active ? this.modules.get(this.active) : undefined;
    // Settings and switching sections belong to the main window.
    if (!isMainWindow) {
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n" && !active?.modal && !active?.ownsNewKey && this.active) {
        e.preventDefault();
        this.openModuleWindow(this.active);
        return;
      }
      if (active && (active.modal || !isTypingTarget(e.target)) && active.handleKey(e)) e.preventDefault();
      return;
    }
    if (mod && e.key === "," && !active?.modal) {
      e.preventDefault();
      this.toggleSettings();
      return;
    }
    if (this.settings.isOpen) {
      if (this.settings.handleKey(e)) e.preventDefault();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n" && !active?.modal && !active?.ownsNewKey && this.active) {
      e.preventDefault();
      this.openModuleWindow(this.active);
      return;
    }
    if (mod && /^[1-9]$/.test(e.key) && !active?.modal) {
      const id = this.enabledModules()[Number(e.key) - 1];
      if (id) {
        e.preventDefault();
        this.showModule(id);
      }
      return;
    }
    // Typing in a field is left alone, except while a full-screen mode (slideshow) owns the keys.
    if (active && (active.modal || !isTypingTarget(e.target)) && active.handleKey(e)) e.preventDefault();
  }

  /** F1: the guide on what shows, or closes it. A terminal's programs keep F1 for themselves. */
  private onHelpKey(e: KeyboardEvent) {
    if (e.key !== "F1" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (document.body.classList.contains("app-locked") || this.onboarding || isTerminalTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.guide.isOpen) this.closeGuide();
    else this.openGuide();
  }

  // ---- privacy lock

  /**
   * Hides everything and blocks the backend until the user unlocks again. `initiate` is false when
   * another window locked the app; unlocking in any window unlocks them all.
   */
  private async lockApp(initiate = true) {
    if (this.locking || (initiate && this.lockStatus.mode === "off")) return;
    this.locking = true;
    if (initiate) await lockApi.lockNow();
    else this.lockStatus = await lockApi.status().catch(() => this.lockStatus);
    document.body.classList.add("app-locked");
    this.closeSettings();
    this.closeGuide(false);
    for (const mod of this.modules.values()) await mod.onLock?.();
    await askForAccess(this.lockStatus.mode, "unlock");
    document.body.classList.remove("app-locked");
    this.locking = false;
    this.resetIdleTimer();
  }

  private resetIdleTimer() {
    clearTimeout(this.idleTimer);
    const minutes = this.config.autoLockMinutes;
    if (this.lockStatus.mode === "off" || !minutes || this.locking) return;
    this.idleTimer = window.setTimeout(async () => {
      // Never interrupt a slideshow or a video someone is watching, in this window or another.
      const active = this.active ? this.modules.get(this.active) : undefined;
      if (active?.modal || (await isKeptAwake())) this.resetIdleTimer();
      else void this.lockApp();
    }, minutes * 60_000);
  }

  private async openLockSettings() {
    const result = await openLockSettings(this.lockStatus, this.config.autoLockMinutes);
    if (!result) return;
    this.lockStatus = result.status;
    this.config.autoLockMinutes = result.autoLockMinutes;
    this.saveConfig();
    for (const mod of this.modules.values()) mod.lockChanged?.(this.lock.enabled);
    this.settings.refresh();
    this.resetIdleTimer();
  }

  // ---- opening paths

  /** Folders go to Files; without Files, the Gallery adds them to its library. */
  private openFolder(path: string) {
    if (this.config.features.files) this.open({ kind: "folder", path });
    else if (this.config.features.gallery) {
      this.closeSettings(false);
      void this.activate("gallery").then(() => this.modules.get("gallery")?.open?.({ kind: "folder", path }));
    }
  }

  private async openPath(path: string, count: number) {
    const kind = await classifyPath(path);
    if (kind === "dir") this.openFolder(path);
    else if (kind === "image" && count === 1) this.open({ kind: "image", path });
    else if (kind === "video" && count === 1) this.open({ kind: "video", path });
    // Word and Excel files (and CSV, text) go to Office.
    else if (kind === "other" && count === 1 && this.config.features.office && kindOf(path)) this.open({ kind: "office", path });
    // Photo and Video Editor projects go to Studio.
    else if (kind === "other" && count === 1 && this.config.features.studio && studioProjectKind(path)) this.open({ kind: "studio", app: studioProjectKind(path)!, path });
  }

  private async openLaunchPath() {
    const path = await api.launchPath().catch(() => null);
    if (path) await this.openPath(path, 1);
  }

  private async setupDragDrop() {
    await getCurrentWebview().onDragDropEvent(async (event) => {
      const payload = event.payload;
      // A file picker open in this window takes the drop itself (see shared/filepicker), as does
      // a module's own drop target under the pointer (a Wallet transaction takes receipts).
      const picking = document.body.classList.contains("file-picker-open") || document.body.classList.contains("drop-claimed");
      if (payload.type === "enter" || payload.type === "over") {
        if (!this.onboarding && !picking) document.body.classList.add("dropping");
        return;
      }
      document.body.classList.remove("dropping");
      if (payload.type !== "drop" || picking || this.onboarding || document.body.classList.contains("app-locked")) return;
      for (const path of payload.paths) await this.openPath(path, payload.paths.length);
    });
  }
}
