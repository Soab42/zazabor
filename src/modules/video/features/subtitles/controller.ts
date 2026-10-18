import { basename } from "../../../../ui/dom";
import type { VideoContext } from "../../extensions";
import { panelApi, type EmbeddedTrack } from "../../panel-api";
import { ownFormat, SubtitleEngine } from "./engine";
import { trackForLanguage } from "./language";
import { episodeKey, showOf, type ShowInfo } from "./match";
import { cuesFromTimed } from "./parse";
import type { OnlineSettings } from "./online";
import { DEFAULT_STYLE, normalizeStyle, type SubStyle } from "./style";
import { snapDelay } from "./timeline";

/** Style and delay saved under a show's name; applied to its other episodes. */
export interface ShowPreset {
  name: string;
  style: SubStyle;
  delay: number;
}

export interface SubtitleSettings {
  /** The style used when a show has no preset. */
  style: SubStyle;
  /** Default subtitle language (two-letter code), "" for none. */
  language: string;
  /** Show the timeline strip over the video as well. */
  showTimeline: boolean;
  presets: Record<string, ShowPreset>;
  /** Subtitle file chosen for a video (by path). */
  assign: Record<string, string>;
  /** Per show: the folder subtitles were taken from and which file went with which episode. */
  series: Record<string, { dir: string; matches: Record<string, string> }>;
  online: OnlineSettings;
}

export const SUBTITLE_DEFAULTS: SubtitleSettings = {
  style: DEFAULT_STYLE,
  language: "",
  showTimeline: false,
  presets: {},
  assign: {},
  series: {},
  online: { apiKey: "", username: "", language: "en" },
};

const MAX_ASSIGNMENTS = 400;
/** After our own subtitles start, VLC's track is switched off again for this long if it comes back. */
const SUPPRESS_MS = 2500;

/**
 * The subtitle logic behind the tab, the dialog and the menus: which source is active (VLC's
 * embedded track or our renderer), delay, style, per-show presets, remembered files, and the
 * clock that keeps our subtitles smooth between the backend's state events.
 */
export class SubtitleController {
  readonly engine: SubtitleEngine;
  /** What the user sees: preset or default style, plus unsaved edits. */
  style: SubStyle;
  delay = 0;
  show: ShowInfo | null = null;
  /** Name of the loaded external file, for the track list. */
  externalName: string | null = null;
  /** The last problem loading a file, for the tab. */
  error: string | null = null;
  /** The Add Subtitles dialog asked the tab to open its advanced section. */
  wantAdvanced = false;
  /** The libVLC track id our engine is drawing (one of the video's own text tracks), else null. */
  embeddedId: number | null = null;
  /** The video's own subtitle tracks are still being read. */
  readingEmbedded = false;

  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private path: string | null = null;
  private lastShow = "";
  private defaultsDone = false;
  private defaultsTries = 0;
  private delayPending = false;
  private suppressUntil = 0;
  private raf = 0;
  private clock = { base: 0, at: 0, playing: false, rate: 1 };
  /** The video's own subtitle tracks once read (text ones carry their cues). */
  private embedded: EmbeddedTrack[] | null = null;

  constructor(private readonly ctx: VideoContext, readonly settings: SubtitleSettings) {
    this.engine = new SubtitleEngine(ctx.stageLayer);
    this.style = normalizeStyle(settings.style);
    this.engine.setStyle(this.style);
    this.unsubscribe = ctx.player.subscribe(() => this.onState());
    this.onState();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  save() {
    this.ctx.shell.saveConfig();
  }

  /** Tells listeners that a setting changed (the stage timeline follows it). */
  emitSettings() {
    this.emit();
  }

  get state() {
    return this.ctx.player.state;
  }

  get currentPath(): string | null {
    return this.path;
  }

  get playing(): boolean {
    return this.ctx.player.state.playing;
  }

  get source(): "ours" | "embedded" | "off" {
    if (this.engine.active) return "ours";
    return this.ctx.player.state.subtitleTrack >= 0 ? "embedded" : "off";
  }

  /**
   * The choice on screen, whoever draws it: one of libVLC's track ids (our engine draws the
   * video's own text tracks), "file" for an added subtitle file, or null when off.
   */
  get shownTrack(): number | "file" | null {
    if (this.engine.active) return this.embeddedId ?? "file";
    const id = this.ctx.player.state.subtitleTrack;
    return id >= 0 ? id : null;
  }

  get preset(): ShowPreset | null {
    return this.show ? this.settings.presets[this.show.key] ?? null : null;
  }

  /** The preset exists but the style or delay on screen differs from it. */
  get presetDirty(): boolean {
    const p = this.preset;
    return !!p && (p.delay !== this.delay || JSON.stringify(normalizeStyle(p.style)) !== JSON.stringify(this.style));
  }

  // ---- clock ------------------------------------------------------------------------------

  /** Video time in ms, moved forward between state events while playing. */
  now(): number {
    const c = this.clock;
    return c.playing ? c.base + (performance.now() - c.at) * c.rate : c.base;
  }

  private syncClock() {
    const { time, playing, rate } = this.ctx.player.state;
    const c = this.clock;
    const predicted = this.now();
    // Small differences are the backend's coarse timer; keep the smooth clock unless it has drifted.
    if (!(playing && c.playing && rate === c.rate && Math.abs(time - predicted) < 120)) {
      this.clock = { base: time, at: performance.now(), playing, rate };
    }
  }

  private loop = () => {
    this.raf = 0;
    this.engine.render(this.now());
    if (this.clock.playing && this.engine.active) this.raf = requestAnimationFrame(this.loop);
  };

  private kick() {
    this.engine.render(this.now());
    if (!this.raf && this.clock.playing && this.engine.active) this.raf = requestAnimationFrame(this.loop);
  }

  // ---- state ------------------------------------------------------------------------------

  private onState() {
    const { player } = this.ctx;
    const state = player.state;
    if (state.path !== this.path) this.opened(state.path);
    this.syncClock();

    if (this.engine.active && state.subtitleTrack !== -1) {
      if (Date.now() < this.suppressUntil) {
        player.setSubtitleTrack(-1);
      } else if (!this.takeOverEmbedded()) {
        // One of VLC's tracks we can't draw (a picture format) was chosen: ours steps aside.
        this.engine.unload();
        this.externalName = null;
        this.embeddedId = null;
        this.emit();
      }
    } else if (state.subtitleTrack !== -1) {
      // VLC picked one of the video's own tracks (its default, or the default language).
      this.takeOverEmbedded();
    }
    if (this.delayPending && state.playing) {
      this.delayPending = false;
      void panelApi.setSubtitleDelay(this.delay).catch(() => undefined);
    }
    if (!this.defaultsDone && state.playing) this.applyDefaults();
    this.kick();
    this.emit();
  }

  private opened(path: string | null) {
    this.path = path;
    this.engine.unload();
    this.externalName = null;
    this.embeddedId = null;
    this.embedded = null;
    this.readingEmbedded = false;
    this.error = null;
    this.defaultsDone = false;
    this.defaultsTries = 0;
    this.suppressUntil = 0;
    if (path && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) this.readEmbedded(path);
    this.show = path ? showOf(path) : null;
    if (!path || !this.show) {
      this.delay = 0;
      this.engine.setDelay(0);
      return;
    }
    const preset = this.settings.presets[this.show.key];
    this.style = normalizeStyle(preset ? preset.style : this.settings.style);
    this.delay = preset ? snapDelay(preset.delay) : 0;
    this.engine.setStyle(this.style);
    this.engine.setDelay(this.delay);
    this.delayPending = true;
    if (preset && this.lastShow !== this.show.key) this.ctx.showOsd(`Subtitle preset “${preset.name}”`);
    this.lastShow = this.show.key;
    const assigned = this.settings.assign[path];
    if (assigned) {
      this.defaultsDone = true;
      void this.useFile(assigned).catch(() => {
        delete this.settings.assign[path];
        this.defaultsDone = false;
      });
    }
  }

  /** The default subtitle language, once the file's tracks are known. */
  private applyDefaults() {
    const { player } = this.ctx;
    const { state } = player;
    this.defaultsTries++;
    if (this.defaultsTries > 40) this.defaultsDone = true;
    if (state.subtitleTracks.length === 0) return;
    this.defaultsDone = true;
    const language = this.settings.language;
    if (!language || this.engine.active || state.subtitleTrack !== -1) return;
    const track = trackForLanguage(state.subtitleTracks, language);
    if (track) player.setSubtitleTrack(track.id);
  }

  // ---- the video's own tracks ----------------------------------------------------------------

  /** Reads the video's own subtitle tracks in the background (Matroska/WebM; others have none). */
  private readEmbedded(path: string) {
    this.readingEmbedded = true;
    panelApi.embeddedSubtitles(path).then((tracks) => {
      if (path !== this.path) return;
      this.embedded = tracks;
      this.readingEmbedded = false;
      // VLC has been drawing the default track meanwhile; ours takes over without a gap.
      this.takeOverEmbedded();
      this.emit();
    }).catch((err) => {
      if (path !== this.path) return;
      console.warn("Could not read the video's subtitle tracks:", err);
      this.readingEmbedded = false;
      this.emit();
    });
  }

  /** The video's own text track behind one of VLC's subtitle track ids, when ours can draw it. */
  private embeddedText(id: number): EmbeddedTrack | null {
    const tracks = this.embedded;
    const listed = this.ctx.player.state.subtitleTracks;
    // VLC lists the file's tracks first, in file order; files added through VLC come after them.
    if (!tracks?.length || listed.length < tracks.length) return null;
    const track = tracks[listed.findIndex((t) => t.id === id)];
    return track?.text && track.cues.length > 0 ? track : null;
  }

  /** If VLC is showing one of the video's own text tracks, draws it with our engine instead. */
  private takeOverEmbedded(): boolean {
    const id = this.ctx.player.state.subtitleTrack;
    const track = id >= 0 ? this.embeddedText(id) : null;
    if (!track) return false;
    this.showEmbedded(id, track);
    return true;
  }

  private showEmbedded(id: number, track: EmbeddedTrack) {
    this.engine.loadCues(cuesFromTimed(track.cues), track.name || `Track ${track.index + 1}`);
    this.embeddedId = id;
    this.externalName = null;
    this.suppressUntil = Date.now() + SUPPRESS_MS;
    this.ctx.player.setSubtitleTrack(-1);
    this.engine.setDelay(this.delay);
    this.kick();
    this.emit();
  }

  // ---- choosing a source ---------------------------------------------------------------------

  /** Shows one of the video's tracks: drawn by us when it's text we have, else by VLC. */
  selectEmbedded(id: number) {
    if (this.path) delete this.settings.assign[this.path];
    const track = this.embeddedText(id);
    if (track) {
      this.showEmbedded(id, track);
      return;
    }
    this.engine.unload();
    this.externalName = null;
    this.embeddedId = null;
    this.ctx.player.setSubtitleTrack(id);
    this.emit();
  }

  turnOff() {
    this.engine.unload();
    this.externalName = null;
    this.embeddedId = null;
    if (this.path) delete this.settings.assign[this.path];
    this.ctx.player.setSubtitleTrack(-1);
    this.save();
    this.emit();
  }

  /**
   * Shows a subtitle file for the current video: ours for SRT/VTT/ASS/SSA, VLC's for other
   * formats and files we can't read as text. `error` is kept for a future message.
   */
  async useFile(path: string): Promise<void> {
    this.error = null;
    this.embeddedId = null;
    if (!ownFormat(path)) {
      this.engine.unload();
      this.externalName = null;
      this.ctx.player.addSubtitle(path);
      this.emit();
      return;
    }
    try {
      await this.engine.load(path);
    } catch {
      // Not UTF-8 text (UTF-16, a legacy encoding) or not parseable: VLC can still try it.
      this.engine.unload();
      this.externalName = null;
      this.ctx.player.addSubtitle(path);
      this.emit();
      return;
    }
    this.externalName = basename(path);
    this.suppressUntil = Date.now() + SUPPRESS_MS;
    this.ctx.player.setSubtitleTrack(-1);
    this.engine.setDelay(this.delay);
    this.kick();
    this.emit();
  }

  /** Remembers a subtitle file for a video (and the show's episode); shows it if the video is playing. */
  async assign(video: string, sub: string): Promise<void> {
    const { assign, series } = this.settings;
    delete assign[video];
    assign[video] = sub;
    const keys = Object.keys(assign);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ASSIGNMENTS))) delete assign[old];
    const show = showOf(video);
    const episode = episodeKey(video);
    const entry = series[show.key] ?? { dir: "", matches: {} };
    entry.dir = sub.replace(/[\\/][^\\/]*$/, "");
    if (episode) entry.matches[episode] = sub;
    series[show.key] = entry;
    this.save();
    if (video === this.path) await this.useFile(sub);
  }

  // ---- delay and style -------------------------------------------------------------------------

  setDelay(ms: number) {
    this.delay = snapDelay(ms);
    this.engine.setDelay(this.delay);
    // VLC's own track follows the same delay; it is harmless while ours is shown.
    void panelApi.setSubtitleDelay(this.delay).catch(() => undefined);
    this.emit();
  }

  setStyle(patch: Partial<SubStyle>) {
    this.style = normalizeStyle({ ...this.style, ...patch });
    this.engine.setStyle(this.style);
    if (!this.preset) {
      this.settings.style = this.style;
      this.save();
    }
    this.emit();
  }

  /** Saves the style and delay under this show's name. */
  savePreset() {
    if (!this.show) return;
    this.settings.presets[this.show.key] = { name: this.show.name, style: this.style, delay: this.delay };
    this.save();
    this.ctx.showOsd(`Saved subtitle preset for “${this.show.name}”`);
    this.emit();
  }

  removePreset() {
    if (!this.show || !this.preset) return;
    delete this.settings.presets[this.show.key];
    this.save();
    this.emit();
  }

  /** Jumps to a cue (ms in subtitle time, so the delay is added). */
  seekToCue(start: number) {
    this.ctx.player.seekTo(Math.max(0, start + this.delay));
  }

  dispose() {
    this.unsubscribe();
    cancelAnimationFrame(this.raf);
    this.engine.dispose();
    this.listeners.clear();
  }
}
