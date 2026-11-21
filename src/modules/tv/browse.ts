import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { tvApi, type Filter, type Item, type Page } from "./api";
import { card, notice, type TvCtx } from "./parts";

export interface BrowseOptions {
  title: string;
  subtitle?: string;
  /** What the page always filters by (a section, a category, a kind). */
  base: Filter;
  /** Show a search box and start with it focused. */
  search?: boolean;
  /** The category is a ranked list (IMDb Top 250): offer sorting by rank. */
  ranked?: boolean;
  /** Shown between the header and the filters (a row of the section's categories). */
  extra?: HTMLElement;
}

const PAGE = 60;

/** A grid of posters with year and quality chips and a sort switch; also the search page. */
export class BrowsePage {
  readonly el: HTMLElement;
  private grid = h("div", { class: "tv-grid", role: "list" });
  private chips = h("div", { class: "tv-chips" });
  private count = h("span", { class: "tv-count" });
  private input: HTMLInputElement | null = null;
  private filter: Filter;
  private items: Item[] = [];
  private total = 0;
  private busy = false;
  private serial = 0;
  private sentinel = h("div", { class: "tv-sentinel" });
  private io: IntersectionObserver;
  private years: [number, number][] = [];
  private qualities: [string, number][] = [];
  private sortBar = h("div", { class: "tv-seg", role: "radiogroup", "aria-label": "Sort" });
  private timer = 0;

  constructor(private ctx: TvCtx, private options: BrowseOptions) {
    this.filter = { ...options.base, sort: options.ranked ? "rank" : "new" };
    const head = h("header", { class: "tv-page-head" }, h("div", { class: "tv-page-title" }, h("h1", null, options.title), options.subtitle ? h("p", null, options.subtitle) : null, this.count));
    if (options.search) {
      this.input = h("input", { class: "tv-search-input", type: "search", placeholder: "Search movies and series", "aria-label": "Search", spellcheck: false, autocomplete: "off" });
      this.input.addEventListener("input", () => {
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          this.filter.q = this.input!.value.trim() || undefined;
          this.filter.year = undefined;
          this.filter.quality = undefined;
          void this.load();
        }, 120);
      });
      head.append(h("label", { class: "tv-search glass" }, icon("search", 18), this.input));
    }
    this.drawSort();
    this.el = h("div", { class: "tv-browse" }, head, options.extra, h("div", { class: "tv-filters" }, this.chips, this.sortBar), this.grid, this.sentinel);
    this.io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void this.more();
    }, { rootMargin: "700px" });
    this.io.observe(this.sentinel);
  }

  focusSearch() {
    this.input?.focus();
  }

  dispose() {
    this.io.disconnect();
    clearTimeout(this.timer);
  }

  private drawSort() {
    const modes: [NonNullable<Filter["sort"]>, string][] = [["new", "Newest"], ["az", "A–Z"], ["year", "Year"]];
    if (this.options.ranked) modes.unshift(["rank", "Rank"]);
    this.sortBar.replaceChildren(...modes.map(([id, label]) => {
      const b = h("button", { class: `tv-seg-btn${this.filter.sort === id ? " on" : ""}`, type: "button", role: "radio", "aria-checked": String(this.filter.sort === id) }, label);
      b.addEventListener("click", () => {
        this.filter.sort = id;
        this.drawSort();
        void this.load(false);
      });
      return b;
    }));
  }

  private drawChips() {
    const chip = (label: string, on: boolean, pick: () => void) => {
      const b = h("button", { class: `tv-chip${on ? " on" : ""}`, type: "button", "aria-pressed": String(on) }, label);
      b.addEventListener("click", pick);
      return b;
    };
    const out: HTMLElement[] = [chip("All years", !this.filter.year, () => this.set({ year: undefined }))];
    for (const [year] of this.years.slice(0, 18)) out.push(chip(String(year), this.filter.year === year, () => this.set({ year })));
    if (this.qualities.length > 1) {
      out.push(h("span", { class: "tv-chip-gap" }));
      for (const [quality] of this.qualities.slice(0, 4)) out.push(chip(quality, this.filter.quality === quality, () => this.set({ quality: this.filter.quality === quality ? undefined : quality })));
    }
    this.chips.replaceChildren(...out);
  }

  private set(change: Partial<Filter>) {
    Object.assign(this.filter, change);
    void this.load(false);
  }

  /** (Re)reads the first page; `facets` also refreshes the year chips. */
  async load(facets = true) {
    const mine = ++this.serial;
    this.busy = true;
    let page: Page;
    try {
      page = await tvApi.items({ ...this.filter, limit: PAGE, offset: 0 }, facets);
    } catch {
      this.busy = false;
      return;
    }
    if (mine !== this.serial) return;
    this.busy = false;
    if (facets) {
      this.years = page.years;
      this.qualities = page.qualities;
    }
    this.drawChips();
    this.ctx.loader.reset();
    this.grid.replaceChildren();
    this.items = [];
    this.total = page.total;
    this.append(page.items);
    this.count.textContent = `${page.total.toLocaleString()} ${page.total === 1 ? "title" : "titles"}`;
    if (!page.items.length) this.grid.append(notice("search", this.filter.q ? "No matches" : "Nothing here yet", this.filter.q ? `Nothing in the catalog is called “${this.filter.q}”.` : "The catalog is still filling up, or this category has no titles."));
  }

  private append(items: Item[]) {
    this.items.push(...items);
    this.grid.append(...items.map((item) => card(item, this.ctx)));
    // the sentinel only reports a change: look again, in case it is still in view
    this.io.unobserve(this.sentinel);
    this.io.observe(this.sentinel);
  }

  private async more() {
    if (this.busy || this.items.length >= this.total || !this.items.length) return;
    this.busy = true;
    const mine = this.serial;
    try {
      const page = await tvApi.items({ ...this.filter, limit: PAGE, offset: this.items.length });
      if (mine === this.serial) this.append(page.items);
    } catch {
      // the next scroll tries again
    } finally {
      this.busy = false;
    }
  }
}
