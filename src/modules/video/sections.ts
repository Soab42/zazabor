import type { ShellContext } from "../../shell/module";
import { basename, h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu } from "../../ui/menu";
import type { LibSection, Pin, ViewMode } from "./library-api";
import type { Player } from "./player";
import { Library } from "./features/library/store";
import {
  MUSIC_TABS, SECTION_ICONS, SECTION_TITLES, SORT_LABELS, pageKind, sameRoute,
  type Crumb, type PageEnv, type PageHooks, type PageResult, type Route,
} from "./features/library/page";
import { folderPage, homePage, recentPage, videosPage } from "./features/library/pages-video";
import { musicCrumbLabel, musicPage } from "./features/library/pages-music";
import { playlistPage, playlistsPage, streamsPage } from "./features/library/pages-lists";

export interface SectionsHooks extends PageHooks {
  /** Plays a file; `queue` is what to continue through. */
  play(path: string, queue?: string[]): void;
}

/** A pinned item for the module's rail. */
export interface RailPin {
  icon: IconName;
  label: string;
  active: boolean;
  /** Opens it; returns true when a library page is now showing (and the player should step aside). */
  open(): boolean;
}

const PIN_ICONS: Record<Pin["kind"], IconName> = { folder: "folder", playlist: "playlist", stream: "network", album: "music", artist: "music" };

/**
 * The media library pages: Home, Videos, Music, Network Streams, Playlists and Recent, with back
 * and forward, an address bar of clickable crumbs, and visible sort, view mode and search. The
 * pages themselves live in `features/library/`.
 */
export class Sections {
  readonly el = h("div", { class: "vp-sections lib" });
  private readonly lib: Library;
  private route: Route;
  private history: Route[] = [];
  private cursor = -1;
  private query = "";
  private dirty = false;
  private railKey = "";
  private disposePage: (() => void) | undefined;
  private readonly railListeners = new Set<() => void>();

  private readonly bar = h("div", { class: "lib-bar" });
  private readonly bodyEl = h("div", { class: "lib-body" });
  private readonly back = h("button", { class: "icon-btn", type: "button", title: "Back", "aria-label": "Back" }, icon("chevronLeft", 18));
  private readonly forward = h("button", { class: "icon-btn", type: "button", title: "Forward", "aria-label": "Forward" }, icon("chevronRight", 18));
  private readonly address = h("nav", { class: "lib-address", "aria-label": "Location" });
  private readonly countEl = h("span", { class: "lib-count" });
  private readonly actionsEl = h("div", { class: "lib-actions" });
  private readonly controlsEl = h("div", { class: "lib-controls" });

  constructor(shell: ShellContext, private readonly hooks: SectionsHooks, player: Player) {
    this.lib = Library.of(shell, player);
    this.lib.playFn = (path, queue) => hooks.play(path, queue);
    this.route = this.rootRoute(this.lib.settings.section);
    this.history = [this.route];
    this.cursor = 0;
    this.back.addEventListener("click", () => this.step(-1));
    this.forward.addEventListener("click", () => this.step(1));
    this.bar.append(this.back, this.forward, this.address, h("span", { class: "lib-grow" }), this.countEl, this.actionsEl, this.controlsEl);
    this.el.append(this.bar, this.bodyEl);
    this.lib.onChange(() => this.refresh());
    this.renderBar();
  }

  // ---- what the module reads --------------------------------------------------------------------

  /** The title of what is on screen, for the top bar. */
  get title(): string {
    const crumbs = this.crumbs();
    return crumbs[crumbs.length - 1]?.label ?? SECTION_TITLES[this.route.section];
  }

  get section(): LibSection {
    return this.route.section;
  }

  /** The section's own rail button is lit (a pinned item that is on screen lights its own instead). */
  get sectionActive(): boolean {
    return !this.lib.settings.pinned.some((pin) => {
      const route = this.pinRoute(pin);
      return !!route && sameRoute(route, this.route);
    });
  }

  /** Calls `fn` when the rail needs to redraw: the section changed or pins did. */
  onRailChange(fn: () => void): () => void {
    this.railListeners.add(fn);
    return () => this.railListeners.delete(fn);
  }

  /** Pinned folders, playlists, streams, albums and artists, for the rail. */
  pinnedRail(): RailPin[] {
    return this.lib.settings.pinned.map((pin) => {
      const route = this.pinRoute(pin);
      return {
        icon: PIN_ICONS[pin.kind],
        label: pin.kind === "stream" ? `Play ${pin.name}` : pin.name,
        active: !!route && sameRoute(route, this.route),
        open: () => {
          if (route) {
            this.go(route);
            return true;
          }
          const stream = this.lib.streamById(pin.id);
          if (stream) this.lib.playAll([stream.url]);
          return false;
        },
      };
    });
  }

  private pinRoute(pin: Pin): Route | null {
    switch (pin.kind) {
      case "folder": return { section: "videos", folder: pin.id };
      case "playlist": return { section: "playlists", id: pin.id };
      case "album": return { section: "music", tab: "albums", album: pin.id };
      case "artist": return { section: "music", tab: "artists", artist: pin.id };
      default: return null;
    }
  }

  // ---- navigation ---------------------------------------------------------------------------------

  private rootRoute(section: LibSection): Route {
    switch (section) {
      case "music": return { section, tab: this.lib?.settings.musicTab ?? "songs" };
      case "videos": return { section };
      case "playlists": return { section };
      default: return { section };
    }
  }

  /** Opens a section's first page (the rail's buttons). */
  show(section: LibSection) {
    this.go(this.rootRoute(section));
  }

  /** Lists a folder's videos on the Videos page. */
  async showFolder(path: string) {
    this.go({ section: "videos", folder: path });
  }

  go(route: Route, record = true) {
    if (record && !sameRoute(route, this.route)) {
      this.history = [...this.history.slice(0, this.cursor + 1), route];
      this.cursor = this.history.length - 1;
    }
    this.route = route;
    this.query = "";
    this.lib.settings.section = route.section;
    if (route.section === "music") this.lib.settings.musicTab = route.tab;
    this.lib.save();
    this.renderBar();
    this.render(false);
    this.el.scrollTop = 0;
    this.railChanged();
  }

  private step(delta: number) {
    const to = this.cursor + delta;
    if (to < 0 || to >= this.history.length) return;
    this.cursor = to;
    this.go(this.history[to], false);
  }

  private crumbs(): Crumb[] {
    const { route } = this;
    const root = (section: LibSection): Crumb => ({ label: SECTION_TITLES[section], route: this.rootRoute(section) });
    switch (route.section) {
      case "videos":
        return route.folder ? [root("videos"), { label: basename(route.folder), route }] : [root("videos")];
      case "music": {
        const crumbs = [root("music")];
        const tab = MUSIC_TABS.find((t) => t.id === route.tab);
        if (tab) crumbs.push({ label: tab.label, route: { section: "music", tab: route.tab } });
        if (route.album || route.artist || route.genre) crumbs.push({ label: musicCrumbLabel(this.lib.songs, route), route });
        return crumbs;
      }
      case "playlists":
        return route.id ? [root("playlists"), { label: this.lib.playlist(route.id)?.name ?? "Playlist", route }] : [root("playlists")];
      default:
        return [root(route.section)];
    }
  }

  private railChanged() {
    const key = JSON.stringify([this.route, this.lib.settings.pinned]);
    if (key === this.railKey) return;
    this.railKey = key;
    for (const fn of this.railListeners) fn();
  }

  // ---- drawing ------------------------------------------------------------------------------------

  /** The address bar and the sort / view / search controls; rebuilt when the route changes. */
  private renderBar() {
    const kind = pageKind(this.route);
    const crumbs = this.crumbs();
    this.back.disabled = this.cursor <= 0;
    this.forward.disabled = this.cursor >= this.history.length - 1;
    const sectionIcon = SECTION_ICONS[this.route.section];
    this.address.replaceChildren(h("span", { class: "lib-address-icon" }, icon(sectionIcon, 16)), ...crumbs.flatMap((crumb, i) => {
      const last = i === crumbs.length - 1;
      const item = last
        ? h("span", { class: "lib-crumb current", title: crumb.label }, crumb.label)
        : h("button", { class: "lib-crumb", type: "button", title: crumb.label, onclick: () => this.go(crumb.route) }, crumb.label);
      return i === 0 ? [item] : [h("span", { class: "lib-crumb-sep", "aria-hidden": "true" }, icon("chevronRight", 12)), item];
    }));

    const controls: HTMLElement[] = [];
    if (kind.sorts.length > 0) {
      const sort = this.lib.settings.sorts[kind.key] ?? kind.defaultSort;
      const sortButton = h("button", { class: "lib-sort", type: "button", title: "Sort by", "aria-label": `Sort by ${SORT_LABELS[sort]}` }, icon("sort", 15), h("span", null, SORT_LABELS[sort]));
      sortButton.addEventListener("click", () => {
        const r = sortButton.getBoundingClientRect();
        openMenu(r.left, r.bottom + 6, kind.sorts.map((key) => ({
          label: SORT_LABELS[key], icon: key === sort ? ("check" as const) : undefined,
          action: () => {
            this.lib.settings.sorts[kind.key] = key;
            this.lib.save();
            this.renderBar();
            this.render(false);
          },
        })));
      });
      controls.push(sortButton);
    }
    if (kind.views) {
      const view = this.lib.settings.views[kind.key] ?? kind.defaultView;
      const mode = (value: ViewMode, iconName: IconName, label: string) => {
        const b = h("button", { type: "button", class: view === value ? "active" : "", title: label, "aria-label": label, "aria-pressed": String(view === value) }, icon(iconName, 15));
        b.addEventListener("click", () => {
          if (view === value) return;
          this.lib.settings.views[kind.key] = value;
          this.lib.save();
          this.renderBar();
          this.render(false);
        });
        return b;
      };
      controls.push(h("div", { class: "segmented lib-view" }, mode("grid", "grid", "Grid view"), mode("list", "list", "List view")));
    }
    if (kind.search) {
      const input = h("input", { class: "lib-search-input", type: "text", placeholder: kind.placeholder, spellcheck: false, autocomplete: "off", "aria-label": kind.placeholder, value: this.query });
      input.addEventListener("input", () => {
        this.query = input.value.trim().toLowerCase();
        this.render(false);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && input.value) {
          e.stopPropagation();
          input.value = "";
          this.query = "";
          this.render(false);
        }
      });
      controls.push(h("label", { class: "lib-search" }, icon("search", 15), input));
    }
    this.controlsEl.replaceChildren(...controls);
  }

  /** Redraws the page from the library's data (scroll position kept unless `keepScroll` is false). */
  render(keepScroll = true) {
    this.dirty = false;
    const scroll = this.el.scrollTop;
    const kind = pageKind(this.route);
    const env: PageEnv = {
      lib: this.lib, hooks: this.hooks, route: this.route, query: this.query,
      view: this.lib.settings.views[kind.key] ?? kind.defaultView,
      sort: this.lib.settings.sorts[kind.key] ?? kind.defaultSort,
      go: (route) => this.go(route),
    };
    this.disposePage?.();
    this.disposePage = undefined;
    let page: PageResult;
    try {
      page = this.build(env);
    } catch (err) {
      console.warn("Could not draw the library page:", err);
      page = { body: h("div", { class: "lib-page" }, h("p", { class: "lib-note" }, "This page couldn't be drawn.")) };
    }
    this.disposePage = page.dispose;
    this.bodyEl.replaceChildren(page.body);
    this.countEl.textContent = page.count ?? "";
    this.actionsEl.replaceChildren(...(page.actions ?? []));
    if (keepScroll) this.el.scrollTop = scroll;
  }

  private build(env: PageEnv): PageResult {
    const { route } = env;
    switch (route.section) {
      case "home": return homePage(env);
      case "recent": return recentPage(env);
      case "videos": return route.folder ? folderPage(env, route.folder) : videosPage(env);
      case "music": return musicPage(env);
      case "streams": return streamsPage(env);
      default: return route.id ? playlistPage(env, route.id) : playlistsPage(env);
    }
  }

  /** The library's data changed: redraw if visible, and not under the user's typing. */
  private refresh() {
    this.railChanged();
    if (this.el.offsetParent === null) {
      this.dirty = true;
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && this.el.contains(active)) {
      this.dirty = true;
      active.addEventListener("blur", () => this.dirty && this.render(), { once: true });
      return;
    }
    this.renderBar();
    this.render();
  }

  /** Whether a redraw was skipped while hidden. */
  get stale(): boolean {
    return this.dirty;
  }
}
