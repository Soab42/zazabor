import { loadImage, previewUrl } from "../../../api";
import { basename } from "../../../ui/dom";
import { fsApi } from "../../files/api";
import { editApi } from "./api";
import { uid, type Media } from "./model";

/**
 * What the editor knows about its files beyond the project: thumbnail strips, pictures, and
 * sound (decoded once into an AudioBuffer, which preview and export both play, plus the
 * waveform's peaks). Everything is cached per media id for the life of the editor.
 */

export const PICTURE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "bmp", "gif", "avif", "tif", "tiff"];
export const AUDIO_EXTENSIONS = ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "wma"];
export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "3gp", "mts", "m2ts", "ts", "wmv", "flv", "ogv"];

const ext = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

export interface Strip {
  url: string;
  /** One picture's size in the sprite. */
  thumbWidth: number;
  thumbHeight: number;
  count: number;
}

export interface Sound {
  buffer: AudioBuffer;
  /** Loudest sample per 10 ms, 0…255. */
  peaks: Uint8Array;
}

/** Peaks per second in `Sound.peaks`. */
export const PEAK_RATE = 100;
const STRIP_HEIGHT = 96;
const PICTURE_SIZE = 2048;

/** Reads a file into a Media item (a new id each time). */
export async function probeMedia(path: string): Promise<Media> {
  const name = basename(path);
  if (PICTURE_EXTENSIONS.includes(ext(path))) {
    const [img, bytes] = await Promise.all([loadImage(previewUrl(path, 0, 256)), fsApi.stat(path).then((e) => e.size, () => undefined)]);
    return { id: uid(), path, name, kind: "image", duration: 0, width: img.naturalWidth, height: img.naturalHeight, fps: 0, audio: false, bytes };
  }
  const p = await editApi.probe(path);
  if (p.video) {
    const notes: string[] = [];
    if (!p.video.decodable) notes.push(`No decoder for its picture (${p.video.codec ?? "unknown format"}).`);
    if (p.audio && !p.audio.decodable) notes.push(`Its sound (${p.audio.codec ?? "unknown"}) is read through VLC.`);
    return {
      id: uid(), path, name, kind: "video", duration: p.duration, width: p.video.width, height: p.video.height,
      fps: p.video.fps || 30, audio: !!p.audio, bytes: p.bytes, ...(notes.length ? { note: notes.join(" ") } : {}),
    };
  }
  if (p.audio) return { id: uid(), path, name, kind: "audio", duration: p.duration, width: 0, height: 0, fps: 0, audio: true, bytes: p.bytes };
  throw new Error(p.missing.length ? `${name}: this system has no ${p.missing.join(", ")}.` : `${name} has no picture or sound Zazabor can read.`);
}

export class MediaStore {
  private strips = new Map<string, Promise<Strip | null>>();
  private pictures = new Map<string, Promise<HTMLImageElement>>();
  private sounds = new Map<string, Promise<Sound | null>>();
  private urls: string[] = [];

  strip(m: Media): Promise<Strip | null> {
    let p = this.strips.get(m.id);
    if (!p) {
      p = this.makeStrip(m).catch(() => null);
      this.strips.set(m.id, p);
    }
    return p;
  }

  private async makeStrip(m: Media): Promise<Strip | null> {
    if (m.missing) return null;
    if (m.kind === "image") {
      const url = previewUrl(m.path, 0, 256);
      const h = STRIP_HEIGHT, w = Math.max(8, Math.round((h * m.width) / Math.max(1, m.height)));
      return { url, thumbWidth: w, thumbHeight: h, count: 1 };
    }
    if (m.kind !== "video") return null;
    const count = Math.max(4, Math.min(150, Math.round(m.duration / 2)));
    const { thumbWidth, jpeg } = await editApi.strip({ path: m.path, width: m.width, height: m.height, duration: m.duration, thumbHeight: STRIP_HEIGHT, count });
    const url = URL.createObjectURL(jpeg);
    this.urls.push(url);
    return { url, thumbWidth, thumbHeight: STRIP_HEIGHT, count };
  }

  /** The picture at a size good for the canvas. */
  picture(m: Media): Promise<HTMLImageElement> {
    let p = this.pictures.get(m.id);
    if (!p) {
      p = loadImage(previewUrl(m.path, 0, PICTURE_SIZE));
      p.catch(() => this.pictures.delete(m.id));
      this.pictures.set(m.id, p);
    }
    return p;
  }

  sound(m: Media): Promise<Sound | null> {
    let p = this.sounds.get(m.id);
    if (!p) {
      p = this.decode(m).catch((err) => {
        console.warn("[video-editor] sound", m.name, err);
        return null;
      });
      this.sounds.set(m.id, p);
    }
    return p;
  }

  private reversedSounds = new Map<string, Promise<Sound | null>>();
  private reversedReady = new Map<string, Sound | null>();

  /** The sound backwards (for reversed clips), made once from the decoded sound. */
  reversed(m: Media): Promise<Sound | null> {
    let p = this.reversedSounds.get(m.id);
    if (!p) {
      p = this.sound(m).then((sound) => {
        if (!sound) return null;
        const src = sound.buffer;
        const buffer = new AudioBuffer({ length: src.length, numberOfChannels: src.numberOfChannels, sampleRate: src.sampleRate });
        for (let ch = 0; ch < src.numberOfChannels; ch++) {
          const data = src.getChannelData(ch).slice();
          data.reverse();
          buffer.copyToChannel(data, ch);
        }
        const out = { buffer, peaks: sound.peaks.slice().reverse() };
        this.reversedReady.set(m.id, out);
        return out;
      });
      this.reversedSounds.set(m.id, p);
    }
    return p;
  }

  reversedNow(m: Media): Sound | null | undefined {
    return this.reversedReady.get(m.id);
  }

  /** A file was relinked: what was read from the old path goes. */
  forget(id: string) {
    this.strips.delete(id);
    this.pictures.delete(id);
    this.sounds.delete(id);
    this.ready.delete(id);
    this.reversedSounds.delete(id);
    this.reversedReady.delete(id);
  }

  /** The sound, if it's already decoded (for drawing waveforms without waiting). */
  private ready = new Map<string, Sound | null>();
  soundNow(m: Media): Sound | null | undefined {
    return this.ready.get(m.id);
  }

  private async decode(m: Media): Promise<Sound | null> {
    if (!m.audio || m.missing) return null;
    const pcm = await editApi.audio(m.path, m.audio);
    const frames = Math.floor(pcm.length / 2);
    if (!frames) {
      this.ready.set(m.id, null);
      return null;
    }
    const buffer = new AudioBuffer({ length: frames, numberOfChannels: 2, sampleRate: 48000 });
    const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
    const step = 48000 / PEAK_RATE;
    const peaks = new Uint8Array(Math.ceil(frames / step));
    let peak = 0;
    for (let i = 0, j = 0; i < frames; i++, j += 2) {
      const l = pcm[j] / 32768, r = pcm[j + 1] / 32768;
      left[i] = l;
      right[i] = r;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
      if ((i + 1) % step === 0 || i === frames - 1) {
        peaks[Math.floor(i / step)] = Math.min(255, Math.round(Math.sqrt(peak) * 255));
        peak = 0;
      }
    }
    const sound = { buffer, peaks };
    this.ready.set(m.id, sound);
    return sound;
  }

  dispose() {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.strips.clear();
    this.pictures.clear();
    this.sounds.clear();
    this.ready.clear();
    this.reversedSounds.clear();
    this.reversedReady.clear();
  }
}
