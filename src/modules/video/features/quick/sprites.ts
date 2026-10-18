import { onSpriteFrame, quickApi, spriteFrameUrl, type SpriteInfo } from "../../quick-api";

/** The preview frame to show for a time: its URL and the time it actually shows. */
export interface PreviewFrame {
  url: string;
  time: number;
}

/**
 * The seek bar's preview frames. `start` asks the backend to make them for the open file;
 * `frameAt` returns the nearest one that exists so far (the bar fills in as they arrive).
 */
class Sprites {
  private info: SpriteInfo | null = null;
  private ready = new Set<number>();
  private salt = 0;
  private wanted = "";
  private unlisten: (() => void) | undefined;

  /** Begins (or continues) preview generation for a file; a no-op for the same file and length. */
  start(path: string, length: number) {
    const key = `${path}|${Math.round(length)}`;
    if (key === this.wanted) return;
    this.wanted = key;
    this.info = null;
    this.ready = new Set();
    this.listen();
    quickApi
      .spriteStart(path, length)
      .then((info) => {
        if (key !== this.wanted || !info) return;
        this.info = info;
        this.salt = Math.round(length);
        for (const i of info.ready) this.ready.add(i);
      })
      .catch((err) => console.warn("Could not start seek previews:", err));
  }

  stop() {
    if (!this.wanted) return;
    this.wanted = "";
    this.info = null;
    this.ready = new Set();
    quickApi.spriteStop().catch(() => undefined);
  }

  private listen() {
    if (this.unlisten) return;
    this.unlisten = () => undefined;
    onSpriteFrame(({ path, index }) => {
      if (this.info && this.info.path === path) this.ready.add(index);
    })
      .then((unlisten) => (this.unlisten = unlisten))
      .catch((err) => console.warn("Could not follow seek previews:", err));
  }

  /** The nearest existing frame to `time` (ms) in the current file, or null while none exists. */
  frameAt(time: number): PreviewFrame | null {
    const info = this.info;
    if (!info || this.ready.size === 0) return null;
    const ideal = Math.max(0, Math.min(info.count - 1, Math.floor(time / info.intervalMs)));
    const index = nearest(this.ready, ideal, info.count);
    if (index === null) return null;
    return {
      url: spriteFrameUrl(info.path, info.intervalMs, index, this.salt),
      time: index * info.intervalMs + info.intervalMs / 2,
    };
  }
}

/** The index in `ready` closest to `ideal` (ties go earlier), searching outward. */
export function nearest(ready: ReadonlySet<number>, ideal: number, count: number): number | null {
  for (let d = 0; d < count; d++) {
    if (ready.has(ideal - d)) return ideal - d;
    if (ready.has(ideal + d)) return ideal + d;
  }
  return null;
}

export const sprites = new Sprites();
