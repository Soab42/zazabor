import type { PDFDocumentProxy } from "pdfjs-dist";
import { documentDir, join } from "@tauri-apps/api/path";
import { open } from "../../../shared/dialog";
import { basename, h, isTypingTarget } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import { openMenu } from "../../../ui/menu";
import { fsApi } from "../../files/api";
import { errorText } from "../../time/api";
import { Cancelled, extensionOf, officeApi, pickSavePath, safeLink, stem } from "../api";
import type { EditorFactory, OfficeEditor } from "../editor";
import { Ribbon, titleBar } from "../ribbon";
import { extractDialog, goToDialog, passwordDialog, propertiesDialog, splitDialog } from "./dialogs";
import { build, loadEngine, openError, openPdf, paper, type Engine, type Slot, type Source } from "./engine";
import { finish } from "./bytes";
import { Organizer } from "./organize";
import { printPdf } from "./print";
import { markImage, signatureDialog, signatureMenu, type Ink } from "./signatures";
import { buildTabs, type NavId, type PdfCtx } from "./tabs";
import { lazyThumbs, Thumbs } from "./thumbs";
import "./pdf.css";

/**
 * PDF: an Acrobat-like reader and editor on pdf.js. Read (zoom, page layouts, find, bookmarks,
 * links), comment (highlight, text boxes, drawing, pictures), fill forms and sign with a picture
 * of a signature, and organize pages (move, rotate, delete, insert, extract, split). Saving
 * writes comments and form values into the file as pdf.js does (an incremental update); page
 * changes build a new file (see engine.ts).
 */

/** "Combined 1", "Pictures 1"… for new PDFs, until they're saved. */
let untitled = 0;

const PICTURES = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", bmp: "image/bmp", gif: "image/gif" };

/** pdf.js draws note icons from these; it's given a made-up folder and the pictures are swapped in. */
const ICON_PREFIX = "pdfjs-annotation-icons/";
const NOTE_ICONS = import.meta.glob("/node_modules/pdfjs-dist/web/images/annotation-*.svg", { query: "?url", import: "default", eager: true }) as Record<string, string>;

const ZOOM_PRESETS: [string, string][] = [["Automatic", "auto"], ["Fit Width", "page-width"], ["Fit Page", "page-fit"], ["Actual Size", "page-actual"]];
const ZOOM_STEPS = ["50%", "75%", "100%", "125%", "150%", "200%", "300%", "400%"];

/** The parts of pdf.js's editor this file uses (its types don't describe them). */
interface EditorUi {
  getLayer(pageIndex: number): EditorLayer | undefined;
  readonly imageManager: { getFromFile(file: File): Promise<{ id: string } | null> };
  undo(): void;
  redo(): void;
  delete(): void;
  unselectAll(): void;
  updateParams(type: number, value: unknown): void;
  addCommands(params: { cmd: () => void; undo: () => void; mustExec: boolean }): void;
  endCurrentEditing(): void;
}

interface EditorLayer {
  deserialize(data: object): Promise<{ remove(): void } | null>;
  addOrRebuild(editor: unknown): void;
}

interface EditStates {
  isEditing?: boolean;
  hasSomethingToUndo?: boolean;
  hasSomethingToRedo?: boolean;
  hasSelectedEditor?: boolean;
}

/** A page structure change kept for Undo: the file before it, and the page that showed. */
interface Step {
  bytes: Uint8Array;
  password: string | null;
  page: number;
}

function blobOf(bytes: Uint8Array, path: string): Blob {
  return new Blob([bytes as BlobPart], { type: MIME[extensionOf(path)] ?? "application/octet-stream" });
}

/** Asks for files to combine (PDFs and pictures), or pictures only. Rejects with Cancelled. */
async function startFrom(engine: Engine, template: string): Promise<{ bytes: Uint8Array; name: string }> {
  const pictures = template === "images";
  const picked = await open({
    title: pictures ? "Choose Pictures for the PDF" : "Choose Files to Combine",
    multiple: true,
    filters: pictures ? [{ name: "Pictures", extensions: PICTURES }] : [{ name: "PDFs and pictures", extensions: ["pdf", ...PICTURES] }, { name: "PDF files", extensions: ["pdf"] }, { name: "Pictures", extensions: PICTURES }],
  });
  if (!picked?.length) throw new Cancelled();
  const slots: Slot[] = [];
  const opened: PDFDocumentProxy[] = [];
  try {
    for (const path of picked) {
      const bytes = await officeApi.read(path).catch((err) => {
        throw new Error(`Couldn’t read ${basename(path)}: ${errorText(err)}`);
      });
      if (extensionOf(path) !== "pdf") {
        slots.push({ image: blobOf(bytes, path) });
        continue;
      }
      const { doc, password } = await openPdf(engine, bytes, (wrong) => passwordDialog(basename(path), wrong)).catch((err) => {
        if ((err as Error)?.name === "Cancelled") throw new Cancelled();
        throw new Error(`Couldn’t open ${basename(path)}: ${openError(err)}`);
      });
      opened.push(doc);
      const source: Source = { bytes, password };
      for (let i = 0; i < doc.numPages; i++) slots.push({ source, index: i, rotate: (await doc.getPage(i + 1)).rotate });
    }
    const bytes = finish(await build(engine, slots, paper()), []);
    return { bytes, name: `${pictures ? "Pictures" : "Combined"} ${++untitled}` };
  } finally {
    for (const doc of opened) void doc.loadingTask.destroy();
  }
}

export const createPdfEditor: EditorFactory = async (host, file, template, recovered) => {
  const engine = await loadEngine();
  const { lib, viewer: V } = engine;
  const T = lib.AnnotationEditorType;
  const P = lib.AnnotationEditorParamsType;

  let path: string | null = null;
  let name: string;
  let bytes: Uint8Array;
  /** Pages changed, or a new or recovered file: unsaved apart from comments and form values. */
  let changed = false;
  if (recovered) {
    bytes = recovered.bytes;
    path = recovered.path;
    name = recovered.name;
    changed = true;
  } else if (file) {
    path = file.path;
    name = basename(file.path);
    bytes = await officeApi.read(file.path).catch((err) => {
      throw new Error(`Couldn’t open ${name}: ${errorText(err)}`);
    });
  } else {
    ({ bytes, name } = await startFrom(engine, template ?? "combine"));
    changed = true;
  }
  const ask = (wrong: boolean) => passwordDialog(title(), wrong);
  const first = await openPdf(engine, bytes, ask).catch((err) => {
    if ((err as Error)?.name === "Cancelled") throw new Cancelled();
    throw new Error(`Couldn’t open ${name}: ${openError(err)}`);
  });
  let doc = first.doc;
  let password = first.password;
  let thumbs = new Thumbs(doc);

  /** Comments or form values changed since the last save. */
  let modified = false;
  /** Bumped by every change of the pages, for AutoRecover. */
  let version = 0;
  let undoSteps: Step[] = [];
  let redoSteps: Step[] = [];
  let ui: EditorUi | null = null;
  let states: EditStates = {};
  const params = new Map<number, unknown>();
  let tool: "select" | "hand" = "select";
  let nav: NavId | null = "pages";
  let organizing = false;
  let readMode = false;
  let dark = false;
  let fieldsShown = true;
  let busy = false;
  let queued = false;
  let wasDirty = false;
  let disposed = false;
  /** The page to show once a reloaded document's pages are laid out. */
  let restore: { page: number; scale: string } | null = null;
  let attachments: Map<string, { filename: string; content?: Uint8Array | null }> | null = null;
  /** The file's size on disk (Properties). */
  let fileSize = bytes.length;

  const dirty = () => changed || modified;
  function title(): string {
    return path ? basename(path) : name;
  }

  // ---- the viewer

  const viewerEl = h("div", { class: "pdfViewer" });
  const scroller = h("div", { class: "pf-scroll", tabindex: "0" }, viewerEl);
  const eventBus = new V.EventBus();

  /** Links in the document: only web and mail addresses open, in the desktop's browser. */
  class SafeLinks extends V.PDFLinkService {
    override addLinkAttributes(link: HTMLAnchorElement, url: string) {
      const safe = safeLink(url);
      link.href = safe ?? "#";
      link.title = safe ?? `${url} (CorePro doesn't open this kind of link)`;
      link.rel = "noopener noreferrer nofollow";
      link.removeAttribute("target");
      link.onclick = (e) => {
        e.preventDefault();
        if (safe) host.shell.openExternally(safe);
        else host.toast("This link isn't a web or email address, so it isn't opened.");
        return false;
      };
    }
  }
  const links = new SafeLinks({ eventBus });
  const finder = new V.PDFFindController({ eventBus, linkService: links });
  const pdfViewer = new V.PDFViewer({
    container: scroller,
    viewer: viewerEl,
    eventBus,
    linkService: links,
    findController: finder,
    annotationMode: lib.AnnotationMode.ENABLE_FORMS,
    annotationEditorMode: T.NONE,
    annotationEditorHighlightColors: "yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F",
    imageResourcesPath: ICON_PREFIX,
    maxCanvasPixels: 2 ** 25,
  });
  links.setViewer(pdfViewer);
  // Anything else that's a link in the page (an anchor pdf.js made) must not navigate CorePro.
  scroller.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest?.("a[href]");
    if (a && !(a.getAttribute("href") ?? "").startsWith("#")) e.preventDefault();
  });

  const mode = () => pdfViewer.annotationEditorMode as unknown as number;

  eventBus.on("annotationeditoruimanager", ({ uiManager }: { uiManager: EditorUi }) => {
    ui = uiManager;
    states = {};
  });
  eventBus.on("editingstateschanged", ({ details }: { details: EditStates }) => {
    states = { ...details };
    if (nav === "comments") commentsSoon();
    schedule();
  });
  eventBus.on("annotationeditormodechanged", () => {
    root.classList.toggle("pf-annotating", mode() > 0);
    schedule();
  });
  eventBus.on("annotationeditorparamschanged", ({ details }: { details: [number, unknown][] }) => {
    for (const [type, value] of details) params.set(type, value);
    schedule();
  });
  eventBus.on("pagesinit", () => {
    pdfViewer.currentScaleValue = restore?.scale ?? "auto";
    if (restore) pdfViewer.currentPageNumber = Math.min(restore.page, doc.numPages);
    restore = null;
    schedule();
  });
  eventBus.on("pagechanging", () => {
    schedule();
    markThumb();
  });
  eventBus.on("scalechanging", () => schedule());
  eventBus.on("rotationchanging", () => schedule());
  eventBus.on("annotationlayerrendered", () => {
    for (const img of viewerEl.querySelectorAll<HTMLImageElement>(`img[src^="${ICON_PREFIX}"]`)) {
      const file = img.getAttribute("src")!.slice(ICON_PREFIX.length);
      const url = Object.entries(NOTE_ICONS).find(([k]) => k.endsWith(`/${file}`))?.[1] ?? Object.entries(NOTE_ICONS).find(([k]) => k.endsWith("/annotation-note.svg"))?.[1];
      if (url) img.src = url;
    }
  });

  function showDocument(page = 1, scale = "auto") {
    restore = { page, scale };
    // pdf.js clears its own flag whenever it writes the file (AutoRecover's copy, a page change),
    // so only a save here clears ours.
    const storage = doc.annotationStorage as unknown as { onSetModified: (() => void) | null };
    storage.onSetModified = () => {
      modified = true;
      schedule();
    };
    pdfViewer.setDocument(doc);
    links.setDocument(doc, null);
    attachments = null;
    void doc.getAttachments().then((a) => {
      attachments = a?.size ? a : null;
      drawNavStrip();
      schedule();
    }).catch(() => undefined);
    drawNav();
  }

  // ---- the frame

  const tb = titleBar({
    tone: "pdf",
    save: () => void save(false),
    undo: () => undo(),
    redo: () => redo(),
    canUndo: () => !!states.hasSomethingToUndo || undoSteps.length > 0,
    canRedo: () => !!states.hasSomethingToRedo || redoSteps.length > 0,
  });
  tb.el.append(h("div", { class: "of-titlebar-end" },
    h("button", { class: "icon-btn small", type: "button", title: "Print (Ctrl+P)", "aria-label": "Print", onclick: () => print() }, icon("print", 15)),
    h("button", { class: "icon-btn small", type: "button", title: "Save As… (Ctrl+Shift+S)", "aria-label": "Save As", onclick: () => void save(true) }, icon("saveAs", 15))));
  const ribbon = new Ribbon({ tone: "pdf", onFile: () => host.showHub() });

  // The navigation pane: an icon strip and the panel it opens.
  const navStrip = h("div", { class: "pf-nav", role: "tablist", "aria-label": "Navigation pane" });
  const panelTitle = h("span", { class: "pf-panel-title" });
  const panelBody = h("div", { class: "pf-panel-body" });
  const panel = h("div", { class: "pf-panel" },
    h("div", { class: "pf-panel-head" }, panelTitle, h("button", { class: "icon-btn small", type: "button", title: "Close", "aria-label": "Close the pane", onclick: () => setNav(null) }, icon("close", 13))),
    panelBody);
  const thumbList = h("div", { class: "pf-thumbs" });
  const thumbObserver = lazyThumbs(panelBody, () => thumbs);

  const organizer = new Organizer({
    move: (pages, to) => void movePages(pages, to),
    rotate: (pages, delta) => void rotatePages(pages, delta),
    remove: (pages) => void deletePages(pages),
    insert: (at, what) => void insertAt(at, what),
    extract: (pages) => void extract(pages),
    open: (page) => {
      ribbon.select("home");
      setOrganizing(false);
      go(page + 1);
    },
    changed: () => schedule(),
  });

  const findInput = h("input", { class: "search-input", type: "search", placeholder: "Find in document", "aria-label": "Find", spellcheck: "false" });
  const findCount = h("span", { class: "pf-find-count" });
  const matchCase = h("button", { class: "icon-btn small pf-find-opt", type: "button", title: "Match case", "aria-label": "Match case" }, h("span", { class: "rb-glyph sans small" }, "Aa"));
  const wholeWord = h("button", { class: "icon-btn small pf-find-opt", type: "button", title: "Whole words only", "aria-label": "Whole words only" }, h("span", { class: "rb-glyph sans small" }, "ab"));
  const findbar = h("div", { class: "pf-findbar glass-strong", role: "search" },
    h("label", { class: "search pf-find-field" }, icon("search", 14), findInput, findCount),
    matchCase, wholeWord,
    h("button", { class: "icon-btn small", type: "button", title: "Previous (Shift+Enter)", "aria-label": "Previous match", onclick: () => findAgain(true) }, icon("chevronUp", 14)),
    h("button", { class: "icon-btn small", type: "button", title: "Next (Enter)", "aria-label": "Next match", onclick: () => findAgain(false) }, icon("chevronDown", 14)),
    h("button", { class: "icon-btn small", type: "button", title: "Close (Esc)", "aria-label": "Close", onclick: () => hideFind() }, icon("close", 14)));
  findbar.hidden = true;

  const ghost = h("div", { class: "pf-ghost", "aria-hidden": "true" });
  ghost.hidden = true;
  const busyNote = h("div", { class: "pf-busy glass-strong", role: "status" });
  busyNote.hidden = true;
  const readBar = h("div", { class: "pf-readbar glass-strong" },
    h("button", { class: "icon-btn small", type: "button", title: "Previous Page", "aria-label": "Previous Page", onclick: () => go(page() - 1) }, icon("chevronLeft", 15)),
    h("span", { class: "pf-readbar-page" }),
    h("button", { class: "icon-btn small", type: "button", title: "Next Page", "aria-label": "Next Page", onclick: () => go(page() + 1) }, icon("chevronRight", 15)),
    h("button", { class: "icon-btn small", type: "button", title: "Zoom Out", "aria-label": "Zoom Out", onclick: () => zoomBy(-1) }, icon("zoomOut", 15)),
    h("button", { class: "icon-btn small", type: "button", title: "Zoom In", "aria-label": "Zoom In", onclick: () => zoomBy(1) }, icon("zoomIn", 15)),
    h("button", { class: "btn small", type: "button", onclick: () => setReadMode(false) }, "Exit Read Mode"));

  const main = h("div", { class: "pf-main" }, scroller, organizer.el, findbar, ghost, busyNote, readBar);
  organizer.el.hidden = true;

  // ---- status bar

  const pageStatus = h("button", { class: "pf-status-btn", type: "button", title: "Go to Page (Ctrl+Shift+N)", onclick: () => goTo() });
  const sizeStatus = h("span", { class: "pf-size-status" });
  const zoomRange = h("input", { type: "range", min: "10", max: "400", step: "5", "aria-label": "Zoom" });
  zoomRange.addEventListener("input", () => {
    if (!organizing) pdfViewer.currentScale = Number(zoomRange.value) / 100;
  });
  const zoomValue = h("button", { class: "of-zoom-value pf-status-btn", type: "button", title: "Actual Size", onclick: () => fit("page-actual") });
  const status = h("div", { class: "of-status" }, pageStatus, sizeStatus, h("span", { class: "spacer" }),
    h("button", { class: "icon-btn small", type: "button", title: "Fit Width", "aria-label": "Fit Width", onclick: () => fit("page-width") }, icon("columns", 14)),
    h("button", { class: "icon-btn small", type: "button", title: "Fit Page (Ctrl+0)", "aria-label": "Fit Page", onclick: () => fit("page-fit") }, icon("fit", 14)),
    h("div", { class: "of-zoom" },
      h("button", { type: "button", title: "Zoom Out", "aria-label": "Zoom Out", onclick: () => zoomBy(-1) }, "−"),
      zoomRange,
      h("button", { type: "button", title: "Zoom In", "aria-label": "Zoom In", onclick: () => zoomBy(1) }, "+"),
      zoomValue));

  const body = h("div", { class: "pf-body" }, navStrip, panel, main);
  const root = h("div", { class: "of-editor tone-pdf pf-editor" }, tb.el, ribbon.el, body, status);

  // ---- reading

  const page = () => pdfViewer.currentPageNumber || 1;

  function go(n: number) {
    if (!doc.numPages) return;
    const target = Math.max(1, Math.min(doc.numPages, n));
    pdfViewer.currentPageNumber = target;
    schedule();
  }

  function goTo() {
    goToDialog(doc.numPages, page(), (n) => go(n));
  }

  function zoomBy(step: number) {
    if (organizing) return organizer.resize(step);
    if (step > 0) pdfViewer.increaseScale({ steps: step });
    else pdfViewer.decreaseScale({ steps: -step });
  }

  function fit(kind: "page-width" | "page-fit" | "page-actual") {
    if (organizing) return;
    pdfViewer.currentScaleValue = kind;
  }

  function zoomText(): string {
    const preset = ZOOM_PRESETS.find(([, v]) => v === pdfViewer.currentScaleValue);
    return preset ? preset[0] : `${Math.round(pdfViewer.currentScale * 100)}%`;
  }

  function setZoomText(text: string) {
    const preset = ZOOM_PRESETS.find(([label]) => label.toLowerCase() === text.trim().toLowerCase());
    if (preset) return void (pdfViewer.currentScaleValue = preset[1]);
    const n = Number.parseFloat(text);
    if (Number.isFinite(n) && n > 0) pdfViewer.currentScale = Math.max(0.1, Math.min(10, n / 100));
  }

  function setTool(next: "select" | "hand") {
    tool = next;
    root.classList.toggle("pf-hand", next === "hand");
    schedule();
  }

  // The Hand tool drags the pages around.
  scroller.addEventListener("pointerdown", (e) => {
    if (tool !== "hand" || mode() > 0 || placing || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, button, a, .annotationLayer section")) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    scroller.setPointerCapture(e.pointerId);
    scroller.classList.add("grabbing");
    const move = (ev: PointerEvent) => {
      scroller.scrollLeft = start.left - (ev.clientX - start.x);
      scroller.scrollTop = start.top - (ev.clientY - start.y);
    };
    const up = () => {
      scroller.classList.remove("grabbing");
      scroller.removeEventListener("pointermove", move);
      scroller.removeEventListener("pointerup", up);
      scroller.removeEventListener("pointercancel", up);
    };
    scroller.addEventListener("pointermove", move);
    scroller.addEventListener("pointerup", up);
    scroller.addEventListener("pointercancel", up);
  });

  // Ctrl+wheel zooms around the pointer, as in Acrobat.
  scroller.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    pdfViewer.updateScale({ scaleFactor: Math.exp(-e.deltaY / 400), origin: [e.clientX, e.clientY] } as Parameters<typeof pdfViewer.updateScale>[0]);
  }, { passive: false });

  function setScroll(m: "page" | "vertical" | "wrapped") {
    pdfViewer.scrollMode = m === "page" ? V.ScrollMode.PAGE : m === "wrapped" ? V.ScrollMode.WRAPPED : V.ScrollMode.VERTICAL;
    schedule();
  }

  function setSpread(m: "none" | "odd" | "even") {
    pdfViewer.spreadMode = m === "odd" ? V.SpreadMode.ODD : m === "even" ? V.SpreadMode.EVEN : V.SpreadMode.NONE;
    schedule();
  }

  function setReadMode(on: boolean) {
    readMode = on;
    root.classList.toggle("pf-read", on);
    if (on) {
      hideFind();
      setMode(T.NONE);
    }
    schedule();
  }

  async function fullScreen() {
    const previous = { scroll: pdfViewer.scrollMode, spread: pdfViewer.spreadMode, scale: pdfViewer.currentScaleValue, page: page() };
    try {
      await main.requestFullscreen();
    } catch {
      host.toast("Full screen isn't available here. Try Read Mode (Ctrl+H).");
      return;
    }
    setMode(T.NONE);
    root.classList.add("pf-full");
    pdfViewer.scrollMode = V.ScrollMode.PAGE;
    pdfViewer.spreadMode = V.SpreadMode.NONE;
    requestAnimationFrame(() => {
      pdfViewer.currentScaleValue = "page-fit";
      go(previous.page);
    });
    const leave = () => {
      if (document.fullscreenElement) return;
      document.removeEventListener("fullscreenchange", leave);
      root.classList.remove("pf-full");
      const at = page();
      pdfViewer.scrollMode = previous.scroll;
      pdfViewer.spreadMode = previous.spread;
      requestAnimationFrame(() => {
        pdfViewer.currentScaleValue = previous.scale;
        go(at);
      });
    };
    document.addEventListener("fullscreenchange", leave);
  }

  // In full screen, a click turns the page; the arrows and space do too (handleKey).
  main.addEventListener("click", (e) => {
    if (!document.fullscreenElement || (e.target as HTMLElement).closest("a, input, button")) return;
    go(page() + (e.clientX < innerWidth / 3 ? -1 : 1));
  });

  function setDark(on: boolean) {
    dark = on;
    root.classList.toggle("pf-dark", on);
    schedule();
  }

  function print() {
    void printPdf(lib, doc, host.toast, () => !disposed);
  }

  // ---- find

  function showFind() {
    if (organizing) {
      ribbon.select("home");
      setOrganizing(false);
    }
    findbar.hidden = false;
    const selected = getSelection()?.toString().trim() ?? "";
    if (selected && selected.length < 100 && !selected.includes("\n")) findInput.value = selected;
    findInput.focus();
    findInput.select();
    if (findInput.value) find("");
  }

  function hideFind() {
    if (findbar.hidden) return;
    findbar.hidden = true;
    findCount.textContent = "";
    eventBus.dispatch("findbarclose", { source: findbar });
    scroller.focus({ preventScroll: true });
  }

  function find(type: string, previous = false) {
    eventBus.dispatch("find", {
      source: findbar, type, query: findInput.value,
      caseSensitive: matchCase.classList.contains("active"), entireWord: wholeWord.classList.contains("active"),
      highlightAll: true, findPrevious: previous, matchDiacritics: false,
    });
  }

  function findAgain(previous: boolean) {
    if (findInput.value) find("again", previous);
  }

  findInput.addEventListener("input", () => find(""));
  matchCase.addEventListener("click", () => (matchCase.classList.toggle("active"), find("casesensitivitychange")));
  wholeWord.addEventListener("click", () => (wholeWord.classList.toggle("active"), find("entirewordchange")));
  findInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      findAgain(e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      hideFind();
    }
  });
  const showMatches = (m: { current: number; total: number } | undefined) => {
    if (!findInput.value) findCount.textContent = "";
    else findCount.textContent = m?.total ? `${m.current} of ${m.total}` : "No results";
  };
  eventBus.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: { current: number; total: number } }) => showMatches(matchesCount));
  eventBus.on("updatefindcontrolstate", ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) => {
    if (state === V.FindState.NOT_FOUND) findCount.textContent = findInput.value ? "No results" : "";
    else if (state !== V.FindState.PENDING) showMatches(matchesCount);
  });

  // ---- comments and fill & sign

  function setMode(next: number) {
    cancelPlacing();
    if (mode() === next || !ui) return;
    if (organizing && next !== T.NONE) return;
    pdfViewer.annotationEditorMode = { mode: next };
    schedule();
  }

  /** The editing parameter of a kind for the tool on now (colour of text boxes, of drawings…). */
  function paramFor(kind: "color" | "size" | "thickness" | "opacity"): number | null {
    const m = mode();
    if (kind === "color") return m === T.FREETEXT ? P.FREETEXT_COLOR : m === T.INK ? P.INK_COLOR : m === T.HIGHLIGHT ? P.HIGHLIGHT_COLOR : null;
    if (kind === "size") return m === T.FREETEXT ? P.FREETEXT_SIZE : null;
    if (kind === "thickness") return m === T.INK ? P.INK_THICKNESS : m === T.HIGHLIGHT ? P.HIGHLIGHT_THICKNESS : null;
    return m === T.INK ? P.INK_OPACITY : null;
  }

  function setParam(kind: "color" | "size" | "thickness" | "opacity", value: unknown) {
    const type = paramFor(kind);
    if (type == null) return;
    eventBus.dispatch("switchannotationeditorparams", { source: root, type, value });
    params.set(type, value);
    schedule();
  }

  function readParam(kind: "color" | "size" | "thickness" | "opacity", fallback: number): number {
    const type = paramFor(kind);
    const value = type == null ? undefined : params.get(type);
    return typeof value === "number" ? value : fallback;
  }

  // ---- placing signatures, marks, pictures and the date

  /** What the next click on a page puts there; sizes in points. */
  let placing: ({ kind: "image"; ink: Ink; width: number; height: number } | { kind: "date"; text: string; size: number }) | null = null;

  async function arm(next: NonNullable<typeof placing>) {
    if (!ui) return;
    if (organizing) {
      ribbon.select("home");
      setOrganizing(false);
    }
    hideFind();
    const wanted = next.kind === "date" ? T.FREETEXT : T.STAMP;
    if (mode() !== wanted) pdfViewer.annotationEditorMode = { mode: wanted };
    placing = next;
    root.classList.add("pf-placing");
    if (next.kind === "image") ghost.replaceChildren(h("img", { src: next.ink.image, alt: "" }));
    else ghost.replaceChildren(h("span", { class: "pf-ghost-text" }, next.text));
    sizeGhost();
    host.toast("Click on the page where it goes (Esc to cancel)");
    schedule();
  }

  function sizeGhost() {
    if (!placing) return;
    const px = pdfViewer.currentScale * (96 / 72);
    if (placing.kind === "image") {
      ghost.style.width = `${placing.width * px}px`;
      ghost.style.height = `${placing.height * px}px`;
    } else {
      ghost.style.width = ghost.style.height = "";
      ghost.style.fontSize = `${placing.size * px}px`;
    }
  }

  function cancelPlacing() {
    if (!placing) return;
    placing = null;
    ghost.hidden = true;
    root.classList.remove("pf-placing");
    schedule();
  }

  scroller.addEventListener("pointermove", (e) => {
    if (!placing) return;
    const r = main.getBoundingClientRect();
    ghost.hidden = !(e.target as HTMLElement).closest(".page");
    ghost.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px) translate(-50%, -50%)`;
  });
  scroller.addEventListener("pointerleave", () => (ghost.hidden = true));

  // Before pdf.js sees the click: place what's armed, and keep the picture tool from opening an
  // empty picture box (pdf.js would ask for a file with the desktop's dialog).
  const guard = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    if (placing?.kind === "date" && e.button === 0) {
      // pdf.js opens a text box where the click is; the date is typed into it, still editable.
      if (e.type === "pointerup" && target.closest(".page")) {
        const text = placing.text;
        cancelPlacing();
        setTimeout(() => {
          const field = document.activeElement as HTMLElement | null;
          if (field?.closest(".freeTextEditor")) document.execCommand("insertText", false, text);
        }, 80);
      }
      return;
    }
    if (placing && e.button === 0) {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "pointerdown") void placeAt(e);
      return;
    }
    if (mode() === T.STAMP && target.classList.contains("annotationEditorLayer")) e.stopPropagation();
  };
  scroller.addEventListener("pointerdown", guard, true);
  scroller.addEventListener("pointerup", guard, true);

  async function placeAt(e: PointerEvent) {
    const what = placing;
    const pageDiv = (e.target as HTMLElement).closest<HTMLElement>(".page");
    if (!what || !pageDiv || !ui) return;
    const pageNumber = Number(pageDiv.dataset.pageNumber);
    const view = pdfViewer.getPageView(pageNumber - 1) as { viewport: { rotation: number; convertToPdfPoint(x: number, y: number): number[] }; div: HTMLElement };
    const box = (view.div.querySelector(".canvasWrapper") ?? view.div).getBoundingClientRect();
    const [x, y] = view.viewport.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top);
    const rotation = view.viewport.rotation;
    const layer = ui.getLayer(pageNumber - 1);
    if (!layer) return;
    cancelPlacing();
    try {
      if (what.kind === "image") {
        const data = await ui.imageManager.getFromFile(new File([dataUrlBlob(what.ink.image)], "signature.png", { type: "image/png", lastModified: Date.now() }));
        if (!data) throw new Error("The picture couldn’t be read.");
        const [w, hgt] = rotation % 180 ? [what.height, what.width] : [what.width, what.height];
        const editor = await layer.deserialize({
          annotationType: T.STAMP, bitmapId: data.id, pageIndex: pageNumber - 1, rotation, isSvg: false,
          rect: [x - w / 2, y - hgt / 2, x + w / 2, y + hgt / 2],
          accessibilityData: { altText: what.ink.name, decorative: false },
        });
        if (editor) layer.addOrRebuild(editor);
      }
    } catch (err) {
      host.toast(`Couldn’t put it on the page: ${errorText(err)}`);
    }
  }

  /** A data URL's bytes (fetching data: URLs isn't allowed by CorePro's content policy). */
  function dataUrlBlob(url: string): Blob {
    const [head, data] = url.split(",", 2);
    const raw = atob(data);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return new Blob([out], { type: head.match(/data:([^;]+)/)?.[1] ?? "image/png" });
  }

  /** The size a picture goes on the page at: `width` points wide, or its own size up to half the page. */
  async function inkSize(ink: Ink, width: number | null): Promise<{ width: number; height: number }> {
    const img = new Image();
    img.src = ink.image;
    await img.decode().catch(() => undefined);
    const ratio = img.naturalWidth && img.naturalHeight ? img.naturalHeight / img.naturalWidth : 0.4;
    if (width) {
      let w = width;
      // Tall signatures are kept to a sensible height.
      if (w * ratio > width * 0.6) w = (width * 0.6) / ratio;
      return { width: w, height: w * ratio };
    }
    const pageWidth = (await doc.getPage(page())).view[2];
    const w = Math.min(img.naturalWidth * 0.75 || 200, pageWidth / 2);
    return { width: w, height: w * ratio };
  }

  async function placeInk(ink: Ink, kind: "signature" | "initials" | "picture" | "mark") {
    const width = kind === "signature" ? 150 : kind === "initials" ? 54 : kind === "mark" ? 16 : null;
    const size = await inkSize(ink, width);
    void arm({ kind: "image", ink, ...size });
  }

  async function addPicture() {
    const picked = await open({ title: "Add a Picture", multiple: false, filters: [{ name: "Pictures", extensions: PICTURES }] }).catch(() => null);
    if (!picked) return;
    try {
      const raw = await officeApi.read(picked);
      const blob = blobOf(raw, picked);
      // Every picture goes on the page as a PNG (pdf.js draws it from a bitmap anyway).
      const bitmap = await createImageBitmap(blob);
      const canvas = h("canvas", { width: bitmap.width, height: bitmap.height });
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close();
      await placeInk({ image: canvas.toDataURL("image/png"), name: stem(picked) }, "picture");
    } catch (err) {
      host.toast(`Couldn’t add ${basename(picked)}: ${errorText(err)}`);
    }
  }

  function sign(anchor: HTMLElement) {
    signatureMenu(anchor, {
      pick: (ink) => void placeInk(ink, ink.name.length <= 4 ? "initials" : "signature"),
      create: async (kind) => {
        const ink = await signatureDialog(kind, host.toast);
        if (ink) void placeInk(ink, kind);
      },
      toast: host.toast,
    });
  }

  // ---- page structure: everything goes through `restructure`

  /** The file as it is now, with comments and form values written in. */
  async function bake(): Promise<Uint8Array> {
    ui?.endCurrentEditing();
    return doc.annotationStorage.size > 0 ? await doc.saveDocument() : bytes;
  }

  async function rotations(): Promise<number[]> {
    const out: number[] = [];
    for (let i = 1; i <= doc.numPages; i++) out.push((await doc.getPage(i)).rotate);
    return out;
  }

  function showBusy(text: string | null) {
    busy = !!text;
    busyNote.hidden = !text;
    busyNote.textContent = text ?? "";
    root.classList.toggle("pf-is-busy", busy);
  }

  /** A new file from `slots`, finished (rotations set): built, opened to read its pages, patched. */
  async function make(slots: Slot[], pass: string | null): Promise<Uint8Array> {
    const built = await build(engine, slots, paper());
    const check = await openPdf(engine, built, ask, pass);
    try {
      const fix: { ref: { num: number; gen: number }; rotate: number }[] = [];
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if ("image" in slot) continue;
        const p = await check.doc.getPage(i + 1);
        if (p.rotate !== ((slot.rotate % 360) + 360) % 360 && p.ref) fix.push({ ref: p.ref, rotate: slot.rotate });
      }
      return finish(built, fix);
    } finally {
      void check.doc.loadingTask.destroy();
    }
  }

  /**
   * Changes the pages: `plan` gets the file as it is now (a source), its page count and rotations,
   * and returns the new pages. Undo restores the file as it was. `select` are the pages to select
   * in Organize afterwards, `show` the page to show.
   */
  async function restructure(what: string, plan: (source: Source, count: number, rotate: number[]) => Promise<{ slots: Slot[]; select?: number[]; show?: number } | null>) {
    if (busy) return;
    showBusy(`${what}…`);
    try {
      const base = await bake();
      const source: Source = { bytes: base, password };
      const result = await plan(source, doc.numPages, await rotations());
      if (!result) return;
      const next = await make(result.slots, password);
      undoSteps.push({ bytes: base, password, page: page() });
      if (undoSteps.length > 30) undoSteps.shift();
      redoSteps = [];
      await replace(next, password, result.show ?? page(), result.select);
    } catch (err) {
      if ((err as Error)?.name !== "Cancelled") host.toast(`Couldn’t change the pages: ${errorText(err)}`);
    } finally {
      showBusy(null);
    }
  }

  /** Shows another version of the file (after a page change, undo or redo). */
  async function replace(next: Uint8Array, pass: string | null, showPage: number, select?: number[]) {
    const opened = await openPdf(engine, next, ask, pass);
    const old = doc;
    const scale = pdfViewer.currentScaleValue || "auto";
    bytes = next;
    password = opened.password;
    doc = opened.doc;
    changed = true;
    version++;
    thumbs.dispose();
    thumbs = new Thumbs(doc);
    showDocument(showPage, scale);
    if (organizing) organizer.show(doc.numPages, thumbs, select);
    // Keep the keyboard here: the old pages it was on are gone.
    if (!root.contains(document.activeElement) || document.activeElement === document.body) (organizing ? organizer.el : scroller).focus({ preventScroll: true });
    void old.loadingTask.destroy();
    schedule();
  }

  function remaining(count: number, gone: number[]): number[] {
    const set = new Set(gone);
    return Array.from({ length: count }, (_, i) => i).filter((i) => !set.has(i));
  }

  function movePages(pages: number[], to: number) {
    void restructure("Moving pages", async (source, count, rotate) => {
      const rest = remaining(count, pages);
      const order = [...rest.slice(0, to), ...pages, ...rest.slice(to)];
      return {
        slots: order.map((i) => ({ source, index: i, rotate: rotate[i] })),
        select: pages.map((_, k) => to + k),
        show: to + 1,
      };
    });
  }

  function rotatePages(pages: number[], delta: number) {
    if (!pages.length) return;
    const set = new Set(pages);
    void restructure("Rotating pages", async (source, count, rotate) => ({
      slots: Array.from({ length: count }, (_, i) => ({ source, index: i, rotate: set.has(i) ? rotate[i] + delta : rotate[i] })),
      select: pages,
    }));
  }

  function deletePages(pages: number[]) {
    if (!pages.length) return;
    if (pages.length >= doc.numPages) return host.toast("A PDF has to keep at least one page.");
    void restructure(pages.length > 1 ? `Deleting ${pages.length} pages` : "Deleting the page", async (source, count, rotate) => ({
      slots: remaining(count, pages).map((i) => ({ source, index: i, rotate: rotate[i] })),
      show: Math.min(pages[0] + 1, count - pages.length),
    }));
  }

  /** Inserts the pages of other files (PDFs and pictures) or a blank page before gap `at`. */
  function insertAt(at: number, what: "file" | "blank") {
    void restructure(what === "blank" ? "Inserting a blank page" : "Inserting pages", async (source, count, rotate) => {
      const added: Slot[] = [];
      const opened: PDFDocumentProxy[] = [];
      try {
        if (what === "blank") {
          // As big as the page before it (or after it, at the start).
          const near = await doc.getPage(Math.max(1, Math.min(count, at)));
          const [x0, y0, x1, y1] = near.view;
          const { blankPdf } = await import("./bytes");
          added.push({ source: { bytes: blankPdf([[x1 - x0, y1 - y0]]) }, index: 0, rotate: near.rotate });
        } else {
          const picked = await open({ title: "Insert Pages From", multiple: true, filters: [{ name: "PDFs and pictures", extensions: ["pdf", ...PICTURES] }] });
          if (!picked?.length) return null;
          for (const p of picked) {
            const raw = await officeApi.read(p);
            if (extensionOf(p) !== "pdf") {
              added.push({ image: blobOf(raw, p) });
              continue;
            }
            const other = await openPdf(engine, raw, (wrong) => passwordDialog(basename(p), wrong));
            opened.push(other.doc);
            const src: Source = { bytes: raw, password: other.password };
            for (let i = 0; i < other.doc.numPages; i++) added.push({ source: src, index: i, rotate: (await other.doc.getPage(i + 1)).rotate });
          }
        }
      } finally {
        for (const d of opened) void d.loadingTask.destroy();
      }
      const own = Array.from({ length: count }, (_, i): Slot => ({ source, index: i, rotate: rotate[i] }));
      return {
        slots: [...own.slice(0, at), ...added, ...own.slice(at)],
        select: added.map((_, k) => at + k),
        show: at + 1,
      };
    });
  }

  /** Saves `pages` as a new PDF (asks where); `remove` takes them out of this one afterwards. */
  async function extract(pages?: number[]) {
    const chosen = await extractDialog(doc.numPages, pages ?? (organizing ? organizer.selection() : [page() - 1]));
    if (!chosen) return;
    const base = stem(path ?? name);
    const folder = path ? path.replace(/\/[^/]*$/, "") : await documentDir().catch(() => null);
    const suggested = folder ? await join(folder, `${base} (pages ${chosen.pages.length > 1 ? `${chosen.pages[0] + 1}-${chosen.pages[chosen.pages.length - 1] + 1}` : chosen.pages[0] + 1}).pdf`) : `${base} (extract).pdf`;
    const target = await pickSavePath(suggested, [{ name: "PDF", extension: "pdf" }]);
    if (!target) return;
    showBusy("Extracting pages…");
    try {
      const source: Source = { bytes: await bake(), password };
      const rotate = await rotations();
      const out = await make(chosen.pages.map((i) => ({ source, index: i, rotate: rotate[i] })), password);
      await officeApi.write(target, out);
      host.remember(target);
      host.toast(`Saved ${basename(target)}`);
    } catch (err) {
      host.toast(`Couldn’t extract the pages: ${errorText(err)}`);
      return;
    } finally {
      showBusy(null);
    }
    if (chosen.remove) deletePages([...new Set(chosen.pages)]);
  }

  /** Splits into several PDFs in a folder: every N pages, or at each top-level bookmark. */
  async function split() {
    const outline = await doc.getOutline().catch(() => null);
    const how = await splitDialog(doc.numPages, !!outline?.length);
    if (!how) return;
    let starts: number[] = [];
    if (how.by === "pages") for (let i = 0; i < doc.numPages; i += how.size) starts.push(i);
    else {
      for (const item of outline ?? []) {
        const at = await destinationPage(item.dest);
        if (at != null) starts.push(at);
      }
      starts = [...new Set([0, ...starts])].sort((a, b) => a - b);
    }
    if (starts.length < 2) return host.toast("That would make just one file.");
    const folder = await open({ title: "Choose a Folder for the Parts", directory: true, defaultPath: path ? path.replace(/\/[^/]*$/, "") : undefined });
    if (!folder) return;
    showBusy(`Splitting into ${starts.length} files…`);
    try {
      const source: Source = { bytes: await bake(), password };
      const rotate = await rotations();
      const base = stem(path ?? name);
      for (let k = 0; k < starts.length; k++) {
        const end = starts[k + 1] ?? doc.numPages;
        const out = await make(Array.from({ length: end - starts[k] }, (_, i) => ({ source, index: starts[k] + i, rotate: rotate[starts[k] + i] })), password);
        let target = await join(folder, `${base} - Part ${k + 1}.pdf`);
        for (let n = 2; await fsApi.stat(target).then(() => true, () => false); n++) target = await join(folder, `${base} - Part ${k + 1} (${n}).pdf`);
        await officeApi.write(target, out);
      }
      host.toast(`Saved ${starts.length} files in ${basename(folder)}`);
    } catch (err) {
      host.toast(`Couldn’t split the file: ${errorText(err)}`);
    } finally {
      showBusy(null);
    }
  }

  async function destinationPage(dest: unknown): Promise<number | null> {
    try {
      const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return null;
      const target = explicit[0];
      if (Number.isInteger(target)) return target as number;
      return await doc.getPageIndex(target as { num: number; gen: number });
    } catch {
      return null;
    }
  }

  async function undo() {
    if (states.hasSomethingToUndo && ui) return ui.undo();
    const step = undoSteps.pop();
    if (!step || busy) return;
    showBusy("Undoing…");
    try {
      redoSteps.push({ bytes: await bake(), password, page: page() });
      await replace(step.bytes, step.password, step.page);
    } catch (err) {
      host.toast(`Couldn’t undo: ${errorText(err)}`);
    } finally {
      showBusy(null);
    }
  }

  async function redo() {
    if (states.hasSomethingToRedo && ui) return ui.redo();
    const step = redoSteps.pop();
    if (!step || busy) return;
    showBusy("Redoing…");
    try {
      undoSteps.push({ bytes: await bake(), password, page: page() });
      await replace(step.bytes, step.password, step.page);
    } catch (err) {
      host.toast(`Couldn’t redo: ${errorText(err)}`);
    } finally {
      showBusy(null);
    }
  }

  function setOrganizing(on: boolean) {
    if (on === organizing) return;
    organizing = on;
    root.classList.toggle("pf-organizing", on);
    organizer.el.hidden = !on;
    scroller.hidden = on;
    if (on) {
      setMode(T.NONE);
      hideFind();
      organizer.show(doc.numPages, thumbs, [page() - 1]);
      organizer.el.focus({ preventScroll: true });
      requestAnimationFrame(() => organizer.el.querySelector(".pf-org-tile.selected")?.scrollIntoView({ block: "center" }));
    } else {
      scroller.focus({ preventScroll: true });
    }
    schedule();
  }

  // The Organize tab shows the page grid; any other tab, the pages.
  ribbon.el.addEventListener("click", () => queueMicrotask(syncTab));
  function syncTab() {
    const tab = ribbon.el.querySelector<HTMLElement>(".rb-tab[aria-selected='true']");
    setOrganizing(tab?.textContent === "Organize");
  }

  // ---- the navigation pane

  const NAV: { id: NavId; label: string; icon: IconName }[] = [
    { id: "pages", label: "Pages", icon: "grid" },
    { id: "bookmarks", label: "Bookmarks", icon: "bookmark" },
    { id: "comments", label: "Comments", icon: "comment" },
    { id: "attachments", label: "Attachments", icon: "paperclip" },
  ];

  function drawNavStrip() {
    navStrip.replaceChildren(...NAV.filter((n) => n.id !== "attachments" || attachments).map((n) => h("button", {
      class: `pf-nav-btn${nav === n.id ? " active" : ""}`, type: "button", role: "tab", title: n.label, "aria-label": n.label, "aria-selected": String(nav === n.id),
      onclick: () => setNav(nav === n.id ? null : n.id),
    }, icon(n.icon, 18))));
  }

  function setNav(id: NavId | null) {
    nav = id;
    drawNavStrip();
    drawNav();
    schedule();
  }

  function drawNav() {
    thumbObserver.disconnect();
    panel.hidden = !nav;
    root.classList.toggle("pf-nav-open", !!nav);
    if (!nav) return;
    panelTitle.textContent = NAV.find((n) => n.id === nav)?.label ?? "";
    if (nav === "pages") drawThumbs();
    else if (nav === "bookmarks") void drawBookmarks();
    else if (nav === "comments") void drawComments();
    else drawAttachments();
  }

  function drawThumbs() {
    const tiles: HTMLElement[] = [];
    for (let i = 0; i < doc.numPages; i++) {
      const img = h("img", { class: "pf-thumb-img", alt: "", draggable: "false", "data-page": String(i), "data-width": "120" });
      img.addEventListener("load", () => (img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`), { once: true });
      const tile = h("button", { class: "pf-thumb", type: "button", "data-index": String(i), title: `Page ${i + 1}`, onclick: () => go(i + 1) }, img, h("span", { class: "pf-thumb-num" }, String(i + 1)));
      tile.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          { label: "Rotate Left", icon: "rotateLeft", action: () => void rotatePages([i], -90) },
          { label: "Rotate Right", icon: "rotateRight", action: () => void rotatePages([i], 90) },
          "separator",
          { label: "Insert From File…", icon: "pageAdd", action: () => insertAt(i + 1, "file") },
          { label: "Insert Blank Page", icon: "blankPage", action: () => insertAt(i + 1, "blank") },
          { label: "Extract…", icon: "pageExtract", action: () => void extract([i]) },
          "separator",
          { label: "Delete Page", icon: "trash", danger: true, action: () => deletePages([i]), disabled: doc.numPages < 2 },
        ]);
      });
      thumbObserver.observe(img);
      tiles.push(tile);
    }
    thumbList.replaceChildren(...tiles);
    panelBody.replaceChildren(thumbList);
    markThumb();
  }

  function markThumb() {
    if (nav !== "pages") return;
    const current = page() - 1;
    for (const t of thumbList.querySelectorAll<HTMLElement>(".pf-thumb")) {
      const on = Number(t.dataset.index) === current;
      if (on && !t.classList.contains("current")) t.scrollIntoView({ block: "nearest" });
      t.classList.toggle("current", on);
    }
  }

  interface OutlineItem {
    title: string;
    bold?: boolean;
    italic?: boolean;
    dest: unknown;
    url: string | null;
    items: OutlineItem[];
  }

  async function drawBookmarks() {
    const outline = (await doc.getOutline().catch(() => null)) as OutlineItem[] | null;
    if (nav !== "bookmarks") return;
    if (!outline?.length) return void panelBody.replaceChildren(h("div", { class: "pf-empty" }, "This document has no bookmarks."));
    const item = (o: OutlineItem): HTMLElement => {
      const row = h("button", {
        class: `pf-mark${o.bold ? " bold" : ""}${o.italic ? " italic" : ""}`, type: "button", title: o.title,
        onclick: () => {
          if (o.url) {
            const safe = safeLink(o.url);
            if (safe) host.shell.openExternally(safe);
            else host.toast("This link isn't a web or email address, so it isn't opened.");
          } else if (o.dest) void links.goToDestination(o.dest as string);
        },
      }, h("span", { class: "pf-mark-title" }, o.title));
      if (!o.items.length) return h("div", { class: "pf-mark-node" }, h("span", { class: "pf-mark-toggle" }), row);
      const kids = h("div", { class: "pf-mark-kids" }, ...o.items.map(item));
      const toggle = h("button", { class: "pf-mark-toggle open", type: "button", "aria-label": "Expand or collapse", onclick: () => (kids.hidden = !kids.hidden, toggle.classList.toggle("open", !kids.hidden)) }, icon("chevronRight", 12));
      return h("div", { class: "pf-mark-node" }, toggle, row, kids);
    };
    panelBody.replaceChildren(h("div", { class: "pf-marks" }, ...outline.map(item)));
  }

  let commentsTimer = 0;
  function commentsSoon() {
    clearTimeout(commentsTimer);
    commentsTimer = window.setTimeout(() => void drawComments(), 400);
  }

  const COMMENT_TYPES: Record<string, { label: string; icon: IconName }> = {
    Text: { label: "Note", icon: "comment" }, FreeText: { label: "Text", icon: "textBox" }, Highlight: { label: "Highlight", icon: "highlighter" },
    Underline: { label: "Underline", icon: "textCursor" }, StrikeOut: { label: "Strikethrough", icon: "textCursor" }, Squiggly: { label: "Squiggly", icon: "textCursor" },
    Ink: { label: "Drawing", icon: "pencil" }, Square: { label: "Rectangle", icon: "pageSingle" }, Circle: { label: "Oval", icon: "pageSingle" },
    Line: { label: "Line", icon: "pencil" }, Polygon: { label: "Polygon", icon: "pencil" }, PolyLine: { label: "Lines", icon: "pencil" },
    Stamp: { label: "Picture", icon: "image" }, Caret: { label: "Insert Text", icon: "textCursor" }, FileAttachment: { label: "Attachment", icon: "paperclip" },
  };
  const EDITOR_TYPES: Record<string, string> = { [T.FREETEXT]: "FreeText", [T.HIGHLIGHT]: "Highlight", [T.INK]: "Ink", [T.STAMP]: "Stamp" };

  async function drawComments() {
    if (nav !== "comments") return;
    const rows: { page: number; type: string; text: string; author: string; when: string; top: number }[] = [];
    const replaced = new Set<string>();
    // Comments added or changed since the file was opened (pdf.js's editors), then those in the file.
    const edits = doc.annotationStorage.size ? (doc.annotationStorage.serializable.map as Map<string, Record<string, unknown>> | null) : null;
    for (const e of edits?.values() ?? []) {
      if (typeof e.id === "string") replaced.add(e.id);
      const type = EDITOR_TYPES[String(e.annotationType)];
      if (e.deleted || !type || typeof e.pageIndex !== "number") continue;
      const text = typeof e.value === "string" ? e.value : String((e.accessibilityData as { altText?: string } | undefined)?.altText ?? "");
      rows.push({ page: e.pageIndex, type, text, author: "", when: "Not saved yet", top: (e.rect as number[] | undefined)?.[3] ?? 0 });
    }
    for (let i = 1; i <= doc.numPages; i++) {
      const annots = (await (await doc.getPage(i)).getAnnotations().catch(() => [])) as { id: string; subtype: string; contentsObj?: { str?: string }; titleObj?: { str?: string }; modificationDate?: string; rect: number[] }[];
      for (const a of annots) {
        if (!COMMENT_TYPES[a.subtype] || replaced.has(a.id)) continue;
        rows.push({ page: i - 1, type: a.subtype, text: a.contentsObj?.str ?? "", author: a.titleObj?.str ?? "", when: a.modificationDate ? pdfDateShort(a.modificationDate) : "", top: a.rect[3] });
      }
      if (nav !== "comments") return;
    }
    rows.sort((a, b) => a.page - b.page || b.top - a.top);
    if (!rows.length) return void panelBody.replaceChildren(h("div", { class: "pf-empty" }, "No comments yet. Highlight text or add a text box from the Comment tab."));
    const list = h("div", { class: "pf-comments" });
    let lastPage = -1;
    for (const r of rows) {
      if (r.page !== lastPage) {
        lastPage = r.page;
        list.append(h("div", { class: "pf-comments-page" }, `Page ${r.page + 1}`));
      }
      const t = COMMENT_TYPES[r.type];
      list.append(h("button", { class: "pf-comment", type: "button", onclick: () => go(r.page + 1) },
        h("span", { class: "pf-comment-icon" }, icon(t.icon, 14)),
        h("span", { class: "pf-comment-main" },
          h("span", { class: "pf-comment-head" }, h("b", null, r.author || t.label), r.when ? h("span", null, r.when) : null),
          r.text ? h("span", { class: "pf-comment-text" }, r.text) : null)));
    }
    panelBody.replaceChildren(list);
  }

  function pdfDateShort(value: string): string {
    const m = value.match(/^(?:D:)?(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/);
    if (!m) return "";
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function drawAttachments() {
    if (!attachments) return void panelBody.replaceChildren(h("div", { class: "pf-empty" }, "No files are attached to this PDF."));
    panelBody.replaceChildren(h("div", { class: "pf-attachments" }, ...[...attachments].map(([id, a]) => h("div", { class: "pf-attachment" },
      icon("paperclip", 14), h("span", { class: "pf-attachment-name", title: a.filename }, a.filename),
      h("button", {
        class: "btn small", type: "button",
        onclick: async () => {
          const folder = path ? path.replace(/\/[^/]*$/, "") : await documentDir().catch(() => null);
          const ext = extensionOf(a.filename) || "bin";
          const target = await pickSavePath(folder ? await join(folder, basename(a.filename)) : basename(a.filename), [{ name: ext.toUpperCase(), extension: ext }]);
          if (!target) return;
          try {
            const content = a.content ?? (await doc.getAttachmentContent(id));
            if (!content) throw new Error("It’s empty.");
            await officeApi.write(target, content);
            host.toast(`Saved ${basename(target)}`);
          } catch (err) {
            host.toast(`Couldn’t save it: ${errorText(err)}`);
          }
        },
      }, "Save…")))));
  }

  // ---- saving

  async function save(as = false): Promise<boolean> {
    let target = path;
    if (!target || as) {
      const folder = path ? path.replace(/\/[^/]*$/, "") : await documentDir().catch(() => null);
      const base = stem(path ?? name);
      target = await pickSavePath(folder ? await join(folder, `${base}.pdf`) : `${base}.pdf`, [{ name: "PDF", extension: "pdf" }]);
      if (!target) return false;
    }
    try {
      ui?.endCurrentEditing();
      const out = doc.annotationStorage.size > 0 ? await doc.saveDocument() : bytes;
      await officeApi.write(target, out);
      path = target;
      fileSize = out.length;
      changed = false;
      doc.annotationStorage.resetModified();
      modified = false;
      host.remember(target);
      host.changed();
      host.toast(`Saved ${basename(target)}`);
      schedule();
      return true;
    } catch (err) {
      host.toast(`Couldn’t save: ${errorText(err)}`);
      return false;
    }
  }

  /** AutoRecover's copy: refreshed in the background when the comments changed since the last one. */
  let kept: { bytes: Uint8Array; version: number; key: string } = { bytes, version: 0, key: "" };
  let keeping = false;
  function snapshot() {
    const key = `${version}:${doc.annotationStorage.size ? doc.annotationStorage.serializable.hash : ""}`;
    if (key !== kept.key && !keeping) {
      keeping = true;
      const at = kept.version + 1;
      const run = doc.annotationStorage.size ? doc.saveDocument() : Promise.resolve(bytes);
      void run.then((b) => (kept = { bytes: b, version: at, key }), () => undefined).finally(() => (keeping = false));
    }
    // The first copy can't wait for pdf.js: it's the pages without the newest comments.
    if (kept.version === 0) kept = { bytes, version: 1, key: kept.key };
    return { bytes: kept.bytes, version: kept.version };
  }

  // ---- updates

  function schedule() {
    if (queued || disposed) return;
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
    const n = page();
    if (organizing) {
      const sel = organizer.selection().length;
      pageStatus.textContent = `${doc.numPages} pages${sel ? ` · ${sel} selected` : ""}`;
    } else pageStatus.textContent = `Page ${n} of ${doc.numPages}`;
    readBar.querySelector(".pf-readbar-page")!.textContent = `${n} / ${doc.numPages}`;
    const view = pdfViewer.getPageView(n - 1) as { viewport?: { rawDims?: { pageWidth: number; pageHeight: number } } } | undefined;
    const dims = view?.viewport?.rawDims;
    sizeStatus.textContent = dims ? `${(dims.pageWidth / 72).toFixed(2)} × ${(dims.pageHeight / 72).toFixed(2)} in` : "";
    const percent = Math.round((pdfViewer.currentScale || 1) * 100);
    zoomRange.value = String(percent);
    zoomValue.textContent = organizing ? "" : `${percent}%`;
    zoomRange.disabled = organizing;
    root.classList.toggle("pf-fields-off", !fieldsShown);
    if (placing) sizeGhost();
  }

  // ---- keys

  root.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (!isTypingTarget(target) || target.closest(".modal-overlay")) return;
    // Typing in a form field or a text box: the shell's own shortcuts (Ctrl+1…9, Ctrl+N) stay out.
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "s") {
      e.preventDefault();
      void save(e.shiftKey);
    } else if (mod && key === "p") {
      e.preventDefault();
      print();
    }
    e.stopPropagation();
  });
  root.addEventListener("mousedown", (e) => {
    if (!ribbon.el.contains(e.target as Node)) ribbon.settle();
  });

  function handleKey(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ribbon.handleKey(e)) return true;
    if (e.key === "Escape") {
      if (placing) return cancelPlacing(), true;
      if (!findbar.hidden) return hideFind(), true;
      if (readMode) return setReadMode(false), true;
      if (mode() > 0 && !states.hasSelectedEditor) return setMode(T.NONE), true;
      if (organizing && organizer.selection().length) return organizer.selectWhere("none"), true;
      return false;
    }
    if (mod && key === "f") return showFind(), true;
    if (mod && key === "p") return print(), true;
    if (mod && key === "d") return void propertiesDialog(doc, { name: title(), path, size: fileSize }), true;
    if (mod && e.shiftKey && key === "n") return goTo(), true;
    if (mod && key === "h") return setReadMode(!readMode), true;
    if (e.key === "F4") return setNav(nav ? null : "pages"), true;
    if (mod && e.shiftKey && (e.key === "+" || e.key === "=")) return rotateView(90), true;
    if (mod && e.shiftKey && (e.key === "_" || e.key === "-")) return rotateView(-90), true;
    if (mod && (e.key === "=" || e.key === "+")) return zoomBy(1), true;
    if (mod && e.key === "-") return zoomBy(-1), true;
    if (mod && e.key === "0") return fit("page-fit"), true;
    // pdf.js's editor takes Ctrl+Z/Y, Delete, Ctrl+A and the arrows while a tool is on.
    const editing = mode() > 0;
    if (mod && key === "z" && !e.shiftKey) return editing && states.hasSomethingToUndo ? false : (void undo(), true);
    if (mod && (key === "y" || (key === "z" && e.shiftKey))) return editing && states.hasSomethingToRedo ? false : (void redo(), true);
    if (organizing) {
      if (e.key === "Delete" || e.key === "Backspace") return deletePages(organizer.selection()), true;
      if (mod && key === "a") return organizer.selectWhere("all"), true;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") return organizer.step(e.key === "ArrowLeft" ? -1 : 1, e.shiftKey), true;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") return organizer.step(e.key === "ArrowUp" ? -2 : 2, e.shiftKey), true;
      if (e.key === "Enter" && organizer.selection().length) return organizer.selection().length && (ribbon.select("home"), setOrganizing(false), go(organizer.selection()[0] + 1)), true;
      return false;
    }
    if (editing) return false;
    if (mod && key === "a") {
      getSelection()?.selectAllChildren(viewerEl);
      return true;
    }
    if (mod || e.altKey) return false;
    const inPages = scroller.contains(document.activeElement);
    if (key === "v") return setTool("select"), true;
    if (key === "h") return setTool("hand"), true;
    if (e.key === "Home") return go(1), true;
    if (e.key === "End") return go(doc.numPages), true;
    const single = pdfViewer.scrollMode === V.ScrollMode.PAGE || !!document.fullscreenElement;
    if (e.key === "ArrowRight" || (single && (e.key === "PageDown" || e.key === " "))) return go(page() + 1), true;
    if (e.key === "ArrowLeft" || (single && e.key === "PageUp")) return go(page() - 1), true;
    if (!inPages && (e.key === "PageDown" || e.key === "PageUp" || e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const by = e.key.startsWith("Page") ? scroller.clientHeight * 0.9 : 48;
      scroller.scrollBy({ top: e.key === "PageUp" || e.key === "ArrowUp" ? -by : by });
      return true;
    }
    return false;
  }

  function rotateView(delta: number) {
    if (organizing) return;
    pdfViewer.pagesRotation = (((pdfViewer.pagesRotation + delta) % 360) + 360) % 360;
    schedule();
  }

  // ---- the ribbon

  const ctx: PdfCtx = {
    lib,
    organizing: () => organizing,
    setOrganizing,
    tool: () => tool,
    setTool,
    zoomText,
    zoomChoices: () => [...ZOOM_PRESETS.map(([label]) => label), ...ZOOM_STEPS],
    setZoomText,
    zoomBy,
    fit,
    rotateView,
    page,
    pages: () => doc.numPages,
    go,
    goTo,
    find: showFind,
    print,
    properties: () => void propertiesDialog(doc, { name: title(), path, size: fileSize }),
    scroll: () => (pdfViewer.scrollMode === V.ScrollMode.PAGE ? "page" : pdfViewer.scrollMode === V.ScrollMode.WRAPPED ? "wrapped" : "vertical"),
    setScroll,
    spread: () => (pdfViewer.spreadMode === V.SpreadMode.ODD ? "odd" : pdfViewer.spreadMode === V.SpreadMode.EVEN ? "even" : "none"),
    setSpread,
    nav: () => nav,
    setNav,
    hasAttachments: () => !!attachments,
    readMode: () => readMode,
    setReadMode,
    fullScreen: () => void fullScreen(),
    dark: () => dark,
    setDark,
    mode,
    setMode,
    color: () => {
      const value = paramFor("color") == null ? undefined : params.get(paramFor("color")!);
      return typeof value === "string" ? value : "#000000";
    },
    setColor: (c) => setParam("color", c),
    fontSize: () => readParam("size", 10),
    setFontSize: (n) => setParam("size", n),
    thickness: () => readParam("thickness", 1),
    setThickness: (n) => setParam("thickness", n),
    opacity: () => readParam("opacity", 1),
    setOpacity: (n) => setParam("opacity", n),
    hasSelection: () => mode() > 0 && !!states.hasSelectedEditor,
    deleteSelected: () => ui?.delete(),
    addPicture: () => void addPicture(),
    fieldsShown: () => fieldsShown,
    toggleFields: () => {
      fieldsShown = !fieldsShown;
      schedule();
    },
    sign,
    mark: (kind) => void placeInk({ image: markImage(kind), name: kind === "check" ? "Check mark" : kind === "cross" ? "Cross" : "Dot" }, "mark"),
    addDate: () => void arm({ kind: "date", text: new Date().toLocaleDateString(), size: 12 }),
    orgSelection: () => (organizing ? organizer.selection() : [page() - 1]),
    rotatePages: (delta) => rotatePages(organizing ? organizer.selection() : [page() - 1], delta),
    deletePages: () => deletePages(organizing ? organizer.selection() : [page() - 1]),
    insert: (what) => insertAt(organizing ? (organizer.selection().length ? organizer.selection()[organizer.selection().length - 1] + 1 : doc.numPages) : page(), what),
    extract: () => void extract(),
    split: () => void split(),
    selectPages: (which) => organizer.selectWhere(which),
    tiles: (step) => organizer.resize(step),
  };
  buildTabs(ribbon, ctx);

  showDocument(1);
  drawNavStrip();
  draw();

  const editor: OfficeEditor = {
    kind: "pdf",
    el: root,
    title,
    path: () => path,
    dirty,
    save,
    print,
    snapshot,
    activate() {
      schedule();
      requestAnimationFrame(() => {
        if (!root.contains(document.activeElement)) (organizing ? organizer.el : scroller).focus({ preventScroll: true });
      });
    },
    deactivate() {
      cancelPlacing();
      if (document.fullscreenElement && main.contains(document.fullscreenElement)) void document.exitFullscreen().catch(() => undefined);
    },
    handleKey,
    dispose() {
      disposed = true;
      thumbObserver.disconnect();
      organizer.dispose();
      thumbs.dispose();
      pdfViewer.cleanup?.();
      void doc.loadingTask.destroy();
    },
  };
  return editor;
};
