import { readBinary } from "./quicklook/api";

/**
 * Listening before choosing: music and sounds play here before they're added anywhere. One plays
 * at a time in the whole app (starting one stops any other). The webview's own player plays the
 * file from a blob: it refuses the app's cs: addresses (as Quick Look found), and the release
 * build's Content Security Policy allows media from blob:.
 */

/** A file bigger than this isn't read for listening. */
const LISTEN_BYTES = 256 * 1024 * 1024;

const TYPES: Record<string, string> = {
  mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", wav: "audio/wav",
  m4a: "audio/mp4", aac: "audio/mp4", wma: "audio/x-ms-wma",
};

/** The file extensions a listen button is offered for. */
export const LISTEN_EXTENSIONS = Object.keys(TYPES);

export const canListen = (path: string) => LISTEN_EXTENSIONS.includes(path.slice(path.lastIndexOf(".") + 1).toLowerCase());

type Listener = (path: string | null) => void;

let playing: { path: string; audio: HTMLAudioElement; url: string } | null = null;
/** The file asked for last (still loading, or playing). */
let wanted: string | null = null;
let token = 0;
const listeners = new Set<Listener>();

function tell() {
  for (const fn of listeners) fn(wanted);
}

/** The file playing or about to (null: nothing). */
export const listening = () => wanted;

/** Calls `fn` with the file playing (or null) whenever that changes; returns the unsubscribe. */
export function onListening(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Stops whatever plays. */
export function stopListening() {
  token++;
  const was = wanted;
  wanted = null;
  if (playing) {
    playing.audio.pause();
    playing.audio.removeAttribute("src");
    playing.audio.load();
    URL.revokeObjectURL(playing.url);
    playing = null;
  }
  if (was !== null) tell();
}

/** Plays `path` from the start, stopping anything else. Rejects when it can't be played. */
export async function listen(path: string): Promise<void> {
  stopListening();
  const mine = ++token;
  wanted = path;
  tell();
  try {
    const bytes = await readBinary(path, LISTEN_BYTES);
    if (mine !== token) return;
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const url = URL.createObjectURL(new Blob([bytes], { type: TYPES[ext] ?? "" }));
    const audio = new Audio();
    playing = { path, audio, url };
    const done = () => {
      if (playing?.audio === audio) stopListening();
    };
    audio.addEventListener("ended", done);
    audio.addEventListener("error", done);
    audio.src = url;
    await audio.play();
  } catch (err) {
    // Stopped or replaced on the way: that isn't a failure.
    if (mine !== token) return;
    stopListening();
    throw err;
  }
}

/** Plays `path`, or stops it when it's the one playing. */
export function toggleListening(path: string): Promise<void> {
  if (wanted === path) {
    stopListening();
    return Promise.resolve();
  }
  return listen(path);
}
