import type { Config } from "../../../../config";
import type { ShellContext } from "../../../../shell/module";
import { clamp } from "../../../../ui/dom";
import { featureSettings } from "../../extensions";
import type { MediaOptions } from "../../media-api";

/** A saved set of video settings plus the control-bar layout. */
export interface VideoProfile {
  id: string;
  name: string;
  controls: string[];
  /** Only the settings that belong to a profile (see `PROFILE_KEYS`). */
  values: Partial<MediaSettings>;
}

/** The video settings edited on the Settings page (stored as `config.video.ext.media`). */
export interface MediaSettings {
  // Interface
  /** The player's accent: follow Zazabor's, or the video module's orange preset. */
  playerAccent: "app" | "orange";
  /** Liquid Glass: the controls float over the video and bend it, as on macOS 26; off docks the bar. */
  glassControls: boolean;
  // Playback
  resume: "always" | "ask" | "never";
  defaultSpeed: number;
  skipSeconds: number;
  bigSkipSeconds: number;
  // Video
  deinterlace: MediaOptions["deinterlace"];
  skipLoopFilter: MediaOptions["skipLoopFilter"];
  fastDecode: boolean;
  // Audio
  volumeStep: number;
  replayGain: MediaOptions["replayGain"];
  // Subtitles and on-screen messages
  showOsd: boolean;
  osdSeconds: number;
  showKeys: boolean;
  // Library
  keepHistory: boolean;
  // Network
  networkCaching: number;
  httpReconnect: boolean;
  rememberUrls: boolean;
  detectPlaylists: boolean;
  // Performance
  hardwareDecoding: boolean;
  threads: number;
  // Recording and casting
  convertWhere: "source" | "folder";
  convertFolder: string;
  convertProfile: string;
  convertNotify: boolean;
  castMenu: boolean;

  // Not part of profiles
  introSeen: boolean;
  recentUrls: string[];
  profiles: VideoProfile[];
  /** "default" is the built-in profile. */
  activeProfile: string;
}

export const MEDIA_DEFAULTS: MediaSettings = {
  playerAccent: "app",
  glassControls: true,
  resume: "always",
  defaultSpeed: 1,
  skipSeconds: 5,
  bigSkipSeconds: 30,
  deinterlace: "auto",
  skipLoopFilter: "normal",
  fastDecode: false,
  volumeStep: 5,
  replayGain: "none",
  showOsd: true,
  osdSeconds: 0.9,
  showKeys: true,
  keepHistory: true,
  networkCaching: 1000,
  httpReconnect: true,
  rememberUrls: true,
  detectPlaylists: true,
  hardwareDecoding: true,
  threads: 0,
  convertWhere: "source",
  convertFolder: "",
  convertProfile: "mp4",
  convertNotify: true,
  castMenu: true,
  introSeen: false,
  recentUrls: [],
  profiles: [],
  activeProfile: "default",
};

const NOT_IN_PROFILES = ["introSeen", "recentUrls", "profiles", "activeProfile"] as const;

/** The settings a profile stores. */
export const PROFILE_KEYS = (Object.keys(MEDIA_DEFAULTS) as (keyof MediaSettings)[]).filter(
  (key) => !(NOT_IN_PROFILES as readonly string[]).includes(key),
);

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);
const num = (value: unknown, lo: number, hi: number, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? clamp(value, lo, hi) : fallback);
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** Repairs values of the wrong type or range in place (settings files can be edited by hand). */
function normalize(s: MediaSettings): MediaSettings {
  const d = MEDIA_DEFAULTS;
  s.playerAccent = oneOf(s.playerAccent, ["app", "orange"], d.playerAccent);
  s.glassControls = bool(s.glassControls, d.glassControls);
  s.resume = oneOf(s.resume, ["always", "ask", "never"], d.resume);
  s.defaultSpeed = num(s.defaultSpeed, 0.25, 2, d.defaultSpeed);
  s.skipSeconds = Math.round(num(s.skipSeconds, 1, 120, d.skipSeconds));
  s.bigSkipSeconds = Math.round(num(s.bigSkipSeconds, 5, 600, d.bigSkipSeconds));
  s.deinterlace = oneOf(s.deinterlace, ["auto", "on", "off"], d.deinterlace);
  s.skipLoopFilter = oneOf(s.skipLoopFilter, ["normal", "faster"], d.skipLoopFilter);
  s.fastDecode = bool(s.fastDecode, d.fastDecode);
  s.volumeStep = Math.round(num(s.volumeStep, 1, 25, d.volumeStep));
  s.replayGain = oneOf(s.replayGain, ["none", "track", "album"], d.replayGain);
  s.showOsd = bool(s.showOsd, d.showOsd);
  s.osdSeconds = num(s.osdSeconds, 0.3, 5, d.osdSeconds);
  s.showKeys = bool(s.showKeys, d.showKeys);
  s.keepHistory = bool(s.keepHistory, d.keepHistory);
  s.networkCaching = Math.round(num(s.networkCaching, 100, 30_000, d.networkCaching));
  s.httpReconnect = bool(s.httpReconnect, d.httpReconnect);
  s.rememberUrls = bool(s.rememberUrls, d.rememberUrls);
  s.detectPlaylists = bool(s.detectPlaylists, d.detectPlaylists);
  s.hardwareDecoding = bool(s.hardwareDecoding, d.hardwareDecoding);
  s.threads = Math.round(num(s.threads, 0, 16, d.threads));
  s.convertWhere = oneOf(s.convertWhere, ["source", "folder"], d.convertWhere);
  s.convertFolder = typeof s.convertFolder === "string" ? s.convertFolder : "";
  s.convertProfile = typeof s.convertProfile === "string" ? s.convertProfile : d.convertProfile;
  s.convertNotify = bool(s.convertNotify, d.convertNotify);
  s.castMenu = bool(s.castMenu, d.castMenu);
  s.introSeen = s.introSeen === true;
  s.recentUrls = Array.isArray(s.recentUrls) ? s.recentUrls.filter((u) => typeof u === "string").slice(0, 12) : [];
  s.profiles = Array.isArray(s.profiles)
    ? s.profiles.filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.controls) && p.values && typeof p.values === "object")
    : [];
  s.activeProfile = typeof s.activeProfile === "string" ? s.activeProfile : "default";
  if (s.activeProfile !== "default" && !s.profiles.some((p) => p.id === s.activeProfile)) s.activeProfile = "default";
  return s;
}

const made = new WeakSet<object>();

/**
 * The video settings, with defaults filled in and values repaired. The same object comes back
 * until the config is replaced, so editing it edits what gets saved.
 */
export function mediaSettings(host: { readonly config: Config }): MediaSettings {
  const current = host.config.video.ext.media;
  if (current && typeof current === "object" && made.has(current)) return current as MediaSettings;
  const settings = normalize(featureSettings({ config: host.config } as ShellContext, "media", MEDIA_DEFAULTS));
  made.add(settings);
  return settings;
}

/** The libVLC instance options derived from the settings. */
export function optionsOf(s: MediaSettings): MediaOptions {
  return {
    hardwareDecoding: s.hardwareDecoding,
    networkCaching: s.networkCaching,
    httpReconnect: s.httpReconnect,
    deinterlace: s.deinterlace,
    skipLoopFilter: s.skipLoopFilter,
    fastDecode: s.fastDecode,
    replayGain: s.replayGain,
    threads: s.threads,
  };
}

// ---- change notifications ---------------------------------------------------------------------

const listeners = new Set<(keys: (keyof MediaSettings)[]) => void>();

/** Calls `fn` after video settings changed (from Settings, a profile switch or the intro). */
export function onMediaSettings(fn: (keys: (keyof MediaSettings)[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyMediaSettings(keys: (keyof MediaSettings)[]) {
  for (const fn of [...listeners]) fn(keys);
}
