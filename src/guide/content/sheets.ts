import type { GuideArticle } from "../types";

export const sheets: GuideArticle = {
  id: "sheets",
  title: "Sheets",
  icon: "sheetFile",
  group: "office",
  summary: "An Excel-like spreadsheet with 489 functions that opens and saves .xlsx, .csv and .tsv.",
  open: { module: "office", target: "sheet", label: "Open Sheets" },
  topics: [
    {
      title: "Enter data and formulas",
      steps: [
        "Start from **Blank workbook** or a template (monthly budget, invoice, to-do list, timesheet), or open an .xlsx, .csv or .tsv file.",
        "Click a cell and type. Press {Enter} to go down or {Tab} to go right; {F2} edits the cell.",
        "Start a formula with =. Function names autocomplete; click or drag cells to put their reference in (they're outlined in colour).",
        "Drag the small square at a selection's corner (the fill handle) to fill a series or copy a formula.",
        "Select cells to see their sum in the status bar.",
      ],
      keys: [
        ["Ctrl+→", "Jump to the edge of the data (any arrow; Shift extends)"],
        ["F2", "Edit the cell"],
        ["Alt+Enter", "New line in a cell"],
        ["Ctrl+Enter", "Fill the selection"],
        ["Ctrl+D", "Fill down (Ctrl+R right)"],
        ["Alt+=", "AutoSum"],
        ["Shift+F3", "Insert a function"],
        ["Ctrl+;", "Today's date"],
        ["Ctrl+`", "Show formulas"],
      ],
    },
    {
      title: "Format",
      steps: [
        "The **Home** tab has font, borders, fill, alignment, wrap and merge, and the **Number** formats (taka, accounting, dates, percentages).",
        "Press {Ctrl+1} for **Format Cells** with every option.",
        "**Conditional Formatting** colours cells by rules, data bars, colour scales or icons; **Cell Styles** applies a ready look.",
        "**Insert**, **Delete** and **Format** add or remove rows and columns and set their sizes.",
      ],
    },
    {
      title: "Sort, filter and find",
      steps: [
        "Select the data and use **Data → Sort**, or **Filter** ({Ctrl+Shift+L}) for drop-downs on the header row.",
        "**Data → Highlight Duplicates** marks repeats.",
        "Press {Ctrl+F} to find and {Ctrl+H} to replace.",
        "**Formulas** has the function library by category, **Name Manager** and **Define Name**, **Show Formulas** and **Calculate Now**.",
      ],
      tips: ["Zazabor can't save an AutoFilter into the .xlsx, make charts or pivot tables yet."],
    },
    {
      title: "Sheets, view and print",
      steps: [
        "Use the tabs at the bottom: add, rename, colour, move, hide or delete sheets. {Ctrl+PgUp}/{Ctrl+PgDn} switch, {Shift+F11} adds one.",
        "**View → Freeze Panes** keeps headers in place while you scroll; tick **Gridlines**, **Headings** and **Formula Bar** to show or hide them.",
        "**Page Layout** has **Themes**, **Print** and the **Sheet Options** (view and print gridlines, headings).",
        "**File → Print** shows a preview of the sheet first.",
      ],
    },
  ],
  related: ["office", "docs", "wallet-statements"],
};
