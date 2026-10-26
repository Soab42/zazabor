import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { button, combo, colorButton, custom, menuButton, stack, type Ribbon } from "../ribbon";
import type { PdfLib } from "./engine";

/** The panels of the navigation pane. */
export type NavId = "pages" | "bookmarks" | "comments" | "attachments";

/** What the ribbon reads and runs; the editor (index.ts) implements it. */
export interface PdfCtx {
  lib: PdfLib;
  /** Organize Pages shows instead of the reading view. */
  organizing(): boolean;
  setOrganizing(on: boolean): void;

  // ---- reading
  tool(): "select" | "hand";
  setTool(tool: "select" | "hand"): void;
  zoomText(): string;
  zoomChoices(): string[];
  setZoomText(text: string): void;
  zoomBy(step: number): void;
  fit(kind: "page-width" | "page-fit" | "page-actual"): void;
  rotateView(delta: number): void;
  page(): number;
  pages(): number;
  go(page: number): void;
  goTo(): void;
  find(): void;
  print(): void;
  properties(): void;
  scroll(): "page" | "vertical" | "wrapped";
  setScroll(mode: "page" | "vertical" | "wrapped"): void;
  spread(): "none" | "odd" | "even";
  setSpread(mode: "none" | "odd" | "even"): void;
  nav(): NavId | null;
  setNav(id: NavId | null): void;
  hasAttachments(): boolean;
  readMode(): boolean;
  setReadMode(on: boolean): void;
  fullScreen(): void;
  dark(): boolean;
  setDark(on: boolean): void;

  // ---- comments
  /** The annotation tool on (an AnnotationEditorType), NONE for none. */
  mode(): number;
  setMode(mode: number): void;
  color(): string;
  setColor(color: string): void;
  fontSize(): number;
  setFontSize(size: number): void;
  thickness(): number;
  setThickness(size: number): void;
  opacity(): number;
  setOpacity(value: number): void;
  hasSelection(): boolean;
  deleteSelected(): void;
  addPicture(): void;

  // ---- fill & sign
  fieldsShown(): boolean;
  toggleFields(): void;
  sign(anchor: HTMLElement): void;
  mark(kind: "check" | "cross" | "dot"): void;
  addDate(): void;

  // ---- organize
  orgSelection(): number[];
  rotatePages(delta: number): void;
  deletePages(): void;
  insert(what: "file" | "blank"): void;
  extract(): void;
  split(): void;
  selectPages(which: "all" | "odd" | "even" | "none"): void;
  tiles(step: number): void;
}

/** Builds Home, Comment, Fill & Sign, Organize and View. */
export function buildTabs(ribbon: Ribbon, ctx: PdfCtx) {
  const T = ctx.lib.AnnotationEditorType;
  const tool = (mode: number) => () => ctx.setMode(ctx.mode() === mode ? T.NONE : mode);
  const reading = () => !ctx.organizing();

  // Home and View each get their own controls (an element can only be in one place).
  const zoomGroup = () => ({
    label: "Zoom",
    controls: [
      stack(
        [combo({ title: "Zoom", width: 78, editable: true, options: () => ctx.zoomChoices(), value: () => ctx.zoomText(), set: (v) => ctx.setZoomText(v), enabled: reading })],
        [
          button({ icon: "zoomOut", title: "Zoom Out", shortcut: "Ctrl+−", run: () => ctx.zoomBy(-1), enabled: reading }),
          button({ icon: "zoomIn", title: "Zoom In", shortcut: "Ctrl+=", run: () => ctx.zoomBy(1), enabled: reading }),
          button({ icon: "fit", title: "Fit Page", shortcut: "Ctrl+0", run: () => ctx.fit("page-fit"), enabled: reading }),
        ]),
      stack(
        [button({ icon: "columns", label: "Fit Width", size: "small", title: "Fit Width", run: () => ctx.fit("page-width"), enabled: reading })],
        [button({ icon: "pageSize", label: "Actual Size", size: "small", title: "Actual Size", run: () => ctx.fit("page-actual"), enabled: reading })]),
    ],
  });

  const rotateGroup = () => ({
    label: "Rotate View",
    controls: [stack(
      [button({ icon: "rotateLeft", label: "Left", size: "small", title: "Rotate View Counterclockwise", shortcut: "Ctrl+Shift+−", run: () => ctx.rotateView(-90), enabled: reading })],
      [button({ icon: "rotateRight", label: "Right", size: "small", title: "Rotate View Clockwise", shortcut: "Ctrl+Shift+=", run: () => ctx.rotateView(90), enabled: reading })])],
  });

  // ---- Home

  const pageField = h("input", { class: "rb-combo-input pf-page-field", type: "text", inputmode: "numeric", "aria-label": "Page number", title: "Page number" });
  pageField.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const n = Number(pageField.value);
      if (Number.isInteger(n) && n >= 1 && n <= ctx.pages()) ctx.go(n);
      pageField.value = String(ctx.page());
      pageField.blur();
    } else if (e.key === "Escape") {
      pageField.value = String(ctx.page());
      pageField.blur();
    }
  });
  const pageTotal = h("span", { class: "pf-page-total" });
  const pageBox = custom(h("div", { class: "rb-combo pf-page-box" }, pageField, pageTotal), () => {
    if (document.activeElement !== pageField) pageField.value = String(ctx.page());
    pageTotal.textContent = `of ${ctx.pages()}`;
  });

  ribbon.tab("home", "Home", [
    {
      label: "Tools",
      controls: [
        button({ icon: "textCursor", label: "Select", size: "large", title: "Select Text", shortcut: "V", run: () => (ctx.setMode(T.NONE), ctx.setTool("select")), active: () => ctx.tool() === "select" && ctx.mode() === T.NONE, enabled: reading }),
        button({ icon: "hand", label: "Hand", size: "large", title: "Hand Tool", shortcut: "H", run: () => (ctx.setMode(T.NONE), ctx.setTool("hand")), active: () => ctx.tool() === "hand" && ctx.mode() === T.NONE, enabled: reading }),
      ],
    },
    zoomGroup(),
    {
      label: "Page",
      controls: [stack(
        [pageBox],
        [
          button({ icon: "prev", title: "First Page", shortcut: "Home", run: () => ctx.go(1), enabled: () => reading() && ctx.page() > 1 }),
          button({ icon: "chevronLeft", title: "Previous Page", shortcut: "Left", run: () => ctx.go(ctx.page() - 1), enabled: () => reading() && ctx.page() > 1 }),
          button({ icon: "chevronRight", title: "Next Page", shortcut: "Right", run: () => ctx.go(ctx.page() + 1), enabled: () => reading() && ctx.page() < ctx.pages() }),
          button({ icon: "next", title: "Last Page", shortcut: "End", run: () => ctx.go(ctx.pages()), enabled: () => reading() && ctx.page() < ctx.pages() }),
        ])],
    },
    rotateGroup(),
    {
      label: "Edit",
      controls: [
        button({ icon: "search", label: "Find", size: "large", title: "Find", shortcut: "Ctrl+F", run: () => ctx.find(), enabled: reading }),
        button({ icon: "highlighter", label: "Highlight", size: "large", title: "Highlight Text", run: tool(T.HIGHLIGHT), active: () => ctx.mode() === T.HIGHLIGHT, enabled: reading }),
        button({ icon: "textBox", label: "Add Text", size: "large", title: "Add Text", run: tool(T.FREETEXT), active: () => ctx.mode() === T.FREETEXT, enabled: reading }),
        button({ icon: "signature", label: "Fill & Sign", size: "large", title: "Fill & Sign", run: () => ribbon.select("sign") }),
        button({ icon: "grid", label: "Organize Pages", size: "large", title: "Organize Pages", run: () => ribbon.select("organize") }),
      ],
    },
    {
      label: "Print",
      controls: [button({ icon: "print", label: "Print", size: "large", title: "Print", shortcut: "Ctrl+P", run: () => ctx.print() })],
    },
  ]);

  // ---- Comment

  const sizes = ["8", "9", "10", "11", "12", "14", "16", "18", "20", "24", "28", "36", "48", "72"];
  ribbon.tab("comment", "Comment", [
    {
      label: "Annotate",
      controls: [
        button({ icon: "highlighter", label: "Highlight", size: "large", title: "Highlight Text (select text, or drag to mark freely)", run: tool(T.HIGHLIGHT), active: () => ctx.mode() === T.HIGHLIGHT, enabled: reading }),
        button({ icon: "textBox", label: "Text Box", size: "large", title: "Add a Text Box (click on the page)", run: tool(T.FREETEXT), active: () => ctx.mode() === T.FREETEXT, enabled: reading }),
        button({ icon: "pencil", label: "Draw", size: "large", title: "Draw Freehand", run: tool(T.INK), active: () => ctx.mode() === T.INK, enabled: reading }),
        button({ icon: "image", label: "Picture", size: "large", title: "Add a Picture…", run: () => ctx.addPicture(), active: () => ctx.mode() === T.STAMP, enabled: reading }),
      ],
    },
    {
      label: "Format",
      controls: [
        stack(
          [colorButton({ icon: "palette", title: "Colour", initial: "#e5484d", noneLabel: "Automatic", apply: (c) => ctx.setColor(c ?? "#000000"), enabled: () => reading() && [T.FREETEXT, T.INK, T.HIGHLIGHT].includes(ctx.mode()) })],
          [combo({ title: "Text Size", width: 46, editable: true, options: () => sizes, value: () => String(ctx.fontSize()), set: (v) => Number(v) > 0 && ctx.setFontSize(Math.min(100, Number(v))), enabled: () => reading() && ctx.mode() === T.FREETEXT })]),
        stack(
          [combo({ title: "Line Thickness", width: 46, options: () => ["1", "2", "3", "5", "8", "12", "20"], value: () => String(ctx.thickness()), set: (v) => ctx.setThickness(Number(v)), enabled: () => reading() && [T.INK, T.HIGHLIGHT].includes(ctx.mode()) })],
          [combo({ title: "Opacity", width: 46, options: () => ["100%", "75%", "50%", "25%"], value: () => `${Math.round(ctx.opacity() * 100)}%`, set: (v) => ctx.setOpacity(Number.parseInt(v, 10) / 100), enabled: () => reading() && ctx.mode() === T.INK })]),
      ],
    },
    {
      label: "Edit",
      controls: [
        button({ icon: "textCursor", label: "Done", size: "large", title: "Stop Annotating (Esc)", run: () => ctx.setMode(T.NONE), enabled: () => ctx.mode() !== T.NONE }),
        button({ icon: "trash", label: "Delete", size: "large", title: "Delete the Selected Comment (Delete)", run: () => ctx.deleteSelected(), enabled: () => ctx.hasSelection() }),
      ],
    },
    {
      label: "Show",
      controls: [button({ icon: "comment", label: "Comments List", size: "large", title: "Show the Comments List", run: () => ctx.setNav(ctx.nav() === "comments" ? null : "comments"), active: () => ctx.nav() === "comments" })],
    },
  ]);

  // ---- Fill & Sign

  const sign = button({ icon: "signature", label: "Sign", size: "large", title: "Sign Yourself: place a signature or initials", run: () => ctx.sign(sign.el), enabled: reading });
  sign.el.classList.add("rb-menu");
  sign.el.setAttribute("aria-haspopup", "dialog");
  sign.el.append(icon("chevronDown", 10));
  ribbon.tab("sign", "Fill & Sign", [
    {
      label: "Fill",
      controls: [
        button({ icon: "textBox", label: "Add Text", size: "large", title: "Add Text (click where it goes)", run: tool(T.FREETEXT), active: () => ctx.mode() === T.FREETEXT, enabled: reading }),
        button({ icon: "calendar", label: "Date", size: "large", title: "Add Today's Date (click where it goes)", run: () => ctx.addDate(), enabled: reading }),
        stack(
          [button({ icon: "check", label: "Check", size: "small", title: "Add a Check Mark (click where it goes)", run: () => ctx.mark("check"), enabled: reading })],
          [button({ icon: "close", label: "Cross", size: "small", title: "Add a Cross (click where it goes)", run: () => ctx.mark("cross"), enabled: reading })],
          [button({ glyph: "●", glyphClass: "sans small", label: "Dot", size: "small", title: "Add a Dot (click where it goes)", run: () => ctx.mark("dot"), enabled: reading })]),
      ],
    },
    {
      label: "Sign",
      controls: [sign],
    },
    {
      label: "Form",
      controls: [button({ icon: "checkSquare", label: "Highlight Fields", size: "large", title: "Highlight the Form's Fields", run: () => ctx.toggleFields(), active: () => ctx.fieldsShown() })],
    },
  ]);

  // ---- Organize

  const many = () => ctx.orgSelection().length > 0;
  ribbon.tab("organize", "Organize", [
    {
      label: "Pages",
      controls: [
        button({ icon: "rotateLeft", label: "Rotate Left", size: "large", title: "Rotate the Selected Pages Counterclockwise", run: () => ctx.rotatePages(-90), enabled: many }),
        button({ icon: "rotateRight", label: "Rotate Right", size: "large", title: "Rotate the Selected Pages Clockwise", run: () => ctx.rotatePages(90), enabled: many }),
        button({ icon: "trash", label: "Delete", size: "large", title: "Delete the Selected Pages (Delete)", run: () => ctx.deletePages(), enabled: () => many() && ctx.orgSelection().length < ctx.pages() }),
      ],
    },
    {
      label: "Insert",
      controls: [
        menuButton({
          icon: "pageAdd", label: "Insert", size: "large", title: "Insert Pages",
          items: () => [
            { label: "From File…", icon: "pageAdd", action: () => ctx.insert("file") },
            { label: "Blank Page", icon: "blankPage", action: () => ctx.insert("blank") },
          ],
        }),
      ],
    },
    {
      label: "Make Files",
      controls: [
        button({ icon: "pageExtract", label: "Extract", size: "large", title: "Extract Pages to a New PDF…", run: () => ctx.extract() }),
        button({ icon: "pageSplit", label: "Split", size: "large", title: "Split into Several PDFs…", run: () => ctx.split(), enabled: () => ctx.pages() > 1 }),
      ],
    },
    {
      label: "Select",
      controls: [stack(
        [button({ label: "All", size: "small", title: "Select All Pages (Ctrl+A)", run: () => ctx.selectPages("all") }), button({ label: "None", size: "small", title: "Select No Pages", run: () => ctx.selectPages("none") })],
        [button({ label: "Odd", size: "small", title: "Select Odd Pages", run: () => ctx.selectPages("odd") }), button({ label: "Even", size: "small", title: "Select Even Pages", run: () => ctx.selectPages("even") })])],
    },
    {
      label: "Thumbnails",
      controls: [stack(
        [button({ icon: "zoomIn", label: "Larger", size: "small", title: "Larger Thumbnails (Ctrl+=)", run: () => ctx.tiles(1) })],
        [button({ icon: "zoomOut", label: "Smaller", size: "small", title: "Smaller Thumbnails (Ctrl+−)", run: () => ctx.tiles(-1) })])],
    },
    {
      label: "Close",
      controls: [button({ icon: "close", label: "Close", size: "large", title: "Back to Reading", run: () => ribbon.select("home") })],
    },
  ]);

  // ---- View

  ribbon.tab("view", "View", [
    {
      label: "Show",
      controls: [
        button({ icon: "sidebar", label: "Navigation Pane", size: "large", title: "Show or Hide the Navigation Pane (F4)", run: () => ctx.setNav(ctx.nav() ? null : "pages"), active: () => !!ctx.nav() }),
        stack(
          [button({ icon: "grid", label: "Pages", size: "small", title: "Page Thumbnails", run: () => ctx.setNav(ctx.nav() === "pages" ? null : "pages"), active: () => ctx.nav() === "pages" })],
          [button({ icon: "bookmark", label: "Bookmarks", size: "small", title: "Bookmarks", run: () => ctx.setNav(ctx.nav() === "bookmarks" ? null : "bookmarks"), active: () => ctx.nav() === "bookmarks" })],
          [button({ icon: "comment", label: "Comments", size: "small", title: "Comments List", run: () => ctx.setNav(ctx.nav() === "comments" ? null : "comments"), active: () => ctx.nav() === "comments" })]),
      ],
    },
    {
      label: "Page Display",
      controls: [
        button({ icon: "pageSingle", label: "Single Page", size: "large", title: "Single Page View", run: () => (ctx.setScroll("page"), ctx.setSpread("none")), active: () => ctx.scroll() === "page" && ctx.spread() === "none", enabled: reading }),
        button({ icon: "pageScroll", label: "Scrolling", size: "large", title: "Enable Scrolling", run: () => (ctx.setScroll("vertical"), ctx.setSpread("none")), active: () => ctx.scroll() === "vertical" && ctx.spread() === "none", enabled: reading }),
        button({ icon: "pageTwo", label: "Two Page", size: "large", title: "Two Page Scrolling", run: () => (ctx.setScroll("vertical"), ctx.setSpread(ctx.spread() === "none" ? "odd" : ctx.spread())), active: () => ctx.spread() !== "none", enabled: reading }),
        stack(
          [button({ icon: "book", label: "Cover Page", size: "small", title: "Show Cover Page in Two Page View", run: () => ctx.setSpread(ctx.spread() === "even" ? "odd" : "even"), active: () => ctx.spread() === "even", enabled: () => reading() && ctx.spread() !== "none" })],
          [button({ icon: "grid", label: "Wrapped", size: "small", title: "Pages Side by Side, Wrapped", run: () => (ctx.setSpread("none"), ctx.setScroll(ctx.scroll() === "wrapped" ? "vertical" : "wrapped")), active: () => ctx.scroll() === "wrapped", enabled: reading })]),
      ],
    },
    zoomGroup(),
    rotateGroup(),
    {
      label: "Read",
      controls: [
        button({ icon: "book", label: "Read Mode", size: "large", title: "Read Mode: the page alone (Ctrl+H)", run: () => ctx.setReadMode(!ctx.readMode()), active: () => ctx.readMode(), enabled: reading }),
        button({ icon: "fullscreen", label: "Full Screen", size: "large", title: "Full Screen, a page at a time (Esc leaves)", run: () => ctx.fullScreen(), enabled: reading }),
        button({ icon: "moon", label: "Dark Pages", size: "large", title: "Dark Pages: light text on dark paper", run: () => ctx.setDark(!ctx.dark()), active: () => ctx.dark() }),
      ],
    },
    {
      label: "Document",
      controls: [
        button({ icon: "info", label: "Properties", size: "large", title: "Document Properties (Ctrl+D)", run: () => ctx.properties() }),
        button({ icon: "paperclip", label: "Attachments", size: "large", title: "Files Attached to the PDF", run: () => ctx.setNav(ctx.nav() === "attachments" ? null : "attachments"), active: () => ctx.nav() === "attachments", enabled: () => ctx.hasAttachments() }),
      ],
    },
  ]);
}
