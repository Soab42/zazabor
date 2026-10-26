import type { UnlistenFn } from "@tauri-apps/api/event";
import { notesApi, onNotesChanged, onSyncStatus, orderOf, syncText, type Note, type SyncStatus } from "../../notes/api";
import "../../notes/notes.css";
import type { AppModule, ModuleFactory } from "../../shell/module";
import { isMainWindow } from "../../shell/windows";
import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { Board } from "./board";
import { matches, noteCard } from "./card";
import { Kanban } from "./kanban";
import "./notes-module.css";

type View = "all" | "pinned" | "deleted";

/**
 * The Notes section: every note as a card of its colour, on a masonry board or in Kanban columns
 * by status, pinned ones first, then the newest. A card opens its note on the desktop; checklist
 * items tick right on the card. Search (titles and text), a pinned filter, Recently Deleted (30
 * days), and the sync's status.
 */
export const createNotesModule: ModuleFactory = (shell) => {
  const notes = new Map<string, Note>();
  const settings = () => shell.config.notes;
  let view: View = "all";
  let dirty = true;
  let visible = false;
  let status: SyncStatus = { folder: null, state: "off", last: null, error: null };
  const unlisten: Promise<UnlistenFn>[] = [];

  const search = h("input", { class: "search-input", type: "search", placeholder: "Search notes", "aria-label": "Search notes", spellcheck: "false" });
  search.addEventListener("input", () => draw());
  const views: [View, string][] = [["all", "All"], ["pinned", "Pinned"], ["deleted", "Recently Deleted"]];
  const viewButtons = views.map(([id, label]) => {
    const button = h("button", { type: "button", onclick: () => ((view = id), draw()) }, label);
    return [id, button] as const;
  });
  const layouts: ["board" | "kanban", IconName, string][] = [["board", "galleryView", "Board"], ["kanban", "columns", "Kanban (by status)"]];
  const layoutButtons = layouts.map(([id, glyph, label]) => {
    const button = h("button", { type: "button", title: label, "aria-label": label, onclick: () => setLayout(id) }, icon(glyph, 16));
    return [id, button] as const;
  });
  const syncChip = h("button", { type: "button", class: "nm-sync", onclick: () => (isMainWindow ? shell.openSettings("notes") : void notesApi.syncNow()) });
  const newButton = h("button", { type: "button", class: "btn primary small", onclick: () => void newNote(null) }, icon("plus", 15), "New Note");
  const emptyTrash = h("button", { type: "button", class: "btn small ghost nm-empty-trash", onclick: () => void notesApi.purge([]) }, icon("trash", 15), "Empty");
  const count = h("span", { class: "nm-count" });
  const bar = h("header", { class: "nm-bar" },
    h("div", { class: "nm-title" }, h("h1", null, "Notes"), count),
    h("label", { class: "search nm-search" }, icon("search", 15), search),
    h("div", { class: "segmented" }, ...viewButtons.map(([, b]) => b)),
    h("div", { class: "segmented nm-layouts" }, ...layoutButtons.map(([, b]) => b)),
    h("div", { class: "spacer" }), syncChip, emptyTrash, newButton);

  const cardHost = {
    openExternally: (url: string) => shell.openExternally(url),
    columns: () => settings().columns,
    dragging: () => kanban.drag.dragging || board.drag.dragging,
  };
  const board = new Board((note) => noteCard(note, cardHost));
  const kanban = new Kanban({
    makeCard: (note) => noteCard(note, cardHost),
    columns: () => settings().columns,
    setColumns: (columns) => {
      settings().columns = columns;
      shell.saveConfig();
      draw();
    },
    setStatus: (id, next) => void notesApi.update(id, { status: next }).catch((err) => console.warn("Could not change the status:", err)),
    addNote: (next) => void newNote(next),
    renameStatus: (from, to) => {
      const columns = settings().columns;
      settings().columns = columns.includes(to) ? columns.filter((c) => c !== from) : columns.map((c) => (c === from ? to : c));
      shell.saveConfig();
      for (const note of notes.values()) if (note.status === from) void notesApi.update(note.id, { status: to });
      draw();
    },
  });
  const empty = h("div", { class: "nm-empty-host" });
  const scroll = h("div", { class: "nm-scroll" }, board.el, kanban.el, empty);
  const el = h("section", { class: "notes-module" }, bar, scroll);

  async function newNote(status: string | null) {
    const note = await notesApi.create({ status: status ?? undefined });
    await notesApi.open(note.id);
  }

  function setLayout(layout: "board" | "kanban") {
    if (settings().layout === layout) return;
    settings().layout = layout;
    shell.saveConfig();
    draw();
  }

  async function load() {
    try {
      const list = await notesApi.list();
      notes.clear();
      for (const n of list) notes.set(n.id, n);
    } catch (err) {
      console.warn("Could not load notes:", err);
    }
    draw();
  }

  function shown(): Note[] {
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return [...notes.values()]
      .filter((n) => (view === "deleted" ? !!n.deleted : !n.deleted && (view === "all" || n.pinned)))
      .filter((n) => matches(n, terms))
      // Pinned first, then where they were dragged to (newest first until then). Never by when
      // they were edited, so typing in a note doesn't move the board.
      .sort((a, b) => (view === "deleted" ? (b.deleted ?? 0) - (a.deleted ?? 0) : Number(b.pinned) - Number(a.pinned) || orderOf(b) - orderOf(a)));
  }

  /** Brings the section up to date (only while it shows; otherwise at the next look). */
  function draw() {
    if (!visible) {
      dirty = true;
      return;
    }
    dirty = false;
    for (const [id, button] of viewButtons) button.classList.toggle("active", id === view);
    // Recently Deleted is always a board: deleted notes have no place in the columns.
    const kanbanShown = settings().layout === "kanban" && view !== "deleted";
    for (const [id, button] of layoutButtons) {
      button.classList.toggle("active", id === settings().layout);
      button.disabled = view === "deleted";
    }
    newButton.hidden = view === "deleted";
    emptyTrash.hidden = view !== "deleted" || ![...notes.values()].some((n) => n.deleted);
    const live = [...notes.values()].filter((n) => !n.deleted).length;
    count.textContent = live ? String(live) : "";
    const list = shown();
    // The Kanban shows its columns (and "Add note") even with no notes in them.
    const nothing = !list.length && (!kanbanShown || !!search.value.trim());
    scroll.classList.toggle("kanban", kanbanShown && !nothing);
    board.el.hidden = kanbanShown || nothing;
    kanban.el.hidden = !kanbanShown || nothing;
    empty.replaceChildren(...(nothing ? [emptyState()] : []));
    if (nothing) return;
    if (kanbanShown) kanban.show(list);
    else board.show(list);
  }

  function emptyState(): HTMLElement {
    const query = search.value.trim();
    const [glyph, title, text, action]: [IconName, string, string, HTMLElement | null] = query
      ? ["search", "No notes match", `Nothing contains “${query}”.`, null]
      : view === "pinned"
        ? ["pin", "Nothing pinned", "Pin a note from its menu to keep it at the top.", null]
        : view === "deleted"
          ? ["trash", "Recently Deleted is empty", "Deleted notes stay here for 30 days.", null]
          : ["note", "No notes yet", "Jot something down. A note floats on your desktop and can stay on top of everything.",
            h("button", { type: "button", class: "btn primary", onclick: () => void newNote(null) }, icon("plus", 15), "New Note")];
    return h("div", { class: "nm-empty" },
      h("div", { class: "nm-empty-tile glass" }, icon(glyph, 30)),
      h("h2", null, title), h("p", null, text), action);
  }

  function showStatus(next: SyncStatus) {
    status = next;
    syncChip.hidden = status.state === "off" && !isMainWindow;
    syncChip.className = `nm-sync ${status.state}`;
    syncChip.title = status.folder ? `${syncText(status)}\n${status.folder}` : "Sync notes through a folder on a cloud drive";
    syncChip.replaceChildren(
      status.state === "syncing" ? h("span", { class: "spinner" }) : icon(status.state === "error" ? "info" : "sync", 14),
      h("span", null, status.state === "off" ? "Set Up Sync" : status.state === "error" ? "Sync problem" : syncText(status)));
  }

  unlisten.push(onNotesChanged((change) => {
    for (const n of change.notes) notes.set(n.id, n);
    for (const id of change.removed) notes.delete(id);
    draw();
  }));
  unlisten.push(onSyncStatus(showStatus));
  void notesApi.syncStatus().then(showStatus, () => undefined);
  void load();
  // "Synced 2 min ago" ages.
  const ticker = window.setInterval(() => visible && status.state === "idle" && showStatus(status), 30_000);

  const module: AppModule = {
    id: "notes",
    title: "Notes",
    icon: "note",
    el,
    activate() {
      visible = true;
      if (dirty) draw();
    },
    deactivate() {
      visible = false;
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
        draw();
        return true;
      }
      return false;
    },
    configChanged: () => draw(),
    dispose() {
      clearInterval(ticker);
      for (const u of unlisten) void u.then((fn) => fn());
      el.remove();
    },
  };
  // Escape in the search field clears it (the shell leaves typing alone).
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.stopPropagation();
      search.value = "";
      draw();
    }
  });
  return module;
};
