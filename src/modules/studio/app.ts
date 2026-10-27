import type { ShellContext } from "../../shell/module";
import { basename } from "../../ui/dom";

/**
 * The contract between the Studio section and its two apps: Photo (`photo/`) and the Video
 * Editor (`video/`). The section owns the inner rail, Home and the list of open projects; an app
 * owns everything inside its own element (title bar, tools, canvas or timeline, panels).
 */

export type StudioKind = "photo" | "video";

/** The shapes a new video starts in (Reels/TikTok/Shorts, YouTube, a square post, a portrait post). */
export type Aspect = "9:16" | "16:9" | "1:1" | "4:5";

/** Pictures Photo opens (and its own project file). */
export const PHOTO_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "avif", "psd", "zazimage", "coreimage",
  // Camera RAW files (LibRaw; see photo/develop.ts).
  "3fr", "arw", "cr2", "cr3", "crw", "dcr", "dng", "erf", "fff", "iiq", "k25", "kdc", "mef", "mos", "mrw", "nef", "nrw", "orf", "pef",
  "raf", "raw", "rw2", "rwl", "sr2", "srf", "srw", "x3f"];
/** The Video Editor's own project file; clips and pictures start a new project instead. */
export const VIDEO_PROJECT_EXTENSIONS = ["zazvideo", "corevideo"];
/** Photo's own project file (`.coreimage` is its name from before Zazabor; both open). */
export const PHOTO_PROJECT_EXTENSIONS = ["zazimage", "coreimage"];

export function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Studio's own project files (.zazimage, .zazvideo, and the older .coreimage, .corevideo): which app they belong to, or null. */
export function studioProjectKind(path: string): StudioKind | null {
  const ext = extensionOf(path);
  return PHOTO_PROJECT_EXTENSIONS.includes(ext) ? "photo" : VIDEO_PROJECT_EXTENSIONS.includes(ext) ? "video" : null;
}

/** Which app opens a file as a project of its own; null for anything else. */
export function studioKindOf(path: string): StudioKind | null {
  const ext = extensionOf(path);
  if (PHOTO_EXTENSIONS.includes(ext)) return "photo";
  if (VIDEO_PROJECT_EXTENSIONS.includes(ext)) return "video";
  return null;
}

/** How an app starts. */
export interface StudioStart {
  /** A file to open: a picture or .coreimage (Photo), a .corevideo project (Video). */
  path?: string;
  /** Video: clips and pictures to put on a new project's timeline, in order. */
  paths?: string[];
  /** Video: the new project's shape. */
  aspect?: Aspect;
  /** Video: an AutoRecover snapshot to open (its id). */
  recover?: string;
  /** Video: make a reel of `paths` in a slideshow theme's style ("Make a Video" in the Gallery). */
  make?: { theme: string; music: string | null };
}

/** What the section offers an app. */
export interface StudioHost {
  readonly shell: ShellContext;
  /** The title, path or unsaved state changed: the rail and the window title follow. */
  changed(): void;
  /** Back to Studio's Home; the project stays open in the rail. */
  showHome(): void;
  /** Remembers a path in Recent (after opening or saving). */
  remember(path: string): void;
  /** A brief message at the bottom of the window. */
  toast(text: string): void;
  /** Closes this app; it has already asked about unsaved changes. */
  close(): void;
}

export interface StudioApp {
  readonly kind: StudioKind;
  readonly el: HTMLElement;
  /** Shown in the rail and the title bar ("Untitled reel" until saved). */
  title(): string;
  /** The project or picture on disk; null until saved. */
  path(): string | null;
  dirty(): boolean;
  /** Saves (asks where the first time, or always with `as`); false when cancelled or it failed. */
  save(as?: boolean): Promise<boolean>;
  /** Shown again: take the keyboard, resume playback timers. */
  activate(): void;
  /** Hidden behind Home or another project: pause playback. */
  deactivate(): void;
  /** Keys typed outside any field while it shows; true when handled. */
  handleKey(e: KeyboardEvent): boolean;
  dispose(): void;
}

/**
 * Builds an app. Rejects with a message when the file can't be read (the section shows it), or
 * with an Error named "Cancelled" when the user cancelled a question the app asked first.
 */
export type StudioFactory = (host: StudioHost, start: StudioStart) => Promise<StudioApp>;
