import type { Config } from "../config";
import type { IconName } from "../ui/icons";

/** The features CorePro is made of; each can be turned off in Settings. */
export type ModuleId = "files" | "gallery" | "video";

export const MODULE_IDS: readonly ModuleId[] = ["files", "gallery", "video"];

/** Something one module asks the shell to show, usually in another module. */
export type OpenRequest =
  | { kind: "folder"; path: string }
  /** `siblings` is the list to browse through (e.g. the other images in that folder). */
  | { kind: "image"; path: string; siblings?: string[] }
  | { kind: "video"; path: string; siblings?: string[] };

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
  /** Called when the feature is turned off in Settings. */
  dispose?(): void;
}

export type ModuleFactory = (shell: ShellContext) => AppModule | Promise<AppModule>;
