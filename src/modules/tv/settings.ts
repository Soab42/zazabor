import type { SettingsRow } from "../../appearance";
import { DEFAULT_TV_SOURCE, type Config } from "../../config";
import { open as openDialog } from "../../shared/dialog";
import type { Category } from "../../shell/settings";
import { h } from "../../ui/dom";
import { errorText, FREE_BD_PLAYLIST, newId, onTv, sizeText, tvApi, type CacheInfo, type Category as TvCategory, type Progress } from "./api";
import "./settings.css";

const normalizeUrl = (text: string) => {
  const t = text.trim();
  return t && !t.includes("://") ? `http://${t}` : t;
};

const hostOf = (url: string) => url.replace(/^[a-z]+:\/\//i, "").split("/")[0];

/**
 * Settings → TV: where the movie servers are (their addresses can change, the categories are found
 * again), which categories show, the catalog and its cache, and the Live TV playlists.
 */
export function tvCategory(host: { readonly config: Config; configChanged(): void }): Category {
  const tv = () => host.config.tv;
  const found = new Map<string, { reachable: boolean; error: string; categories: TvCategory[] }>();
  let progress: Progress | null = null;
  let cache: CacheInfo | null = null;
  let playlistMessage = "";

  const button = (label: string, onclick: () => void, kind = "btn small") => h("button", { class: kind, type: "button", onclick }, label);
  const row = (label: string, hint: string | null, ...controls: (HTMLElement | null)[]) =>
    h("div", { class: "sf-row plain tv-set-row" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, label), hint ? h("p", { class: "sf-hint" }, hint) : null), h("div", { class: "tv-set-buttons" }, ...controls));

  const save = () => host.configChanged();
  const crawl = (force: boolean) => void tvApi.start(tv(), force).then((p) => ((progress = p), drawStatus()), () => undefined);

  // ---- servers
  const serversBox = h("div", { class: "tv-set-box" });
  const categoriesBox = h("div", { class: "tv-set-box" });
  const statusBox = h("div", { class: "tv-set-box" });
  const cacheBox = h("div", { class: "tv-set-box" });
  const liveBox = h("div", { class: "tv-set-box" });

  function drawServers() {
    const rows = tv().sources.map((source) => {
      const input = h("input", { class: "tv-input", type: "text", spellcheck: false, autocomplete: "off", value: source.url, "aria-label": "Server address", placeholder: DEFAULT_TV_SOURCE });
      input.addEventListener("change", () => {
        const url = normalizeUrl(input.value);
        if (!url) return;
        source.url = url;
        input.value = url;
        found.delete(source.id);
        save();
        crawl(true);
        void discover();
      });
      const remove = button("Remove", () => {
        tv().sources = tv().sources.filter((s) => s !== source);
        found.delete(source.id);
        save();
        crawl(true);
        drawServers();
        drawCategories();
      }, "btn small ghost");
      return h("div", { class: "sf-row plain tv-set-row" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, "Server"), input), h("div", { class: "tv-set-buttons" }, remove));
    });
    const add = button("Add a server", () => {
      tv().sources.push({ id: newId(), url: DEFAULT_TV_SOURCE });
      save();
      drawServers();
    });
    const reset = button("Use the default", () => {
      tv().sources = [{ id: "dhakaflix", url: DEFAULT_TV_SOURCE }];
      found.clear();
      save();
      crawl(true);
      drawServers();
      void discover();
    }, "btn small ghost");
    serversBox.replaceChildren(
      h("p", { class: "sf-hint" }, "The address of a DhakaFlix front page, like http://172.16.50.14. Its movie and series categories (on any of its servers) are found from that page, so if the ISP changes the address, change it here."),
      ...rows,
      ...(tv().sources.length ? [] : [h("p", { class: "sf-hint" }, "No server: TV has nothing to show.")]),
      h("div", { class: "tv-set-buttons end" }, reset, add));
  }

  async function discover() {
    await Promise.all(tv().sources.map(async (source) => {
      try {
        found.set(source.id, await tvApi.discover(source.url));
      } catch (err) {
        found.set(source.id, { reachable: false, error: errorText(err), categories: [] });
      }
    }));
    drawCategories();
  }

  function drawCategories() {
    const parts: HTMLElement[] = [];
    for (const source of tv().sources) {
      const result = found.get(source.id);
      if (!result) {
        parts.push(h("p", { class: "sf-hint" }, `Looking at ${hostOf(source.url)}…`));
        continue;
      }
      if (!result.reachable) {
        parts.push(h("p", { class: "sf-hint tv-set-bad" }, result.error));
        continue;
      }
      const sections = new Map<string, TvCategory[]>();
      for (const c of result.categories) sections.set(c.section, [...(sections.get(c.section) ?? []), c]);
      for (const [section, cats] of sections) {
        parts.push(h("p", { class: "tv-set-section" }, { movies: "Movies", tv: "TV Shows", animation: "Animation", indian: "Bangla & Indian" }[section] ?? section));
        for (const c of cats) {
          const input = h("input", { type: "checkbox", class: "switch", role: "switch" });
          input.checked = tv().overrides[c.url] ?? c.defaultOn;
          input.addEventListener("change", () => {
            tv().overrides[c.url] = input.checked;
            save();
            crawl(true);
          });
          parts.push(h("label", { class: "sf-row sf-toggle" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, c.label), h("p", { class: "sf-hint" }, `${hostOf(c.url)}${c.series ? " · series" : ""}`)), input));
        }
      }
    }
    categoriesBox.replaceChildren(...(parts.length ? parts : [h("p", { class: "sf-hint" }, "No categories yet.")]));
  }

  function drawStatus() {
    const p = progress;
    const text = !p ? "…" : p.running ? `Updating: ${p.done} of ${p.total} categories read, ${p.items.toLocaleString()} titles.` : p.reachable === false ? p.error : `${p.items.toLocaleString()} titles${p.lastCrawl ? `, updated ${new Date(p.lastCrawl).toLocaleString()}` : ""}.`;
    statusBox.replaceChildren(row("Catalog", text, button("Refresh catalog", () => crawl(true), "btn small primary")));
  }

  function drawCache() {
    const text = cache ? `${sizeText(cache.bytes) || "0 MB"} of posters and logos (${cache.files} files, up to ${sizeText(cache.cap)}).` : "…";
    cacheBox.replaceChildren(
      row("Posters and logos", text, button("Clear cache", () => void tvApi.clearCache(false).then(refreshCache), "btn small")),
      row("Forget the catalog", "Starts again from the servers on the next refresh. Recently played is forgotten too.", button("Forget", () => void tvApi.clearCache(true).then(() => (refreshCache(), crawl(true))), "btn small ghost")));
  }

  function refreshCache() {
    void tvApi.cacheInfo().then((c) => ((cache = c), drawCache()), () => undefined);
  }

  // ---- live playlists
  async function readPlaylists() {
    try {
      const results = await tvApi.liveRefresh(tv());
      playlistMessage = results.map((r) => (r.error ? `${tv().playlists.find((p) => p.id === r.id)?.name ?? "A playlist"}: ${r.error}` : "")).filter(Boolean).join(" ");
      if (!playlistMessage) playlistMessage = `${results.reduce((n, r) => n + r.count, 0)} channels.`;
    } catch (err) {
      playlistMessage = errorText(err);
    }
    drawLive();
    refreshCache();
  }

  function addPlaylist(name: string, url: string) {
    const clean = url.trim();
    if (!clean || tv().playlists.some((p) => p.url === clean)) return;
    tv().playlists.push({ id: newId(), name: name.trim() || hostOf(clean) || clean.split(/[\\/]/).pop() || "Playlist", url: clean });
    save();
    void readPlaylists();
  }

  function drawLive() {
    const rows = tv().playlists.map((p) => {
      const remove = button("Remove", () => {
        tv().playlists = tv().playlists.filter((x) => x !== p);
        save();
        void readPlaylists();
      }, "btn small ghost");
      return h("div", { class: "sf-row plain tv-set-row" }, h("div", { class: "st-text" }, h("span", { class: "sf-label" }, p.name), h("p", { class: "sf-hint tv-set-url" }, p.url)), h("div", { class: "tv-set-buttons" }, remove));
    });
    const name = h("input", { class: "tv-input", type: "text", placeholder: "Name (optional)", "aria-label": "Playlist name", autocomplete: "off" });
    const url = h("input", { class: "tv-input wide", type: "text", placeholder: "https://… .m3u or .m3u8", "aria-label": "Playlist address", spellcheck: false, autocomplete: "off" });
    const add = () => {
      addPlaylist(name.value, url.value);
      name.value = url.value = "";
    };
    url.addEventListener("keydown", (e) => {
      if (e.key === "Enter") add();
    });
    const choose = button("Choose a file…", async () => {
      const path = await openDialog({ title: "Choose an M3U playlist", filters: [{ name: "Playlists", extensions: ["m3u", "m3u8"] }] });
      if (path) addPlaylist(name.value, path);
    });
    const free = button("Add free Bangladesh channels (iptv-org)", () => addPlaylist(FREE_BD_PLAYLIST.name, FREE_BD_PLAYLIST.url), "btn small primary");
    free.disabled = tv().playlists.some((p) => p.url === FREE_BD_PLAYLIST.url);
    liveBox.replaceChildren(
      h("p", { class: "sf-hint" }, "Live TV plays channels from M3U / M3U8 playlists you add: a link or a file on this computer. If your ISP offers a live-TV playlist, add it by its URL. Nothing is added or downloaded until you do."),
      ...rows,
      h("div", { class: "tv-set-add" }, name, url, h("div", { class: "tv-set-buttons" }, choose, button("Add", add))),
      row("Free-to-air channels", "iptv-org keeps a public index of free-to-air channels. This adds its Bangladesh list; it is read only when you press the button.", free),
      ...(tv().playlists.length ? [row("Playlists", playlistMessage || null, button("Refresh playlists", () => void readPlaylists()))] : []));
  }

  // ---- put together
  const group = (el: HTMLElement): SettingsRow[] => [{ label: "", el }];
  drawServers();
  drawCategories();
  drawStatus();
  drawCache();
  drawLive();
  void onTv("tv-progress", (p) => {
    progress = p;
    drawStatus();
  });

  return {
    id: "tv", title: "TV", icon: "tv", section: "Modules",
    refresh() {
      drawServers();
      drawLive();
      void discover();
      refreshCache();
      void tvApi.state().then((p) => ((progress = p), drawStatus()), () => undefined);
    },
    groups: [
      { title: "Movie servers", rows: group(serversBox) },
      { title: "Categories", rows: group(categoriesBox) },
      { title: "Catalog", rows: group(statusBox) },
      { title: "Cache", rows: group(cacheBox) },
      { title: "Live TV", rows: group(liveBox) },
    ],
  };
}
