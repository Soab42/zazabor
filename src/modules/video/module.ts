import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import type { VideoSection } from "../../config";
import type { AppModule, OpenRequest, ShellContext } from "../../shell/module";
import { basename, dirname, h, stripExtension } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { closeMenu, openMenu } from "../../ui/menu";
import type { VideoSurface } from "./api";
import { ControlBar } from "./controls";
import { openCustomize, type CustomizeHandle } from "./customize";
import { formatRate, formatTime } from "./format";
import { Player } from "./player";
import { Sections } from "./sections";
import { VideoSidebar } from "./sidebar";
import { createVideoSurface } from "./surface";

const VIDEO_EXTENSIONS = ["mp4", "mkv", "webm", "avi", "mov", "m4v", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "ogv", "3gp"];
const SUBTITLE_EXTENSIONS = ["srt", "ass", "ssa", "vtt", "sub"];
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** How long the chrome stays in fullscreen without mouse movement. */
const IDLE_MS = 2500;

const RAIL: { section: VideoSection; icon: IconName; label: string }[] = [
  { section: "home", icon: "home", label: "Home" },
  { section: "videos", icon: "video", label: "Videos" },
  { section: "recent", icon: "clock", label: "Recent" },
];

/** The Video module: a glass-styled player around the libVLC backend (see docs/design/vlc/PLAYER.md). */
export class VideoModule implements AppModule {
  readonly id = "video" as const;
  readonly title = "Video";
  readonly icon: IconName = "video";
  readonly el = h("div", { class: "vp", tabIndex: -1 });

  private readonly surface: VideoSurface = createVideoSurface();
  private readonly player: Player;
  private readonly bar: ControlBar;
  private readonly sidebar: VideoSidebar;
  private readonly sections: Sections;
  private readonly rail = h("nav", { class: "vp-rail", "aria-label": "Video" });
  private readonly top = h("header", { class: "vp-top" });
  private readonly crumb = h("span", { class: "vp-top-crumb" });
  private readonly titleEl = h("div", { class: "vp-top-title" });
  private readonly sidebarToggle = h("button", { class: "icon-btn", type: "button", title: "Sidebar", "aria-label": "Sidebar" }, icon("sidebar", 18));
  private readonly stage = h("div", { class: "vp-stage" });
  private readonly osd = h("div", { class: "vp-osd" });
  private readonly overlay = h("div", { class: "vp-overlay" });
  private readonly unsubscribe: () => void;

  private view: "browse" | "player" = "browse";
  private active = false;
  private fullscreen = false;
  /** The playlist panel in fullscreen is separate from the normal sidebar setting. */
  private fullscreenSidebar = false;
  private shownPath: string | null = null;
  private overlayKey = "";
  private customizer: CustomizeHandle | null = null;
  private idleTimer = 0;
  private osdTimer = 0;
  private clickTimer = 0;

  constructor(private readonly shell: ShellContext) {
    this.player = new Player(shell, this.surface);
    this.bar = new ControlBar({
      player: this.player,
      sidebarOpen: () => this.sidebarOpen(),
      toggleSidebar: () => this.toggleSidebar(),
      toggleFullscreen: () => void this.toggleFullscreen(),
      addSubtitleFile: () => void this.addSubtitleFile(),
    });
    this.sidebar = new VideoSidebar(shell, {
      play: (path, queue) => void this.play(path, queue),
      openFolder: () => void this.openFolder(),
    });
    this.sections = new Sections(shell, {
      play: (path, queue) => void this.play(path, queue),
      openFile: () => void this.openFile(),
      openFolder: () => void this.openFolder(),
      forget: (path) => this.forget(path),
    });

    this.buildTop();
    this.buildStage();
    const content = h("div", { class: "vp-content" }, this.stage, this.sections.el);
    this.el.append(
      this.rail,
      h("div", { class: "vp-main" }, this.top, h("div", { class: "vp-body" }, this.sidebar.el, content), this.bar.el),
    );
    this.el.addEventListener("pointermove", () => this.wake());
    this.el.addEventListener("pointerdown", () => this.wake());
    // A focused button would otherwise also "click" on the Space that toggles playback.
    this.el.addEventListener("keyup", (e) => {
      if (e.key === " " && this.view === "player") e.preventDefault();
    });

    this.sections.show(shell.config.video.section);
    this.bar.render(shell.config.video.controls);
    this.renderRail();
    this.applyView();
    this.unsubscribe = this.player.subscribe(() => this.sync());
  }

  // ---- building ----------------------------------------------------------------------------

  private buildTop() {
    const more = h("button", { class: "icon-btn", type: "button", title: "More", "aria-label": "More" }, icon("more", 18));
    more.addEventListener("click", () => {
      const r = more.getBoundingClientRect();
      openMenu(r.left, r.bottom + 6, [
        { label: "Open File…", icon: "video", action: () => void this.openFile() },
        { label: "Open Folder…", icon: "folder", action: () => void this.openFolder() },
        { label: "Add Subtitle File…", icon: "subtitles", disabled: !this.player.current, action: () => void this.addSubtitleFile() },
        "separator",
        { label: "Customise Player…", icon: "settings", action: () => this.customise() },
      ]);
    });
    this.sidebarToggle.addEventListener("click", () => this.toggleSidebar());
    const fullscreen = h("button", { class: "icon-btn", type: "button", title: "Fullscreen (F)", "aria-label": "Fullscreen" }, icon("fullscreen", 18));
    fullscreen.addEventListener("click", () => void this.toggleFullscreen());
    this.top.append(
      h("div", { class: "vp-top-side" }, more, this.sidebarToggle, h("span", { class: "vp-top-sep" }),
        icon("folder", 16), this.crumb),
      this.titleEl,
      h("div", { class: "vp-top-side end" }, fullscreen),
    );
  }

  private buildStage() {
    this.stage.append(this.surface.el, this.osd, this.overlay);
    this.stage.addEventListener("click", () => {
      if (this.view !== "player") return;
      // Wait out a possible double click before treating it as play/pause.
      clearTimeout(this.clickTimer);
      this.clickTimer = window.setTimeout(() => this.player.togglePlay(), 220);
    });
    this.stage.addEventListener("dblclick", () => {
      clearTimeout(this.clickTimer);
      if (this.view === "player") void this.toggleFullscreen();
    });
  }

  private renderRail() {
    const button = (iconName: IconName, label: string, active: boolean, onClick: () => void, extra = "") => {
      const b = h("button", { class: `vp-rail-btn${active ? " active" : ""}${extra}`, type: "button", title: label, "aria-label": label }, icon(iconName, 20));
      b.addEventListener("click", onClick);
      return b;
    };
    const items: HTMLElement[] = [];
    if (this.player.current) items.push(button("film", "Now playing", this.view === "player", () => this.setView("player"), " now"));
    const section = this.shell.config.video.section;
    for (const entry of RAIL) {
      items.push(button(entry.icon, entry.label, this.view === "browse" && section === entry.section, () => this.setSection(entry.section)));
    }
    const add = button("plus", "Open…", false, () => {
      const r = add.getBoundingClientRect();
      openMenu(r.right + 6, r.top, [
        { label: "Open File…", icon: "video", action: () => void this.openFile() },
        { label: "Open Folder…", icon: "folder", action: () => void this.openFolder() },
      ]);
    });
    items.push(add);
    this.rail.replaceChildren(...items);
  }

  // ---- views -------------------------------------------------------------------------------

  private setSection(section: VideoSection) {
    this.shell.config.video.section = section;
    this.shell.saveConfig();
    this.sections.show(section);
    this.setView("browse");
  }

  private setView(view: "browse" | "player") {
    if (view === "player" && !this.player.current) return;
    this.view = view;
    this.renderRail();
    this.applyView();
  }

  private sidebarOpen() {
    return this.fullscreen ? this.fullscreenSidebar : this.shell.config.video.sidebar;
  }

  private toggleSidebar() {
    if (this.fullscreen) this.fullscreenSidebar = !this.fullscreenSidebar;
    else this.shell.config.video.sidebar = !this.shell.config.video.sidebar;
    this.shell.saveConfig();
    this.applyView();
    this.bar.update();
  }

  private applyView() {
    const playing = this.view === "player";
    const el = this.el.classList;
    el.toggle("view-player", playing);
    el.toggle("view-browse", !playing);
    el.toggle("fullscreen", this.fullscreen);
    el.toggle("sidebar-open", playing && this.sidebarOpen());
    this.sidebarToggle.classList.toggle("active", playing && this.sidebarOpen());
    this.sidebarToggle.disabled = !playing;
    if (this.active && playing) this.surface.start();
    else this.surface.stop();
    this.crumb.textContent = playing && this.player.current ? basename(dirname(this.player.current)) : this.sections.title;
    this.titleEl.textContent = playing && this.player.current ? stripExtension(basename(this.player.current)) : "";
    this.titleEl.title = this.player.current ?? "";
  }

  /** Reacts to the player: bar, title, stage messages, and moving between the pages. */
  private sync() {
    const { current } = this.player;
    if (current !== this.shownPath) {
      this.shownPath = current;
      this.sidebar.setCurrent(current);
      if (current) {
        this.view = "player";
        if (dirname(current) !== this.sidebar.browsing) void this.sidebar.browse(dirname(current));
      } else {
        this.view = "browse";
        if (this.fullscreen) void this.setFullscreen(false);
        this.sections.render();
      }
      this.renderRail();
      this.applyView();
    }
    this.bar.update();
    const error = this.player.error;
    const loading = current !== null && !error && this.player.state.length <= 0;
    const key = error ? `e:${error}` : loading ? "l" : "";
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    this.overlay.className = `vp-overlay${key ? " show" : ""}`;
    this.overlay.replaceChildren(...(error
      ? [icon("video", 30), h("div", { class: "vp-overlay-title" }, "Can't play this video"), h("div", { class: "vp-overlay-text" }, error)]
      : loading ? [h("div", { class: "spinner" })] : []));
  }

  // ---- opening -----------------------------------------------------------------------------

  private async play(path: string, queue?: string[]) {
    this.view = "player";
    this.applyView();
    await this.player.open(path, queue);
  }

  private async openFile() {
    const picked = await this.pick({ multiple: false, filters: [{ name: "Videos", extensions: VIDEO_EXTENSIONS }] });
    if (picked) void this.play(picked);
  }

  private async openFolder() {
    const picked = await this.pick({ directory: true, multiple: false });
    if (!picked) return;
    if (this.view === "player") {
      this.shell.config.video.sidebar = true;
      this.shell.saveConfig();
      this.applyView();
      void this.sidebar.browse(picked);
    } else {
      this.shell.config.video.section = "videos";
      this.renderRail();
      void this.sections.showFolder(picked);
      this.applyView();
    }
  }

  private async addSubtitleFile() {
    const picked = await this.pick({ multiple: false, filters: [{ name: "Subtitles", extensions: SUBTITLE_EXTENSIONS }] });
    if (picked && this.player.current) this.player.addSubtitle(picked);
  }

  private async pick(options: Parameters<typeof open>[0]): Promise<string | null> {
    try {
      const picked = await open(options);
      return typeof picked === "string" ? picked : null;
    } catch (err) {
      console.warn("File dialog failed:", err);
      return null;
    }
  }

  private forget(path: string) {
    const video = this.shell.config.video;
    video.recent = video.recent.filter((p) => p !== path);
    delete video.positions[path];
    this.shell.saveConfig();
  }

  private customise() {
    if (this.customizer) return;
    this.el.classList.add("customizing");
    this.customizer = openCustomize({
      host: this.el,
      bar: this.bar,
      controls: this.shell.config.video.controls,
      onSave: (ids) => {
        this.shell.config.video.controls = ids;
        this.shell.saveConfig();
      },
      onClose: () => {
        this.customizer = null;
        this.el.classList.remove("customizing");
        this.bar.render(this.shell.config.video.controls);
        this.wake();
      },
    });
  }

  // ---- fullscreen --------------------------------------------------------------------------

  private async toggleFullscreen() {
    await this.setFullscreen(!this.fullscreen);
  }

  private async setFullscreen(on: boolean) {
    if (on === this.fullscreen) return;
    try {
      await getCurrentWindow().setFullscreen(on);
    } catch (err) {
      console.warn("Fullscreen failed:", err);
      return;
    }
    this.fullscreen = on;
    this.fullscreenSidebar = false;
    this.applyView();
    this.bar.update();
    this.wake();
  }

  /** In fullscreen the bars fade out after a moment without mouse movement. */
  private wake() {
    this.el.classList.remove("idle");
    clearTimeout(this.idleTimer);
    if (!this.fullscreen) return;
    this.idleTimer = window.setTimeout(() => {
      const busy = this.customizer || document.querySelector(".menu") || this.el.querySelector(".vp-top:hover, .vp-bar:hover, .vp-sidebar:hover");
      if (busy) this.wake();
      else this.el.classList.add("idle");
    }, IDLE_MS);
  }

  // ---- keys and feedback -------------------------------------------------------------------

  private flash(text: string) {
    this.osd.textContent = text;
    this.osd.classList.add("show");
    clearTimeout(this.osdTimer);
    this.osdTimer = window.setTimeout(() => this.osd.classList.remove("show"), 900);
  }

  private stepRate(direction: 1 | -1) {
    const { rate } = this.player.state;
    const to = direction === 1
      ? RATES.find((r) => r > rate + 0.001)
      : [...RATES].reverse().find((r) => r < rate - 0.001);
    if (to === undefined) return;
    this.player.setRate(to);
    this.flash(formatRate(to));
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (this.customizer) {
      if (e.key !== "Escape") return false;
      this.customizer.close();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "o") {
      void this.openFile();
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || this.view !== "player" || !this.player.current) return false;
    const { player } = this;
    switch (e.key) {
      case " ":
      case "k":
      case "K":
        player.togglePlay();
        return true;
      case "ArrowLeft":
      case "ArrowRight": {
        player.seekBy((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 30_000 : 5_000));
        this.flash(formatTime(player.state.time));
        return true;
      }
      case "ArrowUp":
      case "ArrowDown": {
        const volume = Math.round((player.state.volume + (e.key === "ArrowUp" ? 0.05 : -0.05)) * 100) / 100;
        player.setVolume(volume);
        this.flash(`${Math.round(Math.min(1.25, Math.max(0, volume)) * 100)}%`);
        return true;
      }
      case "m":
      case "M":
        player.toggleMute();
        this.flash(this.shell.config.video.muted ? "Muted" : "Unmuted");
        return true;
      case "f":
      case "F":
        void this.toggleFullscreen();
        return true;
      case "Escape":
        if (!this.fullscreen) return false;
        void this.setFullscreen(false);
        return true;
      case "n":
      case "N":
        player.next();
        return true;
      case "p":
      case "P":
        player.previous();
        return true;
      case "[":
        this.stepRate(-1);
        return true;
      case "]":
        this.stepRate(1);
        return true;
      default:
        return false;
    }
  }

  get modal(): boolean {
    return this.fullscreen || this.customizer !== null;
  }

  // ---- AppModule ---------------------------------------------------------------------------

  activate() {
    this.active = true;
    this.applyView();
    if (this.view === "browse") this.sections.render();
  }

  /** Hidden: stop drawing frames, but let the sound play on. */
  deactivate() {
    this.active = false;
    closeMenu();
    this.customizer?.close();
    if (this.fullscreen) void this.setFullscreen(false);
    this.surface.stop();
  }

  configChanged() {
    if (!this.customizer) this.bar.render(this.shell.config.video.controls);
    this.sections.render();
    this.applyView();
  }

  open(request: OpenRequest) {
    if (request.kind === "video") void this.play(request.path, request.siblings);
  }

  async onLock() {
    this.customizer?.close();
    if (this.fullscreen) await this.setFullscreen(false);
    await this.player.lock();
  }

  dispose() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.osdTimer);
    clearTimeout(this.clickTimer);
    if (this.fullscreen) void getCurrentWindow().setFullscreen(false).catch(() => undefined);
    this.unsubscribe();
    this.player.dispose();
    this.surface.dispose();
  }
}
