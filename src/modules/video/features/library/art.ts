import { art, coverUrl, videoThumb, type ArtOptions } from "./widgets";
import { isAudioPath, isUrl, type Library } from "./store";

/**
 * The picture for a path: cover art for songs, a frame for videos, an icon for streams. Songs
 * the library doesn't know yet ask the backend for their tags (and so their cover).
 */
export function pathArt(lib: Library, path: string, size: number, options: Partial<ArtOptions> = {}): HTMLElement {
  if (isUrl(path)) return art({ icon: "network", shape: "square", iconSize: Math.max(14, size / 8), ...options });
  if (isAudioPath(path)) {
    const cover = lib.coverOf(path);
    if (!cover && !lib.songAt(path) && !lib.info(path)) lib.wantInfo([path]);
    return art({ src: cover ? coverUrl(cover, size) : null, icon: "music", shape: "square", iconSize: Math.max(14, size / 8), ...options });
  }
  return art({ src: videoThumb(path, 0, size), icon: "film", shape: "wide", iconSize: Math.max(14, size / 8), ...options });
}
