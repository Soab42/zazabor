import { Editor, type JSONContent } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";
import { documentDir, join } from "@tauri-apps/api/path";
import { open } from "../../../shared/dialog";
import { basename, h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { openMenu, type MenuItem } from "../../../ui/menu";
import { errorText } from "../../time/api";
import { extensionOf, officeApi, pickSavePath, safeLink, stem } from "../api";
import type { EditorFactory, OfficeEditor } from "../editor";
import { Ribbon, titleBar } from "../ribbon";
import { askSave, guardDialog, linkDialog, paragraphDialog, wordCountDialog } from "./dialogs";
import { findState } from "./find";
import { PageView } from "./page";
import { defaultPage, readDocx, readHtml, readMarkdown, readText, type PageSetup } from "./read";
import { extensions, type Hooks } from "./schema";
import { buildTabs, type DocsContext } from "./tabs";
import { templateHtml } from "./templates";
import { writeDocx, writeHtml, writeMarkdown } from "./write";
import "./docs.css";
import { layoutPictures } from "./picture";

type Format = "docx" | "html" | "txt" | "md";

const FORMATS: Record<Format, { name: string; extension: string }> = {
  docx: { name: "Word Document", extension: "docx" },
  html: { name: "Web Page", extension: "html" },
  txt: { name: "Plain Text", extension: "txt" },
  md: { name: "Markdown", extension: "md" },
};

function formatOf(path: string): Format {
  const ext = extensionOf(path);
  return ext === "htm" || ext === "html" ? "html" : ext === "txt" ? "txt" : ext === "md" || ext === "markdown" ? "md" : "docx";
}

/** "Document 1", "Document 2"… for new documents, as Word names them until they're saved. */
let untitled = 0;

/** The CSS of a page, for the web page Save As writes (docs.css's document part). */
const PAGE_CSS = `
.dc-content { font-family: Calibri, Carlito, "Liberation Sans", Arial, sans-serif; font-size: 11pt; line-height: 1.3; color: #000; }
.dc-content p { margin: 0 0 8pt; }
.dc-content h1, .dc-content h2, .dc-content h3, .dc-content h4 { font-family: "Calibri Light", Carlito, "Liberation Sans", sans-serif; font-weight: normal; color: #2f5496; margin: 12pt 0 0; }
.dc-content h1 { font-size: 16pt; } .dc-content h2 { font-size: 13pt; margin-top: 2pt; } .dc-content h3 { font-size: 12pt; color: #1f3763; margin-top: 2pt; }
.dc-content .ds-title { font-family: "Calibri Light", Carlito, sans-serif; font-size: 28pt; line-height: 1.2; margin: 0; letter-spacing: -0.5pt; }
.dc-content .ds-subtitle { color: #5a5a5a; letter-spacing: 0.75pt; }
.dc-content .ds-quote, .dc-content blockquote { font-style: italic; color: #404040; text-align: center; margin: 10pt 43pt 8pt; }
.dc-content table { border-collapse: collapse; width: 100%; margin: 0 0 8pt; } .dc-content td, .dc-content th { border: 0.5pt solid #000; padding: 0 5.4pt; vertical-align: top; } .dc-content td p, .dc-content th p { margin: 0; }
.dc-content img { max-width: 100%; height: auto; } .dc-content a { color: #0563c1; }
.dc-content pre { font-family: "Liberation Mono", monospace; font-size: 10pt; background: #f3f3f3; padding: 6pt 8pt; white-space: pre-wrap; }
`;

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/**
 * Docs: a Word-like word processor. The title bar (Save, Undo, Redo), the ribbon (Home, Insert,
 * Layout, Review, View, and Table while in a table), the page, and the status bar (page, words,
 * layout and zoom). Opens and saves .docx; also web pages, plain text and Markdown.
 */
/** What AutoRecover keeps of a document: enough to reopen it as it was. */
interface Snapshot {
  json: JSONContent;
  page: PageSetup;
  lost: string[];
  format: Format;
}

export const createDocEditor: EditorFactory = async (host, file, template, recovered) => {
  let path = recovered ? recovered.path : file?.path ?? null;
  let format: Format = path ? formatOf(path) : "docx";
  let page = defaultPage();
  let html = "";
  /** Parts of the original Word file Docs doesn't keep; saving over it asks first. */
  let lost: string[] = [];
  const original = path;
  /** An AutoRecover snapshot (see `snapshot` below): the document as Tiptap JSON. */
  let rescued: Snapshot | null = null;
  if (recovered) {
    rescued = JSON.parse(new TextDecoder().decode(recovered.bytes)) as Snapshot;
    page = rescued.page;
    lost = rescued.lost;
    format = rescued.format;
  } else if (path) {
    const bytes = await officeApi.read(path).catch((err) => {
      throw new Error(`Couldn’t open ${basename(path!)}: ${errorText(err)}`);
    });
    const text = () => new TextDecoder().decode(bytes);
    if (format === "docx") {
      const imported = await readDocx(bytes).catch((err) => {
        throw new Error(`Couldn’t read ${basename(path!)}: ${errorText(err)}`);
      });
      html = imported.html;
      page = imported.page;
      lost = imported.warnings;
    } else if (format === "md") html = readMarkdown(text());
    else if (format === "html") html = readHtml(text());
    else html = readText(text());
  } else {
    html = templateHtml(template ?? "blank");
  }
  const name = recovered ? recovered.name : path ? null : `Document ${++untitled}`;

  /** Bumped by every edit, for AutoRecover. */
  let version = 0;
  let spelling = false;
  let plainNext = false;
  /** A redraw is waiting for the next frame; the last unsaved state the section heard of. */
  let queued = false;
  let wasDirty = false;
  let painter: { marks: readonly Mark[]; attrs: Record<string, unknown>; align: string | null } | null = null;

  const hooks: Hooks = {
    save: (as) => void save(as),
    find: (replace) => showFind(replace),
    link: () => linkDialog(editor),
    print: () => print(),
    close: () => void close(),
    openHub: () => host.showHub("open"),
    plainPaste: () => (plainNext = true),
  };

  const view = new PageView(page, () => schedule());
  const editor = new Editor({
    element: view.content,
    extensions: extensions(hooks),
    content: rescued ? rescued.json : html,
    editorProps: {
      attributes: () => ({ class: "dc-pm", spellcheck: String(spelling), "aria-label": "Document" }),
      handlePaste: (_view, event) => {
        if (!plainNext) return false;
        plainNext = false;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        editor.chain().focus().insertContent(text.split(/\r?\n/).map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] }))).run();
        return true;
      },
      handleClick: (_view, _pos, event) => {
        const link = (event.target as HTMLElement).closest("a");
        if (link && (event.ctrlKey || event.metaKey)) {
          openLink(link.getAttribute("href") ?? "");
          return true;
        }
        return false;
      },
    },
    onTransaction: ({ transaction }) => {
      if (transaction.docChanged) {
        version++;
        view.measureSoon();
      }
      schedule();
    },
  });
  // Let the schema's own fixes run first (a trailing paragraph after a table or code block), so a
  // file just opened doesn't count as edited.
  editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
  // A recovered document isn't saved anywhere yet: it counts as edited against an empty one.
  let savedDoc = rescued ? editor.schema.topNodeType.createAndFill()! : editor.state.doc;
  let savedPage = JSON.stringify(page);
  const dirty = () => !editor.state.doc.eq(savedDoc) || JSON.stringify(view.setup) !== savedPage;

  // ---- chrome

  const tb = titleBar({
    tone: "doc",
    save: () => void save(false),
    undo: () => editor.chain().focus().undo().run(),
    redo: () => editor.chain().focus().redo().run(),
    canUndo: () => editor.can().undo(),
    canRedo: () => editor.can().redo(),
  });
  tb.el.append(h("div", { class: "of-titlebar-end" },
    h("button", { class: "icon-btn small", type: "button", title: "Print (Ctrl+P)", "aria-label": "Print", onclick: () => print() }, icon("print", 15)),
    h("button", { class: "icon-btn small", type: "button", title: "Save As… (Ctrl+Shift+S)", "aria-label": "Save As", onclick: () => void save(true) }, icon("saveAs", 15))));
  const ribbon = new Ribbon({ tone: "doc", onFile: () => host.showHub() });

  const ctx: DocsContext = {
    editor,
    view,
    setPage: (next: PageSetup) => {
      view.setPage(next);
      schedule();
    },
    painter: {
      active: () => !!painter,
      start: () => {
        if (painter) return stopPainter();
        const $from = editor.state.selection.$from;
        painter = { marks: editor.state.storedMarks ?? $from.marks(), attrs: { ...$from.parent.attrs }, align: ($from.parent.attrs.textAlign as string) ?? null };
        root.classList.add("dc-painting");
        host.toast("Select the text to paint the formatting on (Esc to stop)");
        schedule();
      },
    },
    marks: {
      on: () => view.content.classList.contains("dc-marks"),
      toggle: () => (view.content.classList.toggle("dc-marks"), schedule()),
    },
    spelling: {
      on: () => spelling,
      toggle: () => {
        spelling = !spelling;
        editor.view.dom.setAttribute("spellcheck", String(spelling));
        schedule();
      },
    },
    find: (replace) => showFind(replace),
    insertPicture: () => void insertPicture(),
    paste: (plain) => void paste(plain),
    wordCount: () => wordCountDialog(editor, view.pageCount),
  };
  buildTabs(ribbon, ctx);

  // ---- find & replace

  const findInput = h("input", { class: "search-input", type: "search", placeholder: "Find in document", "aria-label": "Find", spellcheck: "false" });
  const replaceInput = h("input", { class: "tt-input dc-replace-input", type: "text", placeholder: "Replace with", "aria-label": "Replace with", spellcheck: "false" });
  const count = h("span", { class: "dc-find-count" });
  const matchCase = h("button", { class: "icon-btn small dc-find-opt", type: "button", title: "Match case", "aria-label": "Match case" }, h("span", { class: "rb-glyph sans small" }, "Aa"));
  const wholeWord = h("button", { class: "icon-btn small dc-find-opt", type: "button", title: "Whole words only", "aria-label": "Whole words only" }, h("span", { class: "rb-glyph sans small" }, "ab"));
  const replaceRow = h("div", { class: "dc-find-row" }, replaceInput,
    h("button", { class: "btn small", type: "button", onclick: () => editor.chain().replaceCurrent(replaceInput.value).findNext().run() }, "Replace"),
    h("button", { class: "btn small", type: "button", onclick: () => {
      const n = findState(editor.state)?.matches.length ?? 0;
      editor.commands.replaceAll(replaceInput.value);
      host.toast(n ? `Replaced ${n} ${n === 1 ? "match" : "matches"}` : "Nothing to replace");
    } }, "Replace All"));
  const findbar = h("div", { class: "dc-findbar glass-strong", role: "search" },
    h("div", { class: "dc-find-row" },
      h("label", { class: "search dc-find-field" }, icon("search", 14), findInput, count),
      matchCase, wholeWord,
      h("button", { class: "icon-btn small", type: "button", title: "Previous (Shift+Enter)", "aria-label": "Previous match", onclick: () => editor.commands.findPrevious() }, icon("chevronUp", 14)),
      h("button", { class: "icon-btn small", type: "button", title: "Next (Enter)", "aria-label": "Next match", onclick: () => editor.commands.findNext() }, icon("chevronDown", 14)),
      h("button", { class: "icon-btn small", type: "button", title: "Close (Esc)", "aria-label": "Close", onclick: () => hideFind() }, icon("close", 14))),
    replaceRow);
  findbar.hidden = true;
  const search = () => editor.commands.setSearch(findInput.value, { caseSensitive: matchCase.classList.contains("active"), wholeWord: wholeWord.classList.contains("active") });
  for (const opt of [matchCase, wholeWord]) opt.addEventListener("click", () => (opt.classList.toggle("active"), search()));
  findInput.addEventListener("input", () => search());
  for (const input of [findInput, replaceInput]) {
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        if (input === replaceInput) editor.chain().replaceCurrent(replaceInput.value).findNext().run();
        else if (e.shiftKey) editor.commands.findPrevious();
        else editor.commands.findNext();
      } else if (e.key === "Escape") {
        e.preventDefault();
        hideFind();
      }
    });
  }

  function showFind(replace: boolean) {
    findbar.hidden = false;
    replaceRow.hidden = !replace;
    const { from, to } = editor.state.selection;
    const selected = editor.state.doc.textBetween(from, to, " ");
    if (selected && selected.length < 100 && !selected.includes("\n")) findInput.value = selected;
    search();
    findInput.focus();
    findInput.select();
  }

  function hideFind() {
    findbar.hidden = true;
    editor.commands.clearSearch();
    editor.commands.focus();
  }

  // ---- status bar

  const pageText = h("button", { class: "dc-status-btn", type: "button", title: "Word Count", onclick: () => wordCountDialog(editor, view.pageCount) });
  const wordsText = h("button", { class: "dc-status-btn", type: "button", title: "Word Count", onclick: () => wordCountDialog(editor, view.pageCount) });
  const zoomRange = h("input", { type: "range", min: "10", max: "500", step: "5", "aria-label": "Zoom" });
  zoomRange.addEventListener("input", () => view.setZoom(Number(zoomRange.value) / 100));
  const zoomValue = h("button", { class: "of-zoom-value dc-status-btn", type: "button", title: "Zoom to 100%", onclick: () => view.setZoom(1) });
  const layoutPrint = h("button", { class: "icon-btn small", type: "button", title: "Print Layout", "aria-label": "Print Layout", onclick: () => view.setLayout("print") }, icon("docFile", 14));
  const layoutWeb = h("button", { class: "icon-btn small", type: "button", title: "Web Layout", "aria-label": "Web Layout", onclick: () => view.setLayout("web") }, icon("desktop", 14));
  const status = h("div", { class: "of-status" }, pageText, wordsText, h("span", { class: "spacer" }), layoutPrint, layoutWeb,
    h("div", { class: "of-zoom" },
      h("button", { type: "button", title: "Zoom Out", "aria-label": "Zoom Out", onclick: () => view.setZoom(view.zoom - 0.1) }, "−"),
      zoomRange,
      h("button", { type: "button", title: "Zoom In", "aria-label": "Zoom In", onclick: () => view.setZoom(view.zoom + 0.1) }, "+"),
      zoomValue));

  const body = h("div", { class: "dc-body" }, view.el, findbar);
  const root = h("div", { class: "of-editor tone-doc dc-editor" }, tb.el, ribbon.el, body, status);

  // ---- updates

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  }

  function draw() {
    ribbon.refresh();
    const isDirty = dirty();
    tb.set(title(), isDirty, path);
    if (isDirty !== wasDirty) {
      wasDirty = isDirty;
      host.changed();
    }
    const storage = (editor.storage as unknown as Record<string, { words: () => number }>).characterCount;
    const words = storage.words();
    let current = 1;
    try {
      current = view.pageAt(editor.view.coordsAtPos(editor.state.selection.head).top);
    } catch {
      // Not laid out yet.
    }
    pageText.textContent = `Page ${Math.min(current, view.pageCount)} of ${view.pageCount}`;
    wordsText.textContent = `${words.toLocaleString()} ${words === 1 ? "word" : "words"}`;
    zoomRange.value = String(Math.round(view.zoom * 100));
    zoomValue.textContent = `${Math.round(view.zoom * 100)}%`;
    layoutPrint.classList.toggle("active", view.layout === "print");
    layoutWeb.classList.toggle("active", view.layout === "web");
    const found = findState(editor.state);
    count.textContent = found?.query ? (found.matches.length ? `${found.current + 1} of ${found.matches.length}` : "No results") : "";
  }

  function title(): string {
    return path ? basename(path) : name!;
  }

  // ---- format painter

  function stopPainter() {
    painter = null;
    root.classList.remove("dc-painting");
    schedule();
  }

  view.content.addEventListener("mouseup", () => {
    if (!painter) return;
    // Let the selection settle first: a double or triple click's selection reaches the editor
    // through selectionchange, after the mouse is up.
    setTimeout(() => {
      const p = painter;
      if (!p || editor.state.selection.empty) return;
      const chain = editor.chain().focus().unsetAllMarks();
      for (const mark of p.marks) chain.setMark(mark.type.name, mark.attrs);
      chain.setParagraphFormat({ lineHeight: p.attrs.lineHeight as number | null, spaceBefore: p.attrs.spaceBefore as number | null, spaceAfter: p.attrs.spaceAfter as number | null, indent: p.attrs.indent as number | null, firstLine: p.attrs.firstLine as number | null });
      if (p.align) chain.setTextAlign(p.align);
      chain.run();
      stopPainter();
    }, 150);
  });

  // ---- clipboard, pictures, print

  async function paste(plain: boolean) {
    editor.commands.focus();
    try {
      if (!plain && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes("text/html")) {
            editor.commands.insertContent(await (await item.getType("text/html")).text());
            return;
          }
        }
      }
      const text = await navigator.clipboard.readText();
      editor.commands.insertContent(text.split(/\r?\n/).map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })));
    } catch {
      host.toast(plain ? "Press Ctrl+Shift+V to paste text only" : "Press Ctrl+V to paste");
    }
  }

  async function insertPicture() {
    const picked = await open({ title: "Insert Pictures", multiple: true, filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg"] }] }).catch(() => null);
    const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
    const m = view.setup.margins;
    const room = ((view.setup.orientation === "landscape" ? view.setup.height : view.setup.width) - m.left - m.right) * (4 / 3);
    for (const p of paths) {
      try {
        const bytes = await officeApi.read(p);
        const ext = extensionOf(p);
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : `image/${ext}`;
        const src = `data:${mime};base64,${base64(bytes)}`;
        const natural = await new Promise<number>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth);
          img.onerror = () => resolve(0);
          img.src = src;
        });
        editor.chain().focus().setImage({ src, alt: stem(p), ...(natural > room ? { width: Math.round(room) } : {}) }).run();
      } catch (err) {
        host.toast(`Couldn’t insert ${basename(p)}: ${errorText(err)}`);
      }
    }
  }

  /** Opens a link from the document: only web and mail addresses (a link must never start a program). */
  function openLink(href: string) {
    const url = safeLink(href);
    if (url) host.shell.openExternally(url);
    else host.toast("This link isn't a web or email address, so it isn't opened.");
  }

  /** Prints the document alone (the system's print dialog can also save a PDF). */
  function print() {
    const { width, height, orientation, margins: m } = view.setup;
    const [w, hgt] = orientation === "landscape" ? [height, width] : [width, height];
    // WebKitGTK prints with GTK's own page margins and ignores @page's, so the document's margins
    // are padding on the printed content, repeated on every page.
    const sheet = h("style", null, `@page { size: ${w}pt ${hgt}pt; margin: 0; }
#dc-print-root { padding: ${m.top}pt ${m.right}pt ${m.bottom}pt ${m.left}pt; -webkit-box-decoration-break: clone; box-decoration-break: clone; }`);
    const area = h("div", { id: "dc-print-root", class: "dc-content" });
    area.innerHTML = editor.getHTML();
    layoutPictures(area);
    document.body.append(sheet, area);
    const done = () => {
      sheet.remove();
      area.remove();
    };
    window.addEventListener("afterprint", done, { once: true });
    setTimeout(() => {
      window.print();
      // WebKit may not send afterprint; the print dialog is modal, so this runs after it.
      setTimeout(done, 1000);
    }, 50);
  }

  /** File → Print's preview: the document on paper of its page size, inside its margins. */
  function printPreview() {
    const { width, height, orientation, margins: m } = view.setup;
    const [w, hgt] = orientation === "landscape" ? [height, width] : [width, height];
    const paper = h("div", { class: "of-paper dc-content", style: `width: ${w}pt; min-height: ${hgt}pt; padding: ${m.top}pt ${m.right}pt ${m.bottom}pt ${m.left}pt` });
    paper.innerHTML = editor.getHTML();
    layoutPictures(paper);
    return paper;
  }

  /** File → Info's facts about the document. */
  function info(): [string, string][] {
    const count = (editor.storage as unknown as Record<string, { words: () => number; characters: () => number }>).characterCount;
    return [["Pages", view.pageCount.toLocaleString()], ["Words", count.words().toLocaleString()], ["Characters", count.characters().toLocaleString()]];
  }

  // ---- saving

  async function defaultFolder(): Promise<string | null> {
    if (path) return path.replace(/\/[^/]*$/, "");
    return documentDir().catch(() => null);
  }

  async function save(as = false): Promise<boolean> {
    let target = path;
    let fmt = format;
    if (!target || as) {
      const folder = await defaultFolder();
      const base = path ? stem(path) : name!;
      const order: Format[] = [fmt, ...(["docx", "html", "txt", "md"] as Format[]).filter((f) => f !== fmt)];
      const suggested = folder ? await join(folder, `${base}.${FORMATS[order[0]].extension}`) : `${base}.${FORMATS[order[0]].extension}`;
      const chosen = await pickSavePath(suggested, order.map((f) => FORMATS[f]));
      if (!chosen) return false;
      target = chosen;
      fmt = formatOf(chosen);
    } else if (lost.length && target === original && fmt === "docx") {
      const answer = await guardDialog(basename(target), lost);
      if (answer === "cancel") return false;
      if (answer === "copy") {
        const chosen = await pickSavePath(target.replace(/\.docx$/i, " (Docs copy).docx"), [FORMATS.docx]);
        if (!chosen) return false;
        target = chosen;
        fmt = "docx";
      } else lost = [];
    }
    try {
      const content = editor.getHTML();
      let bytes: Uint8Array;
      let notes: string[] = [];
      if (fmt === "docx") {
        const out = await writeDocx(content, view.setup, stem(target));
        bytes = out.bytes;
        notes = out.warnings;
      } else if (fmt === "html") bytes = new TextEncoder().encode(writeHtml(content, stem(target), PAGE_CSS));
      else if (fmt === "md") bytes = new TextEncoder().encode(writeMarkdown(editor.getJSON()));
      else bytes = new TextEncoder().encode(`${editor.getText({ blockSeparator: "\n" })}\n`);
      await officeApi.write(target, bytes);
      path = target;
      format = fmt;
      if (target !== original) lost = [];
      savedDoc = editor.state.doc;
      savedPage = JSON.stringify(view.setup);
      host.remember(target);
      host.changed();
      host.toast(notes.length ? `Saved. ${notes[0]}` : `Saved ${basename(target)}`);
      schedule();
      return true;
    } catch (err) {
      host.toast(`Couldn’t save: ${errorText(err)}`);
      return false;
    }
  }

  async function close() {
    if (dirty()) {
      const answer = await askSave(title());
      if (answer === "cancel") return;
      if (answer === "save" && !(await save())) return;
    }
    host.close();
  }

  // ---- keys and menus

  root.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape" && painter) {
      stopPainter();
      e.stopPropagation();
      return;
    }
    if (ribbon.handleKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Word's line spacing keys, rather than the shell's section switching.
    if (mod && !e.shiftKey && !e.altKey && ["1", "2", "5"].includes(e.key) && editor.isFocused) {
      editor.chain().focus().setParagraphFormat({ lineHeight: e.key === "1" ? 1 : e.key === "2" ? 2 : 1.5 }).run();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Whatever the document's own keymap took (Ctrl+L, Ctrl+K…) stays here.
    if (e.defaultPrevented && editor.isFocused) e.stopPropagation();
  });

  view.content.addEventListener("mousedown", () => ribbon.settle());
  // A click on the page below the text, or on the desk around it, puts the cursor at the end of
  // the document, as in Word (not on the scroll bars).
  view.el.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || view.content.contains(e.target as Node)) return;
    const desk = view.el;
    if (e.target === desk && (e.offsetX >= desk.clientWidth || e.offsetY >= desk.clientHeight)) return;
    e.preventDefault();
    ribbon.settle();
    editor.commands.focus("end");
  });
  view.content.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const inTable = editor.isActive("table");
    const link = editor.isActive("link");
    const items: MenuItem[] = [
      { label: "Cut", icon: "cut", shortcut: "Ctrl+X", action: () => (editor.commands.focus(), document.execCommand("cut")), disabled: editor.state.selection.empty },
      { label: "Copy", icon: "copy", shortcut: "Ctrl+C", action: () => (editor.commands.focus(), document.execCommand("copy")), disabled: editor.state.selection.empty },
      { label: "Paste", icon: "paste", shortcut: "Ctrl+V", action: () => void paste(false) },
      { label: "Paste Text Only", icon: "docFile", shortcut: "Ctrl+Shift+V", action: () => void paste(true) },
      "separator",
      ...(link
        ? [
          { label: "Edit Link…", icon: "link", action: () => linkDialog(editor) } as MenuItem,
          { label: "Open Link", icon: "external", action: () => openLink(String(editor.getAttributes("link").href ?? "")) } as MenuItem,
          { label: "Remove Link", icon: "close", action: () => editor.chain().focus().extendMarkRange("link").unsetLink().run() } as MenuItem,
        ]
        : [{ label: "Link…", icon: "link", shortcut: "Ctrl+K", action: () => linkDialog(editor) } as MenuItem]),
      { label: "Paragraph…", icon: "lineSpacing", action: () => paragraphDialog(editor) },
      ...(inTable
        ? [
          "separator" as const,
          { label: "Insert Row Above", icon: "rowInsert", action: () => editor.chain().focus().addRowBefore().run() } as MenuItem,
          { label: "Insert Row Below", icon: "rowInsert", action: () => editor.chain().focus().addRowAfter().run() } as MenuItem,
          { label: "Insert Column Left", icon: "colInsert", action: () => editor.chain().focus().addColumnBefore().run() } as MenuItem,
          { label: "Insert Column Right", icon: "colInsert", action: () => editor.chain().focus().addColumnAfter().run() } as MenuItem,
          { label: "Merge Cells", icon: "merge", action: () => editor.chain().focus().mergeCells().run(), disabled: !editor.can().mergeCells() } as MenuItem,
          { label: "Split Cell", icon: "columns", action: () => editor.chain().focus().splitCell().run(), disabled: !editor.can().splitCell() } as MenuItem,
          { label: "Delete Row", icon: "rowDelete", action: () => editor.chain().focus().deleteRow().run() } as MenuItem,
          { label: "Delete Column", icon: "colDelete", action: () => editor.chain().focus().deleteColumn().run() } as MenuItem,
          { label: "Delete Table", icon: "trash", danger: true, action: () => editor.chain().focus().deleteTable().run() } as MenuItem,
        ]
        : []),
      "separator",
      { label: "Select All", icon: "checkSquare", shortcut: "Ctrl+A", action: () => editor.chain().focus().selectAll().run() },
    ];
    openMenu(e.clientX, e.clientY, items);
  });

  draw();

  const doc: OfficeEditor = {
    kind: "doc",
    el: root,
    title,
    path: () => path,
    dirty,
    save,
    print,
    printPreview,
    info,
    snapshot: () => {
      const snap: Snapshot = { json: editor.getJSON(), page: view.setup, lost, format };
      return { bytes: new TextEncoder().encode(JSON.stringify(snap)), version: version + (JSON.stringify(view.setup) !== savedPage ? 1 : 0) };
    },
    activate() {
      view.measureSoon();
      schedule();
      requestAnimationFrame(() => {
        if (findbar.hidden || !findbar.contains(document.activeElement)) editor.commands.focus();
      });
    },
    deactivate() {
      if (painter) stopPainter();
    },
    handleKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ribbon.handleKey(e)) return true;
      if (mod && key === "f") return showFind(false), true;
      if (mod && key === "h") return showFind(true), true;
      if (mod && key === "p") return print(), true;
      if (mod && key === "z") return editor.chain().focus().undo().run(), true;
      if (mod && key === "y") return editor.chain().focus().redo().run(), true;
      return false;
    },
    dispose() {
      editor.destroy();
    },
  };
  return doc;
};
