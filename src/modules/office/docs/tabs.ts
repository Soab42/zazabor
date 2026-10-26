import type { Editor } from "@tiptap/core";
import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { openMenu, type MenuItem } from "../../../ui/menu";
import { button, colorButton, combo, custom, menuButton, splitButton, stack, type Group, type Ribbon } from "../ribbon";
import { dateFormats, linkDialog, paragraphDialog, symbolPicker, tablePicker } from "./dialogs";
import type { PageView } from "./page";
import { MARGIN_PRESETS, PAGE_SIZES, type PageSetup, type PageSize } from "./read";
import { availableFonts, currentStyle, DEFAULT_FONT, DEFAULT_SIZE, FONT_SIZES, STYLES, type DocStyle } from "./schema";

/** What the ribbon works on. */
export interface DocsContext {
  editor: Editor;
  view: PageView;
  setPage(page: PageSetup): void;
  painter: { active(): boolean; start(): void };
  marks: { on(): boolean; toggle(): void };
  spelling: { on(): boolean; toggle(): void };
  find(replace: boolean): void;
  insertPicture(): void;
  paste(plain: boolean): void;
  wordCount(): void;
}

const chain = (c: DocsContext) => c.editor.chain().focus();

/** The font size at the cursor, in points (the default when it has none of its own). */
export function sizeAt(editor: Editor): number {
  return Number.parseFloat(editor.getAttributes("textStyle").fontSize ?? "") || DEFAULT_SIZE;
}

function stepSize(c: DocsContext, up: boolean) {
  const size = sizeAt(c.editor);
  const next = up ? FONT_SIZES.find((s) => s > size) ?? size + 10 : [...FONT_SIZES].reverse().find((s) => s < size) ?? Math.max(1, size - 1);
  chain(c).setFontSize(`${next}pt`).run();
}

export function applyStyle(c: DocsContext, style: DocStyle) {
  const ch = chain(c);
  if (style === "code") return void ch.setCodeBlock().run();
  if (c.editor.isActive("codeBlock")) ch.toggleCodeBlock();
  if (style === "h1" || style === "h2" || style === "h3") return void ch.setHeading({ level: Number(style[1]) as 1 | 2 | 3 }).setParagraphFormat({ docStyle: null }).run();
  ch.setParagraph().setParagraphFormat({ docStyle: style === "normal" ? null : style }).run();
}

function styleNow(c: DocsContext): DocStyle {
  return currentStyle((n, a) => c.editor.isActive(n, a), c.editor.state.selection.$from.parent.attrs.docStyle ?? null);
}

/** The Styles gallery: four cards that show their style, and the rest behind ▾. */
function styleGallery(c: DocsContext) {
  const shown: DocStyle[] = ["normal", "h1", "h2", "title"];
  const cards = shown.map((id) => {
    const name = STYLES.find((s) => s.id === id)!.name;
    const b = h("button", { class: `dc-style-card s-${id}`, type: "button", title: name, onmousedown: (e: Event) => e.preventDefault(), onclick: () => applyStyle(c, id) },
      h("span", { class: "dc-style-preview" }, "AaBbCc"), h("span", { class: "dc-style-name" }, name));
    return [id, b] as const;
  });
  const more = h("button", {
    class: "dc-style-more", type: "button", title: "All styles", "aria-label": "All styles", onmousedown: (e: Event) => e.preventDefault(),
    onclick: () => {
      const r = more.getBoundingClientRect();
      const now = styleNow(c);
      openMenu(r.left - 200, r.bottom + 2, STYLES.map((s) => ({ label: s.name, icon: s.id === now ? "check" : undefined, action: () => applyStyle(c, s.id) })));
    },
  }, icon("chevronDown", 12));
  const el = h("div", { class: "dc-styles" }, ...cards.map(([, b]) => b), more);
  return custom(el, () => {
    const now = styleNow(c);
    for (const [id, b] of cards) b.classList.toggle("on", id === now);
  });
}

/** A spin box in points for the Layout tab (indent, spacing). */
function pointField(label: string, value: () => number | null, set: (v: number | null) => void, presets: number[]) {
  const box = combo({
    title: label, width: 44, editable: true,
    options: () => presets.map((p) => `${p} pt`),
    value: () => `${value() ?? 0} pt`,
    set: (v) => {
      const n = Number.parseFloat(v);
      set(Number.isFinite(n) ? n : null);
    },
  });
  return custom(h("label", { class: "dc-point-field" }, h("span", null, label), box.el), box.refresh);
}

function attrsAt(c: DocsContext) {
  return c.editor.state.selection.$from.parent.attrs as Record<string, number | null>;
}

export function buildTabs(ribbon: Ribbon, c: DocsContext) {
  const e = c.editor;
  const fonts = availableFonts();
  const listNode = () => (e.isActive("taskList") ? "taskItem" : "listItem");

  // ---- Home
  const clipboard: Group = {
    label: "Clipboard",
    controls: [
      splitButton({
        icon: "paste", label: "Paste", size: "large", title: "Paste", shortcut: "Ctrl+V", run: () => c.paste(false),
        items: () => [
          { label: "Keep Source Formatting", icon: "paste", shortcut: "Ctrl+V", action: () => c.paste(false) },
          { label: "Keep Text Only", icon: "docFile", shortcut: "Ctrl+Shift+V", action: () => c.paste(true) },
        ],
      }),
      stack(
        [button({ icon: "cut", label: "Cut", title: "Cut", shortcut: "Ctrl+X", run: () => (e.commands.focus(), document.execCommand("cut")) })],
        [button({ icon: "copy", label: "Copy", title: "Copy", shortcut: "Ctrl+C", run: () => (e.commands.focus(), document.execCommand("copy")) })],
        [button({ icon: "brush", label: "Format Painter", title: "Format Painter: copy this formatting, then select text to paint it on", run: () => c.painter.start(), active: () => c.painter.active() })],
      ),
    ],
  };
  const font: Group = {
    label: "Font",
    more: { title: "Paragraph…", run: () => paragraphDialog(e) },
    controls: [stack(
      [
        combo({
          title: "Font", width: 132, editable: true, options: () => fonts,
          value: () => String(e.getAttributes("textStyle").fontFamily ?? DEFAULT_FONT).replace(/^['"]|['"]$/g, ""),
          set: (v) => chain(c).setFontFamily(/\s/.test(v) ? `'${v}'` : v).run(),
          preview: (v) => ({ fontFamily: `'${v}'` }),
        }),
        combo({
          title: "Font Size", width: 34, editable: true, options: () => FONT_SIZES.map(String),
          value: () => String(sizeAt(e)),
          set: (v) => {
            const n = Number.parseFloat(v);
            if (n >= 1 && n <= 1638) chain(c).setFontSize(`${n}pt`).run();
          },
        }),
        button({ glyph: "A", glyphClass: "sans grow", title: "Increase Font Size", shortcut: "Ctrl+Shift+>", run: () => stepSize(c, true) }),
        button({ glyph: "A", glyphClass: "sans shrink", title: "Decrease Font Size", shortcut: "Ctrl+Shift+<", run: () => stepSize(c, false) }),
        button({ icon: "eraser", title: "Clear All Formatting", run: () => chain(c).unsetAllMarks().setParagraphFormat({ lineHeight: null, spaceBefore: null, spaceAfter: null, indent: null, firstLine: null, docStyle: null }).unsetTextAlign().run() }),
      ],
      [
        button({ glyph: "B", glyphClass: "bold", title: "Bold", shortcut: "Ctrl+B", run: () => chain(c).toggleBold().run(), active: () => e.isActive("bold") }),
        button({ glyph: "I", glyphClass: "italic", title: "Italic", shortcut: "Ctrl+I", run: () => chain(c).toggleItalic().run(), active: () => e.isActive("italic") }),
        button({ glyph: "U", glyphClass: "underline", title: "Underline", shortcut: "Ctrl+U", run: () => chain(c).toggleUnderline().run(), active: () => e.isActive("underline") }),
        button({ glyph: "ab", glyphClass: "strike", title: "Strikethrough", run: () => chain(c).toggleStrike().run(), active: () => e.isActive("strike") }),
        button({ glyph: "x₂", glyphClass: "sans", title: "Subscript", shortcut: "Ctrl+=", run: () => chain(c).toggleSubscript().run(), active: () => e.isActive("subscript") }),
        button({ glyph: "x²", glyphClass: "sans", title: "Superscript", shortcut: "Ctrl+Shift++", run: () => chain(c).toggleSuperscript().run(), active: () => e.isActive("superscript") }),
        colorButton({ icon: "highlighter", title: "Text Highlight Colour", initial: "#ffff00", noneLabel: "No Colour", apply: (color) => (color ? chain(c).setHighlight({ color }).run() : chain(c).unsetHighlight().run()) }),
        colorButton({ glyph: "A", glyphClass: "sans", title: "Font Colour", initial: "#c00000", noneLabel: "Automatic", apply: (color) => (color ? chain(c).setColor(color).run() : chain(c).unsetColor().run()) }),
      ],
    )],
  };
  const spacingItems = (): MenuItem[] => {
    const now = attrsAt(c).lineHeight;
    return [
      ...[1, 1.15, 1.5, 2, 2.5, 3].map((v): MenuItem => ({ label: Number.isInteger(v) ? v.toFixed(1) : String(v), icon: now === v ? "check" : undefined, action: () => chain(c).setParagraphFormat({ lineHeight: v }).run() })),
      "separator",
      { label: "Line Spacing Options…", action: () => paragraphDialog(e) },
      { label: (attrsAt(c).spaceBefore ?? 0) > 0 ? "Remove Space Before Paragraph" : "Add Space Before Paragraph", action: () => chain(c).setParagraphFormat({ spaceBefore: (attrsAt(c).spaceBefore ?? 0) > 0 ? null : 12 }).run() },
      { label: attrsAt(c).spaceAfter === 0 ? "Add Space After Paragraph" : "Remove Space After Paragraph", action: () => chain(c).setParagraphFormat({ spaceAfter: attrsAt(c).spaceAfter === 0 ? null : 0 }).run() },
    ];
  };
  const indent = (step: number) => {
    if (e.isActive("listItem") || e.isActive("taskItem")) return step > 0 ? chain(c).sinkListItem(listNode()).run() : chain(c).liftListItem(listNode()).run();
    const now = attrsAt(c).indent ?? 0;
    return chain(c).setParagraphFormat({ indent: Math.max(0, now + step * 36) || null }).run();
  };
  const paragraph: Group = {
    label: "Paragraph",
    more: { title: "Paragraph…", run: () => paragraphDialog(e) },
    controls: [stack(
      [
        button({ icon: "bullets", title: "Bullets", run: () => chain(c).toggleBulletList().run(), active: () => e.isActive("bulletList") }),
        button({ icon: "numbers", title: "Numbering", run: () => chain(c).toggleOrderedList().run(), active: () => e.isActive("orderedList") }),
        button({ icon: "checklist", title: "Checklist", run: () => chain(c).toggleTaskList().run(), active: () => e.isActive("taskList") }),
        button({ icon: "outdent", title: "Decrease Indent", run: () => indent(-1) }),
        button({ icon: "indent", title: "Increase Indent", run: () => indent(1) }),
        button({ icon: "pilcrow", title: "Show Paragraph Marks", run: () => c.marks.toggle(), active: () => c.marks.on() }),
      ],
      [
        button({ icon: "alignLeft", title: "Align Left", shortcut: "Ctrl+L", run: () => chain(c).setTextAlign("left").run(), active: () => !e.isActive({ textAlign: "center" }) && !e.isActive({ textAlign: "right" }) && !e.isActive({ textAlign: "justify" }) }),
        button({ icon: "alignCenter", title: "Centre", shortcut: "Ctrl+E", run: () => chain(c).setTextAlign("center").run(), active: () => e.isActive({ textAlign: "center" }) }),
        button({ icon: "alignRight", title: "Align Right", shortcut: "Ctrl+R", run: () => chain(c).setTextAlign("right").run(), active: () => e.isActive({ textAlign: "right" }) }),
        button({ icon: "alignJustify", title: "Justify", shortcut: "Ctrl+J", run: () => chain(c).setTextAlign("justify").run(), active: () => e.isActive({ textAlign: "justify" }) }),
        menuButton({ icon: "lineSpacing", title: "Line and Paragraph Spacing", items: spacingItems }),
        button({ icon: "rule", title: "Horizontal Line", run: () => chain(c).setHorizontalRule().run() }),
      ],
    )],
  };
  const editing: Group = {
    label: "Editing",
    controls: [stack(
      [button({ icon: "search", label: "Find", title: "Find", shortcut: "Ctrl+F", run: () => c.find(false) })],
      [button({ icon: "replace", label: "Replace", title: "Replace", shortcut: "Ctrl+H", run: () => c.find(true) })],
      [button({ icon: "checkSquare", label: "Select All", title: "Select All", shortcut: "Ctrl+A", run: () => chain(c).selectAll().run() })],
    )],
  };
  ribbon.tab("home", "Home", [clipboard, font, paragraph, { label: "Styles", controls: [styleGallery(c)], more: { title: "All styles", run: () => applyStyle(c, "normal") } }, editing]);

  // ---- Insert
  const tableControl = button({ icon: "table", label: "Table ▾", size: "large", title: "Insert a table", run: () => tablePicker(tableControl.el, (rows, cols) => chain(c).insertTable({ rows, cols, withHeaderRow: false }).run()) });
  const symbolControl = button({ icon: "symbol", label: "Symbol ▾", size: "large", title: "Insert a symbol", run: () => symbolPicker(symbolControl.el, (s) => chain(c).insertContent(s).run()) });
  ribbon.tab("insert", "Insert", [
    { label: "Pages", controls: [button({ icon: "pageBreak", label: "Page Break", size: "large", title: "Page Break", shortcut: "Ctrl+Enter", run: () => chain(c).setPageBreak().run() })] },
    { label: "Tables", controls: [tableControl] },
    { label: "Illustrations", controls: [button({ icon: "image", label: "Pictures", size: "large", title: "Insert a picture from a file", run: () => c.insertPicture() })] },
    { label: "Links", controls: [button({ icon: "link", label: "Link", size: "large", title: "Insert Link", shortcut: "Ctrl+K", run: () => linkDialog(e), active: () => e.isActive("link") })] },
    {
      label: "Text",
      controls: [
        button({ icon: "rule", label: "Horizontal Line", size: "large", title: "Horizontal Line", run: () => chain(c).setHorizontalRule().run() }),
        menuButton({ icon: "calendar", label: "Date & Time", size: "large", title: "Insert the date or time", items: () => dateFormats().map((f) => ({ label: f, action: () => chain(c).insertContent(f).run() })) }),
      ],
    },
    { label: "Symbols", controls: [symbolControl] },
  ]);

  // ---- Layout
  const page = () => c.view.setup;
  const marginItems = (): MenuItem[] => MARGIN_PRESETS.map((p) => {
    const m = page().margins;
    const now = m.top === p.margins.top && m.left === p.margins.left && m.right === p.margins.right && m.bottom === p.margins.bottom;
    const inch = (v: number) => `${(v / 72).toFixed(2).replace(/\.?0+$/, "")}″`;
    return { label: `${p.name}  ·  top ${inch(p.margins.top)}, sides ${inch(p.margins.left)}`, icon: now ? "check" : undefined, action: () => c.setPage({ ...page(), margins: { ...p.margins } }) };
  });
  const sizeItems = (): MenuItem[] => (Object.entries(PAGE_SIZES) as [Exclude<PageSize, "custom">, (typeof PAGE_SIZES)["a4"]][]).map(([id, s]) => ({
    label: `${s.name}  ·  ${s.note}`,
    icon: page().size === id ? "check" : undefined,
    action: () => c.setPage({ ...page(), size: id, width: s.width, height: s.height }),
  }));
  ribbon.tab("layout", "Layout", [
    {
      label: "Page Setup",
      controls: [
        menuButton({ icon: "margins", label: "Margins", size: "large", title: "Margins", items: marginItems }),
        menuButton({ icon: "orientation", label: "Orientation", size: "large", title: "Orientation", items: () => [
          { label: "Portrait", icon: page().orientation === "portrait" ? "check" : undefined, action: () => c.setPage({ ...page(), orientation: "portrait" }) },
          { label: "Landscape", icon: page().orientation === "landscape" ? "check" : undefined, action: () => c.setPage({ ...page(), orientation: "landscape" }) },
        ] }),
        menuButton({ icon: "pageSize", label: "Size", size: "large", title: "Paper size", items: sizeItems }),
        button({ icon: "pageBreak", label: "Breaks", size: "large", title: "Page Break", shortcut: "Ctrl+Enter", run: () => chain(c).setPageBreak().run() }),
      ],
    },
    {
      label: "Paragraph",
      more: { title: "Paragraph…", run: () => paragraphDialog(e) },
      controls: [
        stack(
          [custom(h("span", { class: "dc-field-head" }, "Indent"))],
          [pointField("Left", () => attrsAt(c).indent, (v) => chain(c).setParagraphFormat({ indent: v || null }).run(), [0, 18, 36, 54, 72, 108, 144])],
          [pointField("First", () => attrsAt(c).firstLine, (v) => chain(c).setParagraphFormat({ firstLine: v || null }).run(), [-36, -18, 0, 18, 36])],
        ),
        stack(
          [custom(h("span", { class: "dc-field-head" }, "Spacing"))],
          [pointField("Before", () => attrsAt(c).spaceBefore, (v) => chain(c).setParagraphFormat({ spaceBefore: v }).run(), [0, 6, 12, 18, 24])],
          [pointField("After", () => attrsAt(c).spaceAfter ?? 8, (v) => chain(c).setParagraphFormat({ spaceAfter: v }).run(), [0, 6, 8, 12, 18, 24])],
        ),
      ],
    },
  ]);

  // ---- Review
  ribbon.tab("review", "Review", [
    {
      label: "Proofing",
      controls: [
        button({ icon: "spell", label: "Spelling", size: "large", title: "Mark spelling mistakes as you type", run: () => c.spelling.toggle(), active: () => c.spelling.on() }),
        button({ icon: "docFile", label: "Word Count", size: "large", title: "Word Count", run: () => c.wordCount() }),
      ],
    },
  ]);

  // ---- View
  ribbon.tab("view", "View", [
    {
      label: "Views",
      controls: [
        button({ icon: "docFile", label: "Print Layout", size: "large", title: "Print Layout: pages as they print", run: () => c.view.setLayout("print"), active: () => c.view.layout === "print" }),
        button({ icon: "desktop", label: "Web Layout", size: "large", title: "Web Layout: text fills the window", run: () => c.view.setLayout("web"), active: () => c.view.layout === "web" }),
      ],
    },
    { label: "Show", controls: [button({ icon: "pilcrow", label: "Formatting Marks", size: "large", title: "Show paragraph marks and page breaks", run: () => c.marks.toggle(), active: () => c.marks.on() })] },
    {
      label: "Zoom",
      controls: [
        button({ icon: "zoomIn", label: "Zoom In", size: "large", title: "Zoom In", run: () => c.view.setZoom(c.view.zoom + 0.1) }),
        button({ icon: "zoomOut", label: "Zoom Out", size: "large", title: "Zoom Out", run: () => c.view.setZoom(c.view.zoom - 0.1) }),
        stack(
          [button({ icon: "fit", label: "100%", title: "Zoom to 100%", run: () => c.view.setZoom(1) })],
          [button({ icon: "zoomFit", label: "One Page", title: "Fit one page in the window", run: () => c.view.onePage() })],
          [button({ icon: "colWidth", label: "Page Width", title: "Fit the page's width", run: () => c.view.fitWidth() })],
        ),
      ],
    },
  ]);

  // ---- Table (while the cursor is in one)
  const inTable = () => e.isActive("table");
  ribbon.tab("table", "Table", [
    {
      label: "Rows & Columns",
      controls: [
        button({ icon: "rowInsert", label: "Insert Above", size: "large", title: "Insert a row above", run: () => chain(c).addRowBefore().run() }),
        button({ icon: "rowInsert", label: "Insert Below", size: "large", title: "Insert a row below", run: () => chain(c).addRowAfter().run() }),
        button({ icon: "colInsert", label: "Insert Left", size: "large", title: "Insert a column to the left", run: () => chain(c).addColumnBefore().run() }),
        button({ icon: "colInsert", label: "Insert Right", size: "large", title: "Insert a column to the right", run: () => chain(c).addColumnAfter().run() }),
      ],
    },
    {
      label: "Delete",
      controls: [stack(
        [button({ icon: "rowDelete", label: "Delete Rows", title: "Delete the selected rows", run: () => chain(c).deleteRow().run() })],
        [button({ icon: "colDelete", label: "Delete Columns", title: "Delete the selected columns", run: () => chain(c).deleteColumn().run() })],
        [button({ icon: "trash", label: "Delete Table", title: "Delete the table", run: () => chain(c).deleteTable().run() })],
      )],
    },
    {
      label: "Merge",
      controls: [
        button({ icon: "merge", label: "Merge Cells", size: "large", title: "Merge the selected cells", run: () => chain(c).mergeCells().run(), enabled: () => e.can().mergeCells() }),
        button({ icon: "columns", label: "Split Cells", size: "large", title: "Split the merged cell", run: () => chain(c).splitCell().run(), enabled: () => e.can().splitCell() }),
      ],
    },
    {
      label: "Options",
      controls: [stack(
        [button({ icon: "table", label: "Header Row", title: "The first row is a header", run: () => chain(c).toggleHeaderRow().run() })],
        [button({ icon: "table", label: "First Column", title: "The first column is a header", run: () => chain(c).toggleHeaderColumn().run() })],
      )],
    },
    {
      label: "Shading",
      controls: [colorButton({ icon: "bucket", title: "Cell Shading", initial: "#deeaf6", noneLabel: "No Colour", apply: (color) => chain(c).setCellAttribute("background", color).run() })],
    },
  ], inTable);
}
