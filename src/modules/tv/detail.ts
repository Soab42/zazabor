import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { showToast } from "../files/ops/toast";
import { errorText, picUrl, sizeText, tvApi, type Item, type Season } from "./api";
import { badges, hueOf, meta, shelf, type TvCtx } from "./parts";

const decodeSafe = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** Where a title sits on the server, readable: "English Movies (1080p) › (2025) 1080p". */
const folderPath = (url: string) => decodeSafe(url.replace(/^https?:\/\/[^/]+\/[^/]+\//, "")).replace(/\/$/, "").split("/").slice(0, -1).join(" › ");

const episodeName = (name: string) => name.replace(/\.[a-z0-9]{2,4}$/i, "");

/** A title's page over the catalog: backdrop from its poster, the facts, Play, and for a series its seasons. */
export class Detail {
  readonly el: HTMLElement;
  private item: Item;
  private body = h("div", { class: "tv-detail-body" });
  private seasons: Season[] = [];
  private season = 0;
  private episodes = h("div", { class: "tv-episodes" });
  private art: HTMLElement;
  private posterBox: HTMLElement;
  private more = h("div", { class: "tv-detail-more" });

  constructor(item: Item, private ctx: TvCtx, private close: () => void) {
    this.item = item;
    const bg = h("img", { class: "tv-detail-bg", alt: "", draggable: false });
    const poster = h("img", { class: "tv-detail-poster", alt: "", draggable: false });
    const art = h("div", { class: "tv-detail-art", style: { "--h": String(hueOf(item.title)) } }, bg, h("div", { class: "tv-detail-shade" }));
    const posterBox = h("div", { class: "tv-detail-card", style: { "--h": String(hueOf(item.title)) } }, h("span", { class: "tv-fallback-title" }, item.title), poster);
    const apply = (next: Item) => {
      Object.assign(this.item, next);
      if (next.poster && bg.dataset.src !== next.poster) {
        bg.dataset.src = next.poster;
        bg.src = poster.src = picUrl(next.poster);
        art.classList.add("has-img");
        posterBox.classList.add("has-img");
      }
      this.drawFacts();
    };
    this.art = art;
    this.posterBox = posterBox;
    const x = h("button", { class: "tv-close glass", type: "button", "aria-label": "Close", title: "Close (Esc)", "data-tv-focus": "" }, icon("close", 18));
    x.addEventListener("click", () => this.close());
    this.el = h("div", { class: "tv-detail", role: "dialog", "aria-modal": "true", "aria-label": item.title }, art, x, h("div", { class: "tv-detail-scroll" }, h("div", { class: "tv-detail-main" }, posterBox, this.body), this.more));
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el || (e.target as HTMLElement).classList.contains("tv-detail-scroll")) this.close();
    });
    this.drawFacts();
    if (item.poster) apply(item);
    else if (!item.noPoster) void tvApi.resolve(item.id).then(apply, () => undefined);
    void this.loadMore();
    if (item.kind === "series") void this.loadSeasons();
    else if (!item.videoUrl) void tvApi.resolve(item.id).then(apply, () => undefined);
  }

  /** More from the same category, below the facts. */
  private async loadMore() {
    try {
      const page = await tvApi.items({ categoryUrl: this.item.categoryUrl, sort: "new", limit: 18 });
      const others = page.items.filter((i) => i.id !== this.item.id).slice(0, 16);
      if (others.length >= 3) this.more.replaceChildren(shelf(`More in ${this.item.category}`, others, this.ctx));
    } catch {
      // the page is complete without it
    }
  }

  /**
   * Zooms out of the card that was clicked: the backdrop grows from the card's rectangle (it is
   * blurred, so stretching it doesn't show) and the poster flies from the card to its place.
   * Transform and opacity only.
   */
  open(from: DOMRect | null, area: DOMRect) {
    if (!from || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ease = "cubic-bezier(0.2, 0.8, 0.3, 1)";
    const sx = from.width / area.width;
    const sy = from.height / area.height;
    this.art.animate([
      { transformOrigin: "0 0", transform: `translate3d(${from.left - area.left}px, ${from.top - area.top}px, 0) scale(${sx}, ${sy})`, opacity: 0.2 },
      { transformOrigin: "0 0", transform: "none", opacity: 1 },
    ], { duration: 460, easing: ease });
    const to = this.posterBox.getBoundingClientRect();
    if (to.width) {
      const k = from.width / to.width;
      this.posterBox.style.animation = "none";
      this.posterBox.animate([
        { transformOrigin: "0 0", transform: `translate3d(${from.left - to.left}px, ${from.top - to.top}px, 0) scale(${k})` },
        { transformOrigin: "0 0", transform: "none" },
      ], { duration: 460, easing: ease });
    }
    this.el.querySelector(".tv-detail-scroll")?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 380, easing: "ease-out" });
  }

  focusPrimary() {
    (this.el.querySelector(".tv-pill.primary") as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private drawFacts() {
    const item = this.item;
    const play = h("button", { class: "tv-pill primary", type: "button", "data-tv-focus": "" }, icon("play", 18), item.kind === "series" ? this.playLabel() : "Play");
    play.addEventListener("click", () => this.playMain());
    const folder = h("button", { class: "tv-pill glass", type: "button", "data-tv-focus": "" }, icon("external", 16), "Open folder in browser");
    folder.addEventListener("click", () => this.ctx.shell.openExternally(item.folderUrl));
    const copy = h("button", { class: "tv-pill glass icon-only", type: "button", title: "Copy link", "aria-label": "Copy link", "data-tv-focus": "" }, icon("link", 17));
    copy.addEventListener("click", () => {
      const link = item.videoUrl || item.folderUrl;
      void navigator.clipboard.writeText(link).then(() => showToast("Link copied"), () => showToast("Couldn't copy the link"));
    });
    const facts = h("dl", { class: "tv-facts" },
      fact("Category", item.category),
      fact("Year", item.year ? String(item.year) : ""),
      fact("Size", sizeText(item.size)),
      fact("Server folder", folderPath(item.folderUrl)),
      fact("Added", item.added ? new Date(item.added).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : ""));
    const keep = this.body.querySelector(".tv-episodes-wrap");
    this.body.replaceChildren(
      h("span", { class: "tv-kicker" }, item.category),
      h("h1", { class: "tv-detail-title" }, item.title),
      h("p", { class: "tv-slide-meta" }, meta(item)),
      badges(item, 7),
      h("div", { class: "tv-detail-actions" }, play, folder, copy),
      facts);
    if (keep) this.body.append(keep);
  }

  private playLabel() {
    const first = this.seasons[0]?.episodes[0];
    return first ? "Play first episode" : "Watch";
  }

  private playMain() {
    if (this.item.kind === "series") {
      const first = this.seasons[this.season]?.episodes[0] ?? this.seasons[0]?.episodes[0];
      if (first) this.playEpisode(first.url);
      return;
    }
    this.ctx.play(this.item);
  }

  private async loadSeasons() {
    const wrap = h("section", { class: "tv-episodes-wrap" }, h("div", { class: "tv-episodes-loading shimmer-line" }), h("div", { class: "tv-episodes-loading shimmer-line" }), h("div", { class: "tv-episodes-loading shimmer-line" }));
    this.body.append(wrap);
    try {
      this.seasons = await tvApi.episodes(this.item.id);
    } catch (err) {
      wrap.replaceChildren(h("p", { class: "tv-error" }, `Couldn't read the episodes: ${errorText(err)}`));
      return;
    }
    if (!this.seasons.length) {
      wrap.replaceChildren(h("p", { class: "tv-error" }, "No episodes were found in this folder."));
      return;
    }
    this.drawFacts();
    this.drawSeasons();
  }

  private drawSeasons() {
    const tabs = h("div", { class: "tv-seasons", role: "tablist" }, ...this.seasons.map((s, i) => {
      const tab = h("button", { class: `tv-season${i === this.season ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(i === this.season), "data-tv-focus": "" }, s.name, h("span", { class: "tv-season-count" }, String(s.episodes.length)));
      tab.addEventListener("click", () => {
        this.season = i;
        this.drawSeasons();
      });
      return tab;
    }));
    const season = this.seasons[this.season];
    this.episodes = h("div", { class: "tv-episodes", role: "list" }, ...season.episodes.map((ep, i) => {
      const play = h("button", { class: "tv-ep-play", type: "button", tabindex: -1, "aria-label": `Play episode ${ep.episode ?? i + 1}` }, icon("play", 15));
      const row = h("div", { class: "tv-episode", role: "listitem", tabindex: -1, "data-tv-focus": "" },
        h("span", { class: "tv-ep-num" }, String(ep.episode ?? i + 1)),
        h("span", { class: "tv-ep-text" }, h("span", { class: "tv-ep-title" }, `Episode ${ep.episode ?? i + 1}`), h("span", { class: "tv-ep-file" }, episodeName(ep.name))),
        h("span", { class: "tv-ep-size" }, sizeText(ep.size)), play);
      row.addEventListener("click", () => this.playEpisode(ep.url));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          this.playEpisode(ep.url);
        }
      });
      return row;
    }));
    const wrap = this.body.querySelector(".tv-episodes-wrap") ?? h("section", { class: "tv-episodes-wrap" });
    wrap.replaceChildren(tabs, this.episodes);
    if (!wrap.isConnected) this.body.append(wrap);
  }

  /** Plays an episode; next and previous walk through every episode in order. */
  private playEpisode(url: string) {
    const all = this.seasons.flatMap((s) => s.episodes.map((e) => e.url));
    this.ctx.playUrl(this.item, url, all);
  }
}

function fact(label: string, value: string): HTMLElement {
  return h("div", { class: "tv-fact", hidden: !value }, h("dt", null, label), h("dd", null, value));
}
