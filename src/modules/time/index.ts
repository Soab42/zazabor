import type { UnlistenFn } from "@tauri-apps/api/event";
import type { AppModule, ModuleFactory } from "../../shell/module";
import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu } from "../../ui/menu";
import "../files/ops/ops.css";
import { showToast } from "../files/ops/toast";
import { ACTIVITY_KINDS, errorText, onTimeChanged, timeApi, type ActivityKind, type Entry, type TimeData } from "./api";
import { confirmDialog } from "./dialog";
import { checkTimeDialog, editDialog, ensureCheckedIn, logPastActivityDialog, logPastWorkDialog, otherActivityDialog, startTimerDialog, type TimeHost } from "./dialogs";
import { CATEGORIES, clock, dayKey, duration, endOfDay, hm, inTab, KIND_CATEGORY, KIND_ICON, KIND_LABEL, matches, stamp, startOfDay, toRow, totals, type Category, type Row, type Tab } from "./model";
import { DateTimeField } from "./pickers";
import { reportDialog } from "./report";
import "./time-module.css";

/** Rows shown at first, and added by each "Load more". */
const PAGE = 20;
/** Where "All time" starts while no From day is picked. */
const ALL_FROM = new Date(2020, 0, 1).getTime();

/**
 * The Time section: check in and out, time a task, log breaks, lunch, prayer, meetings and other
 * activities (one thing runs at a time; an activity pauses the task timer and hands it back), log
 * what already happened, and write the daily report. Eight counters tick every second from the
 * entries' start times; nothing polls. Changes made in any window arrive as `time-changed`.
 */
export const createTimeModule: ModuleFactory = () => {
  /** Today, always (the cards and the header count today). */
  let today: TimeData | null = null;
  /** The All time span, while that scope shows. */
  let ranged: TimeData | null = null;
  let loadedDay = "";
  let scope: "today" | "all" = "today";
  let tab: Tab = "all";
  let limit = PAGE;
  let visible = false;
  let ticker = 0;
  /** Duration cells of running rows, updated by the tick. */
  const liveCells = new Map<HTMLElement, Entry>();
  const unlisten: Promise<UnlistenFn>[] = [];

  const status = h("div", { class: "tt-sr", "aria-live": "polite" });
  const host: TimeHost = {
    tasks: () => today?.tasks ?? [],
    session: () => today?.session ?? null,
    toast: (text) => {
      showToast(text, undefined, 3200);
      status.textContent = text;
    },
    changed: () => void refresh(true),
  };

  // ---- header: title, check-in, refresh, report, timer

  const presenceDot = h("span", { class: "tt-presence-dot" });
  const presenceText = h("span", { class: "tt-presence-text" });
  const checkButton = h("button", { class: "btn small", type: "button", onclick: () => void toggleCheck() });
  const checkMore = h("button", {
    class: "icon-btn small", type: "button", title: "Check in or out at another time", "aria-label": "Check in or out at another time",
    onclick: () => {
      const r = checkMore.getBoundingClientRect();
      const session = host.session();
      openMenu(r.left, r.bottom + 4, [session
        ? { label: "Check Out at…", icon: "logOut", action: () => checkTimeDialog(host, "out") }
        : { label: "Check In at…", icon: "logIn", action: () => checkTimeDialog(host, "in") }]);
    },
  }, icon("chevronDown", 13));
  const presence = h("div", { class: "tt-presence" }, presenceDot, presenceText, checkButton, checkMore);
  const timerButton = h("button", { class: "btn primary tt-timer-btn", type: "button", onclick: () => void timerAction() });
  const bar = h("header", { class: "tt-bar" },
    h("div", { class: "tt-heading" },
      h("span", { class: "tt-heading-icon" }, icon("stopwatch", 20)),
      h("div", { class: "tt-heading-text" }, h("h1", null, "Time Tracking"), h("p", { class: "tt-sub" }, "Track work, breaks, prayer, and meetings"))),
    h("div", { class: "spacer" }),
    presence,
    h("button", { class: "icon-btn", type: "button", title: "Refresh", "aria-label": "Refresh", onclick: () => void refresh(true) }, icon("refresh", 17)),
    h("button", { class: "btn", type: "button", onclick: () => reportDialog(host) }, icon("document", 15), "Report"),
    timerButton);

  // ---- stat cards

  const cardValues = new Map<Category, HTMLElement>();
  const cardEls = new Map<Category, HTMLElement>();
  const cards = h("div", { class: "tt-cards", role: "list", "aria-label": "Today" }, ...CATEGORIES.map((c) => {
    const value = h("span", { class: "tt-card-value", role: "timer", "aria-label": c.label }, "00:00:00");
    const card = h("div", { class: `tt-card tone-${c.id}`, role: "listitem" },
      h("span", { class: "tt-chip-icon" }, icon(c.icon, 16)),
      h("div", { class: "tt-card-text" }, value, h("span", { class: "tt-stat-label" }, c.label)));
    cardValues.set(c.id, value);
    cardEls.set(c.id, card);
    return card;
  }));

  // ---- activity chips and Log past

  const chips = new Map<ActivityKind, { el: HTMLElement; time: HTMLElement }>();
  const chipRow = h("div", { class: "tt-chips" }, h("span", { class: "tt-chips-label" }, "Log activity:"));
  for (const kind of ACTIVITY_KINDS) {
    const time = h("span", { class: "tt-chip-time", role: "timer" });
    const end = h("button", { class: "tt-chip-end", type: "button", "aria-label": `End ${KIND_LABEL[kind]}`, onclick: () => void endActivity() }, icon("stop", 10), "End");
    const start = h("button", { class: "tt-chip-main", type: "button", onclick: () => void beginActivity(kind) }, icon(KIND_ICON[kind], 14), h("span", null, KIND_LABEL[kind]), time);
    const el = h("div", { class: `tt-activity tone-${KIND_CATEGORY[kind]}` }, start, end);
    chips.set(kind, { el, time });
    chipRow.append(el);
  }
  const logPast = h("button", {
    class: "btn small ghost tt-log-past", type: "button", "aria-haspopup": "menu",
    onclick: () => {
      const r = logPast.getBoundingClientRect();
      openMenu(r.right - 200, r.bottom + 4, [
        { label: "Work session…", icon: "briefcase", action: () => logPastWorkDialog(host) },
        { label: "Break / activity…", icon: "coffee", action: () => logPastActivityDialog(host) },
      ]);
    },
  }, icon("plus", 14), "Log past", icon("chevronDown", 12));
  chipRow.append(h("span", { class: "spacer" }), logPast);

  // ---- filters

  const scopes: ["today" | "all", string][] = [["today", "Today"], ["all", "All time"]];
  const scopeButtons = scopes.map(([id, label]) => h("button", { type: "button", onclick: () => setScope(id) }, label));
  const fromField = new DateTimeField({ value: null, placeholder: "Any", label: "From", dateOnly: true, clearable: true, host: () => document.body, onChange: () => ((limit = PAGE), void refresh(true)) });
  const toField = new DateTimeField({ value: null, placeholder: "Now", label: "To", dateOnly: true, clearable: true, host: () => document.body, onChange: () => ((limit = PAGE), void refresh(true)) });
  const range = h("div", { class: "tt-range" }, h("span", { class: "tt-range-label" }, "From"), fromField.el, h("span", { class: "tt-range-label" }, "To"), toField.el);
  const allCount = h("span", { class: "tt-count" });
  const tabs: [Tab, string][] = [["all", "All Activity"], ["work", "Work"], ["breaks", "Breaks & Prayer"]];
  const tabButtons = tabs.map(([id, label]) => h("button", { type: "button", role: "tab", onclick: () => setTab(id) }, label, id === "all" ? allCount : null));
  const search = h("input", { class: "search-input", type: "search", placeholder: "Search tasks, activity…", "aria-label": "Search tasks, activity", spellcheck: "false" });
  search.addEventListener("input", () => ((limit = PAGE), drawTable()));
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.stopPropagation();
      search.value = "";
      drawTable();
    }
  });
  const filters = h("div", { class: "tt-filters" },
    h("div", { class: "segmented" }, ...scopeButtons), range,
    h("div", { class: "segmented tt-tabs", role: "tablist" }, ...tabButtons),
    h("span", { class: "spacer" }),
    h("label", { class: "search tt-search" }, icon("search", 15), search));

  // ---- table

  const head = h("div", { class: "tt-row tt-head", role: "row" }, ...["Activity", "Project", "Started", "Ended", "Duration", "Type"].map((t) => h("span", { class: "tt-cell", role: "columnheader" }, t)));
  const rowsEl = h("div", { class: "tt-rows", role: "rowgroup" });
  const table = h("div", { class: "tt-table", role: "table", "aria-label": "Activity" }, head, rowsEl);
  const more = h("button", { class: "btn small", type: "button", onclick: () => ((limit += PAGE), drawTable()) }, "Load more");
  const moreRow = h("div", { class: "tt-more" }, more);
  const empty = h("div", { class: "tt-empty-host" });
  const sentinel = h("div", { class: "tt-sentinel" });
  const scroll = h("div", { class: "tt-scroll" }, cards, chipRow, filters, table, empty, moreRow, sentinel);
  const el = h("section", { class: "time-module" }, bar, scroll, status);
  // Scrolling near the end loads the next page.
  new IntersectionObserver((seen) => {
    if (seen.some((s) => s.isIntersecting) && !moreRow.hidden && visible) more.click();
  }, { root: scroll, rootMargin: "200px" }).observe(sentinel);

  // ---- data

  let inflight: Promise<void> | null = null;
  let queued = false;
  let soon = 0;

  /**
   * Fetches today (and the All time span when it shows). Bursts of `time-changed` (one per window
   * and per change) wait a moment and fold into one fetch, and a fetch never overlaps another.
   */
  function refresh(now = false): Promise<void> {
    if (!now) {
      clearTimeout(soon);
      soon = window.setTimeout(() => void refresh(true), 40);
      return Promise.resolve();
    }
    if (inflight) {
      queued = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        const at = Date.now();
        const span = scope === "all" ? [fromField.get() ?? ALL_FROM, toField.get() != null ? endOfDay(toField.get()!) : endOfDay(at)] as const : null;
        const [day, all] = await Promise.all([timeApi.data(startOfDay(at), endOfDay(at)), span ? timeApi.data(span[0], span[1]) : Promise.resolve(null)]);
        today = day;
        ranged = all;
        loadedDay = dayKey(at);
      } catch (err) {
        if (errorText(err) !== "locked") console.warn("Could not load time tracking:", err);
      } finally {
        inflight = null;
      }
      draw();
      if (queued) {
        queued = false;
        await refresh(true);
      }
    })();
    return inflight;
  }

  // ---- drawing

  function draw() {
    if (!visible) return;
    drawHeader();
    drawTable();
    tick();
  }

  function drawHeader() {
    const session = today?.session ?? null;
    presence.classList.toggle("in", !!session);
    checkButton.className = `btn small ${session ? "tt-danger-solid" : "primary"}`;
    checkButton.replaceChildren(icon(session ? "logOut" : "logIn", 14), session ? "Check Out" : "Check In");
    const running = today?.running ?? null;
    const timing = running?.kind === "work";
    timerButton.className = `btn tt-timer-btn ${timing ? "tt-danger-solid" : "primary"}`;
    timerButton.replaceChildren(icon(timing ? "stop" : "play", 13), timing ? "Stop" : "Start Task Timer");
    for (const [kind, chip] of chips) {
      const on = running?.kind === kind;
      chip.el.classList.toggle("active", on);
      chip.el.querySelector(".tt-chip-main")!.setAttribute("aria-pressed", String(on));
    }
    for (const [i, button] of scopeButtons.entries()) button.classList.toggle("active", scopes[i][0] === scope);
    for (const [i, button] of tabButtons.entries()) {
      button.classList.toggle("active", tabs[i][0] === tab);
      button.setAttribute("aria-selected", String(tabs[i][0] === tab));
    }
    range.hidden = scope !== "all";
  }

  /** Every second while the section shows: the counters, the running chip and rows, a new day. */
  function tick() {
    if (!today || !visible) return;
    const now = Date.now();
    if (dayKey(now) !== loadedDay) void refresh(true);
    const t = totals(today.sessions, today.entries, startOfDay(now), endOfDay(now), now);
    for (const c of CATEGORIES) cardValues.get(c.id)!.textContent = clock(t[c.id]);
    const running = today.running;
    const live: Category | null = running ? KIND_CATEGORY[running.kind] : today.session ? "idle" : null;
    for (const [id, card] of cardEls) card.classList.toggle("ticking", id === live || (id === "total" && !!running));
    presenceText.textContent = today.session ? `${hm(t.work)} today` : `${hm(t.work)} today · not checked in`;
    for (const [kind, chip] of chips) chip.time.textContent = running?.kind === kind ? clock(now - running.start).replace(/^00:/, "") : "";
    if (running?.kind === "work") {
      const task = today.tasks.find((x) => x.id === running.task);
      timerButton.title = `${task?.title ?? "Task"} · ${clock(now - running.start)}`;
    } else timerButton.title = "";
    for (const [cell, entry] of liveCells) cell.textContent = duration(now - entry.start);
  }

  function startTicking() {
    stopTicking();
    // On the second, so all counters turn over together.
    ticker = window.setTimeout(function step() {
      tick();
      ticker = window.setTimeout(step, 1000 - (Date.now() % 1000));
    }, 1000 - (Date.now() % 1000));
  }

  function stopTicking() {
    clearTimeout(ticker);
  }

  function shownData(): TimeData | null {
    return scope === "today" ? today : ranged;
  }

  function drawTable() {
    if (!visible) return;
    liveCells.clear();
    const data = shownData();
    const tasks = new Map((data?.tasks ?? []).map((t) => [t.id, t]));
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const searched = (data?.entries ?? []).map((e) => toRow(e, tasks)).filter((r) => matches(r, terms));
    allCount.textContent = String(searched.length);
    const rows = searched.filter((r) => inTab(r, tab));
    rowsEl.replaceChildren(...rows.slice(0, limit).map(rowEl));
    table.hidden = !rows.length;
    moreRow.hidden = rows.length <= limit;
    more.textContent = `Load more (${rows.length - limit} more)`;
    empty.replaceChildren(...(rows.length || !data ? [] : [emptyState(terms.length > 0 || tab !== "all")]));
  }

  function rowEl(row: Row): HTMLElement {
    const e = row.entry;
    const running = e.end == null;
    const dur = h("span", { class: "tt-cell tt-dur", role: "cell", "data-label": "Duration" }, duration((e.end ?? Date.now()) - e.start));
    if (running) liveCells.set(dur, e);
    const edit = () => editDialog(host, e);
    const note = e.kind === "work" && e.text ? e.text : "";
    const el = h("div", { class: `tt-row${running ? " running" : ""}`, role: "row", ondblclick: edit },
      h("span", { class: "tt-cell tt-activity-cell", role: "cell" },
        h("span", { class: `tt-kind-icon tone-${row.tone}` }, icon(row.icon, 14)),
        h("span", { class: "tt-name-wrap" },
          h("span", { class: "tt-name", title: note ? `${row.title}\n${note}` : row.title }, row.title),
          note ? h("span", { class: "tt-row-note" }, note) : null),
        h("button", { class: "icon-btn small tt-edit", type: "button", title: "Edit", "aria-label": `Edit ${row.title}`, onclick: edit }, icon("pencil", 13))),
      h("span", { class: "tt-cell tt-project", role: "cell", "data-label": "Project", title: row.project }, row.project),
      h("span", { class: "tt-cell tt-time", role: "cell", "data-label": "Started" }, stamp(e.start)),
      h("span", { class: "tt-cell tt-time", role: "cell", "data-label": "Ended" }, running ? h("span", { class: "tt-running" }, h("span", { class: "tt-pulse" }), "Running") : stamp(e.end!)),
      dur,
      h("span", { class: "tt-cell tt-type", role: "cell", "data-label": "Type" }, h("span", { class: `tt-badge tone-${row.tone}` }, row.badge)));
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      openMenu(ev.clientX, ev.clientY, [
        { label: "Edit…", icon: "pencil", action: edit },
        "separator",
        { label: "Delete", icon: "trash", danger: true, action: () => void deleteEntry(e) },
      ]);
    });
    return el;
  }

  function emptyState(filtered: boolean): HTMLElement {
    const session = host.session();
    const [glyph, title, text, action]: [IconName, string, string, HTMLElement | null] = filtered
      ? ["search", "Nothing matches", "No activity fits this search or tab.", null]
      : !session && scope === "today"
        ? ["stopwatch", "No activity yet", "Check in to start your day, then time a task or log a break.",
          h("button", { class: "btn primary", type: "button", onclick: () => void toggleCheck() }, icon("logIn", 15), "Check In")]
        : ["stopwatch", "No activity yet", scope === "all" ? "Nothing was tracked in this span." : "Start a task timer, or log a break or something that already happened.",
          scope === "today" ? h("button", { class: "btn primary", type: "button", onclick: () => void timerAction() }, icon("play", 13), "Start Task Timer") : null];
    return h("div", { class: "tt-empty" }, h("div", { class: "tt-empty-tile glass" }, icon(glyph, 30)), h("h2", null, title), h("p", null, text), action);
  }

  // ---- actions

  function setScope(next: "today" | "all") {
    if (scope === next) return;
    scope = next;
    limit = PAGE;
    drawHeader();
    if (scope === "all" && !ranged) {
      rowsEl.replaceChildren();
      empty.replaceChildren(h("div", { class: "tt-empty" }, h("span", { class: "spinner large" })));
    }
    void refresh(true);
  }

  function setTab(next: Tab) {
    tab = next;
    limit = PAGE;
    drawHeader();
    drawTable();
  }

  async function run<T>(request: () => Promise<T>): Promise<T | null> {
    try {
      return await request();
    } catch (err) {
      host.toast(errorText(err));
      return null;
    } finally {
      void refresh(true);
    }
  }

  async function toggleCheck() {
    const session = host.session();
    if (!session) {
      if (await run(() => timeApi.checkIn())) host.toast("Checked in");
      return;
    }
    const running = today?.running;
    if (running) {
      const what = running.kind === "work"
        ? `the timer on “${today?.tasks.find((t) => t.id === running.task)?.title ?? "a task"}”`
        : running.text ? `“${running.text}”` : `your ${KIND_LABEL[running.kind].toLowerCase()}`;
      const yes = await confirmDialog({ title: "Check out?", text: `Checking out stops ${what}.`, confirm: "Check Out", danger: true, icon: "logOut", tone: "idle" });
      if (!yes) return;
    }
    if (await run(() => timeApi.checkOut())) host.toast("Checked out");
  }

  async function timerAction() {
    const running = today?.running;
    if (running?.kind === "work") {
      const out = await run(() => timeApi.stop());
      if (out) host.toast(`Timer stopped · ${duration((out.stopped.end ?? Date.now()) - out.stopped.start)}`);
      return;
    }
    if (await ensureCheckedIn(host, "start a timer")) startTimerDialog(host);
  }

  async function beginActivity(kind: ActivityKind) {
    if (today?.running?.kind === kind) return;
    if (!(await ensureCheckedIn(host, `log ${KIND_LABEL[kind].toLowerCase()}`))) return;
    if (kind === "other") return otherActivityDialog(host);
    const paused = today?.running?.kind === "work" ? today.tasks.find((t) => t.id === today?.running?.task) : null;
    const entry = await run(() => timeApi.begin(kind, ""));
    if (entry) host.toast(`${KIND_LABEL[kind]} started${paused ? ` · “${paused.title}” paused` : ""}`);
  }

  async function endActivity() {
    const running = today?.running;
    if (!running || running.kind === "work") return;
    const out = await run(() => timeApi.stop());
    if (!out) return;
    const back = out.resumed ? today?.tasks.find((t) => t.id === out.resumed?.task) : null;
    host.toast(`${KIND_LABEL[running.kind]} ended${back ? ` · back to “${back.title}”` : ""}`);
  }

  async function deleteEntry(entry: Entry) {
    const yes = await confirmDialog({ title: "Delete this entry?", text: "It's removed from your time for good.", confirm: "Delete", danger: true, icon: "trash", tone: "idle" });
    if (yes && (await run(() => timeApi.remove(entry.id).then(() => true)))) host.toast("Deleted");
  }

  unlisten.push(onTimeChanged(() => visible && void refresh()));

  const module: AppModule = {
    id: "time",
    title: "Time",
    icon: "stopwatch",
    el,
    activate() {
      visible = true;
      draw();
      startTicking();
      void refresh(true);
    },
    deactivate() {
      visible = false;
      stopTicking();
    },
    handleKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "f") {
        search.focus();
        search.select();
        return true;
      }
      if (e.key === "Escape" && search.value) {
        search.value = "";
        drawTable();
        return true;
      }
      return false;
    },
    onLock() {
      // Dialogs show times and notes; the lock closes them.
      for (const overlay of document.querySelectorAll(".tt-overlay")) overlay.remove();
    },
    dispose() {
      stopTicking();
      clearTimeout(soon);
      for (const u of unlisten) void u.then((fn) => fn());
      el.remove();
    },
  };
  return module;
};
