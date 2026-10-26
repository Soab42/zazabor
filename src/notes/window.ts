import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyAppearance } from "../appearance";
import { adoptConfig, CONFIG_SAVED, parseConfig, type Config } from "../config";
import { followLock } from "../lock";
import { onOthers, windowLabel } from "../shell/windows";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { notesApi, onNotesChanged, type Note, type NoteWindowState } from "./api";
import { NoteEditor } from "./editor";
import { parse, titleOf } from "./markdown";
import { openNoteMenu } from "./menu";
import { openMenu } from "../ui/menu";
import "./notes.css";

type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];

const GRIPS: [string, ResizeDirection][] = [
  ["n", "North"], ["s", "South"], ["e", "East"], ["w", "West"],
  ["ne", "NorthEast"], ["nw", "NorthWest"], ["se", "SouthEast"], ["sw", "SouthWest"],
];

/**
 * One note on the desktop, in a small frameless window of its own colour, like Microsoft Sticky
 * Notes: + for a new note, the menu for colour, Keep on Top and the notes list, × to put it away.
 */
export async function startNoteWindow(config: Config, id: string) {
  document.body.classList.add("note-window");
  applyAppearance(config.appearance);
  await followLock();
  const win = getCurrentWindow();
  const note: Note | null = await notesApi.get(id).catch(() => null);
  if (!note || note.deleted) return void win.destroy();
  let state: NoteWindowState = await notesApi.windowState(id).catch(() => ({ open: true, x: null, y: null, width: null, height: null, onTop: false }));
  let current: Note = note;

  // Edits go out one at a time; closing the window waits for the last.
  let saving: Promise<unknown> = Promise.resolve();
  const save = (patch: { title?: string; body?: string }) => {
    saving = saving.then(() => notesApi.update(id, patch).then((n) => (current = n), (err) => console.warn("Saving the note failed:", err)));
  };
  const editor = new NoteEditor({
    change: (body) => {
      save({ body });
      showTitle(body);
    },
    openLink: (url) => void invoke("fs_open_default", { path: url }).catch(() => undefined),
    leaveTop: () => {
      titleInput.focus();
      titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);
    },
  });

  // The title, over the text: Enter or ↓ goes on to the text.
  const titleInput = h("input", { class: "note-title", type: "text", placeholder: "Title", maxlength: 200, spellcheck: "true", "aria-label": "Title" });
  titleInput.value = current.title;
  let titleTimer = 0;
  const saveTitle = () => {
    clearTimeout(titleTimer);
    titleTimer = 0;
    if (titleInput.value.trim() !== current.title) save({ title: titleInput.value });
  };
  titleInput.addEventListener("input", () => {
    showTitle();
    clearTimeout(titleTimer);
    titleTimer = window.setTimeout(saveTitle, 350);
  });
  titleInput.addEventListener("blur", saveTitle);
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || (e.key === "ArrowDown" && titleInput.selectionStart === titleInput.value.length)) {
      e.preventDefault();
      saveTitle();
      editor.focus(false);
    }
  });

  const button = (name: Parameters<typeof icon>[0], title: string, onclick: (e: MouseEvent) => void) =>
    h("button", { type: "button", class: "note-btn", title, "aria-label": title, onclick }, icon(name, 16));
  const menuButton = button("more", "Menu", () => {
    const rect = menuButton.getBoundingClientRect();
    openNoteMenu(rect.left, rect.bottom + 4, current, (color) => void notesApi.update(id, { color }).catch(() => undefined), [
      { label: "Notes List", icon: "note", action: () => void invoke("notes_show_list").catch(() => undefined) },
      { label: state.onTop ? "Don’t Keep on Top" : "Keep on Top", icon: "pip", action: () => void setOnTop(!state.onTop) },
      { label: current.pinned ? "Unpin from Top of List" : "Pin to Top of List", icon: "pin", action: () => void notesApi.update(id, { pinned: !current.pinned }) },
      { label: `Status: ${current.status ?? "None"}…`, icon: "columns", action: () => statusMenu(rect.left, rect.bottom + 4) },
      "separator",
      { label: "Delete Note", icon: "trash", danger: true, shortcut: "Ctrl+D", action: () => void notesApi.remove(id) },
    ]);
  });
  /** The Kanban columns to put the note in. */
  const statusMenu = (x: number, y: number) => {
    const names = [...config.notes.columns];
    if (current.status && !names.includes(current.status)) names.push(current.status);
    openMenu(x, y, [
      ...names.map((name) => ({ label: name, icon: (current.status === name ? "check" : undefined) as "check" | undefined, action: () => void notesApi.update(id, { status: name }) })),
      "separator" as const,
      { label: "No Status", icon: (current.status ? undefined : "check") as "check" | undefined, action: () => void notesApi.update(id, { status: null }) },
    ]);
  };
  const topBadge = h("span", { class: "note-btn on", title: "Kept on top", hidden: !state.onTop }, icon("pip", 14));
  const drag = h("div", { class: "note-drag" });
  const bar = h("header", { class: "note-bar" },
    button("plus", "New Note (Ctrl+N)", () => void newNote()), drag, topBadge, menuButton,
    button("close", "Close Note (Ctrl+W)", () => void win.close()));
  // The bar moves the window (no double-click maximise, as a note shouldn't fill the screen).
  bar.addEventListener("pointerdown", (e) => {
    if (e.button === 0 && (e.target === bar || e.target === drag)) void win.startDragging();
  });
  const scroll = h("div", { class: "note-scroll" }, titleInput, editor.area);
  scroll.addEventListener("pointerdown", (e) => {
    // A click below the text puts the caret at its end.
    if (e.target === scroll) {
      e.preventDefault();
      editor.focus();
    }
  });
  const root = h("div", { class: "note", "data-note-color": current.color }, bar, scroll, editor.tools,
    ...GRIPS.map(([cls, direction]) => h("div", { class: `note-grip ${cls}`, onpointerdown: (e: PointerEvent) => e.button === 0 && void win.startResizeDragging(direction) })));
  document.getElementById("app")!.append(root);

  /** The window's title (the taskbar shows it): the note's title, or else its first line. */
  function showTitle(body = current.body) {
    void win.setTitle(titleInput.value.trim() || titleOf(parse(body)) || "Note").catch(() => undefined);
  }
  editor.setBody(current.body);
  showTitle();
  if (!current.body && !current.title) editor.focus();

  async function setOnTop(on: boolean) {
    await win.setAlwaysOnTop(on).catch(() => undefined);
    state = { ...state, onTop: on };
    topBadge.hidden = !on;
    void notesApi.setWindowState(id, state);
  }

  /** A new note (in the next colour), a little down and to the right of this one. */
  async function newNote() {
    const made = await notesApi.create();
    const scale = await win.scaleFactor();
    const at = (await win.outerPosition()).toLogical(scale);
    const size = (await win.innerSize()).toLogical(scale);
    await notesApi.setWindowState(made.id, { open: false, x: at.x + 32, y: at.y + 32, width: size.width, height: size.height, onTop: state.onTop });
    await notesApi.open(made.id);
  }

  // Where the window is and how big, for next time.
  let geometryTimer = 0;
  const saveGeometry = () => {
    clearTimeout(geometryTimer);
    geometryTimer = window.setTimeout(async () => {
      const scale = await win.scaleFactor();
      const at = (await win.outerPosition()).toLogical(scale);
      const size = (await win.innerSize()).toLogical(scale);
      state = { ...state, open: true, x: at.x, y: at.y, width: size.width, height: size.height };
      void notesApi.setWindowState(id, state);
    }, 400);
  };
  void win.onMoved(saveGeometry);
  void win.onResized(saveGeometry);

  // The formatting bar shows while the note has the focus.
  document.body.classList.toggle("focused", document.hasFocus());
  void win.onFocusChanged(({ payload }) => document.body.classList.toggle("focused", payload));

  // Closing the note (×, Ctrl+W, the desktop's close) puts it away: it won't reopen at the next start.
  void win.onCloseRequested(async () => {
    saveTitle();
    editor.flush();
    await saving;
    state = { ...state, open: false };
    await notesApi.setWindowState(id, state).catch(() => undefined);
  });

  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.shiftKey || e.altKey || document.body.classList.contains("app-locked")) return;
    const key = e.key.toLowerCase();
    if (key === "n") void newNote();
    else if (key === "w") void win.close();
    else if (key === "d") void notesApi.remove(id);
    else return;
    e.preventDefault();
  });

  void onNotesChanged((change) => {
    if (change.removed.includes(id)) return void win.destroy();
    const changed = change.notes.find((n) => n.id === id);
    if (!changed) return;
    if (changed.deleted) return void win.destroy();
    current = changed;
    root.dataset.noteColor = changed.color;
    // What this window typed is already on screen; other windows' and the sync's changes aren't.
    if (change.origin !== windowLabel) {
      editor.setBody(changed.body);
      if (document.activeElement !== titleInput) titleInput.value = changed.title;
      showTitle(changed.body);
    }
  });

  void onOthers<string>(CONFIG_SAVED, (json) => {
    try {
      adoptConfig(config, parseConfig(json));
    } catch {
      return;
    }
    applyAppearance(config.appearance);
    if (!config.features.notes) void win.destroy();
  });
}
