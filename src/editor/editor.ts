import { invoke } from "@tauri-apps/api/core";
import { fsApi, type FsEntry } from "../modules/files/api";
import { categoryOf, iconNameFor, iconNode } from "../modules/files/kinds";
import { compareNames } from "../modules/files/sort";
import { readText } from "../shared/quicklook/api";
import { basename, dirname, h } from "../ui/dom";
import { icon } from "../ui/icons";
import { openMenu, type MenuItem } from "../ui/menu";
import { TerminalTabs } from "../terminal/tabs";
import { isTerminalTarget } from "../terminal/target";
import { changeMark, gitApi, type GitFile, type GitStatus } from "./git-api";
import { lineChanges } from "./linediff";
import { applyTheme, languageFor, languageName, monaco } from "./monaco";
import { SourceControl } from "./scm";
import "./editor.css";

/** Files larger than this open read-only in the preview instead (the editor holds them in memory). */
const MAX_EDIT_BYTES = 24 * 1024 * 1024;
/** Folders the explorer and quick open leave out. */
const SKIP = new Set(["node_modules", ".git", "target", "dist", "build", ".cache", "__pycache__"]);
/** Quick open (Ctrl+P) lists at most this many files. */
const QUICK_OPEN_LIMIT = 6000;
/** Source control status is re-read this often while the window is in front. */
const GIT_EVERY_MS = 10_000;
const PANEL_HEIGHT = 260;

export interface EditorHost {
  /** A file the editor doesn't show (an image, a video…): open it elsewhere. */
  openOther(entry: FsEntry): void;
  /** The window's title follows the active file. */
  setTitle(text: string): void;
}

interface Doc {
  path: string;
  model: monaco.editor.ITextModel;
  /** The model's version when last saved: anything else is unsaved. */
  savedVersion: number;
  view: monaco.editor.ICodeEditorViewState | null;
  tab: HTMLElement;
  /** The file's text at the last commit, for the gutter's change bars (null: new file / no repo). */
  base?: string | null;
  /** A diff tab: the old side, and the new side's model (the file's own when editable). */
  diff?: { original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel; source: Doc | null; label: string };
}

type Choice = "save" | "discard" | "cancel";

/**
 * A VS Code–style editor for one folder: the Explorer tree on the left, tabs, Monaco in the middle
 * and a status bar. Text files open in tabs and save with Ctrl+S; Ctrl+P finds files by name.
 */
export class CodeEditor {
  readonly el: HTMLElement;
  private readonly tree = h("div", { class: "ce-tree", role: "tree" });
  private readonly tabs = h("div", { class: "ce-tabs", role: "tablist" });
  private readonly crumbs = h("div", { class: "ce-crumbs" });
  private readonly host = h("div", { class: "ce-monaco" });
  private readonly diffHost = h("div", { class: "ce-monaco", hidden: true });
  private readonly explorerView: HTMLElement;
  private readonly scm: SourceControl;
  private readonly terminals: TerminalTabs;
  private readonly panel = h("section", { class: "ce-panel", hidden: true });
  private readonly activityButtons = new Map<"explorer" | "scm", HTMLElement>();
  private readonly scmBadge = h("span", { class: "ce-badge", hidden: true });
  private readonly branchItem = h("button", { class: "ce-status-item ce-branch", type: "button", title: "Checkout Branch", hidden: true });
  private readonly syncItem = h("button", { class: "ce-status-item", type: "button", title: "Synchronize Changes (pull, then push)", hidden: true });
  private readonly terminalItem = h("button", { class: "ce-status-item", type: "button", title: "Toggle Terminal (Ctrl+`)" }, icon("terminal", 13), "Terminal");
  private diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
  private readonly gutter: monaco.editor.IEditorDecorationsCollection;
  private gutterTimer = 0;
  private git: GitStatus | null = null;
  /** Git changes by absolute path, and folders that contain one, for the Explorer's colours. */
  private gitMarks = new Map<string, string>();
  private gitDirs = new Set<string>();
  private panelHeight = PANEL_HEIGHT;
  private readonly empty = h("div", { class: "ce-empty" }, icon("fileCode", 40), h("p", null, "Open a file from the Explorer, or press Ctrl+P."));
  private readonly status = {
    position: h("button", { class: "ce-status-item", type: "button", title: "Go to Line (Ctrl+G)" }),
    indent: h("button", { class: "ce-status-item", type: "button", title: "Indentation" }),
    encoding: h("span", { class: "ce-status-item" }, "UTF-8"),
    eol: h("button", { class: "ce-status-item", type: "button", title: "Line endings" }),
    language: h("button", { class: "ce-status-item", type: "button", title: "Language mode" }),
    note: h("span", { class: "ce-status-note" }),
  };
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly docs: Doc[] = [];
  private active: Doc | null = null;
  private readonly expanded = new Set<string>();
  private noteTimer = 0;

  constructor(private readonly root: string, private readonly opts: EditorHost) {
    this.explorerView = h("div", { class: "ce-view" },
      h("div", { class: "ce-explorer-head" },
        h("span", { class: "ce-explorer-title", title: root }, basename(root) || root),
        h("button", { class: "icon-btn small", type: "button", title: "Refresh", onclick: () => void this.renderTree() }, icon("refresh", 14)),
        h("button", { class: "icon-btn small", type: "button", title: "Collapse Folders", onclick: () => {
          this.expanded.clear();
          void this.renderTree();
        } }, icon("chevronUp", 14))),
      this.tree);
    this.scm = new SourceControl({
      folder: root,
      openDiff: (repo, file, staged) => void this.openDiff(repo, file, staged),
      openFile: (path) => void this.open(path),
      statusChanged: (status) => this.gitChanged(status),
      note: (text) => this.note(text),
      ask: (title, text, confirm) => this.confirm(title, text, confirm),
    });
    this.scm.el.hidden = true;
    this.scm.onBadge((count) => {
      this.scmBadge.hidden = count === 0;
      this.scmBadge.textContent = count > 99 ? "99+" : String(count);
    });
    const sidebar = h("aside", { class: "ce-explorer" }, this.explorerView, this.scm.el);
    const activity = h("nav", { class: "ce-activity", "aria-label": "Views" },
      this.activityButton("explorer", "files", "Explorer (Ctrl+Shift+E)"),
      this.activityButton("scm", "branch", "Source Control (Ctrl+Shift+G)", this.scmBadge),
      h("span", { class: "spacer" }),
      h("button", { class: "ce-activity-btn", type: "button", title: "Toggle Terminal (Ctrl+`)", onclick: () => this.toggleTerminal() }, icon("terminal", 20)));

    this.terminals = new TerminalTabs({
      cwd: () => this.root,
      actions: [h("button", { class: "icon-btn small", type: "button", title: "Hide Panel (Ctrl+`)", onclick: () => this.toggleTerminal(false) }, icon("close", 14))],
      onEmpty: () => this.toggleTerminal(false),
    });
    const resizer = h("div", { class: "ce-panel-resizer", title: "Drag to resize" });
    resizer.addEventListener("pointerdown", (e) => this.resizePanel(e, resizer));
    this.panel.append(resizer, this.terminals.el);

    const statusBar = h("footer", { class: "ce-status" },
      this.branchItem, this.syncItem, this.status.note, h("span", { class: "spacer" }),
      this.status.position, this.status.indent, this.status.encoding, this.status.eol, this.status.language, this.terminalItem);
    const main = h("section", { class: "ce-main" }, this.tabs, this.crumbs, h("div", { class: "ce-body" }, this.host, this.diffHost, this.empty), this.panel);
    this.el = h("div", { class: "ce" }, h("div", { class: "ce-row" }, activity, sidebar, main), statusBar);

    this.editor = monaco.editor.create(this.host, {
      theme: applyTheme(),
      automaticLayout: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono") || "monospace",
      fontSize: 13,
      fontLigatures: true,
      minimap: { enabled: true },
      smoothScrolling: true,
      cursorSmoothCaretAnimation: "on",
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: "active", indentation: true },
      stickyScroll: { enabled: true },
      padding: { top: 8 },
      scrollBeyondLastLine: false,
      model: null,
    });
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.save());
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => void this.quickOpen());
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => this.active && void this.close(this.active));
    this.editor.onDidChangeCursorPosition(() => this.paintStatus());
    this.editor.onDidChangeModelContent(() => {
      this.paintDirty();
      this.scheduleGutter();
    });
    this.gutter = this.editor.createDecorationsCollection();

    this.status.position.addEventListener("click", () => {
      this.editor.focus();
      this.editor.trigger("status", "editor.action.gotoLine", null);
    });
    this.status.indent.addEventListener("click", (e) => this.indentMenu(e));
    this.status.eol.addEventListener("click", () => this.toggleEol());
    this.status.language.addEventListener("click", (e) => this.languageMenu(e));
    this.branchItem.addEventListener("click", (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      void this.scm.branchMenu(r.left, r.top - 8);
    });
    this.syncItem.addEventListener("click", () => void this.scm.sync());
    this.terminalItem.addEventListener("click", () => this.toggleTerminal());
    window.addEventListener("keydown", (e) => this.onKey(e), true);
    // Source control follows changes made elsewhere (a terminal, another program).
    window.addEventListener("focus", () => void this.scm.refresh());
    window.setInterval(() => {
      if (document.visibilityState === "visible") void this.scm.refresh();
    }, GIT_EVERY_MS);
    this.showView("explorer");
    void this.renderTree();
    void this.scm.refresh();
    this.paintStatus();
  }

  // ---- views and panel -----------------------------------------------------------------------

  private activityButton(view: "explorer" | "scm", name: Parameters<typeof icon>[0], title: string, badge?: HTMLElement) {
    const button = h("button", { class: "ce-activity-btn", type: "button", title, onclick: () => this.showView(view) }, icon(name, 20), badge ?? null);
    this.activityButtons.set(view, button);
    return button;
  }

  private showView(view: "explorer" | "scm") {
    this.explorerView.hidden = view !== "explorer";
    this.scm.el.hidden = view !== "scm";
    for (const [id, button] of this.activityButtons) button.classList.toggle("active", id === view);
    if (view === "scm") void this.scm.refresh();
  }

  /** Shows or hides the terminal panel (starting a terminal the first time). */
  toggleTerminal(show: boolean = this.panel.hidden !== false) {
    this.panel.hidden = !show;
    this.panel.style.height = `${this.panelHeight}px`;
    this.terminalItem.classList.toggle("active", show);
    if (show) void this.terminals.show();
    else {
      this.terminals.hide();
      this.currentEditor()?.focus();
    }
  }

  private resizePanel(e: PointerEvent, handle: HTMLElement) {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const start = this.panelHeight;
    const max = Math.max(120, this.el.clientHeight - 160);
    const move = (ev: PointerEvent) => {
      this.panelHeight = Math.min(max, Math.max(100, start + startY - ev.clientY));
      this.panel.style.height = `${this.panelHeight}px`;
      this.terminals.fit();
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  /** The editor that has the active tab: the code editor, or the new side of a diff. */
  private currentEditor(): monaco.editor.ICodeEditor | null {
    if (!this.active) return null;
    return this.active.diff ? this.diffEditor?.getModifiedEditor() ?? null : this.editor;
  }

  // ---- source control ------------------------------------------------------------------------

  private gitChanged(status: GitStatus | null) {
    const before = this.git?.root;
    this.git = status;
    this.gitMarks = new Map();
    this.gitDirs = new Set();
    if (status) {
      for (const f of status.files) {
        const abs = `${status.root}/${f.path}`;
        const letter = f.index === "?" || f.index === "U" ? f.index : f.work !== "." ? f.work : f.index;
        this.gitMarks.set(abs, changeMark(letter).kind);
        for (let dir = dirname(abs); dir.length > status.root.length; dir = dirname(dir)) this.gitDirs.add(dir);
      }
    }
    this.branchItem.hidden = !status;
    this.syncItem.hidden = !status;
    if (status) {
      this.branchItem.replaceChildren(icon("branch", 13), status.branch || `(${status.commit})`);
      const sync = status.upstream ? `${status.behind ? ` ${status.behind}↓` : ""}${status.ahead ? ` ${status.ahead}↑` : ""}` : "";
      this.syncItem.replaceChildren(icon(status.upstream ? "sync" : "arrowUp", 13), sync.trim() || (status.upstream ? "" : "Publish"));
      this.syncItem.title = status.upstream ? `Synchronize with ${status.upstream} (pull, then push)` : "Publish Branch (push to origin)";
    }
    this.paintTreeMarks();
    // Commits change what the gutter compares with.
    if (status?.root !== before || status) for (const doc of this.docs) if (!doc.diff) doc.base = undefined;
    this.scheduleGutter(0);
  }

  private relativeToRepo(path: string): string | null {
    const root = this.git?.root;
    return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
  }

  /** Marks changed lines in the gutter against the last commit (debounced while typing). */
  private scheduleGutter(delay = 300) {
    clearTimeout(this.gutterTimer);
    this.gutterTimer = window.setTimeout(() => void this.paintGutter(), delay);
  }

  private async paintGutter() {
    const doc = this.active;
    if (!doc || doc.diff) return;
    const rel = this.relativeToRepo(doc.path);
    if (!rel || !this.git) {
      this.gutter.clear();
      return;
    }
    if (doc.base === undefined) doc.base = await gitApi.show(this.git.root, `HEAD:${rel}`).catch(() => null);
    if (this.active !== doc) return;
    const text = doc.model.getValue(monaco.editor.EndOfLinePreference.LF);
    const base = (doc.base ?? "").replace(/\r\n/g, "\n");
    const changes = doc.base === null && !this.gitMarks.has(doc.path) ? [] : lineChanges(base, text);
    this.gutter.set(changes.map((c) => ({
      range: new monaco.Range(Math.max(1, c.start), 1, Math.max(1, c.end), 1),
      options: { isWholeLine: true, linesDecorationsClassName: `ce-gutter-${c.kind}`, overviewRuler: { color: c.kind === "added" ? "#4caf7a" : c.kind === "deleted" ? "#e5534b" : "#4f8fe0", position: monaco.editor.OverviewRulerLane.Left } },
    })));
  }

  /** Opens a changed file as a diff: the working tree against what's staged (or the last commit),
   *  or for staged changes, what's staged against the last commit. */
  private async openDiff(root: string, file: GitFile, staged: boolean) {
    const abs = `${root}/${file.path}`;
    const label = `${basename(file.path)} (${staged ? "Index" : "Working Tree"})`;
    const existing = this.docs.find((d) => d.diff?.label === label && d.path === abs);
    if (existing) return this.activate(existing);
    const show = (spec: string) => gitApi.show(root, spec).catch(() => null);
    const headPath = file.from ?? file.path;
    let original: string;
    let modified: monaco.editor.ITextModel;
    let source: Doc | null = null;
    const language = languageFor(basename(file.path));
    if (staged) {
      original = (await show(`HEAD:${headPath}`)) ?? "";
      modified = monaco.editor.createModel((await show(`:${file.path}`)) ?? "", language);
    } else {
      original = (await show(`:${file.path}`)) ?? (await show(`HEAD:${headPath}`)) ?? "";
      // The new side is the file itself, editable and saved like any tab.
      await this.open(abs, false);
      source = this.docs.find((d) => d.path === abs && !d.diff) ?? null;
      if (!source) return;
      modified = source.model;
    }
    const doc: Doc = {
      path: abs, model: modified, savedVersion: modified.getAlternativeVersionId(), view: null, tab: this.tabFor(abs, label),
      diff: { original: monaco.editor.createModel(original, language), modified, source, label },
    };
    this.docs.push(doc);
    this.tabs.append(doc.tab);
    this.activate(doc);
  }

  private ensureDiffEditor(): monaco.editor.IStandaloneDiffEditor {
    this.diffEditor ??= monaco.editor.createDiffEditor(this.diffHost, {
      automaticLayout: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono") || "monospace",
      fontSize: 13,
      originalEditable: false,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
    });
    return this.diffEditor;
  }

  // ---- Explorer colours ----------------------------------------------------------------------

  private paintTreeMarks() {
    for (const row of this.tree.querySelectorAll<HTMLElement>(".ce-node")) this.markRow(row, row.dataset.path ?? "");
  }

  private markRow(row: HTMLElement, path: string) {
    const kind = this.gitMarks.get(path);
    row.dataset.git = kind ?? (this.gitDirs.has(path) ? "contains" : "");
  }

  /** Unsaved changes in any tab. */
  get dirty(): boolean {
    return this.docs.some((d) => this.isDirty(d));
  }

  private isDirty(doc: Doc) {
    return !doc.diff && doc.model.getAlternativeVersionId() !== doc.savedVersion;
  }

  /** The theme changed (light/dark, accent). */
  themeChanged() {
    monaco.editor.setTheme(applyTheme());
    this.terminals.themeChanged();
  }

  // ---- files ---------------------------------------------------------------------------------

  /** Opens a file in a tab (or switches to it). Files that aren't text open elsewhere. */
  async open(path: string, show = true) {
    const existing = this.docs.find((d) => d.path === path && !d.diff);
    if (existing) return show ? this.activate(existing) : undefined;
    const text = await readText(path, MAX_EDIT_BYTES).catch((err) => {
      this.note(`Couldn’t open ${basename(path)}: ${err}`);
      return null;
    });
    if (!text) return;
    if (text.binary) return this.note(`${basename(path)} isn’t a text file.`);
    if (text.truncated) return this.note(`${basename(path)} is too large to edit here.`);
    const uri = monaco.Uri.file(path);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text.text, languageFor(basename(path)), uri);
    if (text.text.includes("\r\n")) model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
    const doc: Doc = { path, model, savedVersion: model.getAlternativeVersionId(), view: null, tab: this.tabFor(path) };
    this.docs.push(doc);
    this.tabs.append(doc.tab);
    if (show) this.activate(doc);
  }

  private activate(doc: Doc) {
    if (this.active && this.active !== doc && !this.active.diff) this.active.view = this.editor.saveViewState();
    this.active = doc;
    if (doc.diff) {
      const diff = this.ensureDiffEditor();
      diff.setModel({ original: doc.diff.original, modified: doc.diff.modified });
      // A staged diff shows git's copy, which isn't edited here.
      diff.getModifiedEditor().updateOptions({ readOnly: !doc.diff.source });
      this.host.hidden = true;
      this.diffHost.hidden = false;
      diff.getModifiedEditor().focus();
    } else {
      this.editor.setModel(doc.model);
      if (doc.view) this.editor.restoreViewState(doc.view);
      this.diffHost.hidden = true;
      this.host.hidden = false;
      this.editor.focus();
    }
    for (const d of this.docs) d.tab.classList.toggle("active", d === doc);
    doc.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.empty.hidden = true;
    this.paintCrumbs();
    this.paintStatus();
    this.reveal(doc.path);
    this.scheduleGutter(0);
  }

  /** Unfolds the Explorer down to a file and highlights it, as VS Code does for the active file. */
  private reveal(path: string) {
    let added = false;
    for (let folder = dirname(path); folder.startsWith(`${this.root}/`); folder = dirname(folder)) {
      if (!this.expanded.has(folder)) {
        this.expanded.add(folder);
        added = true;
      }
    }
    if (added) void this.renderTree();
    else this.paintTreeSelection();
  }

  private tabFor(path: string, label = basename(path)): HTMLElement {
    const close = h("button", { class: "ce-tab-close", type: "button", title: "Close (Ctrl+W)", tabIndex: -1 }, icon("close", 12));
    const tab = h("div", { class: `ce-tab${label !== basename(path) ? " diff" : ""}`, role: "tab", title: path },
      label !== basename(path) ? icon("columns", 14) : iconNode(iconNameFor(categoryOf({ dir: false, ext: extOf(path) })), 14),
      h("span", { class: "ce-tab-name" }, label), close);
    const doc = () => this.docs.find((d) => d.tab === tab);
    tab.addEventListener("click", () => {
      const d = doc();
      if (d) this.activate(d);
    });
    tab.addEventListener("auxclick", (e) => {
      const d = doc();
      if (e.button === 1 && d) void this.close(d);
    });
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      const d = doc();
      if (d) void this.close(d);
    });
    return tab;
  }

  /** Saves the active tab (or `doc`); a diff tab saves its file. */
  async save(doc = this.active): Promise<boolean> {
    if (doc?.diff) doc = doc.diff.source;
    if (!doc) return false;
    const text = doc.model.getValue(monaco.editor.EndOfLinePreference.TextDefined);
    const version = doc.model.getAlternativeVersionId();
    try {
      await invoke<number>("fs_write_text", { path: doc.path, text });
    } catch (err) {
      this.note(String(err));
      return false;
    }
    doc.savedVersion = version;
    this.paintDirty();
    this.note(`Saved ${basename(doc.path)}`);
    void this.scm.refresh();
    return true;
  }

  /** Saves every tab with changes; false if one couldn't be saved. */
  async saveAll(): Promise<boolean> {
    for (const doc of this.docs) if (this.isDirty(doc) && !(await this.save(doc))) return false;
    return true;
  }

  /** Closes a tab, asking about unsaved changes. Closing a file closes its diffs too. */
  async close(doc: Doc): Promise<boolean> {
    if (doc.diff) return this.closeDiff(doc);
    if (this.isDirty(doc)) {
      const choice = await this.ask(`Save the changes to ${basename(doc.path)}?`, "Your changes will be lost if you don’t save them.");
      if (choice === "cancel") return false;
      if (choice === "save" && !(await this.save(doc))) return false;
    }
    for (const diff of this.docs.filter((d) => d.diff?.source === doc)) await this.closeDiff(diff);
    this.removeTab(doc);
    doc.model.dispose();
    return true;
  }

  private async closeDiff(doc: Doc): Promise<boolean> {
    // The diff editor must let go of the models before they're disposed.
    if (this.active === doc) this.diffEditor?.setModel(null);
    this.removeTab(doc);
    doc.diff?.original.dispose();
    if (!doc.diff?.source) doc.model.dispose();
    return true;
  }

  private removeTab(doc: Doc) {
    const index = this.docs.indexOf(doc);
    if (index < 0) return;
    this.docs.splice(index, 1);
    doc.tab.remove();
    if (this.active !== doc) return;
    this.active = null;
    const next = this.docs[Math.min(index, this.docs.length - 1)];
    if (next) this.activate(next);
    else {
      this.editor.setModel(null);
      this.host.hidden = true;
      this.diffHost.hidden = true;
      this.empty.hidden = false;
      this.gutter.clear();
      this.paintCrumbs();
      this.paintStatus();
    }
  }

  /** Before the window closes: true when it may (changes saved or let go). */
  async confirmClose(): Promise<boolean> {
    const dirty = this.docs.filter((d) => this.isDirty(d));
    if (dirty.length === 0) return true;
    const what = dirty.length === 1 ? basename(dirty[0].path) : `${dirty.length} files`;
    const choice = await this.ask(`Save the changes to ${what}?`, "Your changes will be lost if you don’t save them.");
    if (choice === "cancel") return false;
    return choice === "discard" || this.saveAll();
  }

  // ---- explorer ------------------------------------------------------------------------------

  private async renderTree() {
    const rows = await this.rows(this.root, 0);
    this.tree.replaceChildren(...rows);
    this.paintTreeSelection();
  }

  private async rows(folder: string, depth: number): Promise<HTMLElement[]> {
    const entries = await fsApi.list(folder, false).catch(() => [] as FsEntry[]);
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || compareNames(a.name, b.name));
    const out: HTMLElement[] = [];
    for (const entry of entries) {
      if (entry.dir && SKIP.has(entry.name)) continue;
      const open = entry.dir && this.expanded.has(entry.path);
      const twisty = h("span", { class: `ce-twisty${entry.dir ? "" : " leaf"}` }, entry.dir ? icon(open ? "chevronDown" : "chevronRight", 12) : null);
      const glyph = entry.dir ? icon("folder", 15) : iconNode(iconNameFor(categoryOf(entry)), 15);
      const row = h("div", { class: `ce-node${entry.dir ? " dir" : ""}`, role: "treeitem", "data-path": entry.path, title: entry.path, style: { paddingLeft: `${8 + depth * 14}px` } },
        twisty, glyph, h("span", { class: "ce-node-name" }, entry.name));
      row.addEventListener("click", () => void this.pick(entry));
      this.markRow(row, entry.path);
      out.push(row);
      if (open) out.push(...(await this.rows(entry.path, depth + 1)));
    }
    return out;
  }

  private async pick(entry: FsEntry) {
    if (entry.dir) {
      if (!this.expanded.delete(entry.path)) this.expanded.add(entry.path);
      await this.renderTree();
      return;
    }
    const category = categoryOf(entry);
    if (category === "image" || category === "video" || category === "audio" || category === "archive" || entry.ext === "pdf" || entry.url) {
      this.opts.openOther(entry);
      return;
    }
    await this.open(entry.path);
  }

  private paintTreeSelection() {
    for (const row of this.tree.querySelectorAll<HTMLElement>(".ce-node")) {
      row.classList.toggle("active", row.dataset.path === this.active?.path);
    }
  }

  // ---- quick open (Ctrl+P) -------------------------------------------------------------------

  private async quickOpen() {
    if (document.querySelector(".ce-palette")) return;
    const input = h("input", { class: "ce-palette-input", type: "text", placeholder: "Search files by name", spellcheck: false });
    const list = h("div", { class: "ce-palette-list" });
    const box = h("div", { class: "ce-palette", role: "dialog", "aria-label": "Go to File" }, input, list);
    const scrim = h("div", { class: "ce-scrim" }, box);
    document.body.append(scrim);
    input.focus();
    const files = await this.allFiles();
    let shown: string[] = [];
    let index = 0;
    // Opening a file focuses the editor itself; only closing empty-handed hands focus back here.
    const done = (refocus = true) => {
      scrim.remove();
      if (refocus) this.editor.focus();
    };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      shown = (q ? files.filter((p) => fuzzy(relative(this.root, p).toLowerCase(), q)) : files).slice(0, 60);
      index = Math.min(index, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.map((p, i) => {
        const item = h("div", { class: `ce-palette-item${i === index ? " active" : ""}` },
          iconNode(iconNameFor(categoryOf({ dir: false, ext: extOf(p) })), 15),
          h("span", { class: "ce-palette-name" }, basename(p)),
          h("span", { class: "ce-palette-dir" }, relative(this.root, dirname(p))));
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          done(false);
          void this.open(p);
        });
        return item;
      }));
    };
    input.addEventListener("input", () => {
      index = 0;
      render();
    });
    input.addEventListener("keydown", (e) => {
      // The key must not go on to the editor once the palette closes (Enter would type a newline).
      if (e.key === "Escape") {
        e.preventDefault();
        done();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        index = Math.max(0, Math.min(shown.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)));
        render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const path = shown[index];
        done(!path);
        if (path) void this.open(path);
      }
    });
    scrim.addEventListener("mousedown", (e) => {
      if (e.target === scrim) done();
    });
    render();
  }

  /** Every file below the root (skipping build and dependency folders), for quick open. */
  private async allFiles(): Promise<string[]> {
    const out: string[] = [];
    const queue = [this.root];
    while (queue.length && out.length < QUICK_OPEN_LIMIT) {
      const folder = queue.shift()!;
      const entries = await fsApi.list(folder, false).catch(() => [] as FsEntry[]);
      for (const e of entries) {
        if (e.dir) {
          if (!SKIP.has(e.name)) queue.push(e.path);
        } else out.push(e.path);
      }
    }
    return out.sort((a, b) => compareNames(relative(this.root, a), relative(this.root, b)));
  }

  // ---- status bar and menus ------------------------------------------------------------------

  private paintCrumbs() {
    const doc = this.active;
    if (!doc) {
      this.crumbs.replaceChildren();
      return;
    }
    const parts = relative(this.root, doc.path).split("/");
    this.crumbs.replaceChildren(...parts.flatMap((part, i) => [
      ...(i > 0 ? [h("span", { class: "ce-crumb-sep" }, icon("chevronRight", 11))] : []),
      h("span", { class: "ce-crumb" }, part),
    ]));
  }

  private paintStatus() {
    const doc = this.active;
    for (const item of [this.status.position, this.status.indent, this.status.encoding, this.status.eol, this.status.language]) item.hidden = !doc;
    if (!doc) {
      this.opts.setTitle("Editor");
      return;
    }
    const pos = this.editor.getPosition();
    const selected = this.editor.getSelections()?.reduce((n, s) => n + doc.model.getValueInRange(s).length, 0) ?? 0;
    this.status.position.textContent = `Ln ${pos?.lineNumber ?? 1}, Col ${pos?.column ?? 1}${selected ? ` (${selected} selected)` : ""}`;
    const o = doc.model.getOptions();
    this.status.indent.textContent = o.insertSpaces ? `Spaces: ${o.indentSize}` : `Tab Size: ${o.tabSize}`;
    this.status.eol.textContent = doc.model.getEOL() === "\r\n" ? "CRLF" : "LF";
    this.status.language.textContent = languageName(doc.model.getLanguageId());
    this.paintDirty();
  }

  private paintDirty() {
    for (const doc of this.docs) doc.tab.classList.toggle("dirty", this.isDirty(doc));
    const doc = this.active;
    if (doc) this.opts.setTitle(`${this.isDirty(doc) ? "● " : ""}${basename(doc.path)} — ${basename(this.root)}`);
  }

  private note(text: string) {
    clearTimeout(this.noteTimer);
    this.status.note.textContent = text;
    this.noteTimer = window.setTimeout(() => (this.status.note.textContent = ""), 4000);
  }

  private indentMenu(e: MouseEvent) {
    const doc = this.active;
    if (!doc) return;
    const set = (insertSpaces: boolean, size: number) => {
      doc.model.updateOptions({ insertSpaces, tabSize: size, indentSize: size });
      this.paintStatus();
    };
    const items: MenuItem[] = [
      ...[2, 4, 8].map((n) => ({ label: `Indent with ${n} Spaces`, action: () => set(true, n) })),
      "separator",
      ...[2, 4, 8].map((n) => ({ label: `Indent with Tabs (size ${n})`, action: () => set(false, n) })),
      "separator",
      { label: "Detect from Content", action: () => {
        doc.model.detectIndentation(true, 4);
        this.paintStatus();
      } },
    ];
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.top - 8, items);
  }

  private toggleEol() {
    const doc = this.active;
    if (!doc) return;
    doc.model.pushEOL(doc.model.getEOL() === "\r\n" ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF);
    this.paintStatus();
  }

  private languageMenu(e: MouseEvent) {
    const doc = this.active;
    if (!doc) return;
    const langs = monaco.languages.getLanguages()
      .map((l) => ({ id: l.id, name: l.aliases?.[0] ?? l.id }))
      .sort((a, b) => compareNames(a.name, b.name));
    const items: MenuItem[] = langs.map((l) => ({
      label: l.name, icon: l.id === doc.model.getLanguageId() ? "check" : undefined,
      action: () => {
        monaco.editor.setModelLanguage(doc.model, l.id);
        this.paintStatus();
      },
    }));
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.top - 8, items);
  }

  private onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const key = e.key.toLowerCase();
    const inTerminal = isTerminalTarget(e.target);
    // Handled here, the key mustn't also reach the terminal or Monaco.
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.code === "Backquote") {
      take();
      if (e.shiftKey) {
        this.toggleTerminal(true);
        void this.terminals.add();
      } else if (this.panel.hidden !== false) this.toggleTerminal(true);
      // Shown: from the terminal it hides the panel, from elsewhere it goes to the terminal (VS Code).
      else if (inTerminal) this.toggleTerminal(false);
      else this.terminals.focus();
    } else if (e.shiftKey && key === "e") {
      take();
      this.showView("explorer");
    } else if (e.shiftKey && key === "g") {
      take();
      this.showView("scm");
    } else if (inTerminal) {
      // Ctrl+Shift+T / W and Ctrl+PageUp / PageDown manage the terminals; other keys are the shell's.
      if (this.terminals.handleKey(e)) take();
      else if (key === "p" && !e.shiftKey) {
        take();
        void this.quickOpen();
      }
    } else if (key === "s" && !e.shiftKey && !this.editor.hasTextFocus()) {
      take();
      void this.save();
    } else if (key === "p" && !e.shiftKey && !this.editor.hasTextFocus()) {
      take();
      void this.quickOpen();
    } else if (e.key === "Tab" && this.docs.length > 1 && this.active) {
      take();
      const i = this.docs.indexOf(this.active);
      this.activate(this.docs[(i + (e.shiftKey ? -1 : 1) + this.docs.length) % this.docs.length]);
    }
  }

  /** A yes/no sheet (discarding changes, committing everything); resolves true on confirm. */
  private confirm(title: string, text: string, confirm: string): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (ok: boolean) => {
        document.removeEventListener("keydown", onKey, true);
        scrim.remove();
        resolve(ok);
      };
      const yes = h("button", { class: "btn primary", type: "button", onclick: () => finish(true) }, confirm);
      const no = h("button", { class: "btn ghost", type: "button", onclick: () => finish(false) }, "Cancel");
      const scrim = h("div", { class: "ce-scrim" },
        h("div", { class: "ce-dialog", role: "alertdialog", "aria-label": title },
          h("h2", null, title), h("p", null, text), h("div", { class: "ce-dialog-actions" }, h("span", { class: "spacer" }), no, yes)));
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          finish(e.key === "Enter");
        }
      };
      document.addEventListener("keydown", onKey, true);
      document.body.append(scrim);
      yes.focus();
    });
  }

  /** Save / Don't Save / Cancel, as a sheet over the editor. */
  private ask(title: string, text: string): Promise<Choice> {
    return new Promise((resolve) => {
      const finish = (choice: Choice) => {
        document.removeEventListener("keydown", onKey, true);
        scrim.remove();
        resolve(choice);
      };
      const save = h("button", { class: "btn primary", type: "button", onclick: () => finish("save") }, "Save");
      const discard = h("button", { class: "btn", type: "button", onclick: () => finish("discard") }, "Don’t Save");
      const cancel = h("button", { class: "btn ghost", type: "button", onclick: () => finish("cancel") }, "Cancel");
      const scrim = h("div", { class: "ce-scrim" },
        h("div", { class: "ce-dialog", role: "alertdialog", "aria-label": title },
          h("h2", null, title), h("p", null, text), h("div", { class: "ce-dialog-actions" }, discard, h("span", { class: "spacer" }), cancel, save)));
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          finish("cancel");
        } else if (e.key === "Enter") {
          e.preventDefault();
          finish("save");
        }
      };
      document.addEventListener("keydown", onKey, true);
      document.body.append(scrim);
      save.focus();
    });
  }
}

const extOf = (path: string) => {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const relative = (root: string, path: string) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);

/** The query's letters appear in order in the text. */
function fuzzy(text: string, query: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === query[i] && ++i === query.length) return true;
  return query.length === 0;
}
