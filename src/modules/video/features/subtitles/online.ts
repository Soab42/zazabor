import { panelApi } from "../../panel-api";

/**
 * OpenSubtitles (REST API v1, https://api.opensubtitles.com): search by file hash and name,
 * download as a file. Requests go through the backend (`video_online_request`) because the
 * webview may not contact other sites. A free API key is needed (the user enters it in the
 * Subtitles tab's advanced section); downloading also wants an account (user name + password).
 */

export interface OnlineSettings {
  apiKey: string;
  username: string;
  /** Two-letter code for searches. */
  language: string;
}

export interface OnlineResult {
  fileId: number;
  fileName: string;
  language: string;
  release: string;
  downloads: number;
  title: string;
  season: number | null;
  episode: number | null;
  /** Found by the file's hash, so it was made for this exact file. */
  hashMatch: boolean;
}

export const HOW_TO_GET_A_KEY = [
  "Create a free account at opensubtitles.com.",
  "Open your profile, then “Consumers”, and create an API consumer.",
  "Copy the API key into the Subtitles tab, under Advanced, with your user name and password.",
];

/** The session's password and login token; never saved. */
const session = { password: "", token: "", tokenFor: "" };
export const setOnlinePassword = (password: string) => {
  session.password = password;
  session.token = "";
};
export const hasOnlinePassword = () => session.password !== "";

/** Query strings must have lower-case, alphabetical parameters; brackets etc. are escaped for the backend. */
export function buildSearchPath(params: Record<string, string | number | undefined>): string {
  const encode = (v: string) => encodeURIComponent(v).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => [k.toLowerCase(), encode(String(v).toLowerCase())] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`);
  return `/subtitles?${parts.join("&")}`;
}

function failure(status: number, body: string): Error {
  if (status === 401 || status === 403) return new Error("OpenSubtitles did not accept the API key, user name or password.");
  if (status === 406) return new Error("The OpenSubtitles download limit for today has been reached.");
  if (status === 429) return new Error("OpenSubtitles asked us to slow down. Try again in a moment.");
  let message = "";
  try {
    message = String((JSON.parse(body) as { message?: unknown }).message ?? "");
  } catch {
    // not JSON
  }
  return new Error(message ? `OpenSubtitles: ${message}` : `OpenSubtitles replied with an error (${status}).`);
}

async function call<T>(settings: OnlineSettings, method: "GET" | "POST", path: string, body?: unknown, token?: string): Promise<T> {
  if (!settings.apiKey.trim()) throw new Error("Enter an OpenSubtitles API key first.");
  const reply = await panelApi.onlineRequest(method, path, settings.apiKey.trim(), token, body);
  if (reply.status < 200 || reply.status >= 300) throw failure(reply.status, reply.body);
  try {
    return JSON.parse(reply.body) as T;
  } catch {
    throw new Error("OpenSubtitles sent a reply that could not be read.");
  }
}

interface SearchReply {
  data?: {
    attributes?: {
      language?: string;
      release?: string;
      download_count?: number;
      moviehash_match?: boolean;
      feature_details?: { title?: string; movie_name?: string; season_number?: number; episode_number?: number };
      files?: { file_id?: number; file_name?: string }[];
    };
  }[];
}

/** Finds subtitles by the file's hash and by name; hash matches come first, then popular ones. */
export async function searchOnline(
  settings: OnlineSettings,
  query: { hash?: string; text: string; season?: number | null; episode?: number | null; language?: string },
): Promise<OnlineResult[]> {
  const path = buildSearchPath({
    episode_number: query.episode ?? undefined,
    languages: query.language ?? settings.language,
    moviehash: query.hash,
    query: query.text,
    season_number: query.season ?? undefined,
  });
  const reply = await call<SearchReply>(settings, "GET", path);
  const results: OnlineResult[] = [];
  for (const item of reply.data ?? []) {
    const a = item.attributes;
    const file = a?.files?.[0];
    if (!a || !file?.file_id) continue;
    results.push({
      fileId: file.file_id,
      fileName: String(file.file_name ?? a.release ?? "subtitle.srt"),
      language: String(a.language ?? ""),
      release: String(a.release ?? file.file_name ?? ""),
      downloads: Number(a.download_count ?? 0),
      title: String(a.feature_details?.title ?? a.feature_details?.movie_name ?? ""),
      season: a.feature_details?.season_number ?? null,
      episode: a.feature_details?.episode_number ?? null,
      hashMatch: !!a.moviehash_match,
    });
  }
  return results.sort((x, y) => Number(y.hashMatch) - Number(x.hashMatch) || y.downloads - x.downloads);
}

async function loginToken(settings: OnlineSettings): Promise<string | undefined> {
  if (!settings.username.trim() || !session.password) return undefined;
  const who = `${settings.apiKey}:${settings.username}`;
  if (session.token && session.tokenFor === who) return session.token;
  const reply = await call<{ token?: string }>(settings, "POST", "/login", { username: settings.username.trim(), password: session.password });
  if (!reply.token) throw new Error("OpenSubtitles did not accept the user name or password.");
  session.token = reply.token;
  session.tokenFor = who;
  return reply.token;
}

/** Downloads a result to a file and returns its path. */
export async function downloadOnline(settings: OnlineSettings, result: OnlineResult): Promise<string> {
  const token = await loginToken(settings);
  const reply = await call<{ link?: string; file_name?: string }>(settings, "POST", "/download", { file_id: result.fileId }, token);
  if (!reply.link) throw new Error("OpenSubtitles did not give a download link.");
  return panelApi.onlineDownload(reply.link, reply.file_name ?? result.fileName);
}
