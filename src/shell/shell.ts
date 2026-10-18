import "./shell.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "../api";
import { applyAppearance } from "../appearance";
import { saveConfig, type Config } from "../config";
import { askForAccess, lockApi, openLockSettings, type LockStatus } from "../lock";
import { h, isTypingTarget } from "../ui/dom";
import { MODULE_IDS, type AppModule, type ModuleId, type OpenRequest, type ShellContext, type ShellLock } from "./module";
import { Onboarding } from "./onboarding";
import { Rail } from "./rail";
import { MODULES } from "./registry";
import { classifyPath } from "./router";
import { Settings } from "./settings";

/**
 * The app around the modules: the rail, the workspace, Settings and the first-run wizard, plus
 * everything that belongs to the whole window (privacy lock, key and drop routing, appearance).
 */
export class Shell implements ShellContext {
  private rail = new Rail({ select: (id) => this.showModule(id), settings: () => this.toggleSettings() });
  private workspace = h("main", { class: "workspace" });
  private settings: Settings;
  private modules = new Map<ModuleId, AppModule>();
  private loading = new Map<ModuleId, Promise<AppModule | null>>();
  private active: ModuleId | null = null;
  private onboarding: Onboarding | null = null;
  private lockStatus: LockStatus = { mode: "off", locked: false, systemAvailable: false };
  private locking = false;
  private idleTimer = 0;

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
    document.getElementById("app")!.append(this.rail.el, this.workspace);
    this.rail.setItems(this.enabledModules());
    this.applyAppearance();

    // "System" follows the desktop's light or dark setting as it changes.
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (config.appearance.mode === "system") this.appearanceChanged(false);
    });
    window.addEventListener("keydown", (e) => this.onKey(e));
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
      window.addEventListener(type, () => this.resetIdleTimer(), { passive: true, capture: true });
    }
    this.resetIdleTimer();
    this.setupDragDrop().catch((err) => console.warn("Drag and drop unavailable:", err));

    if (!this.config.onboarded) {
      this.onboarding = new Onboarding({
        config: this.config,
        appearanceChanged: () => this.appearanceChanged(),
        applyFeatures: (features) => this.applyFeatures(features),
      });
      await this.onboarding.run();
      this.onboarding = null;
    }
    const first = this.config.features[this.config.module] ? this.config.module : this.enabledModules()[0];
    await this.activate(first);
    await this.openLaunchPath();
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
      this.config.module = id;
      this.saveConfig();
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
      const mod = this.modules.get(id);
      if (mod) {
        mod.dispose?.();
        mod.el.remove();
        this.modules.delete(id);
      }
      if (this.active === id) {
        this.active = null;
        void this.activate(this.enabledModules()[0]);
      }
    }
    this.rail.setItems(this.enabledModules());
    this.revealActive();
    this.saveConfig();
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
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "l" && this.lock.enabled) {
      e.preventDefault();
      void this.lockApp();
      return;
    }
    if (this.onboarding) return;
    const active = this.active ? this.modules.get(this.active) : undefined;
    if (mod && e.key === "," && !active?.modal) {
      e.preventDefault();
      this.toggleSettings();
      return;
    }
    if (this.settings.isOpen) {
      if (this.settings.handleKey(e)) e.preventDefault();
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

  /** Hides everything and blocks the backend until the user unlocks again. */
  private async lockApp() {
    if (this.lockStatus.mode === "off" || this.locking) return;
    this.locking = true;
    await lockApi.lockNow();
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
