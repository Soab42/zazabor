import { open as pickFiles } from "@tauri-apps/plugin-dialog";
import { basename, dirname, h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import { videoApi } from "../../api";
import type { VideoContext } from "../../extensions";
import { listFolder, panelApi } from "../../panel-api";
import { segmented, selectRow } from "../panel/ui";
import type { SubtitleController } from "./controller";
import { OWN_FORMATS } from "./engine";
import { LANGUAGES } from "./language";
import { episodeOf, matchEpisodes, showOf, type MatchReason } from "./match";
import { downloadOnline, HOW_TO_GET_A_KEY, searchOnline, type OnlineResult } from "./online";

type Scope = "file" | "folder" | "queue";
type Source = "computer" | "online";

/** Every subtitle format the player can show (ours, plus VLC's for sub/idx/sup). */
const SUBTITLE_EXTENSIONS = [...OWN_FORMATS, "sub", "idx", "sup", "smi"];
const SUBTITLE_DIRS = /^(subs?|subtitles?|sub-?titles?)$/i;
const MAX_ONLINE_BATCH = 25;

const REASONS: Record<MatchReason, string> = {
  remembered: "Remembered",
  episode: "Episode number",
  name: "Similar name",
  order: "By order",
  none: "No match",
};

const isSubtitle = (name: string) => SUBTITLE_EXTENSIONS.includes((/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase());

interface Row {
  video: string;
  sub: string | null;
  reason: MatchReason;
}

/** The Add Subtitles dialog (this file / folder / queue; this computer or OpenSubtitles). */
export function openAddSubtitles(c: SubtitleController, ctx: VideoContext, startScope: Scope = "file") {
  const current = ctx.player.current;
  if (!current) {
    ctx.showOsd("Open a video first");
    return;
  }
  let scope: Scope = startScope;
  let source: Source = "computer";
  let videos: string[] = [current];
  /** Subtitle files we know about, in the order found. */
  const candidates: string[] = [];
  /** Choices made by hand, kept when the automatic matching runs again. */
  const manual = new Map<string, string | null>();
  let rows: Row[] = [];
  let busy = false;
  let closed = false;
  let results: OnlineResult[] = [];
  let loadToken = 0;

  const addCandidates = (paths: string[]) => {
    for (const p of paths) if (!candidates.includes(p)) candidates.push(p);
  };

  const status = h("span", { class: "pp-dialog-status", role: "status" });
  const say = (text: string, bad = false) => {
    status.textContent = text;
    status.classList.toggle("bad", bad);
  };

  // ---- matching ---------------------------------------------------------------------------

  function remembered(): Record<string, string> {
    return c.settings.series[showOf(current!).key]?.matches ?? {};
  }

  function rematch() {
    const auto = matchEpisodes(videos, candidates, remembered(), c.settings.language || c.settings.online.language);
    rows = auto.map((m) => {
      if (manual.has(m.video)) {
        const sub = manual.get(m.video) ?? null;
        return { video: m.video, sub, reason: sub ? ("remembered" as const) : ("none" as const) };
      }
      return m;
    });
    renderRows();
  }

  async function loadVideos() {
    const token = ++loadToken;
    try {
      if (scope === "file") videos = [current!];
      else if (scope === "queue") videos = ctx.player.queue.length ? [...ctx.player.queue] : [current!];
      else videos = (await videoApi.listVideos(dirname(current!))).map((f) => f.path);
    } catch {
      videos = [current!];
    }
    if (token !== loadToken) return;
    if (!videos.includes(current!)) videos.unshift(current!);
    rematch();
    renderHeader();
  }

  /** Subtitle files next to the video, in a Subs folder beside it, and where this show's were taken from. */
  async function scanFolders() {
    const folder = dirname(current!);
    const found: string[] = [];
    const look = async (path: string, depth: number) => {
      try {
        const entries = await listFolder(path);
        for (const e of entries) {
          if (!e.dir && isSubtitle(e.name)) found.push(e.path);
          else if (e.dir && depth === 0 && SUBTITLE_DIRS.test(e.name)) await look(e.path, 1);
        }
      } catch {
        // an unreadable folder just has no subtitles
      }
    };
    await look(folder, 0);
    const memory = c.settings.series[showOf(current!).key]?.dir;
    if (memory && memory !== folder) await look(memory, 1);
    return found;
  }

  // ---- layout -------------------------------------------------------------------------------

  const scopeControl = segmented<Scope>(
    [
      { value: "file", label: "This file" },
      { value: "folder", label: "This folder" },
      { value: "queue", label: "This queue" },
    ],
    scope,
    (v) => {
      scope = v;
      void loadVideos();
      renderPanels();
    },
  );
  const sourceControl = segmented<Source>(
    [
      { value: "computer", label: "This computer" },
      { value: "online", label: "Online (OpenSubtitles)" },
    ],
    source,
    (v) => {
      source = v;
      renderPanels();
    },
  );
  const scopeHint = h("p", { class: "pp-note" });
  const sourceBox = h("div", { class: "pp-dialog-source" });
  const reviewBox = h("div", { class: "pp-dialog-review" });

  function renderHeader() {
    const show = showOf(current!);
    const count = videos.length;
    scopeHint.textContent =
      scope === "file"
        ? basename(current!)
        : `${show.name || "Videos"} · ${count} ${count === 1 ? "video" : "videos"} in ${scope === "folder" ? "this folder" : "the queue"}`;
  }

  function renderPanels() {
    renderHeader();
    sourceBox.replaceChildren(source === "computer" ? computerPanel() : onlinePanel());
    renderRows();
  }

  // ---- this computer -----------------------------------------------------------------------------

  function computerPanel(): HTMLElement {
    const choose = h("button", { class: "btn small", type: "button", onclick: async () => {
      const picked = await pickFiles({ multiple: true, filters: [{ name: "Subtitles", extensions: SUBTITLE_EXTENSIONS }], defaultPath: dirname(current!) }).catch(() => null);
      const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
      if (!paths.length) return;
      addCandidates(paths);
      // A single file chosen for one video is a decision, not a guess.
      if (scope === "file" && paths.length === 1) manual.set(current!, paths[0]);
      rematch();
      say(`${paths.length} ${paths.length === 1 ? "file" : "files"} added`);
    } }, icon("folder", 14), "Choose files…");
    const scan = h("button", { class: "btn small ghost", type: "button", onclick: async () => {
      say("Looking…");
      const found = await scanFolders();
      addCandidates(found);
      rematch();
      say(found.length ? `Found ${found.length} subtitle ${found.length === 1 ? "file" : "files"} near the video` : "No subtitle files near the video");
    } }, icon("search", 14), "Find near the video");
    return h("div", null, h("div", { class: "pp-dialog-buttons" }, choose, scan),
      note(candidates.length ? `${candidates.length} subtitle ${candidates.length === 1 ? "file" : "files"} to choose from.` : "Pick subtitle files, or let me look beside the video."));
  }

  const note = (text: string) => h("p", { class: "pp-note" }, text);

  // ---- online ----------------------------------------------------------------------------------

  function onlinePanel(): HTMLElement {
    const online = c.settings.online;
    if (!online.apiKey.trim()) {
      return h("div", { class: "pp-card" },
        h("h4", { class: "pp-card-title" }, "OpenSubtitles needs a free API key"),
        h("ol", { class: "pp-steps" }, ...HOW_TO_GET_A_KEY.map((s) => h("li", null, s))),
        h("button", { class: "btn small", type: "button", onclick: () => {
          c.wantAdvanced = true;
          close();
          ctx.openPanel("subtitles");
        } }, "Open the key settings"));
    }
    const show = showOf(current!);
    const episode = episodeOf(current!);
    const query = h("input", { class: "pp-input", type: "text", "aria-label": "Search", value: show.name || basename(current!).replace(/\.[^.]+$/, "") });
    const language = selectRow("Language", LANGUAGES.map((l) => ({ value: l.code, label: l.name })), online.language, (v) => {
      online.language = v;
      ctx.shell.saveConfig();
    });
    const list = h("div", { class: "pp-results", role: "listbox" });
    const search = h("button", { class: "btn small primary", type: "button", onclick: async () => {
      busy = true;
      say("Searching…");
      list.replaceChildren();
      try {
        const hash = await panelApi.fileHash(current!).then((r) => r.hash).catch(() => undefined);
        results = await searchOnline(online, { hash, text: query.value.trim(), season: episode.season, episode: episode.episode });
        say(results.length ? `${results.length} found` : "Nothing found. Try another name or language.");
        for (const r of results.slice(0, 30)) list.append(resultRow(r));
      } catch (err) {
        say(err instanceof Error ? err.message : "The search failed.", true);
      } finally {
        busy = false;
      }
    } }, icon("search", 14), "Search");
    query.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") search.click();
    });
    const batch = scope === "file" ? null : h("button", { class: "btn small", type: "button", onclick: () => void fillOnline(), title: "Looks up each episode and downloads the best match" }, icon("download", 14), `Find for all ${Math.min(videos.length, MAX_ONLINE_BATCH)} episodes`);
    return h("div", null, h("div", { class: "pp-dialog-search" }, query, search), language.el,
      batch ? h("div", { class: "pp-dialog-buttons" }, batch) : null, list);
  }

  function resultRow(r: OnlineResult): HTMLElement {
    return h("div", { class: "pp-result", role: "option" },
      h("div", { class: "pp-result-main" },
        h("span", { class: "pp-result-title" }, r.release || r.fileName),
        h("span", { class: "pp-result-meta" }, [r.language.toUpperCase(), r.hashMatch ? "exact match" : "", `${r.downloads.toLocaleString()} downloads`].filter(Boolean).join(" · "))),
      h("button", { class: "btn small", type: "button", onclick: async () => {
        if (busy) return;
        busy = true;
        say("Downloading…");
        try {
          const path = await downloadOnline(c.settings.online, r);
          addCandidates([path]);
          if (scope === "file") {
            manual.set(current!, path);
            rematch();
            say("Downloaded. Press Add subtitles to use it.");
          } else {
            manual.set(current!, path);
            rematch();
            say("Downloaded for the current video.");
          }
        } catch (err) {
          say(err instanceof Error ? err.message : "The download failed.", true);
        } finally {
          busy = false;
        }
      } }, "Use"));
  }

  /** For each video: search by hash / show and episode, download the best result. */
  async function fillOnline() {
    if (busy) return;
    busy = true;
    const todo = videos.slice(0, MAX_ONLINE_BATCH);
    let done = 0, failed = 0;
    try {
      for (const video of todo) {
        if (closed) return;
        say(`Looking up ${++done} of ${todo.length}…`);
        try {
          const ep = episodeOf(video);
          const hash = await panelApi.fileHash(video).then((r) => r.hash).catch(() => undefined);
          const found = await searchOnline(c.settings.online, { hash, text: showOf(video).name, season: ep.season, episode: ep.episode });
          const best = found.find((r) => r.hashMatch) ?? found.find((r) => ep.episode == null || r.episode == null || r.episode === ep.episode) ?? null;
          if (!best) {
            failed++;
            continue;
          }
          const path = await downloadOnline(c.settings.online, best);
          addCandidates([path]);
          manual.set(video, path);
          rematch();
        } catch (err) {
          failed++;
          // A rejected key or an exhausted quota will fail every following call too.
          if (err instanceof Error && /key|limit|slow down/i.test(err.message)) {
            say(err.message, true);
            return;
          }
        }
      }
      say(failed ? `Done. ${failed} could not be found.` : "Done. Check the list, then press Add subtitles.");
    } finally {
      busy = false;
    }
  }

  // ---- review list ------------------------------------------------------------------------------

  function label(path: string): string {
    const name = basename(path);
    const same = candidates.filter((p) => basename(p) === name).length > 1;
    return same ? `${basename(dirname(path))}/${name}` : name;
  }

  function renderRows() {
    if (scope === "file" && source === "online") {
      reviewBox.replaceChildren();
      return;
    }
    const list = rows.map((row) => {
      const select = h("select", { "aria-label": `Subtitles for ${basename(row.video)}` },
        h("option", { value: "" }, "No subtitles"),
        ...candidates.map((p) => h("option", { value: p }, label(p))));
      select.value = row.sub ?? "";
      select.addEventListener("change", () => {
        manual.set(row.video, select.value || null);
        rematch();
      });
      const isCurrent = row.video === current;
      return h("div", { class: `pp-row-review${isCurrent ? " current" : ""}` },
        h("span", { class: "pp-row-name", title: row.video }, basename(row.video)),
        select,
        h("span", { class: `pp-badge ${row.reason}` }, REASONS[row.reason]));
    });
    const body: Node[] = [];
    if (rows.length > 1) body.push(h("h4", { class: "pp-heading" }, "Review matches"));
    if (candidates.length || scope === "file") body.push(...list);
    else body.push(note("Add subtitle files above to match them to the episodes."));
    reviewBox.replaceChildren(...body);
    apply.disabled = !rows.some((r) => r.sub);
  }

  // ---- shell --------------------------------------------------------------------------------------

  const apply = h("button", { class: "btn primary", type: "button", onclick: async () => {
    if (busy) return;
    const chosen = rows.filter((r) => r.sub);
    if (!chosen.length) return;
    busy = true;
    let failed = 0;
    for (const row of chosen) {
      try {
        await c.assign(row.video, row.sub!);
      } catch {
        failed++;
      }
    }
    busy = false;
    close();
    ctx.showOsd(failed ? `Subtitles added, ${failed} could not be read` : chosen.length === 1 ? "Subtitles added" : `Subtitles added for ${chosen.length} videos`);
  } }, "Add subtitles");
  apply.disabled = true;

  const overlay = h("div", { class: "modal-overlay" });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else {
      // Keep the player's shortcuts from acting behind the dialog.
      e.stopPropagation();
    }
  };
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  }
  document.addEventListener("keydown", onKey, true);

  const dialog = h("div", { class: "modal pp-dialog", role: "dialog", "aria-label": "Add subtitles" },
    h("header", { class: "modal-head" },
      h("div", null, h("h2", null, "Add subtitles"), scopeHint),
      h("button", { class: "icon-btn", type: "button", title: "Close (Esc)", onclick: close }, icon("close"))),
    h("div", { class: "modal-body pp-dialog-body" },
      h("div", { class: "pp-dialog-choices" },
        h("div", null, h("span", { class: "pp-label" }, "Apply to"), scopeControl.el),
        h("div", null, h("span", { class: "pp-label" }, "From"), sourceControl.el)),
      sourceBox, reviewBox),
    h("footer", { class: "modal-foot" }, status, h("div", { class: "spacer" }),
      h("button", { class: "btn", type: "button", onclick: close }, "Cancel"), apply));
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.append(dialog);
  document.body.append(overlay);

  renderPanels();
  void loadVideos();
  void scanFolders().then((found) => {
    if (closed || !found.length) return;
    addCandidates(found);
    rematch();
    if (source === "computer") renderPanels();
  });
}
