import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppModule, OpenRequest, ShellContext } from "../../shell/module";
import { basename, dirname, h, isTypingTarget, stripExtension } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { closeMenu, openMenu, type MenuItem } from "../../ui/menu";
import type { VideoSurface } from "./api";
import { ControlBar, openPlayerMenu } from "./controls";
import { openCustomize, type CustomizeHandle } from "./customize";
import type { MenuPlace, PanelTab, VideoContext, VideoFeature } from "./extensions";
import { FEATURES } from "./features";
import { formatRate } from "./format";
import { effectiveControls } from "./items";
import { libraryService, type LibSection } from "./library-api";
import { Player } from "./player";
import { quickHooks } from "./quick-api";
import { Sections } from "./sections";
import { VideoSidebar } from "./sidebar";
import { createVideoSurface } from "./surface";

const VIDEO_EXTENSIONS = ["mp4", "mkv", "webm", "avi", "mov", "m4v", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "ogv", "3gp"];
const SUBTITLE_EXTENSIONS = ["srt", "ass", "ssa", "vtt", "sub"];
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** How long the chrome stays in fullscreen without mouse movement. */
const IDLE_MS = 2500;

const RAIL: { section: LibSection; icon: IconName; label: string }[] = [
  { section: "home", icon: "home", label: "Home" },
  { section: "videos", icon: "video", label: "Videos" },
  { section: "music", icon: "music", label: "Music" },
  { section: "streams", icon: "network", label: "Network Streams" },
  { section: "playlists", icon: "playlist", label: "Playlists" },
  { section: "recent", icon: "clock", label: "Recent" },
];

/**
 * The click landed on something over the video (the resume prompt, the stage subtitle timeline, the
 * casting chip, any button): that's not a click on the picture, so it mustn't play/pause or go fullscreen.
 */
function onStageControl(e: Event): boolean {
  const target = e.target instanceof Element ? e.target : null;
  return !!target?.closest("button, a, input, select, textarea, [role='slider'], .vq-prompt, .pp-stage-timeline, .mt-chip");
}

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
  /** Features draw here, over the video and under the bars (subtitles, prompts). */
  private readonly stageLayer = h("div", { class: "vp-stage-layer" });
  /** The right side panel: tabs contributed by features. */
  private readonly panel = h("aside", { class: "vp-panel", "aria-label": "Player panel" });
  private readonly panelTabsEl = h("div", { class: "vp-panel-tabs", role: "tablist" });
  private readonly panelBody = h("div", { class: "vp-panel-body" });
  private panelOpen = false;
  private panelTab: string | null = null;
  private readonly panelPages = new Map<string, HTMLElement>();
  private readonly features: VideoFeature[] = [];
  private tabs: PanelTab[] = [];
  private readonly overlay = h("div", { class: "vp-overlay" });
  private readonly unsubscribe: () => void;

  private view: "browse" | "player" = "browse";
  private active = false;
  private fullscreen = false;
  /** "Hide UI": nothing but the video on screen until Ctrl+H or Esc. */
  private uiHidden = false;
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
      panelOpen: () => this.panelOpen,
      togglePanel: () => this.setPanel(!this.panelOpen),
      toggleFullscreen: () => void this.toggleFullscreen(),
      addSubtitleFile: () => void this.addSubtitleFile(),
    });
    this.sidebar = new VideoSidebar(shell, {
      play: (path, queue) => void this.play(path, queue),
      openFolder: () => void this.openFolder(),
    }, this.player);
    this.sections = new Sections(shell, {
      play: (path, queue) => void this.play(path, queue),
      openFile: () => void this.openFile(),
      openFolder: () => void this.openFolder(),
      forget: (path) => this.forget(path),
    }, this.player);
    this.sections.onRailChange(() => {
      this.renderRail();
      this.applyView();
    });

    this.buildTop();
    this.buildStage();
    this.panel.append(this.panelTabsEl, this.panelBody);
    const content = h("div", { class: "vp-content" }, this.stage, this.sections.el);
    this.el.append(
      this.rail,
      h("div", { class: "vp-main" }, this.top, h("div", { class: "vp-body" }, this.sidebar.el, content, this.panel), this.bar.el),
    );
    this.el.addEventListener("pointermove", () => this.wake());
    this.el.addEventListener("pointerdown", () => this.wake());
    // A focused button would otherwise also "click" on the Space that toggles playback.
    this.el.addEventListener("keyup", (e) => {
      if (e.key === " " && this.view === "player") e.preventDefault();
    });

    this.bar.render(effectiveControls(shell.config.video.controls));
    this.renderRail();
    this.applyView();
    this.unsubscribe = this.player.subscribe(() => this.sync());

    const context = this.context();
    for (const create of FEATURES) this.features.push(create(context));
    this.tabs = this.features.flatMap((f) => f.panelTabs ?? []).sort((a, b) => a.order - b.order);
    this.renderPanelTabs();
  }

  /** The feature-facing view of the module (see extensions.ts). */
  private context(): VideoContext {
    const module = this;
    return {
      shell: this.shell,
      player: this.player,
      surface: this.surface,
      stageLayer: this.stageLayer,
      get showingPlayer() { return module.view === "player"; },
      get fullscreen() { return module.fullscreen; },
      play: (path, queue) => this.play(path, queue),
      showOsd: (text, shortcut) => this.flash(text, shortcut),
      openPanel: (tab) => this.setPanel(true, tab),
      closePanel: () => this.setPanel(false),
      showPlayer: () => this.setView("player"),
      configChanged: () => {
        this.shell.saveConfig();
        this.configChanged();
      },
    };
  }

  /** Menu items contributed by features for a place, grouped with separators. */
  private featureItems(place: MenuPlace): MenuItem[] {
    return this.features
      .map((f) => f.menuItems?.(place) ?? [])
      .filter((group) => group.length)
      .flatMap((group): MenuItem[] => ["separator", ...group]);
  }

  // ---- side panel --------------------------------------------------------------------------

  private renderPanelTabs() {
    this.panelTabsEl.replaceChildren(...this.tabs.map((tab) => {
      const b = h("button", { class: `vp-panel-tab${tab.id === this.panelTab ? " active" : ""}`, type: "button", role: "tab", title: tab.title },
        icon(tab.icon, 16), h("span", null, tab.title));
      b.addEventListener("click", () => this.setPanel(true, tab.id));
      return b;
    }));
  }

  private setPanel(open: boolean, tabId?: string) {
    if (!this.tabs.length) return;
    const next = open ? tabId ?? this.panelTab ?? this.tabs[0].id : this.panelTab;
    const previous = this.panelOpen ? this.tabs.find((t) => t.id === this.panelTab) : undefined;
    const tab = this.tabs.find((t) => t.id === next) ?? this.tabs[0];
    if (previous && (!open || previous.id !== tab.id)) previous.hidden?.();
    this.panelOpen = open;
    if (open) {
      let page = this.panelPages.get(tab.id);
      if (!page) {
        page = h("div", { class: "vp-panel-page" }, tab.render());
        this.panelPages.set(tab.id, page);
      }
      this.panelBody.replaceChildren(page);
      const changed = this.panelTab !== tab.id || !previous;
      this.panelTab = tab.id;
      if (changed) tab.shown?.();
    }
    this.renderPanelTabs();
    this.applyView();
  }

  // ---- building ----------------------------------------------------------------------------

  private buildTop() {
    const more = h("button", { class: "icon-btn", type: "button", title: "Menu", "aria-label": "Menu" }, icon("more", 18));
    more.addEventListener("click", () => {
      const r = more.getBoundingClientRect();
      openPlayerMenu(r.left, r.bottom + 6, this.playerMenu("top"));
    });
    this.sidebarToggle.addEventListener("click", () => this.toggleSidebar());
    this.top.append(
      h("div", { class: "vp-top-side" }, more, this.sidebarToggle, h("span", { class: "vp-top-sep" }),
        icon("folder", 16), this.crumb),
      this.titleEl,
      h("div", { class: "vp-top-side end" }),
    );
  }

  /**
   * The one menu: the "…" button and a right-click on the video both show it. Built-in items,
   * then each feature's group for the place, then Customise Player.
   */
  private playerMenu(place: "top" | "stage"): MenuItem[] {
    const has = this.player.current !== null;
    const watching = has && this.view === "player";
    return [
      { label: "Open File… (Ctrl+O)", icon: "video", action: () => void this.openFile() },
      { label: "Open Folder…", icon: "folder", action: () => void this.openFolder() },
      "separator",
      { label: "Add Subtitles…", icon: "subtitles", disabled: !has, action: () => (quickHooks.addSubtitles ?? (() => void this.addSubtitleFile()))() },
      ...this.featureItems(place),
      "separator",
      { label: this.fullscreen ? "Exit Fullscreen (F)" : "Fullscreen (F)", icon: "fullscreen", disabled: !watching, action: () => void this.toggleFullscreen() },
      { label: "Hide UI (Ctrl+H)", icon: "eyeOff", disabled: !watching, action: () => {
        this.setUiHidden(true);
        this.flash("UI hidden", "Ctrl+H or Esc to show");
      } },
      { label: this.panelOpen ? "Close Side Panel" : "Side Panel", icon: "sidebar", disabled: !watching || this.tabs.length === 0, action: () => this.setPanel(!this.panelOpen) },
      "separator",
      { label: "Customise Player…", icon: "settings", action: () => this.customise() },
    ];
  }

  private buildStage() {
    this.stage.append(this.surface.el, this.stageLayer, this.osd, this.overlay);
    this.stage.addEventListener("contextmenu", (e) => {
      if (this.view !== "player") return;
      e.preventDefault();
      clearTimeout(this.clickTimer);
      openPlayerMenu(e.clientX, e.clientY, this.playerMenu("stage"));
    });
    this.stage.addEventListener("click", (e) => {
      if (this.view !== "player" || onStageControl(e)) return;
      // Wait out a possible double click before treating it as play/pause.
      clearTimeout(this.clickTimer);
      this.clickTimer = window.setTimeout(() => this.player.togglePlay(), 220);
    });
    this.stage.addEventListener("dblclick", (e) => {
      if (onStageControl(e)) return;
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
    const section = this.sections.section;
    for (const entry of RAIL) {
      items.push(button(entry.icon, entry.label, this.view === "browse" && section === entry.section && this.sections.sectionActive, () => this.setSection(entry.section)));
    }
    const pins = this.sections.pinnedRail();
    if (pins.length) items.push(h("span", { class: "vp-rail-sep", "aria-hidden": "true" }));
    for (const pin of pins) {
      items.push(button(pin.icon, pin.label, this.view === "browse" && pin.active, () => {
        if (pin.open()) this.setView("browse");
      }));
    }
    const add = button("plus", "Open…", false, () => {
      const r = add.getBoundingClientRect();
      openMenu(r.right + 6, r.top, [
        { label: "Open File…", icon: "video", action: () => void this.openFile() },
        { label: "Open Folder…", icon: "folder", action: () => void this.openFolder() },
        ...this.featureItems("open"),
      ]);
    });
    items.push(add);
    this.rail.replaceChildren(...items);
  }

  // ---- views -------------------------------------------------------------------------------

  private setSection(section: LibSection) {
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
    el.toggle("panel-open", playing && this.panelOpen);
    el.toggle("ui-hidden", playing && this.uiHidden);
    this.sidebarToggle.classList.toggle("active", playing && this.sidebarOpen());
    this.sidebarToggle.disabled = !playing;
    if (this.active && playing) this.surface.start();
    else this.surface.stop();
    this.crumb.textContent = playing && this.player.current ? basename(dirname(this.player.current)) : this.sections.title;
    const current = this.player.current;
    this.titleEl.textContent = playing && current ? libraryService()?.label(current) ?? stripExtension(basename(current)) : "";
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
        this.uiHidden = false;
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
      controls: effectiveControls(this.shell.config.video.controls),
      onSave: (ids) => {
        this.shell.config.video.controls = ids;
        this.shell.saveConfig();
      },
      onClose: () => {
        this.customizer = null;
        this.el.classList.remove("customizing");
        this.bar.render(effectiveControls(this.shell.config.video.controls));
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
    if (!this.fullscreen && !this.uiHidden) return;
    this.idleTimer = window.setTimeout(() => {
      const busy = this.customizer || document.querySelector(".menu") || this.el.querySelector(".vp-top:hover, .vp-bar:hover, .vp-sidebar:hover, .vp-panel:hover");
      if (busy) this.wake();
      else this.el.classList.add("idle");
    }, IDLE_MS);
  }

  /** Hides everything but the video (H, or the menu); H or Esc brings the interface back. */
  private setUiHidden(on: boolean) {
    if (on === this.uiHidden) return;
    this.uiHidden = on;
    closeMenu();
    this.applyView();
    this.wake();
  }

  // ---- keys and feedback -------------------------------------------------------------------

  private flash(text: string, shortcut?: string) {
    this.osd.replaceChildren(h("span", null, text));
    if (shortcut) this.osd.append(h("kbd", { class: "vp-osd-key" }, shortcut));
    this.osd.classList.add("show");
    clearTimeout(this.osdTimer);
    this.osdTimer = window.setTimeout(() => this.osd.classList.remove("show"), 900);
  }

  private stepRate(direction: 1 | -1, key: string) {
    const { rate } = this.player.state;
    const to = direction === 1
      ? RATES.find((r) => r > rate + 0.001)
      : [...RATES].reverse().find((r) => r < rate - 0.001);
    if (to !== undefined) this.player.setRate(to);
    this.flash(`Speed ${formatRate(to ?? rate)}`, key);
  }

  handleKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (this.customizer) {
      if (e.key !== "Escape") return false;
      this.customizer.close();
      return true;
    }
    if (!isTypingTarget(e.target)) {
      for (const feature of this.features) if (feature.handleKey?.(e)) return true;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "o") {
      void this.openFile();
      return true;
    }
    // Ctrl+H as in VLC's minimal interface; plain G/H belong to the subtitle delay.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "h" && this.view === "player" && this.player.current) {
      this.setUiHidden(!this.uiHidden);
      this.flash(this.uiHidden ? "UI hidden" : "UI shown", this.uiHidden ? "Ctrl+H or Esc to show" : "Ctrl+H");
      return true;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || this.view !== "player" || !this.player.current) return false;
    const { player } = this;
    // Every action tells the user which key did it: `flash(result, key)`.
    switch (e.key) {
      case " ":
      case "k":
      case "K": {
        const ended = player.state.ended;
        player.togglePlay();
        this.flash(ended ? "Replay" : player.state.playing ? "Play" : "Paused", e.key === " " ? "Space" : e.key.toUpperCase());
        return true;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        const seconds = e.shiftKey ? 30 : 5;
        const back = e.key === "ArrowLeft";
        player.seekBy((back ? -1 : 1) * seconds * 1000);
        this.flash(`${back ? "Back" : "Forward"} ${seconds} s`, `${e.shiftKey ? "⇧" : ""}${back ? "←" : "→"}`);
        return true;
      }
      case "ArrowUp":
      case "ArrowDown": {
        const volume = Math.round((player.state.volume + (e.key === "ArrowUp" ? 0.05 : -0.05)) * 100) / 100;
        player.setVolume(volume);
        this.flash(`Volume ${Math.round(Math.min(1.25, Math.max(0, volume)) * 100)}%`, e.key === "ArrowUp" ? "↑" : "↓");
        return true;
      }
      case "m":
      case "M":
        player.toggleMute();
        this.flash(this.shell.config.video.muted ? "Muted" : "Unmuted", "M");
        return true;
      case "f":
      case "F":
        void this.toggleFullscreen().then(() => this.flash(this.fullscreen ? "Fullscreen" : "Windowed", "F"));
        return true;
      case "Escape":
        if (this.uiHidden) {
          this.setUiHidden(false);
          this.flash("UI shown", "Esc");
          return true;
        }
        if (!this.fullscreen) return false;
        void this.setFullscreen(false).then(() => this.flash("Windowed", "Esc"));
        return true;
      case "n":
      case "N":
        player.next();
        this.flash("Next video", "N");
        return true;
      case "p":
      case "P":
        player.previous();
        this.flash("Previous video", "P");
        return true;
      case "[":
      case "]":
        this.stepRate(e.key === "[" ? -1 : 1, e.key);
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
    this.uiHidden = false;
    closeMenu();
    this.customizer?.close();
    if (this.fullscreen) void this.setFullscreen(false);
    this.surface.stop();
  }

  configChanged() {
    if (!this.customizer) this.bar.render(effectiveControls(this.shell.config.video.controls));
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
    for (const feature of this.features) feature.dispose?.();
    this.unsubscribe();
    this.player.dispose();
    this.surface.dispose();
  }
}
