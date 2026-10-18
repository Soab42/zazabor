/**
 * Which subtitle file belongs to which episode: by SxxEyy or episode number, then by name
 * similarity, then by order. Also the show name used for per-show presets.
 */

export interface EpisodeInfo {
  season: number | null;
  episode: number | null;
}

const base = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
const parent = (path: string) => {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length > 1 ? parts[parts.length - 2] : "";
};
const grandparent = (path: string) => {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length > 2 ? parts[parts.length - 3] : "";
};
const stripExt = (name: string) => name.replace(/\.[a-z0-9]{2,4}$/i, "");

/** Language tags and release noise that say nothing about which episode a name is. */
const NOISE =
  /\b(\d{3,4}p|\d{3,4}x\d{3,4}|[xh]\.?26[45]|hevc|avc|web[- ]?dl|web[- ]?rip|blu[- ]?ray|bdrip|brrip|hdtv|dvdrip|hdrip|aac|ac3|dts|ddp?\d?(?:\.\d)?|10bit|8bit|remux|proper|repack|extended|uncut|esub|multi|dual|audio|subs?|subbed|dubbed|hardsub|eng|english|hindi|spanish|french|german|italian|portuguese|russian|japanese|korean|chinese|arabic|turkish|forced|sdh|cc)\b/gi;

/** Season and episode from a file name; null where it doesn't say. */
export function episodeOf(path: string): EpisodeInfo {
  const name = stripExt(base(path));
  let m = /\bS(\d{1,2})[ ._-]*E(\d{1,3})(?:[ ._-]*E?\d{1,3})?\b/i.exec(name);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = /\b(\d{1,2})x(\d{2,3})\b/i.exec(name);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = /\bseason[ ._-]*(\d{1,2})[ ._-]*(?:episode|ep|e)[ ._-]*(\d{1,3})\b/i.exec(name);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = /\b(?:episode|ep|e)[ ._-]*(\d{1,3})\b/i.exec(name);
  if (m) return { season: null, episode: Number(m[1]) };
  // "[Group] Name - 12 [1080p]": the last bare number once tags are removed.
  const bare = name.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(NOISE, " ");
  const numbers = [...bare.matchAll(/(?:^|[\s._-])(\d{1,3})(?=$|[\s._-])/g)];
  if (numbers.length) return { season: null, episode: Number(numbers[numbers.length - 1][1]) };
  return { season: null, episode: null };
}

/** A stable key such as "S01E02" ("E12" without a season), or null when no episode. */
export function episodeKey(path: string): string | null {
  const { season, episode } = episodeOf(path);
  if (episode == null) return null;
  const e = String(episode).padStart(2, "0");
  return season == null ? `E${e}` : `S${String(season).padStart(2, "0")}E${e}`;
}

function sameEpisode(a: EpisodeInfo, b: EpisodeInfo): boolean {
  if (a.episode == null || b.episode == null || a.episode !== b.episode) return false;
  return a.season == null || b.season == null || a.season === b.season;
}

/** Lower-case words of a name without extension, language tags, release noise and episode marks. */
export function nameTokens(path: string): string[] {
  return stripExt(base(path))
    .replace(/\[[^\]]*\]/g, " ")
    .replace(NOISE, " ")
    .replace(/\bS\d{1,2}[ ._-]*E\d{1,3}\b/gi, " ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** 0–1 Dice similarity of two names by their words. */
export function nameSimilarity(a: string, b: string): number {
  const x = nameTokens(a), y = nameTokens(b);
  if (!x.length || !y.length) return 0;
  const counts = new Map<string, number>();
  for (const t of x) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of y) {
    const n = counts.get(t) ?? 0;
    if (n > 0) {
      shared++;
      counts.set(t, n - 1);
    }
  }
  return (2 * shared) / (x.length + y.length);
}

/** The language code in a subtitle name such as "Show.S01E02.en.srt" or "…[French].srt", if any. */
export function languageOf(path: string): string | null {
  const name = stripExt(base(path)).toLowerCase();
  const tag = /[.\-_ \[(]([a-z]{2,3}(?:-[a-z]{2})?|english|spanish|french|german|italian|portuguese|russian|japanese|korean|chinese|arabic|turkish|hindi|dutch|polish|swedish)[\])]?$/.exec(name);
  return tag ? tag[1] : null;
}

export type MatchReason = "remembered" | "episode" | "name" | "order" | "none";

export interface SubtitleMatch {
  video: string;
  sub: string | null;
  reason: MatchReason;
}

/**
 * Pairs each video with a subtitle file. `remembered` maps episode keys to subtitle paths chosen
 * before (it wins); `preferLang` breaks ties between languages of the same episode.
 */
export function matchEpisodes(videos: string[], subs: string[], remembered: Record<string, string> = {}, preferLang?: string): SubtitleMatch[] {
  const used = new Set<string>();
  const result = new Map<string, SubtitleMatch>();
  const infos = new Map<string, EpisodeInfo>();
  const info = (p: string) => infos.get(p) ?? (infos.set(p, episodeOf(p)), infos.get(p)!);
  const wantLang = preferLang?.toLowerCase();

  const pick = (video: string, candidates: string[]): string | undefined => {
    return [...candidates]
      .map((sub) => {
        const lang = languageOf(sub);
        const langScore = wantLang && lang && (lang === wantLang || lang.startsWith(wantLang) || wantLang.startsWith(lang)) ? 0.3 : 0;
        return { sub, score: nameSimilarity(video, sub) + langScore - base(sub).length / 10_000 };
      })
      .sort((a, b) => b.score - a.score)[0]?.sub;
  };

  // 1. Choices made before.
  for (const video of videos) {
    const key = episodeKey(video);
    const sub = key ? remembered[key] : undefined;
    if (sub && subs.includes(sub)) {
      result.set(video, { video, sub, reason: "remembered" });
      used.add(sub);
    }
  }
  // 2. Same episode number.
  for (const video of videos) {
    if (result.has(video)) continue;
    const candidates = subs.filter((s) => !used.has(s) && sameEpisode(info(video), info(s)));
    const sub = pick(video, candidates);
    if (sub) {
      result.set(video, { video, sub, reason: "episode" });
      // Other languages of the same episode stay available for the other videos' tie-breaks, but
      // a file is never given to two videos.
      used.add(sub);
    }
  }
  // 3. Similar names, best pairs first.
  const pairs: { video: string; sub: string; score: number }[] = [];
  for (const video of videos) {
    if (result.has(video)) continue;
    for (const sub of subs) if (!used.has(sub)) pairs.push({ video, sub, score: nameSimilarity(video, sub) });
  }
  pairs.sort((a, b) => b.score - a.score);
  for (const { video, sub, score } of pairs) {
    if (score < 0.6 || result.has(video) || used.has(sub)) continue;
    result.set(video, { video, sub, reason: "name" });
    used.add(sub);
  }
  // 4. What is left, in order, when there are as many files as videos.
  const freeVideos = videos.filter((v) => !result.has(v));
  const freeSubs = subs.filter((s) => !used.has(s));
  if (freeVideos.length > 0 && freeVideos.length === freeSubs.length) {
    freeVideos.forEach((video, i) => result.set(video, { video, sub: freeSubs[i], reason: "order" }));
  }
  return videos.map((video) => result.get(video) ?? { video, sub: null, reason: "none" });
}

// ---- shows -------------------------------------------------------------------------------------

export interface ShowInfo {
  /** Readable name, e.g. "Breaking Bad". */
  name: string;
  /** Lower-case key for presets and memory. */
  key: string;
  /** "S01E02" style label, or "" when the file has no episode. */
  label: string;
}

const SEASON_FOLDER = /^(season|series|staffel|saison|temporada|s)[ ._-]*\d{1,2}$|^specials?$/i;

function tidyName(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(NOISE, " ")
    .replace(/[._]+/g, " ")
    .replace(/\(?\b(19|20)\d{2}\b\)?/g, " ")
    .replace(/[\s-]+$|^[\s-]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The show a video belongs to: from "Name S01E02 …" in the file name, else from its folder. */
export function showOf(path: string): ShowInfo {
  const file = stripExt(base(path));
  const key = episodeKey(path);
  let name = "";
  const marker = /^(.*?)[ ._-]+(?:S\d{1,2}[ ._-]*E\d{1,3}|\d{1,2}x\d{2,3}|season[ ._-]*\d+)/i.exec(file);
  if (marker) name = tidyName(marker[1]);
  if (!name) {
    let folder = parent(path);
    if (SEASON_FOLDER.test(folder.trim())) folder = grandparent(path);
    name = tidyName(folder) || tidyName(file);
  }
  const lower = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return { name: name || file, key: lower || file.toLowerCase(), label: key ?? "" };
}
