import { api } from "./api";
import { normalizeAppearance, type Appearance } from "./appearance";
import { normalizeSettings, type SlideshowSettings } from "./modules/gallery/slideshow/settings";
import type { SortMode } from "./modules/gallery/library/model";
import { MODULE_IDS, type ModuleId } from "./shell/module";
import { tellOthers } from "./shell/windows";

export type FilesView = "icon" | "list" | "column" | "gallery";
export type FilesSortKey = "name" | "date" | "size" | "kind";

export type VideoSection = "home" | "videos" | "recent";

/** Where a video was left, for resuming and for the sidebar's progress bars. */
export interface VideoPosition {
  /** Milliseconds. */
  time: number;
  length: number;
  /** When it was last watched, ms since the epoch. */
  at: number;
}

export interface VideoSettings {
  /** 0–2 (200%, as in VLC; libVLC amplifies above 1). */
  volume: number;
  muted: boolean;
  /** The sidebar (play queue / browser) is open. */
  sidebar: boolean;
  section: VideoSection;
  /** Resume points by file path; trimmed to the most recent 500. */
  positions: Record<string, VideoPosition>;
  /** Recently played files, most recent first (max 50). */
  recent: string[];
  /** Control-bar items in order (Customise player); see docs/design/vlc/PLAYER.md. */
  controls: string[];
  /** Settings of individual video features, by feature id (see `featureSettings` in video/extensions.ts). */
  ext: Record<string, unknown>;
}

/** The redesign's bar (Figma): transport, the seek bar and volume, then quick access and panel/fullscreen on the right. */
export const DEFAULT_VIDEO_CONTROLS = ["previous", "play", "next", "seek", "volume", "audio", "subtitles", "playlist", "settings", "fullscreen"];

export interface FilesSettings {
  showHidden: boolean;
  view: FilesView;
  foldersFirst: boolean;
  /** Tile size of the icon view, in CSS pixels. */
  iconSize: number;
  sort: { key: FilesSortKey; ascending: boolean };
  /** Folders the user pinned to the sidebar's Favourites. */
  pinned: string[];
  /** Where the last session ended, to reopen there. */
  lastPath: string | null;
  /** Ask before moving items to the Trash. */
  confirmTrash: boolean;
  /** The terminal "Open Terminal Here" launches (a command name); null picks one automatically. */
  terminal: string | null;
  /** Servers saved from Connect to Server, shown under Network in the sidebar. */
  servers: SavedServer[];
}

export interface SavedServer {
  name: string;
  /** e.g. smb://nas/photos, sftp://user@host/home/user */
  url: string;
}

export interface Config {
  /** Extra folders added by hand; everything else is discovered automatically. */
  roots: string[];
  hiddenAlbums: string[];
  favoriteAlbums: string[];
  libraryView: "albums" | "favorites" | "photos";
  /** Minutes of inactivity before a configured lock engages; 0 = never. */
  autoLockMinutes: number;
  thumbSize: number;
  sort: SortMode;
  showInfo: boolean;
  showFilmstrip: boolean;
  slideshow: SlideshowSettings;
  appearance: Appearance;
  /** Which features are on (Settings → Features). At least one stays on. */
  features: Record<ModuleId, boolean>;
  /** The module shown last, reopened at launch. */
  module: ModuleId;
  /** The first-run wizard has been completed. */
  onboarded: boolean;
  files: FilesSettings;
  video: VideoSettings;
  terminal: TerminalSettings;
  notes: NotesSettings;
  wallet: WalletSettings;
  office: OfficeSettings;
  clipboard: ClipboardSettings;
  studio: StudioSettings;
  guide: GuideSettings;
  updates: UpdateSettings;
}

/** Updates (src/shell/updates.ts). */
export interface UpdateSettings {
  /** Asks GitHub for a newer Zazabor now and then, and says when there's one. */
  auto: boolean;
  /** A version the user chose to skip: not offered again (a later one is). */
  skipped: string | null;
}

function normalizeUpdates(raw: Partial<UpdateSettings> | undefined): UpdateSettings {
  const skipped = raw?.skipped;
  return { auto: raw?.auto !== false, skipped: typeof skipped === "string" && /^\d+\.\d+\.\d+/.test(skipped) ? skipped.slice(0, 40) : null };
}

/** The clipboard history's page side (the history and its recording settings live in the backend, see clipboard/mod.rs). */
/** The user guide (src/guide). */
export interface GuideSettings {
  /** The article read last; it opens there next time. */
  last: string | null;
}

function normalizeGuide(raw: Partial<GuideSettings> | undefined): GuideSettings {
  const last = raw?.last;
  return { last: typeof last === "string" && /^[a-z0-9-]{1,40}$/.test(last) ? last : null };
}

export interface ClipboardSettings {
  /** Emoji, kaomoji and symbols picked lately in the Win+V popup, most recent first. */
  recent: string[];
  /** The Clipboard section's filter. */
  filter: "all" | "text" | "image" | "files" | "pinned";
}

/** Studio: Photo and the Video Editor. */
export interface StudioSettings {
  /** Projects and pictures opened lately, most recent first (at most 40). */
  recent: string[];
  /** Settings of Photo and the Video Editor, by app (each normalizes its own). */
  apps: Record<string, unknown>;
}

const DEFAULT_STUDIO: StudioSettings = { recent: [], apps: {} };

function normalizeStudio(raw: Partial<StudioSettings> | undefined): StudioSettings {
  const recent = Array.isArray(raw?.recent) ? [...new Set(raw.recent.filter((p): p is string => typeof p === "string"))].slice(0, 40) : [];
  const apps = raw?.apps && typeof raw.apps === "object" && !Array.isArray(raw.apps) ? raw.apps : {};
  return { recent, apps };
}

const DEFAULT_CLIPBOARD: ClipboardSettings = { recent: [], filter: "all" };

function normalizeClipboard(raw: Partial<ClipboardSettings> | undefined): ClipboardSettings {
  const filters: ClipboardSettings["filter"][] = ["all", "text", "image", "files", "pinned"];
  return {
    recent: Array.isArray(raw?.recent) ? [...new Set(raw.recent.filter((r): r is string => typeof r === "string" && r.length < 64))].slice(0, 24) : [],
    filter: filters.includes(raw?.filter as ClipboardSettings["filter"]) ? (raw!.filter as ClipboardSettings["filter"]) : "all",
  };
}

/** Wallet (the ledger itself lives in the backend, see wallet/mod.rs). */
export interface WalletSettings {
  /** Amounts show as ••• (for sharing the screen). */
  hideAmounts: boolean;
  /** An uploaded statement goes straight in when its balance check passes (else it's shown first). */
  autoImportStatements: boolean;
  /** Which account a statement goes to, by its bank and the last four digits ("bkash|5678"). */
  statementAccounts: Record<string, string>;
}

const DEFAULT_WALLET: WalletSettings = { hideAmounts: false, autoImportStatements: false, statementAccounts: {} };

function normalizeWallet(raw: Partial<WalletSettings> | undefined): WalletSettings {
  const accounts: Record<string, string> = {};
  if (raw?.statementAccounts && typeof raw.statementAccounts === "object") {
    for (const [k, v] of Object.entries(raw.statementAccounts)) if (typeof v === "string" && k.length < 120) accounts[k] = v;
  }
  return { ...DEFAULT_WALLET, hideAmounts: raw?.hideAmounts === true, autoImportStatements: raw?.autoImportStatements === true, statementAccounts: accounts };
}

/** Office: Docs and Sheets. */
export interface OfficeSettings {
  /** Files opened lately, most recent first (at most 40). */
  recent: string[];
  /** Files pinned on Home. */
  pinned: string[];
}

const DEFAULT_OFFICE: OfficeSettings = { recent: [], pinned: [] };

function normalizeOffice(raw: Partial<OfficeSettings> | undefined): OfficeSettings {
  const paths = (list: unknown) => (Array.isArray(list) ? [...new Set(list.filter((p): p is string => typeof p === "string"))] : []);
  return { recent: paths(raw?.recent).slice(0, 40), pinned: paths(raw?.pinned) };
}

/** Sticky notes (the notes themselves and their sync live in the backend, see notes/mod.rs). */
export interface NotesSettings {
  /** Notes that were on the desktop when Zazabor last ran open again at the start. */
  reopen: boolean;
  /** How the Notes section shows them: a board of cards, or Kanban columns by status. */
  layout: "board" | "kanban";
  /** The Kanban columns, left to right; a note's status is one of these names. */
  columns: string[];
}

const DEFAULT_NOTES: NotesSettings = { reopen: true, layout: "board", columns: ["To do", "In progress", "Done"] };

function normalizeNotes(raw: Partial<NotesSettings> | undefined): NotesSettings {
  const columns = Array.isArray(raw?.columns) ? [...new Set(raw.columns.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim()))] : null;
  return {
    reopen: raw?.reopen !== false,
    layout: raw?.layout === "kanban" ? "kanban" : "board",
    columns: columns ?? [...DEFAULT_NOTES.columns],
  };
}

/** The Terminal section and the editor's terminal panel. */
export interface TerminalSettings {
  fontSize: number;
  /** Path of the shell new terminals start; "" = the user's login shell. */
  shell: string;
  /** Command blocks through shell integration (marks emitted by a script loaded into the shell). */
  integration: boolean;
}

export const DEFAULT_TERMINAL: TerminalSettings = { fontSize: 13, shell: "", integration: true };

function normalizeTerminal(raw: Partial<TerminalSettings> | undefined): TerminalSettings {
  const t = { ...DEFAULT_TERMINAL, ...raw };
  return {
    fontSize: typeof t.fontSize === "number" ? Math.min(28, Math.max(8, Math.round(t.fontSize))) : DEFAULT_TERMINAL.fontSize,
    shell: typeof t.shell === "string" ? t.shell : "",
    integration: t.integration !== false,
  };
}

const DEFAULT_VIDEO: VideoSettings = {
  volume: 1,
  muted: false,
  sidebar: true,
  section: "home",
  positions: {},
  recent: [],
  controls: DEFAULT_VIDEO_CONTROLS,
  ext: {},
};

function normalizeVideo(raw: Partial<VideoSettings> | undefined): VideoSettings {
  const v = { ...DEFAULT_VIDEO, ...raw };
  const positions: Record<string, VideoPosition> = {};
  if (v.positions && typeof v.positions === "object") {
    for (const [path, p] of Object.entries(v.positions)) {
      if (p && typeof p.time === "number" && typeof p.length === "number" && typeof p.at === "number") positions[path] = p;
    }
  }
  return {
    volume: typeof v.volume === "number" ? Math.min(2, Math.max(0, v.volume)) : 1,
    muted: v.muted === true,
    sidebar: v.sidebar !== false,
    section: v.section === "videos" || v.section === "recent" ? v.section : "home",
    positions,
    recent: Array.isArray(v.recent) ? v.recent.filter((p) => typeof p === "string").slice(0, 50) : [],
    controls: Array.isArray(v.controls) && v.controls.every((c) => typeof c === "string") ? v.controls : DEFAULT_VIDEO_CONTROLS,
    ext: v.ext && typeof v.ext === "object" && !Array.isArray(v.ext) ? v.ext : {},
  };
}

const DEFAULT_FILES: FilesSettings = {
  showHidden: false,
  view: "icon",
  foldersFirst: true,
  iconSize: 96,
  sort: { key: "name", ascending: true },
  pinned: [],
  lastPath: null,
  confirmTrash: false,
  terminal: null,
  servers: [],
};

function normalizeFiles(raw: Partial<FilesSettings> | undefined): FilesSettings {
  const f = { ...DEFAULT_FILES, ...raw };
  const sort = f.sort && ["name", "date", "size", "kind"].includes(f.sort.key) ? f.sort : DEFAULT_FILES.sort;
  return {
    showHidden: f.showHidden === true,
    view: ["icon", "list", "column", "gallery"].includes(f.view) ? f.view : "icon",
    foldersFirst: f.foldersFirst !== false,
    iconSize: typeof f.iconSize === "number" && f.iconSize >= 48 && f.iconSize <= 256 ? f.iconSize : DEFAULT_FILES.iconSize,
    sort: { key: sort.key, ascending: sort.ascending !== false },
    pinned: Array.isArray(f.pinned) ? f.pinned.filter((p) => typeof p === "string") : [],
    lastPath: typeof f.lastPath === "string" ? f.lastPath : null,
    confirmTrash: f.confirmTrash === true,
    terminal: typeof f.terminal === "string" && f.terminal.trim() ? f.terminal.trim() : null,
    servers: Array.isArray(f.servers)
      ? f.servers.filter((s): s is SavedServer => !!s && typeof s.name === "string" && typeof s.url === "string")
      : [],
  };
}

function normalizeFeatures(raw: Partial<Record<ModuleId, boolean>> | undefined): Record<ModuleId, boolean> {
  const features = Object.fromEntries(MODULE_IDS.map((id) => [id, raw?.[id] !== false])) as Record<ModuleId, boolean>;
  if (!MODULE_IDS.some((id) => features[id])) features.gallery = true;
  return features;
}

const DEFAULTS: Config = {
  roots: [],
  hiddenAlbums: [],
  favoriteAlbums: [],
  libraryView: "albums",
  autoLockMinutes: 5,
  thumbSize: 168,
  sort: "date",
  showInfo: false,
  showFilmstrip: true,
  slideshow: normalizeSettings(undefined),
  appearance: normalizeAppearance(undefined),
  features: normalizeFeatures(undefined),
  module: "files",
  onboarded: false,
  files: DEFAULT_FILES,
  video: DEFAULT_VIDEO,
  terminal: DEFAULT_TERMINAL,
  notes: structuredClone(DEFAULT_NOTES),
  wallet: structuredClone(DEFAULT_WALLET),
  office: structuredClone(DEFAULT_OFFICE),
  clipboard: structuredClone(DEFAULT_CLIPBOARD),
  studio: structuredClone(DEFAULT_STUDIO),
  guide: { last: null },
  updates: { auto: true, skipped: null },
};

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await api.loadConfig();
    if (!raw) return structuredClone(DEFAULTS);
    return parseConfig(raw);
  } catch (err) {
    console.warn("Could not read config, using defaults:", err);
    return structuredClone(DEFAULTS);
  }
}

/** A saved config with every field checked and defaults filled in; throws on malformed JSON. */
export function parseConfig(raw: string): Config {
  const parsed = JSON.parse(raw) as Partial<Config>;
  return {
    ...structuredClone(DEFAULTS),
    ...parsed,
    roots: Array.isArray(parsed.roots) ? parsed.roots.filter((r) => typeof r === "string") : [],
    hiddenAlbums: Array.isArray(parsed.hiddenAlbums) ? parsed.hiddenAlbums.filter((r) => typeof r === "string") : [],
    favoriteAlbums: Array.isArray(parsed.favoriteAlbums) ? parsed.favoriteAlbums.filter((r) => typeof r === "string") : [],
    libraryView: parsed.libraryView === "photos" || parsed.libraryView === "favorites" ? parsed.libraryView : "albums",
    sort: parsed.sort === "name" ? "name" : "date",
    slideshow: normalizeSettings(parsed.slideshow),
    appearance: normalizeAppearance(parsed.appearance),
    features: normalizeFeatures(parsed.features),
    module: MODULE_IDS.includes(parsed.module as ModuleId) ? (parsed.module as ModuleId) : "files",
    onboarded: parsed.onboarded === true,
    files: normalizeFiles(parsed.files),
    video: normalizeVideo(parsed.video),
    terminal: normalizeTerminal(parsed.terminal),
    notes: normalizeNotes(parsed.notes),
    wallet: normalizeWallet(parsed.wallet),
    office: normalizeOffice(parsed.office),
    clipboard: normalizeClipboard(parsed.clipboard),
    studio: normalizeStudio(parsed.studio),
    guide: normalizeGuide(parsed.guide),
    updates: normalizeUpdates(parsed.updates),
  };
}

let saveTimer: number | undefined;

/** Persists the config shortly after the last change, and hands it to the other windows. */
export function saveConfig(config: Config) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const json = JSON.stringify(config, null, 2);
    api.saveConfig(json)
      .then(() => tellOthers(CONFIG_SAVED, json))
      .catch((err) => console.error("Saving config failed:", err));
  }, 400);
}

/** The event that carries a saved config to the other windows. */
export const CONFIG_SAVED = "config-saved";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Takes another window's saved config into this one in place: objects are merged key by key (code
 * holds references into the config, e.g. `config.video`), everything else is replaced. Which module
 * this window shows stays its own.
 */
export function adoptConfig(config: Config, incoming: Config) {
  const merge = (target: Record<string, unknown>, source: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(source)) {
      const current = target[key];
      if (isObject(value) && isObject(current)) merge(current, value);
      else target[key] = value;
    }
  };
  const { module: _own, ...rest } = incoming;
  merge(config as unknown as Record<string, unknown>, rest as unknown as Record<string, unknown>);
}
