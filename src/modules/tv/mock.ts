import type { Channel, Discovered, Episode, Events, Filter, Home, Item, Page, Progress, Season, Section, TvMock } from "./api";

/**
 * The dev stand-in for the Rust side: a made-up catalog with real DhakaFlix-style names, posters
 * drawn as SVG, and live channels. `?tvmock` has everything, "empty" nothing found, "offline" a
 * network that can't reach the servers. Never part of a release build (see api.ts).
 */

const DAY = 86400000;
const NOW = Date.now();
const hueOf = (text: string) => {
  let n = 0;
  for (let i = 0; i < text.length; i++) n = (n * 31 + text.charCodeAt(i)) % 360;
  return n;
};

function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if ((line + " " + word).trim().length > max && line) {
      lines.push(line);
      line = word;
    } else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A poster: a gradient with a glow, a few shapes and the title set big, like key art. */
function poster(title: string, year: number | null): string {
  const h = hueOf(title);
  const lines = wrap(title.toUpperCase(), 11);
  const longest = Math.max(...lines.map((l) => l.length));
  const size = Math.min(lines.length > 2 ? 74 : 92, Math.floor(540 / (longest * 0.64)));
  const text = lines.map((l, i) => `<text x="52" y="${700 + i * (size + 6) - (lines.length - 1) * (size + 6) + 150}" font-family="Inter, Helvetica, Arial, sans-serif" font-weight="800" font-size="${size}" letter-spacing="-3" fill="#fff">${esc(l)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 960"><defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 62% 46%)"/><stop offset="1" stop-color="hsl(${(h + 55) % 360} 66% 14%)"/></linearGradient>
    <radialGradient id="r" cx="0.72" cy="0.28" r="0.6"><stop offset="0" stop-color="hsl(${(h + 20) % 360} 90% 72%)" stop-opacity="0.85"/><stop offset="1" stop-color="hsl(${h} 80% 50%)" stop-opacity="0"/></radialGradient>
    <linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.78"/></linearGradient></defs>
    <rect width="640" height="960" fill="url(#g)"/><rect width="640" height="960" fill="url(#r)"/>
    <circle cx="${180 + (h % 5) * 60}" cy="${300 + (h % 3) * 40}" r="${130 + (h % 4) * 25}" fill="none" stroke="#fff" stroke-opacity="0.18" stroke-width="3"/>
    <circle cx="${440 - (h % 4) * 40}" cy="${220 + (h % 5) * 30}" r="${70 + (h % 3) * 30}" fill="#fff" fill-opacity="0.08"/>
    <path d="M0 ${560 + (h % 80)} Q 220 ${470 + (h % 60)} 640 ${600 + (h % 70)} L640 960 L0 960Z" fill="#000" fill-opacity="0.22"/>
    <rect width="640" height="960" fill="url(#f)"/>${text}
    <text x="54" y="920" font-family="Inter, Helvetica, Arial, sans-serif" font-weight="600" font-size="30" letter-spacing="6" fill="#fff" fill-opacity="0.7">${year ?? ""}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

interface Seed {
  t: string;
  y: number;
  q?: string;
  tags?: string[];
  rank?: number;
}

const ENGLISH_2025: Seed[] = [
  { t: "28 Years Later", y: 2025, tags: ["Dual Audio", "BluRay", "HEVC"] },
  { t: "A House of Dynamite", y: 2025, tags: ["Dual Audio", "NF"] },
  { t: "A Big Bold Beautiful Journey", y: 2025, tags: ["Dual Audio", "AMZN"] },
  { t: "A Minecraft Movie", y: 2025, tags: ["Dual Audio", "WEB-DL"] },
  { t: "Anaconda", y: 2025, tags: ["Dual Audio", "AMZN"] },
  { t: "Afterburn", y: 2025, tags: ["Dual Audio"] },
  { t: "After the Hunt", y: 2025, tags: ["Dual Audio", "AMZN"] },
  { t: "A Working Man", y: 2025, tags: ["Dual Audio", "AMZN"] },
  { t: "Superman", y: 2025, tags: ["Dual Audio", "HMAX", "HEVC"] },
  { t: "Jurassic World Rebirth", y: 2025, tags: ["Dual Audio", "WEB-DL"] },
  { t: "Mission Impossible - The Final Reckoning", y: 2025, tags: ["Dual Audio", "BluRay"] },
  { t: "The Fantastic Four - First Steps", y: 2025, tags: ["Dual Audio", "DSNP"] },
  { t: "Weapons", y: 2025, tags: ["Dual Audio", "HMAX"] },
  { t: "Sinners", y: 2025, tags: ["Dual Audio", "BluRay", "IMAX"] },
  { t: "Frankenstein", y: 2025, tags: ["Dual Audio", "NF"] },
  { t: "Tron Ares", y: 2025, tags: ["Dual Audio", "DSNP"] },
  { t: "F1 The Movie", y: 2025, tags: ["Dual Audio", "ATVP"] },
  { t: "Predator Badlands", y: 2025, tags: ["Dual Audio", "DSNP"] },
];
const ENGLISH_OLDER: Seed[] = [
  { t: "Dune Part Two", y: 2024, tags: ["Dual Audio", "BluRay"] },
  { t: "Oppenheimer", y: 2023, tags: ["Dual Audio", "BluRay", "IMAX"] },
  { t: "Everything Everywhere All at Once", y: 2022, tags: ["Dual Audio", "BluRay"] },
  { t: "Interstellar", y: 2014, tags: ["Dual Audio", "BluRay", "IMAX"] },
  { t: "Mad Max Fury Road", y: 2015, tags: ["Dual Audio", "BluRay"] },
  { t: "The Matrix", y: 1999, tags: ["Dual Audio", "BluRay"] },
  { t: "A Fistful of Dollars", y: 1964, tags: [] },
  { t: "2001-A Space Odyssey", y: 1968, tags: [] },
];
const IMDB: Seed[] = [
  "The Shawshank Redemption|1994", "The Godfather|1972", "The Dark Knight|2008", "The Godfather-Part II|1974", "12 Angry Men|1957", "Schindler's List|1993",
  "The Lord of the Rings-The Return of the King|2003", "Pulp Fiction|1994", "The Good, the Bad and the Ugly|1966", "Fight Club|1999", "Forrest Gump|1994", "Inception|2010",
].map((s, i) => ({ t: s.split("|")[0], y: Number(s.split("|")[1]), rank: i + 1, tags: ["Dual Audio"] }));
const HINDI: Seed[] = [
  { t: "120 Bahadur", y: 2025 }, { t: "Aankhon Ki Gustaakhiyan", y: 2025 }, { t: "Aap Jaisa Koi", y: 2025 }, { t: "Saiyaara", y: 2025, tags: ["NF"] },
  { t: "War 2", y: 2025, tags: ["HEVC"] }, { t: "Sitaare Zameen Par", y: 2025 }, { t: "Dhurandhar", y: 2025 }, { t: "Ajey-The Untold Story of a Yogi", y: 2025, q: "720p", tags: ["HDTC"] },
];
const BANGLA: Seed[] = [
  { t: "Dhumketu", y: 2025, q: "720p" }, { t: "Raghu Dakat", y: 2025, q: "720p" }, { t: "Chengiz", y: 2023, q: "720p" }, { t: "Projapoti 2", y: 2019, q: "720p" },
  { t: "Pather Panchali", y: 1955, q: "720p" }, { t: "Charulata", y: 1964, q: "720p" },
];
const ANIMATION: Seed[] = [
  { t: "Zootopia 2", y: 2025, tags: ["Dual Audio", "DSNP"] }, { t: "KPop Demon Hunters", y: 2025, tags: ["NF"] }, { t: "Demon Slayer - Infinity Castle", y: 2025, tags: ["Dual Audio"] },
  { t: "Inside Out 2", y: 2024, tags: ["Dual Audio", "DSNP"] }, { t: "Spirited Away", y: 2001, tags: ["Dual Audio", "BluRay"] }, { t: "Spider-Man - Across the Spider-Verse", y: 2023, tags: ["Dual Audio"] },
];
const KOREAN: Seed[] = [
  { t: "18 Again", y: 2020, q: "720p", tags: ["Dual Audio", "AMZN"] }, { t: "100 Days My Prince", y: 2018, q: "720p" }, { t: "Squid Game", y: 2021, q: "720p", tags: ["Dual Audio", "NF"] },
  { t: "Crash Landing on You", y: 2019, q: "720p", tags: ["Dual Audio"] }, { t: "Goblin", y: 2016, q: "720p" }, { t: "Reply 1988", y: 2015, q: "720p" },
];
const SERIES: Seed[] = [
  { t: "A Knight of the Seven Kingdoms", y: 2026, tags: ["Dual Audio", "HMAX"] }, { t: "A Discovery of Witches", y: 2018 }, { t: "Severance", y: 2022, tags: ["ATVP"] },
  { t: "The Last of Us", y: 2023, tags: ["Dual Audio", "HMAX"] }, { t: "Wednesday", y: 2022, q: "720p", tags: ["Dual Audio", "NF"] }, { t: "Stranger Things", y: 2016, tags: ["Dual Audio", "NF"] },
  { t: "Breaking Bad", y: 2008, q: "720p" }, { t: "The Bear", y: 2022, q: "720p", tags: ["HULU" as string] },
];
const ANIME: Seed[] = [{ t: "Jujutsu Kaisen", y: 2020, q: "720p" }, { t: "Attack on Titan", y: 2013, q: "720p" }, { t: "One Piece", y: 1999, q: "720p" }, { t: "Spy x Family", y: 2022, q: "720p" }];
const DOCS: Seed[] = [{ t: "13th", y: 2016, q: "720p", tags: ["WEBRip"] }, { t: "14 Peaks-Nothing Is Impossible", y: 2021, q: "720p", tags: ["NF"] }, { t: "Free Solo", y: 2018, q: "1080p" }];

interface Cat {
  url: string;
  label: string;
  section: Section;
  series: boolean;
  defaultOn: boolean;
  seeds: Seed[];
  host: string;
}

const CATS: Cat[] = [
  { url: "http://172.16.50.14/DHAKA-FLIX-14/English%20Movies%20%281080p%29/", label: "English Movies 1080p", section: "movies", series: false, defaultOn: true, host: "172.16.50.14", seeds: [...ENGLISH_2025, ...ENGLISH_OLDER] },
  { url: "http://172.16.50.14/DHAKA-FLIX-14/IMDb%20Top-250%20Movies/", label: "IMDb Top 250", section: "movies", series: false, defaultOn: true, host: "172.16.50.14", seeds: IMDB },
  { url: "http://172.16.50.14/DHAKA-FLIX-14/Hindi%20Movies/", label: "Hindi Movies", section: "indian", series: false, defaultOn: true, host: "172.16.50.14", seeds: HINDI },
  { url: "http://172.16.50.7/DHAKA-FLIX-7/Kolkata%20Bangla%20Movies/", label: "Kolkata Bangla Movies", section: "indian", series: false, defaultOn: true, host: "172.16.50.7", seeds: BANGLA },
  { url: "http://172.16.50.14/DHAKA-FLIX-14/Animation%20Movies%20%281080p%29/", label: "Animation Movies 1080p", section: "animation", series: false, defaultOn: true, host: "172.16.50.14", seeds: ANIMATION },
  { url: "http://172.16.50.14/DHAKA-FLIX-14/KOREAN%20TV%20%26%20WEB%20Series/", label: "Korean TV & Web Series", section: "tv", series: true, defaultOn: true, host: "172.16.50.14", seeds: KOREAN },
  { url: "http://172.16.50.12/DHAKA-FLIX-12/TV-WEB-Series/", label: "TV & Web Series", section: "tv", series: true, defaultOn: true, host: "172.16.50.12", seeds: SERIES },
  { url: "http://172.16.50.10/DHAKA-FLIX-10/Anime%20%26%20Cartoon%20TV%20Series/", label: "Anime & Cartoon TV Series", section: "animation", series: true, defaultOn: true, host: "172.16.50.10", seeds: ANIME },
  { url: "http://172.16.50.10/DHAKA-FLIX-10/Documentary/", label: "Documentary", section: "tv", series: false, defaultOn: true, host: "172.16.50.10", seeds: DOCS },
  { url: "http://172.16.50.10/DHAKA-FLIX-10/Tutorial/", label: "Tutorial", section: "tv", series: false, defaultOn: false, host: "172.16.50.10", seeds: [] },
];

function build(): Item[] {
  const items: Item[] = [];
  let n = 0;
  for (const cat of CATS) {
    cat.seeds.forEach((s, i) => {
      const quality = s.q ?? (cat.section === "animation" || cat.section === "movies" ? "1080p" : "720p");
      const series = cat.series;
      const name = `${s.t} (${series ? `TV Series ${s.y}` : s.y}) ${quality}`;
      items.push({
        id: `m${n++}`,
        title: s.t,
        year: s.y,
        quality,
        tags: s.tags ?? [],
        kind: series ? "series" : "movie",
        section: cat.section,
        category: cat.label,
        categoryUrl: cat.url,
        folderUrl: `${cat.url}${encodeURIComponent(name)}/`,
        videoUrl: series ? "" : `${cat.url}${encodeURIComponent(name)}/${encodeURIComponent(s.t)}.mkv`,
        size: series ? 0 : (900 + ((hueOf(s.t) * 13) % 2600)) * 1048576,
        poster: poster(s.t, s.y),
        noPoster: false,
        added: NOW - (i * 3 + (n % 5)) * DAY * (s.y >= 2024 ? 1 : 12) - (n % 9) * 3600000,
        rank: s.rank ?? null,
        played: 0,
      });
    });
  }
  return items;
}

const CHANNELS: [string, string, string][] = [
  ["BTV", "General", "BTV"], ["BTV News", "News", "BTV"], ["Somoy TV", "News", "S"], ["Jamuna TV", "News", "J"], ["Channel 24", "News", "24"], ["Ekattor TV", "News", "E71"],
  ["DBC News", "News", "DBC"], ["News24", "News", "N24"], ["NTV", "General", "NTV"], ["RTV", "General", "RTV"], ["ATN Bangla", "Entertainment", "ATN"], ["Channel i", "Entertainment", "i"],
  ["Gazi TV", "Sports", "GTV"], ["T Sports", "Sports", "TS"], ["Maasranga TV", "Entertainment", "M"], ["Deepto TV", "Entertainment", "D"], ["Independent TV", "General", "IND"],
  ["Boishakhi TV", "Entertainment", "BTV"], ["Bijoy TV", "General", "BIJ"], ["Banglavision", "Entertainment", "BV"], ["Nagorik TV", "General", "NG"], ["Ekushey Television", "General", "ETV"],
  ["Sangsad TV", "General", "SAN"], ["Channel 9", "General", "C9"], ["Duronto TV", "Kids", "DU"], ["Peace TV Bangla", "Religious", "PTV"], ["Asian TV", "Music", "AS"], ["Rupashi Bangla", "Music", "RB"],
];

function logo(text: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect x="30" y="18" width="100" height="64" rx="18" fill="hsl(${hue} 70% 46%)"/><text x="80" y="60" text-anchor="middle" font-family="Inter, Arial" font-weight="800" font-size="${text.length > 2 ? 26 : 34}" fill="#fff">${esc(text)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function createMock(mode: string): TvMock {
  const listeners = new Map<string, Set<(p: never) => void>>();
  const emit = <K extends keyof Events>(event: K, payload: Events[K]) => listeners.get(event)?.forEach((fn) => (fn as (p: Events[K]) => void)(payload));
  const offline = mode === "offline";
  const empty = mode === "empty";
  const all = offline || empty ? [] : build();
  let channels: Channel[] = CHANNELS.map(([name, group, mark], i) => ({
    id: `c${i}`, source: "s1", name, tvgId: "", logo: i % 7 === 4 ? null : logo(mark, hueOf(name)), hasLogo: i % 7 !== 4, group, url: `https://example.com/live/${i}.m3u8`,
    fav: i === 1 || i === 8 || i === 13, watched: i === 2 ? NOW - 3600000 : i === 9 ? NOW - 86400000 : i === 13 ? NOW - 7200000 : 0, status: "" as Channel["status"],
  }));
  if (mode === "nolive") channels = [];
  const progress: Progress = { running: false, done: 0, total: 0, items: all.length, reachable: offline ? false : true, error: offline ? "Can't reach DhakaFlix at 172.16.50.14 — are you on the ISP's network?" : "", lastCrawl: NOW - 3600000 };

  const filtered = (f: Filter, withYear = true, withQuality = true) => {
    let list = all.filter((i) => (!f.section || i.section === f.section) && (!f.kind || i.kind === f.kind) && (!f.categoryUrl || i.categoryUrl === f.categoryUrl) && (!f.played || i.played > 0));
    if (f.q) for (const w of f.q.toLowerCase().split(/\s+/)) list = list.filter((i) => `${i.title} ${i.category}`.toLowerCase().includes(w));
    if (withYear && f.year) list = list.filter((i) => i.year === f.year);
    if (withQuality && f.quality) list = list.filter((i) => i.quality === f.quality);
    return list;
  };
  const sorted = (list: Item[], sort: Filter["sort"]) =>
    [...list].sort((a, b) => sort === "az" ? a.title.localeCompare(b.title) : sort === "year" ? (b.year ?? 0) - (a.year ?? 0) || b.added - a.added : sort === "rank" ? (a.rank ?? 1e5) - (b.rank ?? 1e5) : sort === "played" ? b.played - a.played : b.added - a.added);
  const query = (f: Filter) => {
    const list = sorted(filtered(f), f.sort);
    return list.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 60));
  };

  function episodesOf(item: Item): Season[] {
    const seasons = 2 + (hueOf(item.title) % 3);
    return Array.from({ length: seasons }, (_, s) => ({
      name: `Season ${s + 1}`,
      episodes: Array.from({ length: 8 + ((s * 3 + hueOf(item.title)) % 5) }, (_, e): Episode => {
        const code = `S${String(s + 1).padStart(2, "0")}E${String(e + 1).padStart(2, "0")}`;
        return { name: `${item.title} ${code}  ${item.quality} ${item.tags[1] ?? "WEB-DL"} x265 HEVC ESub [Dual Audio][Hindi 2.0+English 2.0] -MsMod.mkv`, url: `${item.folderUrl}Season%20${s + 1}/${code}.mkv`, size: (380 + ((e * 17 + s * 5) % 180)) * 1048576, season: s + 1, episode: e + 1 };
      }),
    }));
  }

  const home = (): Home => {
    const movies = sorted(all.filter((i) => i.kind === "movie"), "new");
    const hero = movies.slice(0, 7);
    const years = new Map<number, number>();
    for (const i of movies) if (i.year) years.set(i.year, (years.get(i.year) ?? 0) + 1);
    const topYear = [...years].sort((a, b) => b[0] - a[0]).find(([, n]) => n >= 10)?.[0] ?? null;
    return {
      hero,
      recent: query({ played: true, sort: "played", limit: 20 }),
      new: query({ limit: 30 }),
      top: topYear ? query({ kind: "movie", year: topYear, limit: 10 }) : [],
      topYear,
      categories: CATS.filter((c) => all.some((i) => i.categoryUrl === c.url)).map((c) => ({
        url: c.url, label: c.label, section: c.section, kind: c.series ? "series" : "movie", count: all.filter((i) => i.categoryUrl === c.url).length * (c.section === "movies" ? 46 : 18),
        items: query({ categoryUrl: c.url, sort: /imdb/i.test(c.label) ? "rank" : "new", limit: 24 }),
      })),
      total: all.length * 24,
    };
  };

  const discovered = (): Discovered => offline
    ? { reachable: false, error: progress.error, categories: [] }
    : { reachable: true, error: "", categories: CATS.map(({ url, label, section, series, defaultOn }) => ({ url, label, section, series, defaultOn })) };

  return {
    async invoke(cmd, args) {
      await new Promise((r) => setTimeout(r, 30));
      switch (cmd) {
        case "tv_discover": return discovered();
        case "tv_state": return progress;
        case "tv_start": return progress;
        case "tv_home": return home();
        case "tv_items": {
          const f = args.filter as Filter;
          const list = filtered(f);
          const noYear = filtered(f, false, false);
          const years = new Map<number, number>();
          const qualities = new Map<string, number>();
          for (const i of noYear) {
            if (i.year) years.set(i.year, (years.get(i.year) ?? 0) + 1);
            if (i.quality) qualities.set(i.quality, (qualities.get(i.quality) ?? 0) + 1);
          }
          const page: Page = { items: query(f), total: list.length, years: args.facets ? [...years].sort((a, b) => b[0] - a[0]) : [], qualities: args.facets ? [...qualities].sort((a, b) => b[1] - a[1]) : [] };
          return page;
        }
        case "tv_resolve": return all.find((i) => i.id === args.id);
        case "tv_episodes": return episodesOf(all.find((i) => i.id === args.id)!);
        case "tv_played": {
          const item = all.find((i) => i.id === args.id);
          if (item) item.played = Date.now();
          return null;
        }
        case "tv_cache_info": return { bytes: 84 * 1048576, files: 412, items: all.length, channels: channels.length, cap: 300 * 1048576 };
        case "tv_clear_cache": return null;
        case "tv_live_refresh": return [{ id: (args.sources as { id: string }[])[0]?.id ?? "s1", count: channels.length, error: "" }];
        case "tv_live_channels": return channels.map((c) => ({ ...c }));
        case "tv_live_fav": channels.find((c) => c.id === args.id)!.fav = args.on as boolean; return null;
        case "tv_live_watched": channels.find((c) => c.id === args.id)!.watched = Date.now(); return null;
        case "tv_live_logo": return channels.find((c) => c.id === args.id)?.logo ?? null;
        case "tv_live_probe": {
          const ids = args.ids as string[];
          ids.forEach((id, i) => setTimeout(() => {
            const ch = channels.find((c) => c.id === id);
            if (!ch) return;
            ch.status = i % 9 === 4 || i % 11 === 7 ? "offline" : "online";
            emit("tv-live-status", { id, status: ch.status as "online" | "offline" });
          }, 250 + i * 40));
          return ids.length;
        }
        default: throw new Error(`The TV mock has no ${cmd}`);
      }
    },
    listen(event, fn) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn as (p: never) => void);
      return () => set!.delete(fn as (p: never) => void);
    },
  };
}
