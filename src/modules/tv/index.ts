import type { AppModule, ModuleFactory, ShellContext } from "../../shell/module";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import "../files/ops/ops.css";
import { showToast } from "../files/ops/toast";
import { errorText, isMock, onTv, tvApi, type CatRow, type Home, type Item, type Progress, type Section } from "./api";
import { BrowsePage } from "./browse";
import { Detail } from "./detail";
import { Hero, homeRows, homeSkeleton } from "./home";
import { LivePage } from "./live";
import { notice, PosterLoader, type TvCtx } from "./parts";
import "./tv.css";

type Route =
  | { id: "home" }
  | { id: "section"; section: "movies" | "tv" | "animation" | "indian" }
  | { id: "category"; url: string; label: string }
  | { id: "search" }
  | { id: "live" };

const NAV: { id: string; label: string; route: Route }[] = [
  { id: "home", label: "Home", route: { id: "home" } },
  { id: "movies", label: "Movies", route: { id: "section", section: "movies" } },
  { id: "tv", label: "TV Shows", route: { id: "section", section: "tv" } },
  { id: "animation", label: "Animation", route: { id: "section", section: "animation" } },
  { id: "indian", label: "Bangla & Indian", route: { id: "section", section: "indian" } },
  { id: "live", label: "Live TV", route: { id: "live" } },
  { id: "search", label: "Search", route: { id: "search" } },
];

const SECTION_TITLES: Record<string, [string, string]> = {
  movies: ["Movies", "Every film on the servers"],
  tv: ["TV Shows", "Series, web series and shows"],
  animation: ["Animation", "Animated films, anime and cartoons"],
  indian: ["Bangla & Indian", "Kolkata Bangla, Hindi and South Indian films"],
};

const navId = (r: Route) => (r.id === "section" ? (r.section === "tv" ? "tv" : r.section) : r.id === "category" ? "" : r.id);
const routeKey = (r: Route) => JSON.stringify(r);

class TvModule implements AppModule {
  readonly id = "tv" as const;
  readonly title = "TV";
  readonly icon = "tv" as const;
  readonly el: HTMLElement;

  private nav = h("nav", { class: "tv-nav glass", "aria-label": "TV" });
  private glider = h("span", { class: "tv-nav-glider", "aria-hidden": "true" });
  private pills = new Map<string, HTMLElement>();
  private back = h("button", { class: "tv-nav-back", type: "button", title: "Back (Esc)", "aria-label": "Back", hidden: true, "data-tv-focus": "" }, icon("chevronLeft", 18));
  private status = h("button", { class: "tv-status", type: "button", title: "Refresh the catalog", "data-tv-focus": "" });
  private scroll = h("div", { class: "tv-scroll" });
  private pageEl = h("div", { class: "tv-page" });
  private layer = h("div", { class: "tv-layer" });
  private loader = new PosterLoader();
  private route: Route = { id: "home" };
  private history: Route[] = [];
  private hero: Hero | null = null;
  private page: { dispose?(): void } | null = null;
  private home: Home | null = null;
  private progress: Progress | null = null;
  private detail: Detail | null = null;
  private detailFocus: HTMLElement | null = null;
  private drawSerial = 0;
  private reloadTimer = 0;
  private refreshTimer = 0;
  private active = false;
  private started = false;
  private unlisten: Promise<() => void>[] = [];
  private ctx: TvCtx;

  constructor(private shell: ShellContext) {
    this.ctx = {
      shell,
      loader: this.loader,
      play: (item) => this.play(item),
      playUrl: (item, path, siblings) => this.playUrl(item, path, siblings),
      openDetail: (item, from) => this.openDetail(item, from),
      openCategory: (url, label) => this.go({ id: "category", url, label }),
    };
    for (const n of NAV) {
      const pill = h("button", { class: "tv-nav-pill", type: "button", "data-tv-focus": "" }, n.id === "search" ? icon("search", 15) : null, n.label);
      pill.addEventListener("click", () => this.go(n.route, true));
      this.pills.set(n.id, pill);
    }
    this.back.addEventListener("click", () => this.goBack());
    this.status.addEventListener("click", () => void this.refresh(true));
    this.nav.append(this.glider, this.back, ...this.pills.values(), h("span", { class: "tv-nav-sep" }), this.status);
    this.scroll.append(this.pageEl);
    this.el = h("div", { class: "tv" }, this.scroll, this.nav, this.layer);
    this.el.addEventListener("focusin", (e) => this.rove(e.target as HTMLElement));
    let frame = 0;
    this.scroll.addEventListener("scroll", () => {
      if (frame || !this.hero) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        this.hero?.parallax(this.scroll.scrollTop);
      });
    }, { passive: true });
    new ResizeObserver(() => this.moveGlider()).observe(this.nav);
    this.paintNav();
    this.paintStatus();
  }

  // ---- life

  activate() {
    this.active = true;
    if (!this.started) {
      this.started = true;
      this.unlisten.push(
        onTv("tv-progress", (p) => this.onProgress(p)),
        onTv("tv-changed", () => this.onChanged()),
      );
      void tvApi.state().then((p) => this.onProgress(p), () => undefined);
      void this.refresh(false);
      this.refreshTimer = window.setInterval(() => void this.refresh(false), 30 * 60 * 1000);
      void this.show(false);
    } else if (this.route.id === "home") {
      this.scheduleReload(0);
    }
    this.hero?.start();
    if (!this.detail) window.setTimeout(() => this.focusFirst(), 60);
  }

  deactivate() {
    this.active = false;
    this.hero?.stop();
  }

  dispose() {
    clearInterval(this.refreshTimer);
    clearTimeout(this.reloadTimer);
    this.hero?.stop();
    this.page?.dispose?.();
    for (const u of this.unlisten) void u.then((fn) => fn());
  }

  configChanged() {
    void this.refresh(false);
    this.home = null;
    void this.show(true);
  }

  get modal() {
    return this.detail !== null;
  }

  // ---- the catalog

  private async refresh(force: boolean) {
    try {
      this.onProgress(await tvApi.start(this.shell.config.tv, force));
    } catch (err) {
      this.onProgress({ running: false, done: 0, total: 0, items: 0, reachable: false, error: errorText(err), lastCrawl: 0 });
    }
  }

  private onProgress(p: Progress) {
    const wasRunning = this.progress?.running === true;
    this.progress = p;
    this.paintStatus();
    if (wasRunning && !p.running) this.scheduleReload(300);
    else if (this.route.id === "home" && (!this.home || this.home.total === 0) && p.items > 0) this.scheduleReload(1200);
  }

  private onChanged() {
    if (this.route.id === "home" && (!this.home || this.home.total === 0)) this.scheduleReload(1200);
  }

  private scheduleReload(ms: number) {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => {
      if (this.route.id === "home" || this.route.id === "section" || this.route.id === "category") void this.show(true);
    }, ms);
  }

  private paintStatus() {
    const p = this.progress;
    let text = "";
    if (p?.running) text = p.total ? `Updating ${p.done}/${p.total}` : "Looking…";
    else if (p?.reachable === false) text = "Offline";
    else if (p && p.items) text = `${p.items.toLocaleString()} titles`;
    this.status.classList.toggle("spin", p?.running === true);
    this.status.classList.toggle("bad", !p?.running && p?.reachable === false);
    this.status.replaceChildren(icon(p?.reachable === false && !p.running ? "bolt" : "refresh", 15), h("span", null, text || "Refresh"));
    this.status.title = p?.reachable === false ? p.error : "Refresh the catalog";
  }

  // ---- routes

  private go(route: Route, reset = false) {
    if (this.detail) this.closeDetail(false);
    if (routeKey(route) === routeKey(this.route)) {
      this.scroll.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (reset) this.history = [];
    else this.history.push(this.route);
    this.route = route;
    void this.show(false);
  }

  private goBack() {
    const prev = this.history.pop();
    if (!prev) return;
    this.route = prev;
    void this.show(false);
  }

  private paintNav() {
    const current = navId(this.route);
    for (const [id, pill] of this.pills) {
      pill.classList.toggle("on", id === current);
      if (id === current) pill.setAttribute("aria-current", "page");
      else pill.removeAttribute("aria-current");
    }
    this.back.hidden = this.history.length === 0;
    requestAnimationFrame(() => this.moveGlider());
  }

  /** The glass highlight slides to the active pill. */
  private moveGlider() {
    const pill = this.pills.get(navId(this.route));
    this.glider.classList.toggle("none", !pill || !pill.offsetWidth);
    if (!pill || !pill.offsetWidth) return;
    this.glider.style.width = `${pill.offsetWidth}px`;
    this.glider.style.transform = `translate3d(${pill.offsetLeft}px, 0, 0)`;
  }

  /** Draws the current route; `keep` keeps the scroll position (a quiet redraw as the catalog grows). */
  private async show(keep: boolean) {
    const serial = ++this.drawSerial;
    const top = keep ? this.scroll.scrollTop : 0;
    this.hero?.stop();
    this.hero = null;
    this.page?.dispose?.();
    this.page = null;
    this.loader.reset();
    this.paintNav();
    const route = this.route;
    const target = this.pageEl;
    let entered = keep;
    const put = (...children: Node[]) => {
      target.replaceChildren(...children);
      this.scroll.scrollTop = top;
      if (!entered) {
        // a page comes in with a short fade and rise
        entered = true;
        target.classList.remove("enter");
        void target.offsetWidth;
        target.classList.add("enter");
      }
    };
    if (route.id === "home") {
      if (!this.home) put(homeSkeleton());
      let home: Home;
      try {
        home = await tvApi.home();
      } catch (err) {
        if (serial === this.drawSerial) put(notice("tv", "TV isn't available", errorText(err)));
        return;
      }
      if (serial !== this.drawSerial) return;
      this.home = home;
      this.loader.reset();
      if (!home.total) return put(this.emptyHome());
      const { hero, rows } = homeRows(home, this.ctx);
      this.hero = hero;
      const banner = this.banner();
      put(...[hero?.el ?? h("div", { class: "tv-hero-gap" }), banner, ...rows, h("div", { class: "tv-end" })].filter((n): n is HTMLElement => !!n));
      if (this.active) hero?.start();
    } else if (route.id === "live") {
      const live = new LivePage(this.ctx);
      this.page = live;
      put(live.el);
      await live.load();
    } else {
      const page = await this.browsePage(route);
      if (serial !== this.drawSerial) return;
      this.page = page;
      put(page.el);
      await page.load();
      if (route.id === "search" && !keep) page.focusSearch();
    }
    if (serial === this.drawSerial && !keep && this.active && route.id !== "search") window.setTimeout(() => this.focusFirst(), 60);
  }

  private async browsePage(route: Route): Promise<BrowsePage> {
    if (route.id === "search") return new BrowsePage(this.ctx, { title: "Search", subtitle: "Titles across every server", base: {}, search: true });
    if (route.id === "category") {
      return new BrowsePage(this.ctx, { title: route.label, base: { categoryUrl: route.url }, ranked: /imdb/i.test(route.label) });
    }
    const section = (route as { section: Section }).section;
    const [title, subtitle] = SECTION_TITLES[section];
    let cats: CatRow[] = this.home?.categories ?? [];
    if (!cats.length) cats = (await tvApi.home().catch(() => null))?.categories ?? [];
    const mine = cats.filter((c) => (section === "tv" ? c.kind === "series" : section === "movies" ? c.kind === "movie" : c.section === section));
    const extra = mine.length > 1
      ? h("div", { class: "tv-cats" }, ...mine.map((c) => {
        const b = h("button", { class: "tv-cat glass", type: "button", "data-tv-focus": "" }, c.label, h("span", null, c.count.toLocaleString()));
        b.addEventListener("click", () => this.go({ id: "category", url: c.url, label: c.label }));
        return b;
      }))
      : undefined;
    const base = section === "movies" ? { kind: "movie" as const } : section === "tv" ? { kind: "series" as const } : { section };
    return new BrowsePage(this.ctx, { title, subtitle, base, extra });
  }

  private banner(): HTMLElement | null {
    const p = this.progress;
    if (p?.reachable !== false || p.running) return null;
    return h("div", { class: "tv-banner glass" }, icon("bolt", 16), h("span", null, `${p.error || "Can't reach DhakaFlix."} Showing the saved catalog; playing needs the network.`));
  }

  private emptyHome(): HTMLElement {
    const p = this.progress;
    if (p?.running || !p) {
      return h("div", { class: "tv-empty-wrap" }, notice("refresh", "Reading DhakaFlix", p?.total ? `${p.done} of ${p.total} categories read, ${p.items.toLocaleString()} titles found so far.` : "Finding the movie and series categories…"));
    }
    const retry = h("button", { class: "tv-pill primary", type: "button", "data-tv-focus": "" }, icon("refresh", 16), "Try again");
    retry.addEventListener("click", () => void this.refresh(true));
    const settings = h("button", { class: "tv-pill glass", type: "button", "data-tv-focus": "" }, icon("settings", 16), "Server settings");
    settings.addEventListener("click", () => this.shell.openSettings("tv"));
    const off = p.reachable === false;
    return h("div", { class: "tv-empty-wrap" }, notice(off ? "bolt" : "tv", off ? "Can't reach the movie server" : "Nothing found yet", off ? p.error || "Can't reach DhakaFlix — are you on the ISP's network?" : "The servers answered but no movie folders turned up. Check the addresses and categories in Settings.", retry, settings));
  }

  // ---- playing

  private fail(err: unknown) {
    showToast(errorText(err));
  }

  private mark(item: Item) {
    item.played = Date.now();
    void tvApi.played(item.id).catch(() => undefined);
  }

  private play(item: Item) {
    if (item.kind === "series") {
      void tvApi.episodes(item.id).then((seasons) => {
        const all = seasons.flatMap((s) => s.episodes.map((e) => e.url));
        if (!all.length) return this.openDetail(item);
        this.playUrl(item, all[0], all);
      }, (err) => this.fail(err));
      return;
    }
    if (item.videoUrl) return this.playUrl(item, item.videoUrl);
    tvApi.resolve(item.id).then((done) => {
      Object.assign(item, done);
      if (done.videoUrl) this.playUrl(item, done.videoUrl);
      else this.fail("No video file was found in that folder.");
    }, (err) => this.fail(err));
  }

  private playUrl(item: Item, path: string, siblings?: string[]) {
    this.mark(item);
    this.shell.open({ kind: "video", path, siblings: siblings && siblings.length > 1 ? siblings : undefined });
  }

  // ---- the detail page

  private openDetail(item: Item, from?: HTMLElement) {
    if (this.detail) this.closeDetail(false);
    this.detailFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const detail = new Detail(item, this.ctx, () => this.closeDetail(true));
    this.detail = detail;
    this.layer.replaceChildren(detail.el);
    this.layer.classList.add("open");
    this.scroll.inert = true;
    this.nav.inert = true;
    detail.open(from?.getBoundingClientRect() ?? null, this.layer.getBoundingClientRect());
    window.setTimeout(() => detail.focusPrimary(), 40);
  }

  private closeDetail(restore: boolean) {
    if (!this.detail) return;
    this.detail = null;
    this.layer.classList.remove("open");
    this.layer.replaceChildren();
    this.scroll.inert = false;
    this.nav.inert = false;
    if (restore && this.detailFocus?.isConnected) this.detailFocus.focus({ preventScroll: true });
    this.detailFocus = null;
  }

  // ---- keys and focus

  /** One element of the page is the tab stop; the arrows move between the rest. */
  private rove(target: HTMLElement) {
    const el = target.closest<HTMLElement>("[data-tv-focus]");
    if (!el || el.tagName === "BUTTON" || el.tagName === "INPUT") return;
    this.el.querySelectorAll<HTMLElement>('[data-tv-focus][tabindex="0"]').forEach((n) => (n.tabIndex = -1));
    el.tabIndex = 0;
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }

  private focusables(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>("[data-tv-focus]")].filter((n) => n.offsetParent !== null && !n.hasAttribute("disabled") && !n.closest("[inert]"));
  }

  private focusFirst() {
    if (this.detail || !this.active) return;
    const cur = document.activeElement;
    if (cur instanceof HTMLElement && this.el.contains(cur) && cur !== document.body && cur.matches("[data-tv-focus],input")) return;
    const first = this.pageEl.querySelector<HTMLElement>(".tv-slide.on .tv-pill, .tv-card, .tv-chan");
    first?.focus({ preventScroll: true });
  }

  private move(dir: "left" | "right" | "up" | "down"): boolean {
    const root = this.detail ? this.detail.el : this.el;
    const nodes = this.focusables(root);
    const cur = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-tv-focus]") : null;
    if (!cur || !nodes.includes(cur)) {
      nodes.find((n) => n.getBoundingClientRect().top > 60)?.focus();
      return true;
    }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const n of nodes) {
      if (n === cur) continue;
      const r = n.getBoundingClientRect();
      const dx = r.left + r.width / 2 - ax;
      const dy = r.top + r.height / 2 - ay;
      let primary: number;
      let ortho: number;
      if (dir === "left" || dir === "right") {
        primary = dir === "right" ? dx : -dx;
        ortho = Math.abs(dy);
        if (primary <= 2 || ortho > Math.max(a.height, r.height) * 0.6) continue;
      } else {
        primary = dir === "down" ? dy : -dy;
        ortho = Math.abs(dx);
        if (primary <= 2 || primary < Math.min(a.height, r.height) * 0.35) continue;
      }
      const score = primary + ortho * (dir === "left" || dir === "right" ? 4 : 2.2);
      if (score < bestScore) {
        bestScore = score;
        best = n;
      }
    }
    if (best) {
      best.focus({ preventScroll: true });
      best.scrollIntoView({ block: dir === "up" || dir === "down" ? "center" : "nearest", inline: "nearest", behavior: "smooth" });
      return true;
    }
    if ((dir === "left" || dir === "right") && this.hero && cur.closest(".tv-hero")) {
      this.hero.step(dir === "right" ? 1 : -1);
      return true;
    }
    return dir === "left" || dir === "right";
  }

  handleKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const typing = e.target instanceof HTMLInputElement;
    if (e.key === "Escape") {
      if (this.detail) return this.closeDetail(true), true;
      if (typing && (e.target as HTMLInputElement).value) {
        (e.target as HTMLInputElement).value = "";
        (e.target as HTMLInputElement).dispatchEvent(new Event("input"));
        return true;
      }
      if (this.history.length) return this.goBack(), true;
      return false;
    }
    const dirs: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    const dir = dirs[e.key];
    if (dir) {
      if (typing && dir !== "down" && dir !== "up") return false;
      return this.move(dir);
    }
    const focused = document.activeElement as HTMLElement | null;
    if (e.key === "Enter" && focused?.matches("[data-tv-focus]") && focused.tagName !== "BUTTON") {
      focused.click();
      return true;
    }
    if ((e.key === "p" || e.key === "P") && !typing && focused?.classList.contains("tv-card")) {
      focused.dispatchEvent(new CustomEvent("tv-play"));
      return true;
    }
    if (e.key === "/" && !typing) {
      this.go({ id: "search" }, true);
      return true;
    }
    return false;
  }
}

export const createTvModule: ModuleFactory = (shell) => {
  if (isMock) document.documentElement.dataset.tvMock = "1";
  return new TvModule(shell);
};
