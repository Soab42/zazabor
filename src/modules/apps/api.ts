import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { IconName } from "../../ui/icons";

/** Where an app came from; mirrors `Source` in `src-tauri/src/programs/scan.rs`. */
export type Source = "deb" | "flatpak" | "snap" | "appimage" | "folder" | "file" | "web" | "steam" | "launcher" | "missing" | "manual";

/** One installed app; mirrors `Program` in `src-tauri/src/programs/mod.rs`. */
export interface Program {
  id: string;
  name: string;
  summary: string;
  icon?: string;
  source: Source;
  installation?: string;
  package?: string;
  version?: string;
  publisher?: string;
  size?: number;
  /** ms since the epoch. */
  installed?: number;
  location?: string;
  /** The desktop file id that starts it. */
  launcher?: string;
  launchers: string[];
  isSelf: boolean;
}

export interface Leftover {
  path: string;
  size: number;
  kind: "settings" | "data" | "cache" | "state";
}

/** What uninstalling would do; mirrors `Plan` in `src-tauri/src/programs/remove.rs`. */
export interface Plan {
  id: string;
  name: string;
  source: Source | null;
  admin: boolean;
  steps: string[];
  dependents: string[];
  extras: string[];
  canPurge: boolean;
  leftovers: Leftover[];
  warnings: string[];
  blocked: string | null;
  action: string;
  undoable: boolean;
}

export interface Options {
  purge: boolean;
  extras: boolean;
  leftovers: string[];
}

export interface Outcome {
  message: string;
  /** The removed files' places in the Trash. */
  trashed: string[];
  problems: string[];
}

export const appsApi = {
  list: () => invoke<Program[]>("programs_list"),
  plan: (id: string) => invoke<Plan>("programs_plan", { id }),
  uninstall: (id: string, options: Options) => invoke<Outcome>("programs_uninstall", { id, options }),
  open: (launcher: string) => invoke<void>("programs_open", { launcher }),
  dryRun: () => invoke<boolean>("programs_dry_run"),
  /** Puts trashed files back (a Files job). */
  restore: (paths: string[]) => invoke<number>("fs_trash_restore", { paths }),
};

export function onProgress(handler: (id: string, line: string) => void): Promise<UnlistenFn> {
  return listen<{ id: string; line: string }>("programs-progress", (e) => handler(e.payload.id, e.payload.line));
}

/** How each source is named in the list, and its group in the filter. */
export const SOURCES: Record<Source, { label: string; group: Group; icon: IconName }> = {
  deb: { label: "apt", group: "system", icon: "package" },
  flatpak: { label: "Flatpak", group: "flatpak", icon: "package" },
  snap: { label: "Snap", group: "snap", icon: "package" },
  appimage: { label: "AppImage", group: "home", icon: "file" },
  folder: { label: "Home folder", group: "home", icon: "folder" },
  file: { label: "Home folder", group: "home", icon: "file" },
  web: { label: "Web app", group: "other", icon: "network" },
  steam: { label: "Steam", group: "other", icon: "play" },
  launcher: { label: "Launcher", group: "other", icon: "external" },
  missing: { label: "Broken launcher", group: "other", icon: "info" },
  manual: { label: "Installed by hand", group: "system", icon: "lock" },
};

export type Group = "all" | "system" | "flatpak" | "snap" | "home" | "other";

export const GROUPS: [Group, string][] = [["all", "All"], ["system", "System"], ["flatpak", "Flatpak"], ["snap", "Snap"], ["home", "Home Folder"], ["other", "Shortcuts"]];

export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} bytes`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
