import type { Config } from "../config";
import type { IconName } from "../ui/icons";

/** The features CorePro is made of; each can be turned off in Settings. */
export type ModuleId = "files" | "gallery" | "video" | "terminal" | "notes" | "time" | "wallet" | "office" | "studio" | "clipboard";

export const MODULE_IDS: readonly ModuleId[] = ["files", "gallery", "video", "terminal", "notes", "time", "wallet", "office", "studio", "clipboard"];

/** A dot on a module's rail button while it has something going on (Time: a timer running). */
export interface RailStatus {
  /** "live" pulses (a task timer runs), "paused" (an activity runs), "on" (checked in, nothing running). */
  tone: "live" | "paused" | "on";
  /** Added to the button's tooltip. */
  title: string;
}

/** Something one module asks the shell to show, usually in another module. */
export type OpenRequest =
  | { kind: "folder"; path: string }
  /**
   * `siblings` is the list to browse through (e.g. the other images in that folder). `alone`: the
   * window exists only for this file, so show it without the module's library around it.
   */
  | { kind: "image"; path: string; siblings?: string[]; alone?: boolean }
  | { kind: "video"; path: string; siblings?: string[]; alone?: boolean }
  /** A Word or Excel file (or .csv, .odt…), for Office. */
  | { kind: "office"; path: string; alone?: boolean }
  /**
   * Studio: a picture (or a .coreimage) to edit in Photo, or clips and pictures to start a video
   * with in the Video Editor (a .corevideo project opens as it is).
   */
  | { kind: "studio"; app: "photo" | "video"; path?: string; paths?: string[]; make?: { theme: string; music: string | null } };

/** The app-wide privacy lock, as seen by modules. */
export interface ShellLock {
  /** A lock is configured (password or system). */
  readonly enabled: boolean;
  /** Locks the app now (no-op when no lock is configured). */
  lockNow(): void;
  /** Re-checks identity for private content; resolves true at once when no lock is set. */
  authorize(reason: string): Promise<boolean>;
  /** Opens the lock's settings dialog. */
  openSettings(): void;
}

/** What the shell offers every module. */
export interface ShellContext {
  readonly config: Config;
  /** Persists the config shortly after the last change. */
  saveConfig(): void;
  /** Routes a request to the module that handles it, or to the system's default app. */
  open(request: OpenRequest): void;
  /** Opens a path with the system's default application. */
  openExternally(path: string): void;
  showModule(id: ModuleId): void;
  /** Opens Settings, on a category when given (main window only). */
  openSettings(category?: string): void;
  readonly lock: ShellLock;
}

/** One feature of the app, shown in the workspace when picked on the app rail. */
export interface AppModule {
  readonly id: ModuleId;
  readonly title: string;
  readonly icon: IconName;
  /** Built once; the shell attaches it to the workspace and hides it while inactive. */
  readonly el: HTMLElement;
  /** Called when the module becomes visible; resume work, take keyboard focus. */
  activate(): void;
  /** Called when another module takes over; pause expensive work (timers, scanning, playback UI). */
  deactivate(): void;
  /** Keys reach the active module first; return true when handled. */
  handleKey(e: KeyboardEvent): boolean;
  /** Shows something another module asked for (e.g. Files opening an image in the Gallery viewer). */
  open?(request: OpenRequest): void;
  /** True while the module is in a full-screen mode (e.g. a slideshow) that shell shortcuts must not interrupt. */
  readonly modal?: boolean;
  /** Ctrl+N reaches `handleKey` (a new file, as in Word) instead of opening a new CorePro window. */
  readonly ownsNewKey?: boolean;
  /** Appearance changed (theme, accent, grid layout, zoom curve); re-apply whatever depends on it. */
  appearanceChanged?(): void;
  /** Settings edited the module's part of the config; re-read it. */
  configChanged?(): void;
  /** The privacy lock was configured or removed. */
  lockChanged?(enabled: boolean): void;
  /** The app is about to lock: close private views, stop playback. */
  onLock?(): void | Promise<void>;
  /** Called when the feature is turned off in Settings. */
  dispose?(): void;
  /** Where a new window of this module should start (Files: the folder it shows). */
  windowPath?(): string | null;
}

export type ModuleFactory = (shell: ShellContext) => AppModule | Promise<AppModule>;
