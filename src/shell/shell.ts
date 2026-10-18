import "./shell.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "../api";
import { applyAppearance } from "../appearance";
import { adoptConfig, CONFIG_SAVED, parseConfig, saveConfig, type Config } from "../config";
import { askForAccess, dismissUnlockPrompt, lockApi, openLockSettings, type LockStatus } from "../lock";
import { basename, h, isTypingTarget } from "../ui/dom";
import { MODULE_IDS, type AppModule, type ModuleId, type OpenRequest, type ShellContext, type ShellLock } from "./module";
import { Onboarding } from "./onboarding";
import { Rail } from "./rail";
import { MODULES } from "./registry";
import { classifyPath } from "./router";
import { Settings } from "./settings";
import { isTerminalTarget } from "../terminal/target";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { closeThisWindow, isFileWindow, isMainWindow, onOthers, openWindow, tellOthers, windowStart } from "./windows";

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
    openWindow: (id) => this.openModuleWindow(id),
  });
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

  readonly lock: ShellLock = this.makeLock();

  constructor(readonly config: Config) {
    this.settings = new Settings({
      config,
      appearanceChanged: () => this.appearanceChanged(),
      configChanged: () => this.configChanged(),
      setFeature: (id, on) => this.setFeature(id, on),
      lockMode: () => this.lockStatus.mode,
      openLockSettings: () => void this.openLockSettings(),
      lockNow: () => void this.lockApp(),
      close: () => this.closeSettings(),
    });
    this.workspace.append(this.settings.el);
    // An extra window is one section on its own: no app rail, no Settings, no switching.
    if (isMainWindow) document.getElementById("app")!.append(this.rail.el, this.workspace);
    else {
      document.body.classList.add("solo-window");
      document.getElementById("app")!.append(this.workspace);
    }
    this.rail.setItems(this.enabledModules());
    this.applyAppearance();

    // "System" follows the desktop's light or dark setting as it changes.
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (config.appearance.mode === "system") this.appearanceChanged(false);
    });
    window.addEventListener("keydown", (e) => this.onKey(e));
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
    const wanted = windowStart && windowStart.module !== "viewer" ? windowStart.module : this.config.module;
    const first = this.config.features[wanted] ? wanted : this.enabledModules()[0];
    // A Terminal window starts its first shell in the folder it was opened for.
    if (first === "terminal" && windowStart?.path) (await this.ensure("terminal"))?.open?.({ kind: "folder", path: windowStart.path });
    await this.activate(first);
    const path = windowStart?.path;
    if (path && first === wanted) {
      if (first === "files") this.open({ kind: "folder", path });
      else if (first === "gallery") this.open({ kind: "image", path, alone: isFileWindow });
      else if (first === "video") this.open({ kind: "video", path, alone: isFileWindow });
      // A window for one file is called after it.
      if (isFileWindow) void getCurrentWindow().setTitle(basename(path)).catch(() => undefined);
    }
    if (isMainWindow) await this.openLaunchPath();
  }

  // ---- other windows

  /** Opens a module in a new window, at the place it's showing (Files: the same folder). */
  private openModuleWindow(id: ModuleId) {
    openWindow(id, this.modules.get(id)?.windowPath?.() ?? undefined);
  }

  /** Settings saved and the lock changed in another window apply here too. */
  private followOtherWindows() {
    void onOthers<string>(CONFIG_SAVED, (json) => this.configFromElsewhere(json));
    void onOthers<null>(ACTIVITY, () => this.resetIdleTimer());
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
    this.closeSettings(false);
    void this.activate(id);
  }

  open(request: OpenRequest) {
    const target: ModuleId = request.kind === "folder" ? "files" : request.kind === "image" ? "gallery" : "video";
    if (!this.config.features[target]) {
      this.openExternally(request.path);
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
        void getCurrentWindow().setTitle(`${MODULES[id].title} — CorePro`).catch(() => undefined);
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
    this.revealActive();
    this.saveConfig();
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

  private openSettings() {
    if (this.settings.isOpen || this.onboarding) return;
    this.settings.open();
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
    const active = this.active ? this.modules.get(this.active) : undefined;
    // Settings and switching sections belong to the main window.
    if (!isMainWindow) {
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n" && !active?.modal && this.active) {
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
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n" && !active?.modal && this.active) {
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
    this.idleTimer = window.setTimeout(() => {
      // Never interrupt a slideshow someone is watching.
      const active = this.active ? this.modules.get(this.active) : undefined;
      if (active?.modal) this.resetIdleTimer();
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
  }

  private async openLaunchPath() {
    const path = await api.launchPath().catch(() => null);
    if (path) await this.openPath(path, 1);
  }

  private async setupDragDrop() {
    await getCurrentWebview().onDragDropEvent(async (event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        if (!this.onboarding) document.body.classList.add("dropping");
        return;
      }
      document.body.classList.remove("dropping");
      if (payload.type !== "drop" || this.onboarding || document.body.classList.contains("app-locked")) return;
      for (const path of payload.paths) await this.openPath(path, payload.paths.length);
    });
  }
}
