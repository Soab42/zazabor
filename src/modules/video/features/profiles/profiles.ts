import type { Config } from "../../../../config";
import { DEFAULT_VIDEO_CONTROLS } from "../../../../config";
import { MEDIA_DEFAULTS, PROFILE_KEYS, mediaSettings, notifyMediaSettings, type MediaSettings, type VideoProfile } from "./settings";

/** What profile operations need from the app: the config, saving it, and telling the player. */
export interface ProfileHost {
  readonly config: Config;
  /** Persist the config. */
  save(): void;
  /** The video part of the config changed under the player (re-render the control bar). */
  changed(): void;
}

export const DEFAULT_PROFILE_ID = "default";

/** The built-in profile: the factory layout and settings. It can't be renamed or deleted. */
export function defaultProfile(): VideoProfile {
  const values: Partial<MediaSettings> = {};
  for (const key of PROFILE_KEYS) (values as Record<string, unknown>)[key] = MEDIA_DEFAULTS[key];
  return { id: DEFAULT_PROFILE_ID, name: "Default", controls: [...DEFAULT_VIDEO_CONTROLS], values };
}

/** The built-in profile first, then the saved ones. */
export function listProfiles(host: ProfileHost): VideoProfile[] {
  return [defaultProfile(), ...mediaSettings(host).profiles];
}

export function activeProfile(host: ProfileHost): VideoProfile {
  const id = mediaSettings(host).activeProfile;
  return listProfiles(host).find((p) => p.id === id) ?? defaultProfile();
}

/** The current layout and profile settings as a profile's content. */
function snapshot(host: ProfileHost): Pick<VideoProfile, "controls" | "values"> {
  const s = mediaSettings(host);
  const values: Partial<MediaSettings> = {};
  for (const key of PROFILE_KEYS) (values as Record<string, unknown>)[key] = s[key];
  return { controls: [...host.config.video.controls], values };
}

const cleanName = (name: string) => name.trim().replace(/\s+/g, " ").slice(0, 40);

/** A name that no other profile uses ("Movies", "Movies 2", …). */
function uniqueName(profiles: VideoProfile[], wanted: string, ignore?: string): string {
  const base = cleanName(wanted) || "Profile";
  const taken = new Set(profiles.filter((p) => p.id !== ignore).map((p) => p.name.toLowerCase()));
  taken.add(defaultProfile().name.toLowerCase());
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

/** Saves the current layout and settings as a new profile and makes it the active one. */
export function saveProfile(host: ProfileHost, name: string): VideoProfile {
  const s = mediaSettings(host);
  const profile: VideoProfile = {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: uniqueName(s.profiles, name),
    ...snapshot(host),
  };
  s.profiles = [...s.profiles, profile];
  s.activeProfile = profile.id;
  host.save();
  return profile;
}

/** Overwrites a saved profile with the current layout and settings. */
export function updateProfile(host: ProfileHost, id: string) {
  const s = mediaSettings(host);
  if (!s.profiles.some((p) => p.id === id)) return;
  s.profiles = s.profiles.map((p) => (p.id === id ? { ...p, ...snapshot(host) } : p));
  host.save();
}

export function renameProfile(host: ProfileHost, id: string, name: string) {
  const s = mediaSettings(host);
  s.profiles = s.profiles.map((p) => (p.id === id ? { ...p, name: uniqueName(s.profiles, name, id) } : p));
  host.save();
}

export function deleteProfile(host: ProfileHost, id: string) {
  const s = mediaSettings(host);
  s.profiles = s.profiles.filter((p) => p.id !== id);
  if (s.activeProfile === id) s.activeProfile = DEFAULT_PROFILE_ID;
  host.save();
}

/** Applies a profile: its control-bar layout and its settings. */
export function switchProfile(host: ProfileHost, id: string) {
  const profile = listProfiles(host).find((p) => p.id === id);
  if (!profile) return;
  const s = mediaSettings(host);
  const changed: (keyof MediaSettings)[] = [];
  for (const key of PROFILE_KEYS) {
    const value = key in profile.values ? profile.values[key] : MEDIA_DEFAULTS[key];
    (s as unknown as Record<string, unknown>)[key] = value;
    changed.push(key);
  }
  s.activeProfile = profile.id;
  host.config.video.controls = [...profile.controls];
  host.save();
  host.changed();
  notifyMediaSettings(changed);
}
