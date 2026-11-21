import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { errorText, FREE_BD_PLAYLIST, newId, onTv, picUrl, tvApi, type Channel } from "./api";
import { hueOf, notice, type TvCtx } from "./parts";

const initials = (name: string) => name.replace(/\(.*?\)/g, "").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");

/** Live TV: channels from the user's M3U playlists, with favourites, recently watched and an offline check. */
export class LivePage {
  readonly el: HTMLElement;
  private channels: Channel[] = [];
  private group = "";
  private query = "";
  private body = h("div", { class: "tv-live-body" });
  private chips = h("div", { class: "tv-chips" });
  private count = h("span", { class: "tv-count" });
  private tiles = new Map<string, HTMLElement>();
  private logoIo: IntersectionObserver;
  private logoQueue: Channel[] = [];
  private logoActive = 0;
  private unlisten: Promise<() => void>[] = [];
  private error = "";
  private busy = false;

  constructor(private ctx: TvCtx) {
    const input = h("input", { class: "tv-search-input", type: "search", placeholder: "Search channels", "aria-label": "Search channels", spellcheck: false, autocomplete: "off" });
    input.addEventListener("input", () => {
      this.query = input.value.trim().toLowerCase();
      this.draw();
    });
    const refresh = h("button", { class: "tv-pill glass", type: "button", "data-tv-focus": "", title: "Read the playlists again" }, icon("refresh", 16), "Refresh");
    refresh.addEventListener("click", () => void this.refreshLists());
    this.el = h("div", { class: "tv-browse tv-live" },
      h("header", { class: "tv-page-head" }, h("div", { class: "tv-page-title" }, h("h1", null, "Live TV"), h("p", null, "Channels from your own playlists"), this.count), h("label", { class: "tv-search glass" }, icon("search", 18), input), refresh),
      this.chips, this.body);
    this.logoIo = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const ch = this.channels.find((c) => c.id === (entry.target as HTMLElement).dataset.id);
        this.logoIo.unobserve(entry.target);
        if (ch && !ch.logo && ch.hasLogo) {
          this.logoQueue.push(ch);
          this.pumpLogos();
        }
      }
    }, { rootMargin: "300px" });
    this.unlisten.push(onTv("tv-live-status", (s) => {
      const ch = this.channels.find((c) => c.id === s.id);
      if (!ch) return;
      ch.status = s.status;
      this.tiles.get(s.id)?.classList.toggle("offline", s.status === "offline");
      this.tiles.get(s.id)?.setAttribute("data-status", s.status);
      this.updateCount();
    }));
    this.unlisten.push(onTv("tv-live-changed", () => void this.load()));
  }

  dispose() {
    this.logoIo.disconnect();
    for (const u of this.unlisten) void u.then((fn) => fn());
  }

  /** Reads the channels, draws them and checks which ones answer (only while this tab is open). */
  async load() {
    try {
      this.channels = await tvApi.liveChannels();
    } catch (err) {
      this.error = errorText(err);
    }
    this.draw();
    const ids = this.channels.map((c) => c.id).slice(0, 400);
    if (ids.length) void tvApi.liveProbe(ids).catch(() => undefined);
  }

  private async refreshLists() {
    if (this.busy) return;
    this.busy = true;
    try {
      const results = await tvApi.liveRefresh(this.ctx.shell.config.tv);
      this.error = results.filter((r) => r.error).map((r) => r.error).join(" ");
    } catch (err) {
      this.error = errorText(err);
    }
    this.busy = false;
    await this.load();
  }

  private updateCount() {
    const off = this.channels.filter((c) => c.status === "offline").length;
    this.count.textContent = `${this.channels.length} channels${off ? ` · ${off} offline` : ""}`;
  }

  private matching(): Channel[] {
    return this.channels.filter((c) => (!this.group || (this.group === "★" ? c.fav : (c.group || "Other") === this.group)) && (!this.query || `${c.name} ${c.group}`.toLowerCase().includes(this.query)));
  }

  private draw() {
    this.tiles.clear();
    this.updateCount();
    if (!this.channels.length) {
      this.chips.replaceChildren();
      this.body.replaceChildren(this.empty());
      return;
    }
    const groups = new Map<string, number>();
    for (const c of this.channels) groups.set(c.group || "Other", (groups.get(c.group || "Other") ?? 0) + 1);
    const chip = (label: string, value: string) => {
      const b = h("button", { class: `tv-chip${this.group === value ? " on" : ""}`, type: "button", "aria-pressed": String(this.group === value) }, label);
      b.addEventListener("click", () => {
        this.group = value;
        this.draw();
      });
      return b;
    };
    const chips = [chip("All", "")];
    if (this.channels.some((c) => c.fav)) chips.push(chip("★ Favourites", "★"));
    for (const [g] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 14)) chips.push(chip(g, g));
    this.chips.replaceChildren(...chips);
    const list = this.matching();
    const parts: HTMLElement[] = [];
    if (this.error) parts.push(h("p", { class: "tv-error" }, this.error));
    const browsing = !this.group && !this.query;
    if (browsing) {
      const favs = this.channels.filter((c) => c.fav);
      if (favs.length) parts.push(this.row("Favourites", favs));
      const recent = this.channels.filter((c) => c.watched > 0).sort((a, b) => b.watched - a.watched).slice(0, 12);
      if (recent.length) parts.push(this.row("Recently watched", recent));
    }
    parts.push(h("section", { class: "tv-shelf" }, browsing ? h("header", { class: "tv-shelf-head" }, h("h2", null, "All channels")) : null, list.length ? h("div", { class: "tv-chan-grid", role: "list" }, ...list.map((c) => this.tile(c, list))) : h("p", { class: "tv-error" }, "No channel matches.")));
    this.body.replaceChildren(...parts);
  }

  private row(title: string, list: Channel[]): HTMLElement {
    return h("section", { class: "tv-shelf" }, h("header", { class: "tv-shelf-head" }, h("h2", null, title)), h("div", { class: "tv-row", role: "list" }, ...list.map((c) => this.tile(c, list))));
  }

  private tile(ch: Channel, context: Channel[]): HTMLElement {
    const logo = h("img", { class: "tv-chan-logo", alt: "", draggable: false });
    const mark = h("span", { class: "tv-chan-initials", style: { "--h": String(hueOf(ch.name)) } }, initials(ch.name));
    const face = h("span", { class: "tv-chan-face" }, mark, logo);
    if (ch.logo) {
      logo.src = picUrl(ch.logo);
      face.classList.add("has-img");
    }
    const star = h("button", { class: `tv-star${ch.fav ? " on" : ""}`, type: "button", tabindex: -1, title: ch.fav ? "Remove from favourites" : "Add to favourites", "aria-label": "Favourite", "aria-pressed": String(ch.fav) }, icon(ch.fav ? "starFilled" : "star", 15));
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      ch.fav = !ch.fav;
      void tvApi.liveFav(ch.id, ch.fav);
      this.draw();
    });
    const tile = h("div", { class: `tv-chan${ch.status === "offline" ? " offline" : ""}`, role: "listitem", tabindex: -1, "data-tv-focus": "", "data-id": ch.id, "data-status": ch.status, "aria-label": `${ch.name}${ch.status === "offline" ? " (offline)" : ""}` },
      face, star,
      h("span", { class: "tv-chan-name" }, ch.name),
      h("span", { class: "tv-chan-group" }, ch.group || "Other"),
      h("span", { class: "tv-chan-state" }, h("span", { class: "tv-dot-status" }), "Offline"));
    const play = () => this.play(ch, context);
    tile.addEventListener("click", play);
    tile.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        play();
      }
    });
    this.tiles.set(ch.id, tile);
    if (!ch.logo && ch.hasLogo) this.logoIo.observe(tile);
    return tile;
  }

  /** Plays a channel; next and previous zap through the channels of the list it was picked from. */
  private play(ch: Channel, context: Channel[]) {
    ch.watched = Date.now();
    void tvApi.liveWatched(ch.id);
    this.ctx.shell.open({ kind: "video", path: ch.url, siblings: context.map((c) => c.url) });
  }

  private pumpLogos() {
    while (this.logoActive < 4 && this.logoQueue.length) {
      const ch = this.logoQueue.shift()!;
      this.logoActive++;
      tvApi.liveLogo(ch.id).then((path) => {
        if (!path) return;
        ch.logo = path;
        for (const tile of this.el.querySelectorAll<HTMLElement>(`[data-id="${ch.id}"]`)) {
          const img = tile.querySelector<HTMLImageElement>(".tv-chan-logo");
          if (img) img.src = picUrl(path);
          tile.querySelector(".tv-chan-face")?.classList.add("has-img");
        }
      }, () => undefined).finally(() => {
        this.logoActive--;
        this.pumpLogos();
      });
    }
  }

  private empty(): HTMLElement {
    const add = h("button", { class: "tv-pill primary", type: "button", "data-tv-focus": "" }, icon("plus", 16), "Add free Bangladesh channels (iptv-org)");
    add.addEventListener("click", () => {
      const tv = this.ctx.shell.config.tv;
      if (!tv.playlists.some((p) => p.url === FREE_BD_PLAYLIST.url)) tv.playlists.push({ id: newId(), ...FREE_BD_PLAYLIST });
      this.ctx.shell.saveConfig();
      void this.refreshLists();
    });
    const own = h("button", { class: "tv-pill glass", type: "button", "data-tv-focus": "" }, icon("settings", 16), "Add a playlist…");
    own.addEventListener("click", () => this.ctx.shell.openSettings("tv"));
    return notice("tv", "No channels yet", "Live TV plays the M3U playlists you add. The iptv-org list is a public index of free-to-air channels, and nothing is downloaded until you press the button. An ISP's live-TV playlist can be added by its URL in Settings → TV.", add, own);
  }
}
