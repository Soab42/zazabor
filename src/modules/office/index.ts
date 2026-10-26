import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppModule, ModuleFactory } from "../../shell/module";
import { isMainWindow, openWindow } from "../../shell/windows";
import { dirname, h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu } from "../../ui/menu";
import "../files/ops/ops.css";
import { showToast } from "../files/ops/toast";
import { openDialog } from "../time/dialog";
import "../time/time-module.css";
import { errorText } from "../time/api";
import { kindOf, officeApi, pickFiles, type OfficeKind, type Recovered } from "./api";
import type { EditorFactory, EditorHost, HubView, OfficeEditor, RecoveredFile } from "./editor";
import { renderHub, type HubHost } from "./hub";
import "./office.css";

const RECENT_MAX = 40;
/** How often unsaved files are snapshotted for AutoRecover. */
const RECOVER_EVERY_MS = 20_000;

/** Each editor is its own chunk, loaded the first time it's needed. */
const LOADERS: Record<OfficeKind, () => Promise<EditorFactory>> = {
  doc: async () => (await import("./docs")).createDocEditor,
  sheet: async () => (await import("./sheets")).createSheetEditor,
  pdf: async () => (await import("./pdf")).createPdfEditor,
};

const KIND_ICON: Record<OfficeKind, IconName> = { doc: "docFile", sheet: "sheetFile", pdf: "pdfFile" };

/** What a kind of file is called in messages. */
const KIND_NOUN: Record<OfficeKind, string> = { doc: "document", sheet: "workbook", pdf: "PDF" };

/** Asks about unsaved changes: save them, throw them away, or stay. */
function askSave(title: string): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    let answer: "save" | "discard" | "cancel" = "cancel";
    const choose = (a: typeof answer) => () => ((answer = a), dialog.close());
    const dialog = openDialog({
      title: `Save changes to “${title}”?`,
      icon: "save",
      tone: "work",
      class: "tt-confirm",
      body: [h("p", { class: "tt-dialog-text" }, "Your changes will be lost if you don't save them.")],
      foot: [
        h("button", { class: "btn", type: "button", onclick: choose("discard") }, "Don't Save"),
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: choose("cancel") }, "Cancel"),
        h("button", { class: "btn primary", type: "button", "data-autofocus": "", onclick: choose("save") }, "Save"),
      ],
      onClose: () => resolve(answer),
    });
  });
}

/**
 * Office: Docs (a Word-like word processor) and Sheets (an Excel-like spreadsheet). Like the
 * Microsoft 365 app, it has a rail of its own: Home, New and Open, a page for Docs and one for
 * Sheets, then the files open right now. A file's editor fills the rest; its File tab comes back
 * here while the file stays open.
 */
export const createOfficeModule: ModuleFactory = (shell) => {
  const settings = () => shell.config.office;
  const editors: OfficeEditor[] = [];
  let current: OfficeEditor | null = null;
  let view: HubView = "home";
  /** The file whose File tab opened the hub: its Save, Save As, Print and Close show on top. */
  let backstage: OfficeEditor | null = null;
  let visible = false;
  /** Files being opened, so a double click doesn't open one twice. */
  const opening = new Set<string>();
  /** Each editor's AutoRecover id and the version last kept. */
  const recovery = new Map<OfficeEditor, { id: string; kept: number }>();
  /** Snapshots a CorePro that didn't close cleanly left behind. */
  let recovered: Recovered[] = [];

  const toast = (text: string) => showToast(text, undefined, 3200);

  // ---- rail

  const railButton = (id: HubView, glyph: IconName, title: string, label?: string) =>
    h("button", { class: `of-rail-btn${id === "doc" || id === "sheet" || id === "pdf" ? ` tone-${id}` : ""}`, type: "button", title, "aria-label": title, onclick: () => showHub(id) },
      icon(glyph, 20), label ? h("span", { class: "of-rail-label" }, label) : null);
  const hubButtons: [HubView, HTMLButtonElement][] = [
    ["home", railButton("home", "home", "Home")],
    ["new", railButton("new", "plus", "New (Ctrl+N)")],
    ["open", railButton("open", "open", "Open (Ctrl+O)")],
    ["doc", railButton("doc", "docFile", "Docs")],
    ["sheet", railButton("sheet", "sheetFile", "Sheets")],
    ["pdf", railButton("pdf", "pdfFile", "PDF")],
  ];
  const files = h("div", { class: "of-rail-files" });
  const rail = h("nav", { class: "of-rail", "aria-label": "Office" },
    ...hubButtons.slice(0, 3).map(([, b]) => b), h("div", { class: "of-rail-sep" }),
    ...hubButtons.slice(3).map(([, b]) => b), h("div", { class: "of-rail-sep" }), files);

  function drawRail() {
    for (const [id, button] of hubButtons) button.classList.toggle("active", !current && id === view);
    files.replaceChildren(...editors.map((ed) => {
      const b = h("button", {
        class: `of-rail-btn tone-${ed.kind}${ed === current ? " active" : ""}`, type: "button",
        title: `${ed.title()}${ed.dirty() ? " (edited)" : ""}${ed.path() ? `\n${ed.path()}` : ""}`, "aria-label": ed.title(),
        onclick: () => showEditor(ed),
        onauxclick: (e: MouseEvent) => e.button === 1 && void closeEditor(ed),
      }, icon(KIND_ICON[ed.kind], 19), ed.dirty() ? h("span", { class: "of-rail-dot" }) : null);
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          { label: "Save", icon: "save", shortcut: "Ctrl+S", action: () => void ed.save() },
          { label: "Save As…", icon: "saveAs", shortcut: "Ctrl+Shift+S", action: () => void ed.save(true) },
          ...(ed.path() ? [{ label: "Show in Files", icon: "folder" as IconName, action: () => showInFiles(ed.path()!) }] : []),
          "separator",
          { label: "Close", icon: "close", shortcut: "Ctrl+W", action: () => void closeEditor(ed) },
        ]);
      });
      return b;
    }));
  }

  // ---- hub

  const search = h("input", { class: "search-input", type: "search", placeholder: "Search recent files", "aria-label": "Search recent files", spellcheck: "false" });
  search.addEventListener("input", () => drawHub());
  const hubBody = h("div", { class: "of-hub-body" });
  const hub = h("div", { class: "of-hub" }, h("div", { class: "of-hub-head" }, h("span", { class: "spacer" }), h("label", { class: "search of-search" }, icon("search", 15), search)), hubBody);
  const editorHost = h("div", { class: "of-editors of-editor" });
  const main = h("div", { class: "of-main" }, hub, editorHost);
  const el = h("section", { class: "office" }, rail, main);

  const hubHost: HubHost = {
    recent: () => settings().recent,
    pinned: () => settings().pinned,
    newFile: (kind, template) => void newFile(kind, template),
    open: (path) => void openPath(path),
    browse: (kind, folder) => void browse(kind, folder),
    togglePin(path) {
      const pinned = settings().pinned;
      settings().pinned = pinned.includes(path) ? pinned.filter((p) => p !== path) : [path, ...pinned];
      shell.saveConfig();
      drawHub();
    },
    forget(path) {
      settings().recent = settings().recent.filter((p) => p !== path);
      settings().pinned = settings().pinned.filter((p) => p !== path);
      shell.saveConfig();
      drawHub();
    },
    showInFiles,
    openInWindow: (path) => openWindow("office", path),
  };

  /** Home's "Recovered" list: files CorePro was editing when it last stopped without saving them. */
  function recoveredList(): HTMLElement | null {
    if (view !== "home" || !recovered.length) return null;
    return h("div", { class: "of-recovered" },
      h("div", { class: "of-hub-head" }, icon("undo", 16), h("h2", null, "Recovered"), h("span", { class: "of-recovered-hint" }, "CorePro closed before these were saved.")),
      h("div", { class: "of-recent" }, ...recovered.map((r) => h("div", { class: `of-recent-row tone-${r.kind}`, title: r.path ?? "Never saved" },
        h("span", { class: "of-kind" }, icon(KIND_ICON[r.kind], 15)),
        h("span", { class: "of-recent-name" }, r.name),
        h("span", { class: "of-recent-path" }, r.path ? r.path.replace(/^\/home\/[^/]+/, "~") : "Not saved yet"),
        h("span", { class: "of-recent-when" }, new Date(r.saved).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })),
        h("span", { class: "of-recovered-actions" },
          h("button", { class: "btn small primary", type: "button", onclick: () => void openRecovered(r) }, "Open"),
          h("button", { class: "icon-btn small", type: "button", title: "Delete this copy", "aria-label": "Delete this copy", onclick: () => void forgetRecovered(r.id) }, icon("trash", 14)))))));
  }

  async function openRecovered(r: Recovered) {
    try {
      const factory = await LOADERS[r.kind]();
      const file: RecoveredFile = { bytes: await officeApi.recovery.read(r.id), name: r.name, path: r.path };
      const editor = await add((host) => factory(host, null, undefined, file));
      // The new editor keeps the same snapshot until it's saved or closed.
      recovery.set(editor, { id: r.id, kept: -1 });
      recovered = recovered.filter((x) => x.id !== r.id);
    } catch (err) {
      toast(`Couldn’t recover “${r.name}”: ${errorText(err)}`);
    }
  }

  async function forgetRecovered(id: string) {
    await officeApi.recovery.remove(id).catch(() => undefined);
    recovered = recovered.filter((x) => x.id !== id);
    drawHub();
  }

  /** Keeps a snapshot of every unsaved file that changed since the last one, and drops those saved. */
  async function autoRecover() {
    for (const ed of editors) {
      if (!ed.snapshot) continue;
      const kept = recovery.get(ed);
      if (!ed.dirty()) {
        if (kept) {
          recovery.delete(ed);
          await officeApi.recovery.remove(kept.id).catch(() => undefined);
        }
        continue;
      }
      const snap = ed.snapshot();
      if (kept && kept.kept === snap.version) continue;
      const id = kept?.id ?? `${ed.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await officeApi.recovery.save({ id, kind: ed.kind, path: ed.path(), name: ed.title() }, snap.bytes);
        recovery.set(ed, { id, kept: snap.version });
      } catch (err) {
        console.warn("AutoRecover failed:", err);
      }
    }
  }
  const recoverTimer = window.setInterval(() => void autoRecover(), RECOVER_EVERY_MS);
  void officeApi.recovery.list().then((list) => {
    recovered = list;
    if (!current) drawHub();
  }, () => undefined);

  function drawHub() {
    const ed = backstage && editors.includes(backstage) ? backstage : null;
    const strip = ed
      ? h("div", { class: `of-backstage tone-${ed.kind}` },
        h("button", { class: "btn", type: "button", onclick: () => showEditor(ed) }, icon("back", 15), `Back to ${ed.title()}`),
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => void ed.save().then((ok) => ok && showEditor(ed)) }, icon("save", 15), "Save"),
        h("button", { class: "btn", type: "button", onclick: () => void ed.save(true).then((ok) => ok && showEditor(ed)) }, icon("saveAs", 15), "Save As"),
        ed.print ? h("button", { class: "btn", type: "button", onclick: () => (showEditor(ed), ed.print!()) }, icon("print", 15), "Print") : null,
        ed.path() ? h("button", { class: "btn", type: "button", onclick: () => showInFiles(ed.path()!) }, icon("folder", 15), "Show in Files") : null,
        h("button", { class: "btn", type: "button", onclick: () => void closeEditor(ed) }, icon("close", 15), "Close"))
      : null;
    const rescued = recoveredList();
    hubBody.replaceChildren(...(strip ? [strip] : []), ...(rescued ? [rescued] : []), ...renderHub(view, hubHost, search.value));
  }

  function showInFiles(path: string) {
    shell.open({ kind: "folder", path: dirname(path) });
  }

  function remember(path: string) {
    settings().recent = [path, ...settings().recent.filter((p) => p !== path)].slice(0, RECENT_MAX);
    shell.saveConfig();
  }

  // ---- showing things

  function showHub(next: HubView, from: OfficeEditor | null = null) {
    backstage = from;
    if (current) current.deactivate();
    current = null;
    view = next;
    hub.hidden = false;
    editorHost.hidden = true;
    for (const ed of editors) ed.el.hidden = true;
    drawHub();
    drawRail();
    retitle();
  }

  function showEditor(ed: OfficeEditor) {
    if (current && current !== ed) current.deactivate();
    current = ed;
    hub.hidden = true;
    editorHost.hidden = false;
    for (const other of editors) other.el.hidden = other !== ed;
    drawRail();
    retitle();
    if (visible) ed.activate();
  }

  /** A window of its own carries the file's name, as Word's and Excel's do. */
  function retitle() {
    if (isMainWindow) return;
    const title = current ? `${current.title()}${current.dirty() ? " •" : ""} — Office` : "Office — CorePro";
    void getCurrentWindow().setTitle(title).catch(() => undefined);
  }

  function hostFor(get: () => OfficeEditor | null): EditorHost {
    return {
      shell,
      changed: () => (drawRail(), retitle()),
      showHub: (v) => showHub(v ?? "home", get()),
      remember,
      toast,
      close: () => {
        const ed = get();
        if (ed) void closeEditor(ed, false);
      },
    };
  }

  async function add(make: (host: EditorHost) => Promise<OfficeEditor>) {
    let made: OfficeEditor | null = null;
    const editor = await make(hostFor(() => made));
    made = editor;
    editor.el.hidden = true;
    editorHost.append(editor.el);
    editors.push(editor);
    showEditor(editor);
    return editor;
  }

  async function newFile(kind: OfficeKind, template = "blank") {
    try {
      const factory = await LOADERS[kind]();
      await add((host) => factory(host, null, template));
    } catch (err) {
      if ((err as Error)?.name !== "Cancelled") toast(`Couldn’t start a new ${KIND_NOUN[kind]}: ${errorText(err)}`);
    }
  }

  async function openPath(path: string) {
    const already = editors.find((e) => e.path() === path);
    if (already) return showEditor(already);
    const kind = kindOf(path);
    if (!kind) return toast("Office opens Word and Excel files, CSV and text.");
    if (opening.has(path)) return;
    opening.add(path);
    try {
      const factory = await LOADERS[kind]();
      await add((host) => factory(host, { path }));
      remember(path);
    } catch (err) {
      // A protected PDF whose password the user didn't give.
      if ((err as Error)?.name !== "Cancelled") toast(errorText(err));
    } finally {
      opening.delete(path);
    }
  }

  async function browse(kind?: OfficeKind, folder?: "documents" | "desktop" | "downloads") {
    const paths = await pickFiles(kind, folder).catch(() => []);
    for (const path of paths) await openPath(path);
  }

  /** Closes a file, asking about unsaved changes first (unless the editor already did). */
  async function closeEditor(ed: OfficeEditor, ask = true): Promise<boolean> {
    if (ask && ed.dirty()) {
      if (current !== ed) showEditor(ed);
      const answer = await askSave(ed.title());
      if (answer === "cancel") return false;
      if (answer === "save" && !(await ed.save())) return false;
    }
    const index = editors.indexOf(ed);
    if (index < 0) return true;
    editors.splice(index, 1);
    // Closed on purpose (saved, or "Don't Save"): its AutoRecover copy goes.
    const kept = recovery.get(ed);
    if (kept) {
      recovery.delete(ed);
      void officeApi.recovery.remove(kept.id).catch(() => undefined);
    }
    ed.deactivate();
    ed.dispose();
    ed.el.remove();
    if (current === ed) {
      current = null;
      const next = editors[index] ?? editors[index - 1];
      if (next) showEditor(next);
      else showHub(view);
    } else drawRail();
    return true;
  }

  /** What Ctrl+N makes: the kind of file or Home page showing. */
  function newKind(): OfficeKind {
    return current?.kind ?? (view === "sheet" || view === "pdf" ? view : "doc");
  }

  // Ctrl+N is a new file of the kind showing, as in Word and Excel, not a new CorePro window
  // (that stays on the rail button's right-click).
  el.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "n") return;
    e.preventDefault();
    e.stopPropagation();
    void newFile(newKind());
  }, true);

  showHub("home");

  // Closing the window with unsaved files asks about each, as Word and Excel do. A second ×
  // while that runs is the same request.
  let closing = false;
  const unlistenClose = getCurrentWindow().onCloseRequested(async (event) => {
    if (closing) return event.preventDefault();
    const unsaved = editors.filter((ed) => ed.dirty());
    if (!unsaved.length) return;
    event.preventDefault();
    closing = true;
    try {
      shell.showModule("office");
      for (const ed of unsaved) if (!(await closeEditor(ed))) return;
    } finally {
      closing = false;
    }
    await getCurrentWindow().destroy();
  });

  const module: AppModule = {
    id: "office",
    title: "Office",
    icon: "office",
    el,
    ownsNewKey: true,
    activate() {
      visible = true;
      if (current) current.activate();
      else drawHub();
    },
    deactivate() {
      visible = false;
      current?.deactivate();
    },
    handleKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "o") {
        void browse();
        return true;
      }
      // Ctrl+N while the focus is outside Office (the listener on `el` catches it inside).
      if (mod && key === "n" && !e.shiftKey && !e.altKey) {
        void newFile(newKind());
        return true;
      }
      if (current) {
        if (mod && key === "w") {
          void closeEditor(current);
          return true;
        }
        if (mod && key === "s") {
          void current.save(e.shiftKey);
          return true;
        }
        return current.handleKey(e);
      }
      if (mod && key === "f") {
        search.focus();
        return true;
      }
      return false;
    },
    open(request) {
      if (request.kind === "office") void openPath(request.path);
    },
    windowPath: () => current?.path() ?? null,
    dispose() {
      clearInterval(recoverTimer);
      void unlistenClose.then((fn) => fn());
      for (const ed of editors) ed.dispose();
      el.remove();
    },
  };
  return module;
};
