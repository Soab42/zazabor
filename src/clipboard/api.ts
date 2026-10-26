import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { IconName } from "../ui/icons";

/** One copy in the history; mirrors `Item` in `src-tauri/src/clipboard/mod.rs`. */
export interface ClipItem {
  id: string;
  kind: "text" | "image" | "files";
  /** The text; for files, their paths, one per line. */
  text: string;
  /** The rich-text flavour of a text, when the source offered one. */
  html?: string;
  uris?: string[];
  /** A picture's PNG, as a full path. */
  image?: string;
  width?: number;
  height?: number;
  hash: string;
  pinned: boolean;
  /** When it was (last) copied, ms since the epoch. */
  created: number;
  /** The app it came from (its window class), when known. */
  source?: string;
}

export interface ClipSettings {
  enabled: boolean;
  clearOnExit: boolean;
  /** Window classes whose copies aren't kept. */
  exclude: string[];
  tookSuperV: boolean;
}

export interface History {
  items: ClipItem[];
  settings: ClipSettings;
  /** CorePro can paste into other apps (X11); otherwise the user presses Ctrl+V. */
  canPaste: boolean;
}

export interface ClipShortcut {
  supported: boolean;
  state: "none" | "installed" | "other";
  binding: string;
  command: string;
  /** GNOME opens its notification list with Super+V. */
  gnomeSuperV: boolean;
  tookSuperV: boolean;
}

export const clipboardApi = {
  list: () => invoke<History>("clipboard_list"),
  pin: (id: string, pinned: boolean) => invoke<void>("clipboard_pin", { id, pinned }),
  remove: (id: string) => invoke<void>("clipboard_delete", { id }),
  /** Clear all (pinned items stay). */
  clear: () => invoke<void>("clipboard_clear"),
  setSettings: (s: Pick<ClipSettings, "enabled" | "clearOnExit" | "exclude">) => invoke<void>("clipboard_set_settings", s),
  /** Puts an item on the clipboard; `paste` also pastes it where the user was typing. True when it pasted. */
  use: (id: string, paste: boolean) => invoke<boolean>("clipboard_use", { id, paste }),
  /** Types an emoji or a symbol where the user was typing (true when it could). */
  type: (text: string) => invoke<boolean>("clipboard_type", { text }),
  togglePopup: () => invoke<void>("clipboard_popup"),
  hidePopup: () => invoke<void>("clipboard_popup_hide"),
  showSection: () => invoke<void>("clipboard_show_section"),
  shortcut: () => invoke<ClipShortcut>("clipboard_shortcut"),
  setShortcut: (binding: string | null, takeSuperV: boolean) => invoke<ClipShortcut>("clipboard_set_shortcut", { binding, takeSuperV }),
};

export function onClipboardChanged(fn: () => void): Promise<UnlistenFn> {
  return listen("clipboard-changed", () => fn());
}

export const KIND_ICON: Record<ClipItem["kind"], IconName> = { text: "clipText", image: "image", files: "files" };

/** The first lines of a text, tidied for a card. */
export function preview(item: ClipItem, lines = 4): string {
  const text = item.text.replace(/\r/g, "").replace(/\t/g, "  ");
  const rows = text.split("\n");
  const shown = rows.slice(0, lines).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l));
  return shown.join("\n") + (rows.length > lines ? "\n…" : "");
}

/** "3 files", "1,204 characters", "1920 × 1080". */
export function describe(item: ClipItem): string {
  if (item.kind === "image") return item.width && item.height ? `${item.width} × ${item.height}` : "Picture";
  if (item.kind === "files") {
    const n = item.uris?.length ?? item.text.split("\n").length;
    return n === 1 ? "1 file" : `${n} files`;
  }
  const n = [...item.text].length;
  return `${n.toLocaleString()} character${n === 1 ? "" : "s"}${item.html ? " · formatted" : ""}`;
}

/** A source window class as people know the app ("firefox" → "Firefox"). */
export function appName(source?: string): string {
  if (!source) return "";
  const known: Record<string, string> = { "google-chrome": "Chrome", "code": "VS Code", "org.gnome.nautilus": "Files", "gnome-terminal-server": "Terminal", "corepro": "CorePro" };
  const key = source.toLowerCase();
  return known[key] ?? source.replace(/[-_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
