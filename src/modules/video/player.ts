import type { UnlistenFn } from "@tauri-apps/api/event";
import type { ShellContext } from "../../shell/module";
import { clamp, dirname } from "../../ui/dom";
import { onState, videoApi, type PlaybackState, type VideoSurface } from "./api";
import { addRecent, nextIndex, previousAction, resumeTime, trimPositions, type RepeatMode } from "./queue";

/** How often the resume point is saved while playing. */
const SAVE_EVERY_MS = 5000;

/**
 * Playback logic between the UI and the libVLC backend: the play queue, resume points, recent
 * files, volume persistence and auto-advance. The UI listens for changes and reads `state`.
 */
export class Player {
  /** The file being played (or loading), even before the backend reports it. */
  current: string | null = null;
  state: PlaybackState;
  queue: string[] = [];
  repeat: RepeatMode = "off";
  shuffle = false;
  /** Set when opening failed before the backend could report it. */
  openError: string | null = null;
  /**
   * Shown as the "continue watching" prompt. `resumed`: the file opened at its resume point and
   * the prompt offers Start over; otherwise it opened at 0 and the prompt offers to jump there.
   */
  resumeOffer: { path: string; time: number; resumed: boolean } | null = null;

  private readonly listeners = new Set<() => void>();
  private unlisten: UnlistenFn | undefined;
  private disposed = false;
  private token = 0;
  private lastSave = 0;
  private endedHandled = false;

  constructor(private readonly shell: ShellContext, private readonly surface: VideoSurface) {
    this.state = this.blankState(null);
    onState((s) => this.handleState(s))
      .then((unlisten) => {
        if (this.disposed) unlisten();
        else this.unlisten = unlisten;
      })
      .catch((err) => console.warn("Could not subscribe to video state:", err));
  }

  /** Calls `fn` on every state or queue change; returns the unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private get settings() {
    return this.shell.config.video;
  }

  private blankState(path: string | null): PlaybackState {
    return {
      path, playing: false, time: 0, length: 0, ended: false,
      volume: this.settings.volume, muted: this.settings.muted, rate: 1,
      audioTracks: [], audioTrack: -1, subtitleTracks: [], subtitleTrack: -1,
      videoWidth: 0, videoHeight: 0, error: null,
    };
  }

  /** Index of the current file in the queue, -1 when it isn't in it. */
  get index(): number {
    return this.current ? this.queue.indexOf(this.current) : -1;
  }

  get hasNext(): boolean {
    return this.queue.length > 1 || this.repeat === "all";
  }

  get hasPrevious(): boolean {
    return this.current !== null;
  }

  /** The message to show instead of the picture, if any. */
  get error(): string | null {
    return this.openError ?? this.state.error;
  }

  // ---- opening and leaving ----------------------------------------------------------------

  /** Plays a file; `siblings` is the queue to continue through, otherwise its folder's videos. */
  async open(path: string, siblings?: string[]) {
    this.savePosition();
    const token = ++this.token;
    const saved = this.settings.positions[path];
    const startAt = resumeTime(saved);
    this.current = path;
    this.openError = null;
    this.endedHandled = false;
    this.state = { ...this.blankState(path), time: startAt, length: saved?.length ?? 0 };
    this.resumeOffer = startAt > 0 ? { path, time: startAt, resumed: true } : null;
    this.queue = siblings && siblings.includes(path) ? siblings : [path];
    this.settings.recent = addRecent(this.settings.recent, path);
    this.shell.saveConfig();
    this.emit();

    if (!(siblings && siblings.includes(path))) void this.loadFolderQueue(path, token);
    const { width, height } = decodeSize(this.surface.pixelSize);
    try {
      await videoApi.open(path, width, height, startAt);
      if (token !== this.token) return;
      await Promise.all([videoApi.setVolume(this.settings.volume), videoApi.setMuted(this.settings.muted)]);
    } catch (err) {
      if (token !== this.token) return;
      console.warn("Could not open video:", err);
      this.openError = typeof err === "string" ? err : "This file could not be opened.";
      this.emit();
    }
  }

  private async loadFolderQueue(path: string, token: number) {
    try {
      const files = await videoApi.listVideos(dirname(path));
      if (token !== this.token || !files.some((f) => f.path === path)) return;
      this.queue = files.map((f) => f.path);
      this.emit();
    } catch (err) {
      console.warn("Could not list the folder's videos:", err);
    }
  }

  /** Stops playback and unloads the file. */
  async stop() {
    if (!this.current) return;
    this.savePosition();
    this.token++;
    this.current = null;
    this.openError = null;
    this.resumeOffer = null;
    this.state = this.blankState(null);
    this.emit();
    try {
      await videoApi.stop();
    } catch (err) {
      console.warn("Stop failed:", err);
    }
  }

  // ---- transport ---------------------------------------------------------------------------

  togglePlay() {
    if (!this.current) return;
    if (this.state.ended) {
      this.endedHandled = false;
      this.run(videoApi.seek(0));
      this.run(videoApi.setPaused(false));
      return;
    }
    const pause = this.state.playing;
    this.state = { ...this.state, playing: !pause };
    if (pause) this.savePosition();
    this.emit();
    this.run(videoApi.setPaused(pause));
  }

  seekTo(time: number) {
    if (!this.current) return;
    const length = this.state.length;
    const target = Math.max(0, length > 0 ? Math.min(time, length) : time);
    this.state = { ...this.state, time: target };
    this.emit();
    this.run(videoApi.seek(target));
  }

  seekBy(delta: number) {
    this.seekTo(this.state.time + delta);
  }

  next() {
    // "Repeat one" only applies to the end of a file; the button still moves on.
    const to = nextIndex(this.queue.length, this.index, this.repeat === "one" ? "off" : this.repeat, this.shuffle);
    if (to !== null && this.queue[to]) void this.open(this.queue[to], this.queue);
  }

  previous() {
    const action = previousAction(this.state.time, this.queue.length, this.index, this.repeat);
    if ("restart" in action) this.seekTo(0);
    else void this.open(this.queue[action.index], this.queue);
  }

  cycleRepeat() {
    this.repeat = this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off";
    this.emit();
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    this.emit();
  }

  // ---- resume offer (the prompt itself is features/quick/resume.ts) ----------------------------

  /** Keeps playing where it is now and forgets the offer. */
  dismissResumeOffer() {
    if (!this.resumeOffer) return;
    this.resumeOffer = null;
    this.emit();
  }

  /** Offers to jump to `time` in a file that opened at its start (the "ask" resume setting). */
  offerResume(path: string, time: number) {
    if (this.current !== path || time <= 0) return;
    this.resumeOffer = { path, time, resumed: false };
    this.emit();
  }

  /** Accepts the offer: jumps to the resume point if playback isn't already there. */
  acceptResume() {
    const offer = this.resumeOffer;
    if (!offer) return;
    this.resumeOffer = null;
    if (!offer.resumed && this.current === offer.path) this.seekTo(offer.time);
    else this.emit();
  }

  /** Plays the current file from the start instead of the resume point. */
  startOver() {
    this.resumeOffer = null;
    this.seekTo(0);
  }

  // ---- queue editing (media library) -----------------------------------------------------------
  // The queue array is replaced, never changed in place: callers of `open` share their lists.

  private readonly queueListeners = new Set<() => void>();

  /** Calls `fn` whenever the queue is edited here; returns the unsubscribe function. */
  onQueueChange(fn: () => void): () => void {
    this.queueListeners.add(fn);
    return () => this.queueListeners.delete(fn);
  }

  private setQueue(queue: string[]) {
    this.queue = queue;
    this.emit();
    for (const fn of this.queueListeners) fn();
  }

  /** Adds files to the end of the queue; with nothing playing, starts the first. */
  enqueue(paths: string[]) {
    if (paths.length === 0) return;
    if (!this.current) {
      void this.open(paths[0], paths);
      return;
    }
    const add = paths.filter((p) => p !== this.current);
    this.setQueue([...this.queue.filter((p) => !add.includes(p)), ...add]);
  }

  /** Puts files right after the current one; with nothing playing, starts the first. */
  playNext(paths: string[]) {
    if (paths.length === 0) return;
    if (!this.current) {
      void this.open(paths[0], paths);
      return;
    }
    const add = paths.filter((p) => p !== this.current);
    const rest = this.queue.filter((p) => !add.includes(p));
    const at = rest.indexOf(this.current) + 1;
    this.setQueue([...rest.slice(0, at), ...add, ...rest.slice(at)]);
  }

  /** Inserts files at a position of the queue (a drop), moving them if they are already in it. */
  insertInQueue(paths: string[], at: number) {
    if (paths.length === 0) return;
    const add = paths.filter((p) => p !== this.current);
    const before = this.queue.slice(0, at).filter((p) => !add.includes(p)).length;
    const rest = this.queue.filter((p) => !add.includes(p));
    this.setQueue([...rest.slice(0, before), ...add, ...rest.slice(before)]);
    if (!this.current) void this.open(paths[0], this.queue);
  }

  /** Moves the item at `from` so it lands before the item that is at `to` (`to` may be the length). */
  moveInQueue(from: number, to: number) {
    if (from < 0 || from >= this.queue.length) return;
    const target = Math.min(Math.max(to, 0), this.queue.length);
    const item = this.queue[from];
    const rest = this.queue.filter((_, i) => i !== from);
    rest.splice(target > from ? target - 1 : target, 0, item);
    this.setQueue(rest);
  }

  /** Takes the item at `index` out of the queue; the playing item stays. */
  removeFromQueue(index: number) {
    if (index < 0 || index >= this.queue.length || this.queue[index] === this.current) return;
    this.setQueue(this.queue.filter((_, i) => i !== index));
  }

  /** Empties the queue except for the playing item. */
  clearQueue() {
    this.setQueue(this.current ? [this.current] : []);
  }

  // ---- sound and speed ----------------------------------------------------------------------

  setVolume(volume: number) {
    const v = clamp(volume, 0, 1.25);
    this.settings.volume = v;
    this.state = { ...this.state, volume: v };
    if (v > 0 && this.settings.muted) this.applyMuted(false);
    this.shell.saveConfig();
    this.emit();
    this.run(videoApi.setVolume(v));
  }

  toggleMute() {
    this.applyMuted(!this.settings.muted);
    this.shell.saveConfig();
    this.emit();
  }

  private applyMuted(muted: boolean) {
    this.settings.muted = muted;
    this.state = { ...this.state, muted };
    this.run(videoApi.setMuted(muted));
  }

  setRate(rate: number) {
    const r = clamp(rate, 0.25, 2);
    this.state = { ...this.state, rate: r };
    this.emit();
    this.run(videoApi.setRate(r));
  }

  setAudioTrack(id: number) {
    this.state = { ...this.state, audioTrack: id };
    this.emit();
    this.run(videoApi.setAudioTrack(id));
  }

  setSubtitleTrack(id: number) {
    this.state = { ...this.state, subtitleTrack: id };
    this.emit();
    this.run(videoApi.setSubtitleTrack(id));
  }

  addSubtitle(path: string) {
    this.run(videoApi.addSubtitle(path));
  }

  private run(call: Promise<unknown>) {
    call.catch((err) => console.warn("Video command failed:", err));
  }

  // ---- state from the backend --------------------------------------------------------------

  private handleState(s: PlaybackState) {
    // Events for a file we already left (or are still switching to) are stale.
    if (!this.current || s.path !== this.current) return;
    const wasPlaying = this.state.playing;
    this.state = s;
    if (!s.ended) this.endedHandled = false;
    const now = Date.now();
    if (s.playing && now - this.lastSave >= SAVE_EVERY_MS) this.savePosition();
    else if (wasPlaying && !s.playing && !s.ended) this.savePosition();
    this.emit();
    if (s.ended && !this.endedHandled) {
      this.endedHandled = true;
      this.handleEnded();
    }
  }

  private handleEnded() {
    this.savePosition(true);
    const to = nextIndex(this.queue.length, this.index, this.repeat, this.shuffle);
    if (to === null || !this.queue[to]) return;
    if (this.repeat === "one") {
      this.endedHandled = false;
      this.run(videoApi.seek(0));
      this.run(videoApi.setPaused(false));
    } else {
      void this.open(this.queue[to], this.queue);
    }
  }

  // ---- resume points -----------------------------------------------------------------------

  /** Remembers where the current file is (or that it was finished) and trims old entries. */
  savePosition(finished = false) {
    const { current, state } = this;
    if (!current || state.path !== current || state.length <= 0) return;
    this.lastSave = Date.now();
    const positions = this.settings.positions;
    positions[current] = { time: finished ? state.length : state.time, length: state.length, at: this.lastSave };
    this.settings.positions = trimPositions(positions);
    this.shell.saveConfig();
  }

  /** Stops for the privacy lock, keeping the position. */
  async lock() {
    await this.stop();
  }

  dispose() {
    this.disposed = true;
    this.savePosition();
    this.unlisten?.();
    this.listeners.clear();
    this.token++;
    if (this.current) void videoApi.stop().catch(() => undefined);
    this.current = null;
  }
}

/**
 * The largest size to decode frames at: the screen in device pixels (so the picture stays sharp
 * in fullscreen) or the stage if that is larger, capped at 4K. The stage may not be laid out yet
 * when a module opens straight into a video, so it can't be the only measure.
 */
function decodeSize(stage: { width: number; height: number }) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(stage.width, Math.round(screen.width * dpr));
  const height = Math.max(stage.height, Math.round(screen.height * dpr));
  const fit = Math.min(1, 3840 / width, 2160 / height);
  return { width: Math.round(width * fit), height: Math.round(height * fit) };
}
