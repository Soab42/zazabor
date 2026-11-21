import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { picUrl, type CatRow, type Home, type Item } from "./api";
import { badges, hueOf, meta, shelf, skeletonShelf, type TvCtx } from "./parts";

/** Seconds each title stays: the progress bars and the Ken Burns move share it. */
const SLIDE_SECONDS = 7;

/**
 * The auto-advancing "Top Shelf": the newest films as a full-bleed picture (the poster, cover-fitted
 * with the focus in its upper third) that drifts slowly, with the title rising in over it. The
 * progress bars are what advance it: a bar's fill ends, the next title comes, and pausing the CSS
 * animations (pointer over, focus inside, window hidden) pauses everything together.
 */
export class Hero {
  readonly el: HTMLElement;
  private slides: HTMLElement[] = [];
  private bars: HTMLElement[] = [];
  private index = 0;
  private height = 600;
  private wheelAt = 0;

  constructor(private items: Item[], private ctx: TvCtx) {
    this.el = h("section", { class: "tv-hero", "aria-roledescription": "carousel", "aria-label": "New on DhakaFlix", style: { "--dur": `${SLIDE_SECONDS}s` } });
    items.forEach((item, i) => {
      const slide = this.slide(item, i);
      this.slides.push(slide);
      this.el.append(slide);
    });
    this.el.append(h("div", { class: "tv-hero-fx", "aria-hidden": "true" }));
    if (items.length > 1) {
      const bars = h("div", { class: "tv-hero-bars", role: "tablist" });
      items.forEach((item, i) => {
        const fill = h("span", { class: "tv-bar-fill" });
        fill.addEventListener("animationend", () => this.go(this.index + 1, false));
        const bar = h("button", { class: "tv-bar", type: "button", tabindex: -1, role: "tab", "aria-label": `Show ${item.title}` }, fill);
        bar.addEventListener("click", () => this.go(i, true));
        this.bars.push(bar);
        bars.append(bar);
      });
      const prev = h("button", { class: "tv-hero-arrow left", type: "button", tabindex: -1, "aria-label": "Previous" }, icon("chevronLeft", 22));
      const next = h("button", { class: "tv-hero-arrow right", type: "button", tabindex: -1, "aria-label": "Next" }, icon("chevronRight", 22));
      prev.addEventListener("click", () => this.step(-1));
      next.addEventListener("click", () => this.step(1));
      this.el.append(prev, next, bars);
      this.swipe();
    }
    this.el.addEventListener("pointerenter", () => this.el.classList.add("hold"));
    this.el.addEventListener("pointerleave", () => this.el.classList.remove("hold"));
    this.el.addEventListener("focusin", () => this.el.classList.add("hold"));
    this.el.addEventListener("focusout", () => this.el.classList.remove("hold"));
    document.addEventListener("visibilitychange", () => this.el.classList.toggle("hidden", document.hidden));
    new ResizeObserver(() => (this.height = this.el.offsetHeight || this.height)).observe(this.el);
    this.go(0, false);
  }

  private slide(item: Item, i: number): HTMLElement {
    const bg = h("img", { class: "tv-slide-bg", alt: "", draggable: false });
    const art = h("div", { class: "tv-slide-art", style: { "--h": String(hueOf(item.title)) } }, bg, h("div", { class: "tv-slide-shade" }));
    const apply = (next: Item) => {
      Object.assign(item, next);
      if (next.poster && bg.dataset.src !== next.poster) {
        bg.dataset.src = next.poster;
        bg.src = picUrl(next.poster);
        art.classList.add("has-img");
      }
    };
    const play = h("button", { class: "tv-pill primary", type: "button", "data-tv-focus": "" }, icon("play", 17), item.kind === "series" ? "Watch" : "Play");
    play.addEventListener("click", () => this.ctx.play(item));
    const more = h("button", { class: "tv-pill glass", type: "button", "data-tv-focus": "" }, icon("info", 17), "Details");
    more.addEventListener("click", () => this.ctx.openDetail(item, this.el));
    const copy = h("div", { class: "tv-slide-copy" },
      h("span", { class: "tv-kicker" }, i === 0 ? "New on DhakaFlix" : item.category),
      h("h1", { class: "tv-slide-title" }, item.title),
      h("p", { class: "tv-slide-meta" }, meta(item)),
      badges(item, 5),
      h("div", { class: "tv-slide-actions" }, play, more));
    const slide = h("div", { class: `tv-slide${i % 2 ? " alt" : ""}`, role: "group", "aria-roledescription": "slide", "aria-label": `${i + 1} of ${this.items.length}` }, art, copy);
    if (item.poster) apply(item);
    this.ctx.loader.watch(slide, item, apply);
    return slide;
  }

  /** Swiping (touch or pen) or a sideways trackpad swipe moves to the next or previous title. */
  private swipe() {
    let startX = 0;
    let down = false;
    this.el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || (e.target as HTMLElement).closest("button")) return;
      down = true;
      startX = e.clientX;
    });
    this.el.addEventListener("pointerup", (e) => {
      if (!down) return;
      down = false;
      if (Math.abs(e.clientX - startX) > 60) this.step(e.clientX < startX ? 1 : -1);
    });
    this.el.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaX) < 24 || Math.abs(e.deltaX) < Math.abs(e.deltaY) || performance.now() - this.wheelAt < 700) return;
      e.preventDefault();
      this.wheelAt = performance.now();
      this.step(e.deltaX > 0 ? 1 : -1);
    }, { passive: false });
  }

  /** The page scrolled: the picture moves slower than the page and dims. */
  parallax(top: number) {
    const y = Math.min(Math.max(top, 0), this.height);
    this.el.style.setProperty("--py", `${(y * 0.38).toFixed(1)}px`);
    this.el.style.setProperty("--dim", ((y / (this.height * 0.8)) * 0.8).toFixed(3));
  }

  /** Moves to the next (or previous) title, as the arrow keys do. */
  step(delta: number) {
    this.go(this.index + delta, true);
  }

  go(i: number, user: boolean) {
    const next = (i + this.slides.length) % this.slides.length;
    if (user && next === this.index && this.slides[next].classList.contains("on")) return;
    const old = this.slides[this.index];
    if (next !== this.index) {
      old.classList.add("leaving");
      window.setTimeout(() => old.classList.remove("leaving"), 1000);
    }
    this.index = next;
    this.slides.forEach((s, n) => {
      const on = n === next;
      s.classList.toggle("on", on);
      s.toggleAttribute("inert", !on);
    });
    this.bars.forEach((b, n) => {
      b.classList.toggle("done", n < next);
      b.classList.toggle("on", n === next);
      b.setAttribute("aria-selected", String(n === next));
    });
  }

  /** The window is shown: the bars run (and so the carousel). */
  start() {
    this.el.classList.remove("stopped");
  }

  stop() {
    this.el.classList.add("stopped");
  }
}

const SECTION_ORDER: Record<string, number> = { movies: 0, indian: 1, animation: 2, tv: 3 };

/** Rows of the Home page, built from what the backend sent. */
export function homeRows(home: Home, ctx: TvCtx): { hero: Hero | null; rows: HTMLElement[] } {
  const rows: HTMLElement[] = [];
  const hero = home.hero.length ? new Hero(home.hero, ctx) : null;
  if (home.recent.length) rows.push(shelf("Recently Played", home.recent, ctx, { subtitle: "Pick up where you left off" }));
  if (home.new.length) rows.push(shelf("New on DhakaFlix", home.new, ctx));
  if (home.top.length >= 3) rows.push(shelf(`Top 10 in ${home.topYear ?? "this year"}`, home.top, ctx, { numbered: true, subtitle: "Newest first" }));
  const cats = [...home.categories].filter((c) => c.items.length).sort((a, b) => (SECTION_ORDER[a.section] ?? 9) - (SECTION_ORDER[b.section] ?? 9));
  const imdb = cats.find((c) => /imdb/i.test(c.label));
  const row = (c: CatRow, numbered = false) => shelf(c.label, c.items, ctx, { numbered, subtitle: `${c.count.toLocaleString()} titles`, onMore: () => ctx.openCategory(c.url, c.label) });
  if (imdb) rows.push(row(imdb, true));
  for (const c of cats) if (c !== imdb) rows.push(row(c));
  return { hero, rows };
}

export function homeSkeleton(): HTMLElement {
  return h("div", { class: "tv-home-skeleton" }, h("div", { class: "tv-hero shimmer" }), skeletonShelf("New on DhakaFlix"), skeletonShelf("Top 10"));
}
