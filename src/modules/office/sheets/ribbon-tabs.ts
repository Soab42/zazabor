import { BorderStyle } from "@ironcalc/wasm";
import type { MenuItem } from "../../../ui/menu";
import { button, colorButton, combo, custom, divider, menuButton, Ribbon, splitButton, stack, type Control } from "../ribbon";
import { CURRENCIES, NUMBER_KINDS, type BorderChoice, type SheetActions } from "./commands";
import { FUNCTION_CATEGORIES } from "./functions";
import { h } from "../../../ui/dom";

export const FONTS = [
  "Calibri", "Arial", "Cambria", "Times New Roman", "Courier New", "Verdana", "Georgia", "Tahoma", "Trebuchet MS", "Segoe UI",
  "Liberation Sans", "Liberation Serif", "Liberation Mono", "DejaVu Sans", "DejaVu Serif", "Noto Sans", "Noto Serif", "Ubuntu", "Inter", "Roboto",
  "Noto Sans Bengali", "Noto Serif Bengali", "Kalpurush", "SolaimanLipi",
];
export const SIZES = ["8", "9", "10", "11", "12", "14", "16", "18", "20", "22", "24", "26", "28", "36", "48", "72"];

/**
 * Excel's ribbon for Sheets: Home, Insert, Page Layout, Formulas, Data, Review and View, with the
 * groups and commands Excel puts there (those the engine can do).
 */
export function buildRibbon(a: SheetActions, onFile: () => void): Ribbon {
  const ribbon = new Ribbon({ tone: "sheet", onFile });
  const st = () => a.current();
  const small = (look: Parameters<typeof button>[0]) => button({ size: "small", ...look });
  const large = (look: Parameters<typeof button>[0]) => button({ size: "large", ...look });

  const borderItems = (): MenuItem[] => {
    const b = (label: string, choice: BorderChoice, icon: "borderBottom" | "borders" = "borders"): MenuItem => ({ label, icon, action: () => a.borders(choice) });
    return [
      b("Bottom Border", "Bottom", "borderBottom"), b("Top Border", "Top"), b("Left Border", "Left"), b("Right Border", "Right"),
      "separator",
      b("No Border", "None"), b("All Borders", "All"), b("Outside Borders", "Outer"), b("Inside Borders", "Inner"), b("Thick Outside Borders", "ThickOuter"),
      "separator",
      b("Bottom Double Border", "DoubleBottom", "borderBottom"), b("Thick Bottom Border", "ThickBottom", "borderBottom"),
      "separator",
      ...([[BorderStyle.Thin, "Thin line"], [BorderStyle.Medium, "Medium line"], [BorderStyle.Thick, "Thick line"], [BorderStyle.Dotted, "Dotted line"], [BorderStyle.MediumDashed, "Dashed line"], [BorderStyle.Double, "Double line"]] as const)
        .map(([style, label]): MenuItem => ({ label: `${a.borderLineStyle() === style ? "✓ " : ""}${label}`, action: () => a.borderLine(style) })),
    ];
  };

  // ---- Home
  ribbon.tab("home", "Home", [
    {
      label: "Clipboard",
      controls: [
        splitButton({ icon: "paste", label: "Paste", size: "large", title: "Paste", shortcut: "Ctrl+V", run: () => void a.paste("all"), items: () => [
          { label: "Paste", icon: "paste", shortcut: "Ctrl+V", action: () => void a.paste("all") },
          { label: "Paste Values", icon: "paste", action: () => void a.paste("values") },
        ] }),
        stack([small({ icon: "cut", label: "Cut", title: "Cut", shortcut: "Ctrl+X", run: () => a.cut() })], [small({ icon: "copy", label: "Copy", title: "Copy", shortcut: "Ctrl+C", run: () => a.copy() })], [small({ icon: "brush", label: "Format Painter", title: "Format Painter: pick up these formats, then select where they go", run: () => a.painter() })]),
      ],
    },
    {
      label: "Font",
      more: { title: "Format Cells: Font", run: () => a.formatCells("font") },
      controls: [stack(
        [
          combo({ title: "Font", width: 128, options: () => FONTS, value: () => st().font.name, set: (v) => (a.fontName(v), a.focus()), editable: true, preview: (v) => ({ fontFamily: `"${v}"` }) }),
          combo({ title: "Font Size", width: 34, options: () => SIZES, value: () => String(st().font.sz), set: (v) => (Number(v) > 0 && a.fontSize(Number(v)), a.focus()), editable: true }),
          small({ glyph: "A", glyphClass: "sans", title: "Increase Font Size", run: () => a.grow(1) }),
          small({ glyph: "A", glyphClass: "sans small", title: "Decrease Font Size", run: () => a.grow(-1) }),
        ],
        [
          small({ glyph: "B", glyphClass: "bold", title: "Bold", shortcut: "Ctrl+B", run: () => a.toggle("font.b"), active: () => st().font.b }),
          small({ glyph: "I", glyphClass: "italic", title: "Italic", shortcut: "Ctrl+I", run: () => a.toggle("font.i"), active: () => st().font.i }),
          small({ glyph: "U", glyphClass: "underline", title: "Underline", shortcut: "Ctrl+U", run: () => a.toggle("font.u"), active: () => st().font.u }),
          small({ glyph: "S", glyphClass: "strike", title: "Strikethrough", shortcut: "Ctrl+5", run: () => a.toggle("font.strike"), active: () => st().font.strike }),
          divider(),
          splitButton({ icon: "borderBottom", size: "small", title: "Borders", run: () => a.borders("Bottom"), items: borderItems }),
          colorButton({ icon: "bucket", title: "Fill Colour", initial: "#ffff00", noneLabel: "No Fill", apply: (c) => a.fillColor(c) }),
          colorButton({ glyph: "A", glyphClass: "sans", title: "Font Colour", initial: "#ff0000", noneLabel: "Automatic", apply: (c) => a.fontColor(c) }),
        ],
      )],
    },
    {
      label: "Alignment",
      more: { title: "Format Cells: Alignment", run: () => a.formatCells("alignment") },
      controls: [
        stack(
          [
            small({ icon: "alignTop", title: "Top Align", run: () => a.valign("top"), active: () => st().alignment?.vertical === "top" }),
            small({ icon: "alignMiddle", title: "Middle Align", run: () => a.valign("center"), active: () => st().alignment?.vertical === "center" }),
            small({ icon: "alignBottom", title: "Bottom Align", run: () => a.valign("bottom"), active: () => (st().alignment?.vertical ?? "bottom") === "bottom" }),
            divider(),
            small({ icon: "wrap", label: "Wrap Text", title: "Wrap Text: show long text on several lines", run: () => a.wrap(), active: () => !!st().alignment?.wrap_text }),
          ],
          [
            small({ icon: "alignLeft", title: "Align Left", run: () => a.align("left"), active: () => st().alignment?.horizontal === "left" }),
            small({ icon: "alignCenter", title: "Center", run: () => a.align("center"), active: () => st().alignment?.horizontal === "center" }),
            small({ icon: "alignRight", title: "Align Right", run: () => a.align("right"), active: () => st().alignment?.horizontal === "right" }),
            divider(),
            splitButton({ icon: "merge", label: "Merge & Center", size: "small", title: "Merge & Center", run: () => a.merge("center"), items: () => [
              { label: "Merge & Center", icon: "merge", action: () => a.merge("center") },
              { label: "Merge Across", icon: "merge", action: () => a.merge("across") },
              { label: "Merge Cells", icon: "merge", action: () => a.merge("merge") },
              { label: "Unmerge Cells", icon: "table", action: () => a.merge("unmerge") },
            ] }),
          ],
        ),
      ],
    },
    {
      label: "Number",
      more: { title: "Format Cells: Number", run: () => a.formatCells("number") },
      controls: [stack(
        [combo({ title: "Number Format", width: 118, options: () => NUMBER_KINDS.map(([, label]) => label), value: () => a.numberKind(), set: (label) => {
          const kind = NUMBER_KINDS.find(([, l]) => l === label)?.[0];
          if (kind) a.numberFormat(kind);
          a.focus();
        } })],
        [
          splitButton({ glyph: "৳", glyphClass: "sans", size: "small", title: "Accounting Number Format", run: () => a.numberFormat("accounting"), items: () => CURRENCIES.map(([sym, label]): MenuItem => ({ label, action: () => a.currency(sym) })) }),
          small({ glyph: "%", glyphClass: "sans", title: "Percent Style", shortcut: "Ctrl+Shift+%", run: () => a.numberFormat("percent") }),
          small({ glyph: ",", glyphClass: "sans", title: "Comma Style", run: () => a.thousands() }),
          small({ glyph: ".0→", glyphClass: "sans small", title: "Increase Decimal", run: () => a.decimals(1) }),
          small({ glyph: "←.0", glyphClass: "sans small", title: "Decrease Decimal", run: () => a.decimals(-1) }),
        ],
      )],
    },
    {
      label: "Styles",
      controls: [
        menuButton({ icon: "palette", label: "Conditional Formatting", size: "large", title: "Conditional Formatting", items: () => [
          { label: "Greater Than…", action: () => a.conditional("greater") },
          { label: "Less Than…", action: () => a.conditional("less") },
          { label: "Between…", action: () => a.conditional("between") },
          { label: "Equal To…", action: () => a.conditional("equal") },
          { label: "Text that Contains…", action: () => a.conditional("text") },
          { label: "Duplicate Values…", action: () => a.conditional("duplicates") },
          "separator",
          { label: "Top 10 Items…", action: () => a.conditional("top10") },
          { label: "Bottom 10 Items…", action: () => a.conditional("bottom10") },
          { label: "Above Average…", action: () => a.conditional("above") },
          { label: "Below Average…", action: () => a.conditional("below") },
          "separator",
          { label: "Data Bars", icon: "chart", action: () => a.conditional("databar") },
          { label: "Colour Scale (2 colours)", icon: "palette", action: () => a.conditional("scale2") },
          { label: "Colour Scale (red, yellow, green)", icon: "palette", action: () => a.conditional("scale3") },
          { label: "Icon Set (arrows)", icon: "arrowUp", action: () => a.conditional("icons") },
          "separator",
          { label: "Clear Rules from Selected Cells", icon: "eraser", action: () => a.clearConditional("selection") },
          { label: "Clear Rules from Entire Sheet", icon: "eraser", action: () => a.clearConditional("sheet") },
        ] }),
        menuButton({ icon: "brush", label: "Cell Styles", size: "large", title: "Cell Styles", items: () => a.cellStyles().map((name): MenuItem => ({ label: name, action: () => a.cellStyle(name) })) }),
      ],
    },
    {
      label: "Cells",
      controls: [
        menuButton({ icon: "rowInsert", label: "Insert", size: "large", title: "Insert", items: () => [
          { label: "Insert Sheet Rows", icon: "rowInsert", action: () => a.insert("rows") },
          { label: "Insert Sheet Columns", icon: "colInsert", action: () => a.insert("columns") },
          { label: "Insert Sheet", icon: "sheetAdd", shortcut: "Shift+F11", action: () => a.insert("sheet") },
        ] }),
        menuButton({ icon: "rowDelete", label: "Delete", size: "large", title: "Delete", items: () => [
          { label: "Delete Sheet Rows", icon: "rowDelete", action: () => a.remove("rows") },
          { label: "Delete Sheet Columns", icon: "colDelete", action: () => a.remove("columns") },
          { label: "Delete Sheet", icon: "trash", action: () => a.remove("sheet") },
        ] }),
        menuButton({ icon: "table", label: "Format", size: "large", title: "Format", items: () => [
          { label: "Row Height…", icon: "rowHeight", action: () => a.size("rows") },
          { label: "AutoFit Row Height", icon: "rowHeight", action: () => a.autofit("rows") },
          { label: "Column Width…", icon: "colWidth", action: () => a.size("columns") },
          { label: "AutoFit Column Width", icon: "colWidth", action: () => a.autofit("columns") },
          "separator",
          { label: "Hide Rows", icon: "eyeOff", shortcut: "Ctrl+9", action: () => a.hide("rows", true) },
          { label: "Hide Columns", icon: "eyeOff", shortcut: "Ctrl+0", action: () => a.hide("columns", true) },
          { label: "Unhide Rows", icon: "eye", action: () => a.hide("rows", false) },
          { label: "Unhide Columns", icon: "eye", action: () => a.hide("columns", false) },
          "separator",
          { label: "Format Cells…", icon: "table", shortcut: "Ctrl+1", action: () => a.formatCells() },
        ] }),
      ],
    },
    {
      label: "Editing",
      controls: [stack(
        [splitButton({ glyph: "Σ", glyphClass: "sans", label: "AutoSum", size: "small", title: "AutoSum", shortcut: "Alt+=", run: () => a.autoSum("SUM"), items: () => ["SUM", "AVERAGE", "COUNT", "MAX", "MIN"].map((fn): MenuItem => ({ label: fn[0] + fn.slice(1).toLowerCase(), action: () => a.autoSum(fn) })).concat([{ label: "More Functions…", action: () => a.insertFunction() }]) })],
        [menuButton({ icon: "arrowUp", label: "Fill", size: "small", title: "Fill", items: () => [
          { label: "Down", shortcut: "Ctrl+D", action: () => a.fill("down") },
          { label: "Right", shortcut: "Ctrl+R", action: () => a.fill("right") },
        ] })],
        [menuButton({ icon: "eraser", label: "Clear", size: "small", title: "Clear", items: () => [
          { label: "Clear All", action: () => a.clear("all") },
          { label: "Clear Formats", action: () => a.clear("formats") },
          { label: "Clear Contents", shortcut: "Delete", action: () => a.clear("contents") },
        ] })],
      ), stack(
        [menuButton({ icon: "sortCustom", label: "Sort & Filter", size: "small", title: "Sort & Filter", items: () => [
          { label: "Sort A to Z", icon: "sortAsc", action: () => a.sort(true) },
          { label: "Sort Z to A", icon: "sortDesc", action: () => a.sort(false) },
          "separator",
          { label: a.filterOn() ? "Remove Filter" : "Filter", icon: "filter", shortcut: "Ctrl+Shift+L", action: () => a.toggleFilter() },
          { label: "Clear Filter", icon: "eraser", disabled: !a.filterOn(), action: () => a.clearFilter() },
        ] })],
        [menuButton({ icon: "search", label: "Find & Select", size: "small", title: "Find & Select", items: () => [
          { label: "Find…", icon: "search", shortcut: "Ctrl+F", action: () => a.find(false) },
          { label: "Replace…", icon: "replace", shortcut: "Ctrl+H", action: () => a.find(true) },
          { label: "Go To…", icon: "arrowUp", shortcut: "Ctrl+G", action: () => a.goTo() },
        ] })],
      )],
    },
  ]);

  // ---- Insert
  ribbon.tab("insert", "Insert", [
    { label: "Functions", controls: [large({ glyph: "fx", glyphClass: "italic", label: "Function", title: "Insert Function", shortcut: "Shift+F3", run: () => a.insertFunction() })] },
    { label: "Links", controls: [large({ icon: "link", label: "Link", title: "Insert Link", shortcut: "Ctrl+K", run: () => a.link() })] },
    { label: "Cells", controls: [
      large({ icon: "rowInsert", label: "Rows", title: "Insert Sheet Rows", run: () => a.insert("rows") }),
      large({ icon: "colInsert", label: "Columns", title: "Insert Sheet Columns", run: () => a.insert("columns") }),
      large({ icon: "sheetAdd", label: "Sheet", title: "Insert Sheet", shortcut: "Shift+F11", run: () => a.insert("sheet") }),
    ] },
    { label: "Text", controls: [
      large({ icon: "calendar", label: "Date", title: "Insert today's date", shortcut: "Ctrl+;", run: () => a.edit(new Date().toLocaleDateString("en-GB")) }),
      large({ icon: "clock", label: "Time", title: "Insert the time", shortcut: "Ctrl+Shift+:", run: () => a.edit(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })) }),
    ] },
  ]);

  // ---- Page Layout
  ribbon.tab("layout", "Page Layout", [
    { label: "Themes", controls: [menuButton({ icon: "palette", label: "Themes", size: "large", title: "Themes: the workbook's colours", items: () => a.themes().map((t): MenuItem => ({ label: t.name, action: () => a.setTheme(t) })) })] },
    { label: "Page Setup", controls: [large({ icon: "print", label: "Print", title: "Print", shortcut: "Ctrl+P", run: () => a.print() })] },
    { label: "Sheet Options", controls: [stack(
      [small({ icon: "gridlines", label: "View Gridlines", title: "View gridlines", run: () => a.setGridlines(!a.gridlines()), active: () => a.gridlines() })],
      [small({ icon: "print", label: "Print Gridlines", title: "Print gridlines", run: () => a.setPrintGridlines(!a.printGridlines()), active: () => a.printGridlines() })],
      [small({ icon: "table", label: "Headings", title: "View headings", run: () => a.setHeadings(!a.headings()), active: () => a.headings() })],
    )] },
  ]);

  // ---- Formulas
  const category = (name: string, label: string, icon: Parameters<typeof button>[0]["icon"]): Control =>
    menuButton({ icon, label, size: "large", title: label, items: () => FUNCTION_CATEGORIES[name].slice(0, 60).map((fn): MenuItem => ({ label: fn, action: () => a.insertNamed(fn) })).concat(FUNCTION_CATEGORIES[name].length > 60 ? [{ label: "More…", action: () => a.insertFunction(name) }] : []) });
  ribbon.tab("formulas", "Formulas", [
    { label: "Function Library", controls: [
      large({ glyph: "fx", glyphClass: "italic", label: "Insert Function", title: "Insert Function", shortcut: "Shift+F3", run: () => a.insertFunction() }),
      splitButton({ glyph: "Σ", glyphClass: "sans", label: "AutoSum", size: "large", title: "AutoSum", run: () => a.autoSum("SUM"), items: () => ["SUM", "AVERAGE", "COUNT", "MAX", "MIN"].map((fn): MenuItem => ({ label: fn, action: () => a.autoSum(fn) })) }),
      category("Financial", "Financial", "wallet"),
      category("Logical", "Logical", "checkSquare"),
      category("Text", "Text", "textBox"),
      category("Date & Time", "Date & Time", "calendar"),
      category("Lookup & Reference", "Lookup & Reference", "search"),
      category("Math & Trig", "Math & Trig", "symbol"),
      menuButton({ icon: "more", label: "More Functions", size: "large", title: "More Functions", items: () => ["Statistical", "Engineering", "Information", "Database"].map((c): MenuItem => ({ label: c, action: () => a.insertFunction(c) })) }),
    ] },
    { label: "Defined Names", controls: [
      large({ icon: "tag", label: "Name Manager", title: "Name Manager", run: () => a.names() }),
      large({ icon: "tag", label: "Define Name", title: "Define Name for the selection", run: () => a.names(true) }),
    ] },
    { label: "Formula Auditing", controls: [large({ icon: "eye", label: "Show Formulas", title: "Show Formulas", shortcut: "Ctrl+`", run: () => a.setShowFormulas(!a.showFormulas()), active: () => a.showFormulas() })] },
    { label: "Calculation", controls: [large({ icon: "refresh", label: "Calculate Now", title: "Calculate Now", run: () => a.calculate() })] },
  ]);

  // ---- Data
  ribbon.tab("data", "Data", [
    { label: "Sort & Filter", controls: [
      stack([small({ icon: "sortAsc", title: "Sort A to Z", run: () => a.sort(true) })], [small({ icon: "sortDesc", title: "Sort Z to A", run: () => a.sort(false) })]),
      large({ icon: "sortCustom", label: "Sort", title: "Sort by the active cell's column", run: () => a.sort(true) }),
      large({ icon: "filter", label: "Filter", title: "Filter", shortcut: "Ctrl+Shift+L", run: () => a.toggleFilter(), active: () => a.filterOn() }),
      large({ icon: "eraser", label: "Clear", title: "Clear Filter: show every row", run: () => a.clearFilter(), enabled: () => a.filterOn() }),
    ] },
    { label: "Data Tools", controls: [
      large({ icon: "palette", label: "Highlight Duplicates", title: "Highlight duplicate values", run: () => a.conditional("duplicates") }),
      large({ icon: "tag", label: "Names", title: "Name Manager", run: () => a.names() }),
    ] },
  ]);

  // ---- Review
  ribbon.tab("review", "Review", [
    { label: "Proofing", controls: [large({ icon: "search", label: "Find", title: "Find", shortcut: "Ctrl+F", run: () => a.find(false) }), large({ icon: "replace", label: "Replace", title: "Replace", shortcut: "Ctrl+H", run: () => a.find(true) })] },
  ]);

  // ---- View
  const zoomField = custom(h("div", { class: "rb-stack" }), () => {});
  ribbon.tab("view", "View", [
    { label: "Show", controls: [stack(
      [small({ icon: "gridlines", label: "Gridlines", title: "Gridlines", run: () => a.setGridlines(!a.gridlines()), active: () => a.gridlines() })],
      [small({ icon: "table", label: "Headings", title: "Headings", run: () => a.setHeadings(!a.headings()), active: () => a.headings() })],
      [small({ glyph: "fx", glyphClass: "italic", label: "Formula Bar", title: "Formula Bar", run: () => a.setFormulaBar(!a.formulaBar()), active: () => a.formulaBar() })],
    )] },
    { label: "Zoom", controls: [
      menuButton({ icon: "zoomIn", label: "Zoom", size: "large", title: "Zoom", items: () => [200, 150, 125, 100, 90, 75, 50, 25].map((z): MenuItem => ({ label: `${z}%${Math.round(a.zoom() * 100) === z ? "  ✓" : ""}`, action: () => a.setZoom(z / 100) })) }),
      large({ icon: "zoomFit", label: "100%", title: "Zoom to 100%", run: () => a.setZoom(1) }),
      zoomField,
    ] },
    { label: "Window", controls: [menuButton({ icon: "freeze", label: "Freeze Panes", size: "large", title: "Freeze Panes", items: () => [
      { label: "Freeze Panes (above and left of the active cell)", icon: "freeze", action: () => a.freeze("panes") },
      { label: "Freeze Top Row", icon: "freeze", action: () => a.freeze("row") },
      { label: "Freeze First Column", icon: "freeze", action: () => a.freeze("column") },
      ...(a.frozen() ? [{ label: "Unfreeze Panes", icon: "snowflake" as const, action: () => a.freeze("none") }] : []),
    ] })] },
  ]);
  return ribbon;
}
