# Docs and Sheets: a word processor and an Excel-compatible spreadsheet (plan, draft)

*Researched 2026-10-26. Licences, versions and release dates were read from each project's
repository and the npm registry on that day. Target: Tauri 2 + plain TypeScript on Linux
(WebKitGTK 2.50.4 on this machine), lazy Vite chunks per feature. Status: **proposal, nothing
built.** Section 10 lists the decisions only the user can make.*

## 1. Summary

- **Sheets: IronCalc for the engine and the xlsx files, with Zazabor's own grid on top.**
  [IronCalc](https://github.com/ironcalc/IronCalc) is a Rust spreadsheet engine, MIT or
  Apache-2.0. It has an xlsx reader and writer and WASM bindings, and its latest release is v0.9.1
  (2026-10-21). Formulas, styles, merged cells, conditional formatting, undo and xlsx round trips
  all go through one model. Zazabor draws the grid itself, so it follows `docs/DESIGN.md`. IronCalc
  is young: it calls itself "in its infancy", and charts and pivot tables are not supported yet.
- **Docs: Tiptap (ProseMirror) for the editor.** .docx comes in through mammoth and goes out
  through the `docx` package. All three are MIT or BSD, actively released, and work without a
  framework. Docx import is semantic, not pixel-perfect, so a **fidelity guard** saves a copy
  instead of overwriting a file whose parts Zazabor can't keep.
- **LibreOffice as an optional helper**, when it is installed (it is on this machine:
  `/usr/bin/soffice`). It converts .doc, .xls, .odt, .ods and .rtf in and out, and gives
  high-fidelity PDFs. Zazabor never depends on it.
- **Not recommended:** embedding ONLYOFFICE or Collabora (server-based, AGPL), Univer's paid
  conversion server, Handsontable (proprietary) and HyperFormula (GPL-3.0-only). The reasons are in
  sections 2 and 4.
- **Start with Quick Look.** Read-only previews of .docx, .xlsx, .xls, .ods and .csv in Files'
  Quick Look are small and useful on their own, and they test the parsing first.

## 2. Sheets: options compared

| Option | Licence | Latest release | What it gives | Verdict |
|---|---|---|---|---|
| [IronCalc](https://github.com/ironcalc/IronCalc) (`ironcalc` crate, `@ironcalc/wasm`, `@ironcalc/wasm-xlsx`) | MIT OR Apache-2.0 | v0.9.1, 2026-10-21 | An engine with Excel-compatible functions and an xlsx reader/writer (`Model.fromXlsx` / `toXlsx` in `wasm-xlsx`). The model also covers undo/redo, merges, freeze panes, conditional formatting, named styles, autofill, CSV paste and clipboard, and keyboard navigation. Its own React widget is `@ironcalc/workbook`. | **Recommended engine.** Unsupported per [its docs](https://docs.ironcalc.com/features/unsupported-features.html): collaboration, charts ("not planned for version 1.0"), pivot tables. |
| [Univer](https://github.com/dream-num/univer) | Apache-2.0 (core) | v1.2.0, 2026-10-22 | A polished canvas-rendered Sheets and Docs SDK with a formula engine. The view layer is React 18. | Good UI, but [xlsx import/export needs a conversion backend](https://docs.univer.ai/guides/sheets/features/import-export) and `@univerjs-pro/*` packages. A [licence decides which features are available](https://docs.univer.ai/server/license), and unlicensed use is restricted, with watermarks among the restrictions. It also has its own look. **Fallback** if building the grid proves too slow. |
| [Fortune-sheet](https://github.com/ruilisi/fortune-sheet) | MIT | v1.0.4, 2025-11-06 | Luckysheet's successor, React only. xlsx through a third-party plugin ([fortuneexcel](https://github.com/corbe30/fortuneexcel)). | No: React only, quiet for a year, and xlsx support sits outside the project. |
| [x-spreadsheet](https://github.com/myliang/x-spreadsheet) | MIT | v1.1.7, 2020-09-13 | A light canvas grid. | No: unmaintained. |
| [Handsontable](https://handsontable.com/docs/javascript-data-grid/software-license/) | Proprietary (non-commercial or commercial) | 18.1.2, 2026-10-07 | A data grid. "The last version available under permissive terms was 6.2.2" (2018). | No: not open source. |
| [HyperFormula](https://github.com/handsontable/hyperformula) | GPL-3.0-only or commercial | 3.5.0, 2026-10-09 | A formula engine with over 400 functions, but no file formats. | No: GPL would bind Zazabor's licence (Zazabor has none yet, section 10), and it duplicates IronCalc. |
| [SheetJS CE](https://docs.sheetjs.com/docs/getting-started/installation/nodejs) | Apache-2.0 | 0.20.3 from cdn.sheetjs.com (npm is stuck at 0.18.5) | Reads and writes many formats. | Not for editing: the Community Edition doesn't write styles ([maintainer](https://git.sheetjs.com/sheetjs/sheetjs/issues/2936)). It could still serve exotic import formats. |
| [ExcelJS](https://github.com/exceljs/exceljs) | MIT | v4.4.0, 2023-10-19 | Reads and writes xlsx with styles. | No: no releases for three years. |
| [calamine](https://github.com/tafia/calamine) (Rust) | MIT | v0.37.0, 2026-10-18 | Fast **read-only** xls, xlsx, xlsb and ods: values and formulas, no formatting. | **Yes, for Quick Look previews** and for Money's statement imports. |
| [rust_xlsxwriter](https://github.com/jmcnamara/rust_xlsxwriter) | Apache-2.0 | 0.101.0 (crates.io) | Writes xlsx only. | Yes for exports (Money, Time reports). Not an editor. |

## 3. Sheets: the design

**Engine in the page, files in Rust.** The Sheets chunk loads `@ironcalc/wasm-xlsx`. Its WASM
file is 2.5 MB, or 0.9 MB gzipped (measured from the 0.9.1 package), and it loads only when a
sheet opens. Rust reads and writes the bytes, using the same safe save as the code editor
(temporary file, then rename, keeping permissions), and inspects the zip for the fidelity guard
(section 6.3). The `ironcalc` crate can also run headless in Rust later, for example to recalculate
or export without a window.

**Zazabor's own grid.** The cell area is a canvas: one draw per frame, only visible cells, and
100,000 rows scroll smoothly, as the Files views do. Headers, the selection, the in-cell editor,
the formula bar and the menus are DOM in Zazabor's glass classes. The model already provides
navigation (`onArrowDown`, `onPageDown`, `onNavigateToEdgeInDirection`), selection ranges, formula
completion and clipboard helpers, so the grid mostly draws and forwards input.

**First version:**

- Sheet tabs: add, rename, colour, hide, move.
- A formula bar with function completion.
- Cell styles: font, bold, italic, colours, borders, alignment, wrap, and number formats such as
  ৳ and % with dates.
- Merge cells, freeze panes, resize, hide and insert rows and columns.
- The fill handle, undo and redo, and find and replace.
- Copy and paste with Excel and LibreOffice (HTML tables and TSV).

**Later:**

- Sort and filter: no sort call appears in the WASM API, so this is Zazabor code over ranges.
- A conditional-formatting editor (the model supports the rules already).
- Charts: Zazabor's own SVG charts kept beside the file, until IronCalc writes charts.

**Formats:**

| Format | Open | Save | What is lost |
|---|---|---|---|
| .xlsx | IronCalc | IronCalc | Charts, pivot tables, and anything else IronCalc drops: drawings, images, comments and data validation must be confirmed with a test corpus (section 9). The fidelity guard protects the original. |
| .xlsm | IronCalc, read-only | As .xlsx, without macros | Macros (Zazabor never runs VBA). |
| .csv, .tsv | Parsed in Rust (`csv` crate: delimiter, encoding, BOM) | First sheet, values only | Everything but values. Saving warns if there are other sheets or formulas. |
| .xls, .ods | LibreOffice converts to .xlsx when installed. Otherwise a read-only calamine view (values and formulas, no styles). | .xlsx, or .ods through LibreOffice | Whatever the conversion drops. |

## 4. Docs: options compared

| Option | Licence | Latest release | Verdict |
|---|---|---|---|
| [Tiptap](https://github.com/ueberdosis/tiptap) 3 on ProseMirror | MIT | v3.32.0, 2026-10-13 (`prosemirror-view` 1.42.8, 2026-10-24) | **Recommended.** `@tiptap/core` takes a plain element, with no framework needed. Free extensions cover tables, task lists, images, links, highlight, text style and alignment. Its own [DOCX import/export is paid](https://tiptap.dev/product/conversion) (Pro packages or the cloud service), so Zazabor converts .docx itself. |
| [Lexical](https://github.com/facebook/lexical) | MIT | v0.52.0, 2026-09-28 | A fine alternative that also works without a framework. It has fewer ready-made document features (tables, alignment, styles) than the Tiptap set and is still pre-1.0. |
| Univer Docs | Apache-2.0 | v1.2.0 | Has Word-like layout with pages, headers and footers, but its docx import and export need the same Pro conversion server as Sheets. |
| Zazabor's Notes editor (`src/notes/editor.ts`) | ours | — | Built for Markdown notes. A document editor needs tables with merged cells, styles, page setup and images, which would mean rebuilding ProseMirror. Its Markdown reader and writer (`src/notes/markdown.ts`) is still useful for .md import and export. |
| [mammoth.js](https://github.com/mwilliamson/mammoth.js) (docx → HTML) | BSD-2-Clause | 1.13.0 on npm, 2026-09 | **Yes, for import.** It "aims to produce simple and clean HTML by using semantic information in the document, and ignoring other details". It keeps headings, lists, tables, images, footnotes, links and inline formatting, and drops fonts, sizes, colours and table borders. It does no sanitising, so Zazabor must clean its HTML. |
| [docx](https://github.com/dolanmiu/docx) (writes .docx) | MIT | 9.14.0, 2026-10-23 | **Yes, for export.** Zazabor maps the editor's document tree onto it. |
| [docx-rs](https://github.com/bokuweb/docx-rs) (Rust) | MIT | 0.4.21, 2026-07-20 | Possible later, for exports without a window. |
| Embed [ONLYOFFICE Docs](https://github.com/ONLYOFFICE/DocumentServer) or [Collabora Online](https://www.collaboraonline.com/code/) | AGPL-3.0 (ONLYOFFICE v10.0.0, 2026-10-12) | — | **No.** Both are document servers (Docker or packages) that a browser editor talks to through WOPI or their APIs. That means hundreds of MB and a background service for a desktop app, AGPL obligations, and a look Zazabor can't restyle. They give the best Office fidelity, which is why "Open in LibreOffice" stays one click away (section 6.4). |

## 5. Docs: the design

- **The editor.** A page view: an A4 or Letter-width sheet with margins on the backdrop, flowing
  continuously. A glass toolbar has paragraph style, bold, italic, underline, strikethrough, text
  colour, highlight, alignment, lists, checklists, table, image, link, page break and clear
  formatting. There is an outline sidebar from the headings, find and replace (Ctrl+F, Ctrl+H),
  word and character counts, zoom, and keyboard shortcuts as in Word or Google Docs. Page numbers
  and real page breaks show in print and PDF (CSS `@page`), not live while editing (section 10,
  item 6).
- **Stored as the user's file.** No private format: a document is the .docx, .md or .html file it
  came from. New documents save as .docx by default. Unsaved work goes to a recovery file
  (section 6.2).
- **Import:** .docx through mammoth, then a strict allowlist sanitiser (known tags and attributes
  only; no scripts, no event attributes, `data:` image URLs only), then the Tiptap schema. .md goes
  through `markdown.ts` and .html through the same sanitiser. .odt, .rtf and .doc go through
  LibreOffice to .docx when it's installed, and otherwise open in the system app.
- **Export:** .docx through `docx`, .md, .html, and PDF (section 6.4).
- **What a docx round trip loses:** fonts, sizes and colours from styles (Zazabor writes its own
  clean styles), page size and margins from the original, headers and footers, comments, tracked
  changes, fields, text boxes, columns and section breaks. The fidelity guard decides what happens
  to the original (section 6.3).
- **Bangla.** Text input goes through the system input method (ibus or fcitx) into
  `contenteditable`. ProseMirror handles composition, but Bangla conjuncts need a test pass
  (section 9). PDFs and .docx exports name a font that has Bengali glyphs (Noto Sans Bengali by
  default, section 10).

## 6. Shared pieces

### 6.1 Windows and routing

- Documents and sheets open in their own window, as text and code open in the code editor
  (`src/shell/windows.ts`). `classifyPath` in `src/shell/router.ts` gains `"document"` and
  `"sheet"`, and `OpenRequest` gains `{ kind: "doc" | "sheet"; path }`. Today these files are
  `"other"` and open in the system app. With the features off, they still do.
- **Files:** double-click opens them in Zazabor when the feature is on. "Open With" lists Zazabor
  Docs and Sheets next to the system's apps. Right-click → New Document or New Spreadsheet in a
  folder.
- **Quick Look** (`src/shared/quicklook/bodies.ts`): .docx renders through mammoth and the
  sanitiser, read-only. .xlsx, .xls, .ods and .csv go through a new Rust command,
  `fs_sheet_preview { path, sheet, rows: 200, cols: 30 }`, built on calamine, which returns a table
  with sheet tabs. Neither loads the editors' chunks.
- **Default app:** the same opt-in switches as for folders, images and videos (`xdg-mime`, off by
  default, reversible).
- **Elsewhere in Zazabor:** Time's daily report and Money's exports can open straight into Docs or
  Sheets.

### 6.2 Saving, autosave and versions

- **Save** (Ctrl+S) writes the file with the code editor's safe save. **Autosave to the file** is
  an option, on for files Zazabor created and off for Office files from elsewhere: explicit saves
  are the Office habit, and they keep the fidelity guard meaningful.
- **Recovery:** every 5 seconds while there are unsaved changes, the document's state goes to
  `office/recovery/<path-hash>`. After a crash, opening the file again (or starting Zazabor) offers
  "Restore unsaved changes from 10:42". The recovery file is cleared on save or on "Don't Save".
- **Versions:** each save first copies the previous file to `office/versions/<path-hash>/<time>.<ext>`.
  Older versions are thinned to one per day after a week and dropped after 30 days. File → Version
  History lists them, opens one read-only, and restores it.

### 6.3 The fidelity guard

Before overwriting an Office file, Rust lists the zip's parts (the `zip` crate is already a
dependency) and reports what Zazabor can't write back:

- **.xlsx:** `xl/charts/`, `xl/pivotTables/`, `xl/drawings/`, `xl/vbaProject.bin`, `xl/comments*`,
  `xl/externalLinks/`.
- **.docx:** `word/header*.xml`, `word/footer*.xml`, `word/comments.xml`, `word/footnotes.xml`,
  tracked changes (`w:ins` or `w:del` in `document.xml`), and `vbaProject.bin`.

If any of these are found, a banner names them in plain words when the file opens ("This
spreadsheet has 2 charts and a pivot table that Zazabor can't keep"). Save then defaults to **Save
a Copy** (`Report (Zazabor).xlsx`), with "Overwrite anyway" and "Open in LibreOffice" next to it.

### 6.4 Print and PDF

WebKitGTK has printing, but Tauri has no API that exposes it ([WebKit bug
212814](https://bugs.webkit.org/show_bug.cgi?id=212814), pointing at Tauri issue #4917). Zazabor
already links the `webkit2gtk` crate (feature `v2_40`), so a Rust command can run
`webkit2gtk::PrintOperation` on the editor's webview:

- **Print…** shows the GTK print dialog.
- **Export as PDF** prints straight to a file with GTK print settings: the output URI and format
  `pdf`. Printer lookup for "Print to File" is name-based and that name is translated in other
  locales, so the code must not match on the English name.

When LibreOffice is installed, "Export as PDF (LibreOffice)" converts the saved .docx or .xlsx with
`soffice --headless --convert-to pdf` for Word-accurate pagination.

### 6.5 Bundle and loading

- Two new chunks, `office-docs` (Tiptap, ProseMirror, mammoth, `docx`) and `office-sheets` (grid
  and IronCalc WASM). Each loads on the first open, like Monaco and pdf.js today.
- The WASM is served from the app's assets with the right MIME type, so it streams and compiles
  while loading.
- Quick Look uses only mammoth (dynamically imported) and the Rust preview command.

### 6.6 WebKitGTK notes

- WASM and canvas are fine in WebKitGTK 2.50. The canvas grid redraws only changed tiles, and
  glass stays on the bars (no blur over the grid).
- `contenteditable` and input-method composition: ProseMirror works around most engine quirks.
  Bangla, Arabic (right-to-left) and emoji need a test pass.
- **Spell checking** comes from WebKitGTK's web context, through Enchant and Hunspell. Whether
  Tauri turns it on, and which languages are installed, has to be checked. Zazabor may need to
  enable it from Rust.
- Clipboard: reading `text/html` and TSV pasted from LibreOffice, Excel on the web and Google
  Sheets must be tested through Tauri's clipboard path.

## 7. Milestones

| # | Milestone | Done when |
|---|---|---|
| O0 | **Quick Look previews**: docx (mammoth and the sanitiser), xlsx, xls, ods and csv (calamine, sheet tabs) | Space on any of these in Files shows the content in under 300 ms for typical files. The editor chunks are not loaded. |
| O1 | **Sheets core**: IronCalc model, canvas grid, formula bar, styles, sheets, undo, clipboard, xlsx and csv open and save, fidelity guard, recovery | A test corpus of 30 real workbooks (bank statements, budgets, reports) opens, recalculates and saves, and Excel and LibreOffice reopen the saved files with the same values and formulas. |
| O2 | **Sheets polish**: fill, merge, freeze, number formats, find, sort and filter, print and PDF, xls and ods through LibreOffice, versions | A 100,000-row sheet scrolls without dropped frames. Sorting and undoing it gives the original back. |
| O3 | **Docs core**: Tiptap editor, page view, toolbar, outline, find and replace, docx, md and html in and out, fidelity guard, recovery, print and PDF | A corpus of 30 real .docx files imports with headings, lists, tables and images intact, and Word and LibreOffice reopen the exported .docx cleanly. Bangla typing works. |
| O4 | **Integration**: routing and Open With, New Document and New Spreadsheet in Files, default-app switches, Time and Money exports opening in Sheets and Docs, an optional Office section (section 10, item 1) | Every route in section 6.1 works with the features on and off. |

## 8. Effort, roughly

O0 is about one session. O1 is the biggest piece (the grid, input and clipboard), about 3–4
sessions. O2 is 2. O3 is 3, mostly the docx mapping and the page view. O4 is 1.

## 9. Risks

| Risk | Mitigation |
|---|---|
| IronCalc is young (v0.9, "in its infancy") | Pin the version and keep a test corpus (O1) that must pass before each upgrade. The guard protects originals. Univer's open-source core is the fallback for the UI and engine, with Zazabor's own xlsx mapping. |
| A missing function or formula difference | IronCalc treats any difference from Excel as a bug ([docs](https://docs.ironcalc.com/)). Report it upstream and show `#NAME?` honestly, never a wrong number. |
| docx fidelity disappoints | Set expectations in the banner, save a copy by default, and keep Open in LibreOffice one click away. |
| No print API in Tauri on Linux | Use `webkit2gtk::PrintOperation` directly from Rust (section 6.4). Fall back to the print dialog, or to LibreOffice. |
| Untrusted documents (HTML injection through mammoth, zip bombs) | Strict sanitiser, CSP stays on, and size and entry-count limits when reading zips in Rust. Macros never run. |
| Bundle weight | Separate lazy chunks (section 6.5). Quick Look stays light. |
| Bangla and other complex scripts | Test input methods, line breaking and PDF fonts early (O1 and O3). Ship Noto Sans Bengali, or require it as a dependency. |

## 10. Decisions to make

1. **One "Office" section on the rail** (recent documents and spreadsheets, templates, New buttons),
   or editors opened only from Files and Quick Look, as the code editor is?
2. **Overwriting Office files with parts Zazabor can't keep:** save a copy by default (recommended),
   or ask every time?
3. **LibreOffice as an optional helper** for .doc, .xls, .odt and .ods and for exact PDFs: fine to
   use it when it's installed? Should the .deb recommend it?
4. **Default app:** offer "Make Zazabor the default for documents and spreadsheets" switches (off
   by default)?
5. **Zazabor's licence.** There is none yet. This plan avoids GPL and AGPL code so the choice stays
   open. Say so if Zazabor will be GPL anyway, because that reopens HyperFormula and others.
6. **Pagination:** is a page-width view with exact pages only in print and PDF enough, or do you
   need Word-style live pages with headers and footers? Live pages are much more work, and would
   point to Univer Docs plus a docx bridge.
7. **Charts in Sheets** in the first version? IronCalc won't have them before its 1.0, so Zazabor
   would draw its own and store them beside the file.
8. **Fonts:** Noto Sans Bengali, SolaimanLipi or another as the default Bangla font in documents
   and PDFs?
