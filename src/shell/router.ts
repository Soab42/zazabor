import { api } from "../api";

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "mts", "3gp", "ogv", "vob"]);

export type PathClass = "dir" | "image" | "video" | "other" | "missing";

/** Tells what a path is, so the shell can pick the module that opens it. */
export async function classifyPath(path: string): Promise<PathClass> {
  const kind: string = await api.pathKind(path).catch(() => "missing");
  if (kind === "dir" || kind === "image" || kind === "video" || kind === "missing") return kind;
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext) ? "video" : "other";
}
