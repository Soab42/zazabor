# PDF: an Acrobat-like reader and editor (plan, draft)

*Researched 2026-10-26. Licences, versions and release dates were read from each project's
repository, crates.io and the npm registry on that day. Target: Tauri 2 + plain TypeScript on
Linux (WebKitGTK 2.50.4 and Pop!_OS 22.04 on this machine). Status: **P0–P2 built, P3–P4 built
without PDFium, P5 (OCR, certificate signatures) and part of P6 (PDF → Word) built in round 3,
true redaction and editing existing text with PDFium in round 4 (see What's built).**
Section 11 lists the decisions only the user can make.*

## What's built (2026-10-26)

P0–P2 are in `src/modules/office/pdf/`, on pdf.js 6.4.299 only (no PDFium, no new npm packages).
Checked by hand in the app on a nested display, and the saved files with Poppler (`pdfinfo`,
`pdftotext`, `pdftoppm`, `pdfimages`, `pdfdetach`) and pdf.js in Node.

- **Reading (P0):** pdf.js `PDFViewer` with text selection, links (web and mail addresses only,
  through `safeLink`, opened in the desktop's browser; scripting off), forms, and pdf.js's
  stylesheet scoped to the PDF app. Navigation pane with page thumbnails, bookmarks, a comments
  list and attachments (saved with Save…). Find (match case, whole words, all hits highlighted).
  Zoom (presets, slider, Ctrl+wheel around the pointer), page box, rotate view, single page,
  scrolling, two-page with cover page, wrapped, Read Mode (Ctrl+H), full screen, dark pages,
  Hand tool, Document Properties (Ctrl+D), Go to Page (Ctrl+Shift+N), password-protected files,
  print (pages drawn at 150 dpi with form values and new comments).
- **Comment (P1):** highlight (on text or freehand), text boxes, drawing, pictures, with colour,
  text size, thickness and opacity; delete; undo and redo; the comments list shows comments from
  other apps (author, date, text) and new ones.
- **Fill & Sign (P1):** form fields; Add Text; today's date (typed into a text box where you
  click); check, cross and dot marks; signatures and initials typed (three letterings), drawn or
  from a picture of a signature (paper made transparent), placed where you click and kept in
  `office/pdf-signatures.json` in the app's data folder (`src-tauri/src/office/pdf_signatures.rs`,
  refused while Zazabor is locked). They're pictures on the page, not certificate signatures.
- **Saving:** Save writes comments and form values as pdf.js does (an incremental update);
  AutoRecover keeps a copy every 20 s while there are unsaved changes.
- **Organize and Combine (P2):** a page grid (Organize tab): select with click, Ctrl and Shift,
  drag to move, rotate, delete, insert from PDFs and pictures or a blank page, extract (optionally
  deleting the pages), split every N pages or at top-level bookmarks into a folder. Undo and redo
  for page changes. New → Combine Files (PDFs and pictures, asks for passwords) and Pictures to
  PDF. Page changes build a new file with pdf.js's `extractPages`, which keeps links, form fields,
  annotations and the bookmarks of pages that stay, and a file built from one source keeps its
  encryption. pdf.js can't set a page's saved rotation, so `pdf/bytes.ts` sets it with an
  incremental update afterwards (also naming Zazabor as the producer).

**Not done yet, by milestone:** P0's range loading (files are read whole; Office's reader stops at
256 MB); replies to comments; Replace Pages; a print preview; picture pages are Letter or A4 by
the system's region rather than the picture's own size (pdf.js decides).

### Round 2 (2026-10-27): P3 and P4 on lopdf, without PDFium

A permission check refused shipping a prebuilt PDFium library, so this round uses pdf.js and
the `lopdf` crate (0.46.0, MIT, built from source, `default-features = false`) only. The Rust
side is `src-tauri/src/office/pdf_tools/` (one command, `pdf_edit`: the page sends the file as it
is now, with pdf.js's own comments and form values written in, plus a list of operations; Rust
answers with the whole new file, which the page opens in place of the old one, keeping the page
and scroll position; each change is one Undo step). Every change is a full rewrite with
unreferenced objects dropped, so nothing removed survives in an earlier revision. An encrypted
file is decrypted with its password, changed and encrypted again with the same passwords; its
owner's restrictions are respected (comments need "comments allowed", page changes need "changes
allowed") unless the owner's password opened it.

- **Comment (P3 annotations):** underline, strikethrough and squiggly on selected text (select,
  then the button; or the button, then select), notes with a popup, rectangle, oval, line,
  arrow and polygon (Shift keeps them even; double-click or Enter ends a polygon), with colour,
  thickness and opacity. They're standard annotations with appearance streams, so other
  viewers draw them the same (checked with Poppler's `pdftoppm`). Any comment, from any app, can
  be deleted from its right-click menu on the page or the trash button in the Comments list.
- **Edit tab (P3 page content):** Add Text written into the page with the standard fonts
  (Helvetica, Times, Courier, bold; widths from the metric-compatible Liberation fonts);
  text they can't show (Bangla…) goes on as a picture of the text. Add Picture (JPEG as it is,
  others as RGB with an alpha mask). Watermark (text or picture, opacity, rotation, over or under
  the page, which pages; marked as an artifact). Header & Footer and Bates Numbering ({page},
  {pages}, {date}, {file}, {bates}; left, centre and right). Flatten comments and/or form fields
  (each annotation's appearance drawn into the page, the form removed when no fields are left).
  Everything is placed as the page shows, its /Rotate applied.
- **Protect tab (P4):** Protect with AES-256 (PDF 2.0 revision 6): a password to open, and/or
  restrictions with a permissions password; Remove Security, which asks for the permissions
  password when the file restricts anything. lopdf leaves the key lengths out of the encryption
  dictionary, and Poppler then decrypts garbage, so `/Length 256` and the crypt filter's
  `/Length 32` are added as Acrobat writes them. Remove Hidden Information: metadata and the
  document properties, attachments, scripts and actions (JavaScript, launch, submit; /AA, XFA),
  comments.
- **Redaction, the honest version (§11 decision 7's rasterising option):** Mark Area (drag; click
  a mark to remove it) and Find & Mark (typed text, phone numbers, email addresses, national ID
  numbers). Marks cover the whole words a match touches, measured with the PDF's own fonts
  (pdf.js's loaded font faces) with a margin: an earlier version measured with a generic font
  and left letters uncovered. Apply draws each marked page with pdf.js at 150–300 dpi
  (comments and form values included), paints the marks black, and replaces the page's content
  with that picture: its text, drawings, annotations and form fields go, and the structure tree
  (which can carry alternate text) is dropped. Optionally the hidden information goes too. The
  check afterwards: the redacted pages hold no text at all, and pages where the found text still
  appears (without marks) are named. True object-level redaction (keeping the rest of the page
  as text) needs PDFium.
- **Reduce File Size (P4):** pictures downsampled to the resolution they're shown at (found by
  following each page's content and the forms it draws), photos re-encoded as JPEG and line art
  as Flate, unused objects dropped, streams compressed, object streams; nothing changes when it
  can't get smaller. Ghostscript's pdfwrite is offered as "Maximum" when it's installed (a
  separate program, never linked).
- **Fixes:** pdf.js's OffscreenCanvas path drew big pictures blank in WebKitGTK 2.50 (scanned
  pages came out white at random), so documents open with `isOffscreenCanvasSupported: false`;
  form check boxes are tinted like text fields.

Checked: 11 Rust tests (annotations and their appearances, removing with popups, watermark text
and picture round trips, headers/footers/Bates, text and pictures, flatten, passwords open and
refuse and keep restrictions, redaction leaves no trace of the text in any decoded stream or
string, hidden information goes, compression downsamples, rotated pages). In the app on a nested
display, with each saved file checked in Poppler (`pdftoppm`, `pdftotext`, `pdfinfo`,
`pdfimages`) and Ghostscript: underline, strikethrough, a note, rectangle, arrow and polygon;
a watermark on all pages; Bates numbers ACME-000001 on with a footer; Latin and Bangla text; a
picture; Reduce Size (2.7 MB → 356 KB, the photo at exactly 150 ppi; Ghostscript: a 300 dpi
scan 2.6 MB → 276 KB); Find & Mark and Apply Redactions (none of the marked text, nor the
title and author, anywhere in the file's bytes or inflated streams); flattened form fields;
Protect (AES-256, Poppler opens it with the password and reports the restrictions) and Remove
Security (a wrong permissions password refused); Remove Hidden Information and Undo.

**Waiting for the user:** PDFium (editing existing text runs, true object-level redaction that
keeps the rest of a page as text, reading a page's exact glyph positions); OCR (P5, model
downloads); certificate signatures (P5, a certificate); conversions to Docs and Sheets (P6);
Quick Look and the Files thumbnails open PDFs through their own pdf.js calls and probably need
the same OffscreenCanvas switch for big scans (not changed here).

### Round 3 (2026-10-27): OCR, certificate signatures, PDF → Word, still without PDFium

No PDFium, no PDFium wasm and no other prebuilt PDF library (the user decides that separately).
Redaction stays rasterised; true object-level redaction and editing existing text still wait.

- **Recognize Text (Convert → Scan & OCR):** tesseract.js 7.0.0 and tesseract.js-core 7.0.0
  (Apache-2.0), bundled by Vite and served from the app, never from a CDN (the SIMD LSTM core,
  `workerBlobURL: false`). The language data isn't bundled: English and Bangla `tessdata_fast`
  files (Apache-2.0) are downloaded the first time they're needed, after a dialog that gives the
  size, from GitHub pinned to commit `87416418657359cb625c412a48b6e1d6d41c29bd` and checked
  against a pinned SHA-256 (eng 4,113,088 bytes, ben 855,841 bytes), with progress, Cancel and
  resume (HTTP Range). They're kept in the app's data folder under `office/ocr/`, out of git.
  Settings → PDF lists them, with Download/Resume and Remove. Each page without text is drawn at
  300 dpi, read, and Tesseract's text-only PDF of that page goes in as an invisible text layer
  (a form XObject drawn over the page, placed through the page's rotation and boxes), so the page
  looks the same and its text can be found, selected and copied (`src-tauri/src/office/pdf_tools/ocr.rs`;
  downloads in `src-tauri/src/office/pdf_ocr.rs`). The release build's CSP already allows it:
  the worker and wasm come from `'self'`, `'wasm-unsafe-eval'` is there, and the data reaches the
  worker through IndexedDB, so the CSP is unchanged (checked with a `custom-protocol` build).
- **Certificate signatures (Fill & Sign → Certificate):** any .p12/.pfx and its password; the
  dialog shows who it's for, who issued it and when it expires. Drag the box for a visible
  signature (name, date, reason, optionally a picture; upright on rotated pages), or sign without
  one. The signature is added as an incremental update with lopdf (the earlier bytes untouched),
  then a CMS detached signature over the byte range is made with OpenSSL (`openssl` crate,
  system OpenSSL 3), SubFilter `ETSI.CAdES.detached` (PAdES basic), SHA-256, signing-certificate
  attribute. A second signature keeps the first valid. Encrypted files are refused for signing.
  Signed files are Saved As. **Signatures** (View → Document, Fill & Sign, and a side panel that
  shows when a file has any) checks each one: intact or changed, the whole file covered or not,
  and whether the signer is trusted by the system's certificates. Changes that rewrite the file
  (page edits, tools, redaction, compression) ask first, because they break the signatures.
- **PDF → Word (Convert → To Word):** "Flowing text" rebuilds the text as Docs paragraphs
  (headings from font size, bullet and numbered lists, pictures), writes a .docx through Docs'
  own writer and opens it in Docs. "Keep the layout" runs LibreOffice headless (its PDF import,
  a throwaway profile, 180 s limit), only when LibreOffice is installed; that .docx is saved but
  not opened in Docs, which mis-draws its text boxes (it's faithful in LibreOffice and Word).
  Bank Statement to Excel and Tables to Excel in the same group are the Statements work.
- **Comment replies:** Reply on a comment in the Comments list adds a reply (`/IRT`, `/RT /R`,
  as Acrobat writes them); replies are listed under their comment, replies from other apps too,
  and deleting a comment deletes its replies. A reply's box is a point, so pdf.js (which draws
  replies as notes of their own) puts nothing over the comment.
- **Also:** Organize → Insert → Replace Pages… (and on a thumbnail's menu) swaps pages for pages
  of another PDF; File → Print in the new Office backstage shows a preview of the pages
  (up to 30) and the document's details.

Checked: `cargo test --lib` (313 passed), including signing round trips with a tampering check
on classic and cross-reference-stream files, an invisible signature plus a second one, a wrong
password and a bad file, Poppler's `pdfsig` agreeing, the OCR text layer on 0° and 90° pages
(checked with `pdftotext`), the pinned language list, and replies. In the app on a nested display:

- Signing with a test certificate made with openssl ("Rahim Test Signer", self-signed): `pdfsig`
  reports "Signature is Valid", "Total document signed", ETSI.CAdES.detached, SHA-256, and the
  issuer not trusted (expected for self-signed). The visible signature draws. After an
  edit was confirmed, the panel shows the signature no longer covers the file.
- OCR: both languages downloaded in the app and passed the hash check; on a two-page scan
  (English, and Bangla drawn with HarfBuzz shaping) Find "agreement" gives two hits lined up
  over the scan, and `pdftotext` gives the English and the Bangla ("বাংলাদেশ একটি সুন্দর দেশ।…",
  one word misread). Reading an English page with English + Bangla adds stray Bangla digits, so
  the dialog keeps English as the default. Around 15–20 s a page on a busy machine. Remove and
  Download in Settings work.
- PDF → Word (flowing text) opened in Docs with the headings, both lists, the picture and the
  second page. The LibreOffice option made a faithful .docx (checked in LibreOffice).
- Replies: a reply listed under its note, nothing extra on the page; Undo removes it.

**Left:** Replace Pages and the print preview are built but weren't tried in the app. Clicking a
note's icon doesn't open its popup in the viewer (with or without replies; seen while checking
replies, not looked into). Quick Look and the Files thumbnails still need checking on a big
scan for the OffscreenCanvas problem. The resume after a cancelled download works by the file's
hash, but Settings didn't redraw to show "Resume". While Tesseract loads, the progress says
"Starting…" for a few seconds. Signatures: no timestamps (PAdES B-T) or long-term validation
data, no revocation checks. Still waiting for PDFium: editing existing text, true object-level
redaction.

### Round 4 (2026-10-27): PDFium

PDFium chromium/8100 (BSD-3-Clause; the prebuilt library from bblanchon/pdfium-binaries) is
fetched by `scripts/fetch-pdfium.sh` at a pinned release, checked against its SHA-256, into
`src-tauri/pdfium/` (not in git). It isn't linked: `pdfium-render` 0.9.4 (MIT OR Apache-2.0,
`default-features = false`, `pdfium_7881` bindings, `thread_safe`; dynamic loading only) loads
libpdfium.so the first time a tool needs it, from `ZAZABOR_PDFIUM` (the file or its folder; for
tests), then `<exe dir>/../lib/zazabor/` (installed: `scripts/install-linux.sh` runs the fetch
script when the library is missing and puts libpdfium.so and its LICENSE in ~/.local/lib/zazabor;
`--uninstall` removes that folder), then `pdfium/lib/` in src-tauri found by walking up from the
executable (dev builds). A failed load isn't remembered; without the library the PDFium tools say
why and everything else, rasterised redaction included, works as before. All PDFium calls run one
at a time (`src-tauri/src/office/pdf_tools/pdfium.rs`). The PDFium steps are operations in the same
`pdf_edit` pipeline as the lopdf ones, so passwords, permissions, Undo and the full rewrite
(unreferenced objects dropped) apply to them too; `pdf_edit_noted` also returns notes for the page.

- **True redaction (§4.5), now the default** (Protect → Apply Redactions → "Remove what's under the
  marks"; "Replace marked pages with pictures" is still offered, and is the only choice without
  PDFium). In `redact.rs`: characters under a mark are taken out; a text object only partly under
  one is rebuilt from the characters left, a word at a time at each word's own position, in the
  object's own font, size, colours and render mode (so an OCR layer stays invisible). Pictures
  wholly under a mark go; one partly under is replaced by a copy with the covered pixels painted
  black in the picture's own pixels. Paths and shadings wholly under a mark go (those reaching
  outside stay, under the box). Form XObjects a mark touches are opened up into the page first
  (PDFium can't rewrite a form's own content: it loses the form's fonts). Each marked page's
  content streams are joined into one first, because PDFium puts what it adds into a page's first
  stream, which would draw rebuilt text under the rest. Annotations, links and form fields that a
  mark touches go (with popups and replies), and so do the page's thumbnail and the document's
  structure tree (alternate text). A black box is drawn over each mark. Then PDFium reads the new
  file again and no character may be left under any mark, or nothing is changed and the page asks
  for the picture method. A signed file gets a warning in the dialog that the signatures will show
  as invalid.
- **Edit Text (§4.6, one line at a time)** (Edit → Edit Text): a click picks the text object under
  it and the ones beside it on the same baseline in the same font and size; an input appears over
  the line in its size, face and colour; Enter (or clicking away) writes it, Esc doesn't. Runs at
  either end that the edit leaves alone stay where they were (a list's number and its gap). The
  new text goes in the line's own font when that font has every letter (its glyph outlines,
  checked one by one, since embedded fonts are subsets, and the text read back the same).
  Otherwise the line goes into the closest standard font (Helvetica, Times or Courier; bold and
  italic kept) and the note says which letters were missing. Letters the standard fonts can't show
  either, and scripts that need shaping (Bangla, Devanagari, Arabic…), are refused with a pointer
  to Add Text. Text inside form XObjects, and text whose font has no Unicode mapping, is refused.
  No reflow: longer text runs past the line's old end. Saved through PDFium, reopened in pdf.js.

Checked: `cargo test --lib` with `ZAZABOR_PDFIUM`. The PDFium tests are ignored only when the
library is absent (a `has_pdfium` cfg from build.rs). Redaction: "SECRET123" is gone from the
file's bytes, every inflated stream and string (literal and hex), from PDFium's text and from
`pdftotext`. "Top" and "here" on the same line are still text. The picture under the line has black
pixels where the mark was and white elsewhere. A mark over nothing still passes the check. Edit
Text: a round trip ("Public text" → "Private words" in the same font, read back by PDFium and
Poppler and clicked again), page 1 untouched, and stale or Bangla edits refused.

In the app on a nested display (dev build, PDFium found in src-tauri/pdfium), with the saved files
checked in Poppler:

- LibreOffice manual: Find & Mark "Rahim" marked the name in line 1 and the email address in line 2.
  Applying with the default method boxed both. The rest of each line is still text: it selects in
  the viewer, and `pdftotext` reads "…reviewed. Contact" and "at 01712-345678 or". Neither word is
  left in Poppler's text, `strings` or any inflated stream, and the untouched lines render
  pixel-identical to the original.
- An OCR'd scan (round 3's invisible layer, in a form XObject over a 200 dpi photo of the page):
  marking "agreement" opened the form up, took the two words out of the invisible text (the words
  around them stay searchable), and painted the scan's own pixels black under the marks
  (`pdfimages`).
- Edit Text on "1. Check the names of both parties.": the new text went in, in the file's own
  LiberationSerif, and was read back by Poppler. Typing "Quick" (no "Q" in that subset) put the line
  in Times-Roman (a standard font, `pdffonts`), while the "1." and the gap after it stayed in place.

Before building on it, PDFium's own behaviour was checked with its C API directly (ctypes):
regenerating a page keeps kerning (TJ arrays); a word rebuilt in a LibreOffice subset font
renders like the original; removing objects from a form breaks the form's fonts; objects added to
a page with several content streams land in the first. Those findings are why the code joins
streams and opens forms up.

**Left:** a picture partly under a mark is stored again losslessly (Flate), so a scanned page gets
bigger: the 446 KB scan became 1.2 MB (Reduce Size brings it back down). Such a picture also
loses its soft mask (transparency), if it had one. Opening up a form drops its clipping to its
bounding box. Drawings that reach outside a mark stay, under the box (not clipped). Text in a Type 3
font, or any text PDFium can't read, that a mark touches goes whole. Edit Text: the input sits a
few pixels below the line (cosmetic). It edits one line at a time, with no paragraph reflow
(§4.6's P5 step). Clicking a note's icon still doesn't open its popup (seen in round 3). The
signed-file warning in Apply Redactions wasn't tried in the app.


## 1. Summary

- **pdf.js already does most of Acrobat's everyday work.** Zazabor already uses `pdfjs-dist`
  6.4.299 (Apache-2.0, 2026-10-03) for Quick Look (`src/shared/quicklook/pdf.ts`). Its
  `AnnotationEditorType` now has FreeText, Highlight, Ink, Stamp (images), Signature, Comment and
  Popup editors. `saveDocument()` writes the edits and form values into the file. `extractPages()`
  merges files, reorders and deletes pages, and inserts images as pages (checked in
  `node_modules/pdfjs-dist/types`). The [releases](https://github.com/mozilla/pdf.js/releases) add
  digital-signature verification (6.2) and merge and reorganise fixes (5.7–6.0). Firefox 150 and
  151 ship page reordering and merging on top of it
  ([report](https://aphnetworks.com/news/31615-firefox-150-turns-its-pdf-viewer-real-pdf-editor)).
  Zazabor's Acrobat is mostly a UI around these pieces.
- **PDFium in Rust does what pdf.js can't:** true redaction, editing existing text, an invisible
  OCR text layer, flattening, watermarks, and image recompression. Use
  [pdfium-render](https://github.com/ajrcarey/pdfium-render) 0.9.4 (MIT or Apache-2.0,
  2026-09-06) over PDFium (BSD-3-Clause). The library comes prebuilt from
  [pdfium-binaries](https://github.com/bblanchon/pdfium-binaries) (MIT, chromium/8111,
  2026-10-19) as one shared library shipped beside the binary.
- **lopdf for the file's structure:** [lopdf](https://github.com/J-F-Liu/lopdf) 0.46.0 (MIT,
  2026-10-21) encrypts and decrypts (AES), edits metadata and writes the incremental updates that
  digital signatures need. qpdf (Apache-2.0, 12.4.2, 2026-09-27; `libqpdf28` 10.6.3 is installed
  here) is optional, for repairing, linearising and compacting.
- **Real digital signatures are feasible:** PAdES baseline, a CMS signature over a byte range,
  with a certificate from a .p12/.pfx file or a USB token. Visible "Fill & Sign" signatures are
  pdf.js Signature annotations and need no certificate.
- **Not recommended:** MuPDF and mupdf.js (AGPL-3.0-or-later, or a commercial licence), Poppler
  (GPL) and Ghostscript (AGPL) as libraries. The last two can be optional *external* helpers when
  installed, as LibreOffice is for Office. The original pdf-lib has had no release since 2021.
- **Where it lives:** a third Office app next to Docs and Sheets, red as Acrobat is. PDFs in Files
  open there when the feature is on.

## 2. Acrobat's tools and where each comes from

| Tool | Acrobat | Zazabor, first version | Engine |
|---|---|---|---|
| View | Single, continuous, two-up, thumbnails, bookmarks, attachments, search, zoom, rotate view | All of these, plus night mode (inverted pages) and Read Aloud later | pdf.js `PDFViewer`, `PDFFindController`, `PDFLinkService` (all in `pdf_viewer.mjs`) |
| Comment | Highlight, underline, strikethrough, sticky note, text box, freehand, shapes, stamps, a comment list with replies | Highlight (snaps to selected text), free highlight, note, text box, ink, stamps (images and "Approved"-style presets), comment panel with replies and filters | pdf.js editors. Underline, strikethrough and shapes (line, arrow, rectangle, ellipse) aren't pdf.js editors yet, so Zazabor adds them as annotations through PDFium (section 4.3) |
| Fill & Sign | Fill fields, type text anywhere, a reusable signature and initials | Same. Signatures are drawn, typed or from an image, and saved in a library | pdf.js forms (`annotationStorage`) and its Signature editor |
| Organise Pages | Reorder, rotate, delete, insert, extract, split, replace | Same, in a thumbnail grid with drag and drop and multi-select | pdf.js `extractPages()`. Rotation that's saved goes through PDFium |
| Combine | Merge several files | Same, from Files' right-click menu too | pdf.js `extractPages()` with several documents |
| Edit PDF | Edit text and images in place, add text, images and links | Add text, images and links anywhere. Edit an existing line of text when its font allows (section 4.6). Move, resize and delete images | PDFium page objects |
| Redact | Mark text, areas and search patterns, then apply true removal | Same, with Bangladeshi patterns (NID, phone numbers, bKash numbers) | PDFium (section 4.5) |
| Protect | Passwords, permissions, remove hidden information | AES-256 open password and permissions; remove a known password; remove metadata, attachments and JavaScript | lopdf (or qpdf) |
| Compress | Reduce file size | Downsample and recompress images, then compact objects | PDFium and the `image` crate, then lopdf/qpdf; Ghostscript as an optional helper |
| Scan & OCR | Make scans searchable | Same, for English and Bangla | tesseract.js, plus PDFium for the invisible text layer |
| Export / Create | To and from Word, Excel, images | Images ↔ PDF; Office files → PDF; PDF → Docs (approximate) | pdf.js, LibreOffice helper, Office (section 4.10) |
| Request e-signatures | A cloud service | Not planned: it needs a server | — |
| Print | Print dialog | The PDF itself goes to the printer, exactly | CUPS (section 4.12) |

## 3. Engines compared

| Option | Licence | Latest release | What it gives | Verdict |
|---|---|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | Apache-2.0 | 6.4.299, 2026-10-03 | Rendering, text layer, forms (and some XFA), the editors in section 2, `saveDocument()`, `extractPages()`, signature verification. Already a dependency | **Yes: the viewer, the editors and saving** |
| [pdfium-render](https://github.com/ajrcarey/pdfium-render) + PDFium | MIT/Apache-2.0 (crate), BSD-3-Clause (PDFium) | 0.9.4, 2026-09-06; binaries chromium/8111, 2026-10-19 | Page objects (create, edit, remove text, path and image objects), annotations, forms, importing pages, rotation, rendering, character positions, saving. It can inspect signatures but not make them | **Yes: native editing in Rust.** One shared library (about 5–6 MB) is shipped next to the binary, as libVLC is for Video |
| [@embedpdf/pdfium](https://www.npmjs.com/package/@embedpdf/pdfium) (PDFium in WebAssembly) | MIT (npm). The [EmbedPDF](https://github.com/embedpdf/embed-pdf-viewer) repository is Apache-2.0 | 2.15.1, 2026-09-16 | PDFium inside the page, used by EmbedPDF's viewer (true redaction, annotations) | A fallback if shipping a native library is a problem. pdfium-render warns that the wasm builds' fixed heap breaks on long documents, and EmbedPDF's v3 "is not yet recommended for production" |
| [lopdf](https://github.com/J-F-Liu/lopdf) | MIT | 0.46.0, 2026-10-21 | Object-level reading and writing, encryption and decryption, incremental saves, object streams | **Yes: structure, encryption, signatures** |
| [qpdf](https://github.com/qpdf/qpdf) ([qpdf-rs](https://github.com/ancwrd1/qpdf-rs) 0.3.7) | Apache-2.0 | 12.4.2, 2026-09-27 (10.6.3 here) | Repair, linearise, object streams, encryption, splitting | Optional, through the system's libqpdf when it's there |
| [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) | MIT | 2.11.1, 2026-09-15 | A maintained fork of pdf-lib: create and modify PDFs in JS | Not needed while pdf.js and PDFium cover writing. Keep it in mind for JS-only tools |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | MIT | 1.17.1, 2021-11-06 | The same, unmaintained | No |
| [MuPDF](https://mupdf.com) / [mupdf.js](https://www.npmjs.com/package/mupdf) (`mupdf` crate 0.8.0) | **AGPL-3.0-or-later** or commercial | npm 1.28.1, 2026-09-06 | The best all-rounder: redaction, text editing, conversion | **No.** AGPL would bind Zazabor's licence, and the commercial licence costs money |
| [Poppler](https://poppler.freedesktop.org) | **GPL** | 22.02 here | Rendering, `pdftoppm` | No as a library. Its tools may be called when installed |
| [Ghostscript](https://www.ghostscript.com/licensing/) | **AGPL** or commercial | 9.55 here | Strong compression (`-dPDFSETTINGS`) | Only as an optional external program |
| [hayro](https://github.com/LaurenzV/hayro) 0.8.0 / [krilla](https://github.com/LaurenzV/krilla) 0.8.2 | MIT/Apache-2.0 | 2026-10 / 2026-06 | A young Rust renderer and a Rust PDF writer (from the Typst ecosystem) | Watch them. krilla could make PDFs from scratch later |
| [tesseract.js](https://github.com/naptha/tesseract.js) | Apache-2.0 | 7.0.0, 2025-12-15 | Tesseract in WebAssembly, with word boxes | **Yes: OCR**, with `eng` and `ben` data downloaded on first use ([tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) `ben` is 0.86 MB, [tessdata_best](https://github.com/tesseract-ocr/tessdata_best) 11 MB) |
| [Tesseract](https://github.com/tesseract-ocr/tesseract) (native) | Apache-2.0 | 5.5.3, 2026-07-24 (Pop!_OS has 4.1.1, not installed) | Faster native OCR | Used instead of tesseract.js when it's installed |
| [OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF) | MPL-2.0 (Python, needs Ghostscript) | 17.13.0, 2026-09-28 | The reference OCR pipeline | Not bundled. Its approach (deskew, OCR, an invisible text layer) is the model to follow |
| Signing crates: [cms](https://crates.io/crates/cms) 0.2.3 (2024-01) with [x509-cert](https://crates.io/crates/x509-cert) 0.3.0; or [openssl](https://crates.io/crates/openssl) 0.10.81; [cryptoki](https://crates.io/crates/cryptoki) 0.12.1 for USB tokens; [pdf_signing](https://crates.io/crates/pdf_signing) 0.3.0 | Apache-2.0/MIT; Apache-2.0; Apache-2.0; MIT/Apache-2.0 | see left | Writing CMS SignedData and talking to PKCS#11 tokens | **Yes**, with lopdf placing the signature. `pdf_signing` is small and quiet (2024), so read it rather than depend on it |
| LibreOffice (`soffice`, installed here) | MPL-2.0 | — | Office files → PDF | Optional helper, as in the Office plan |

## 4. The design

### 4.1 Layout

Acrobat's current layout, in Zazabor's glass:

- **Title bar:** Save, Undo and Redo, the file's name and saved state, Share (Open in Files and
  Email as Attachment).
- **Tools pane on the left**, as Acrobat's "All tools": Comment, Fill & Sign, Edit, Organise
  Pages, Combine, Redact, Protect, Compress, Scan & OCR, Export. Picking one swaps in its own
  toolbar above the page.
- **Quick toolbar** floating over the page: select, hand, add comment, highlight, draw, text,
  sign, zoom, page number.
- **Side panels:** thumbnails, bookmarks (outline), attachments, comments with filters and
  replies, and signatures (who signed, and whether the signature is valid).
- **Status bar:** page *n* of *m*, zoom and the page-layout buttons.

pdf.js's `PDFViewer` with `PDFRenderingQueue` keeps memory low for long documents: it only renders
the pages near view. Zazabor styles its layers and builds every panel itself.

### 4.2 Saving and versions

- The PDF file is the document; there's no private format. Ctrl+S writes `saveDocument()`'s
  bytes through the safe save already used by the code editor and Office (`fs::text::write_bytes`).
- Recovery and versions as in the Office plan (`docs/plans/docs-and-sheets.md` §6.2): unsaved
  edits are kept every 5 seconds, and the previous file is kept for 30 days.
- After a Rust operation (redact, compress, OCR, protect), the page reloads the new bytes and stays
  at the same page and zoom. Each operation is one Undo step: the bytes from before it are kept,
  in memory up to a budget and then on disk.

### 4.3 Annotations pdf.js doesn't draw yet

For underline, strikethrough, squiggly, line, arrow, rectangle, ellipse and polygon:

1. Zazabor draws them over the page while they're being edited.
2. On save, Rust adds them as real PDF annotations with appearance streams (PDFium
   `FPDFPage_CreateAnnot`).
3. pdf.js then renders them like any other annotation.

Hand-drawn shapes can also be pdf.js Ink annotations straight away.

### 4.4 Forms

- pdf.js renders AcroForm fields and keeps their values in `annotationStorage`. `saveDocument()`
  writes the values and refreshes their appearances.
- XFA forms (old government forms) have partial support in pdf.js (`enableXfa`). The form says
  so, and offers "Open in LibreOffice" as a fallback.
- Making new forms (adding fields): PDFium can create widget annotations. This comes later (P5).

### 4.5 Redaction: true removal, not black boxes

1. **Mark:** drag over text, drag a rectangle, or search ("all phone numbers", "NID numbers",
   "email addresses", or custom text and regular expressions). Marks are red outlines, and
   nothing is removed yet.
2. **Apply**, page by page, in Rust with PDFium:
   - Remove every text character inside a mark. A text object only partly inside is rebuilt from
     its remaining characters, with the same font (`FPDFTextObj_GetFont`), size and matrix.
   - Paint the marked area black into image pixels (get the bitmap, change it, set it back).
   - Clip or remove vector paths in the area.
   - Remove annotations and form fields under marks.
   - Draw the black box (or a chosen colour and "Redacted" label).
3. **Clean up:** offer to remove metadata, hidden layers, attachments, document JavaScript,
   comments and previous revisions. Then save with a **full rewrite, never an incremental save**,
   so the old content can't survive in an earlier revision of the file.
4. **Check:** extract the text under each mark again and confirm it's empty. Then say "Redaction
   applied and checked".
5. **Paranoid mode:** replace each redacted page with an image of itself (OCR keeps it
   searchable). It's the safe choice for documents that must not leak.

### 4.6 Editing existing text, honestly

PDFs hold positioned runs of glyphs in subset fonts, not paragraphs. Acrobat rebuilds paragraphs
and reflows them, and that's the hard part. The plan has three steps:

- **P3, one run at a time:** click a line; its text object becomes editable in place. Saving
  writes the new text when the embedded font has every glyph needed. Otherwise Zazabor
  substitutes the closest installed font (Liberation for Arial, Times and Courier; Noto Sans
  Bengali for Bangla) and marks the run. There's no reflow.
- **P5, paragraph editing:** group runs into lines and paragraphs by position and spacing, then
  re-lay the edited paragraph out inside its box.
- **Always available:** "Add text", and "White-out and retype" for scans.

Bangla glyph runs in PDFs are often stored as shaped glyph IDs without Unicode mapping, so text
editing on those is unlikely to work. The tool says so instead of corrupting the text.

### 4.7 Signatures

| Kind | What it is | How |
|---|---|---|
| Fill & Sign | A picture of a signature: drawn, typed in a script font, or from a photo of paper with its background removed | pdf.js Signature editor. A library of saved signatures and initials, encrypted at rest with the privacy lock's key when a lock is set |
| Digital signature (PAdES baseline B-B) | A certificate-backed signature that proves who signed and that nothing changed since | Rust. lopdf adds a signature field and a `/ByteRange` placeholder in an incremental update. The bytes are hashed, a CMS SignedData is built (`cms` and `x509-cert`, or `openssl`) and written into the placeholder |
| Certificates | Where the key comes from | A .p12/.pfx file with its password, or a PKCS#11 USB token (`cryptoki`); Bangladeshi licensed CAs issue both. Optional RFC 3161 timestamps from a timestamp server the user names |
| Validation | Showing signatures in the file | pdf.js 6.2 verifies signatures and certificates. The Signatures panel lists each one: valid, changed since signing, or unknown issuer |

### 4.8 Scan & OCR

1. Render each page with pdf.js at 300 dpi.
2. Detect rotation and deskew.
3. Run tesseract.js in a worker, or native Tesseract when installed, with English, Bangla or
   both.
4. Rust adds an invisible text layer word by word (PDFium text objects, render mode invisible),
   so the page looks the same but search, selection and copy work.

It takes one page at a time with progress and Cancel, and never touches pages that already have
text unless asked.

### 4.9 Compress and protect

- **Compress:** pick a preset, High (150 dpi), Medium (120 dpi) or Small (96 dpi), or custom.
  Rust downsamples and re-encodes images as JPEG (photos) or Flate (line art) with PDFium and
  the `image` crate, drops unused objects, and writes object streams (lopdf, or qpdf when
  present). Before and after sizes show before saving. When Ghostscript is installed,
  "Maximum compression (Ghostscript)" is offered as a separate process.
- **Protect:** an open password and permissions (print, copy, edit) with AES-256 (lopdf). Remove
  a password the user knows. Zazabor never tries to break one.

### 4.10 Conversions

| From → to | How | Quality |
|---|---|---|
| Images → PDF | pdf.js `extractPages` with image entries, or PDFium; page size from the image or A4 | Exact |
| PDF → images | pdf.js render, encoded in Rust (PNG, JPEG, WebP) at a chosen dpi | Exact |
| Docs or Sheets → PDF | Office's Export as PDF (`webkit2gtk` print, see the Office plan §6.4), or LibreOffice | Good |
| .docx, .xlsx, .pptx files → PDF | LibreOffice helper when installed | Good |
| PDF → Docs (.docx) | pdf.js text content with positions: lines become paragraphs, font size becomes headings, images come along, and simple tables are found from aligned columns. Then Docs saves .docx | Approximate. It says so. LibreOffice's PDF import opens in Draw (positioned boxes), so it's not a better path |
| PDF → Sheets | Tables found as above, one sheet per table | Approximate; later (P6) |

### 4.11 Big files

Quick Look reads up to 64 MB at once (`MAX_BYTES` in `pdf.ts`). The editor should instead load
through the `cs://` protocol with HTTP range requests, so pdf.js fetches only the parts it needs
(a 500 MB scan opens at once). `protocol.rs` doesn't serve ranges today, so that's a small addition.

### 4.12 Print

The PDF itself goes to CUPS, so pages print exactly as they are (no re-rendering through the
webview):

- **The GTK print dialog**, through a small FFI to `gtk_print_unix_dialog` and `GtkPrintJob` with
  the file as its source (`gtk+-unix-print-3.0`; the gtk-rs crates don't wrap it).
- **Or Zazabor's own print sheet:** printers from CUPS (`lpstat`), pages, copies, duplex and fit,
  then `lp`.

Annotations print as they look; with "Flatten comments", from a temporary flattened copy.

### 4.13 Integration

- Files: double-click opens the PDF app (when on). Right-click shows Combine into PDF and
  Compress PDF. Quick Look stays as it is.
- Gallery: select photos, then Create PDF (one per page, A4 or photo size).
- Office: Docs and Sheets "Export as PDF" can open the result here.
- Wallet: receipts that are PDFs open here. Statement PDFs (bKash, banks) could be parsed later
  through the same text extraction.

## 5. Backend commands

All in `src-tauri/src/pdf/`, each on a path, writing a new file, with progress events for long
jobs.

| Command | Purpose |
|---|---|
| `pdf_annotate { path, annots }` | Add the annotation kinds pdf.js lacks (section 4.3) |
| `pdf_rotate { path, pages, degrees }` | Rotation stored in the file |
| `pdf_redact { path, marks, cleanup, rasterize }` | Section 4.5, returns the check's result |
| `pdf_edit_text { path, page, object, text }` | Section 4.6 |
| `pdf_add_objects { path, page, objects }` | Text, images, links, watermarks, headers and footers |
| `pdf_ocr_layer { path, page, words }` | The invisible text layer (OCR runs in the page) |
| `pdf_compress { path, preset }` | Section 4.9; returns the old and new sizes |
| `pdf_protect { path, open_password, permissions }`, `pdf_unprotect { path, password }` | Encryption |
| `pdf_sign { path, field, cert, appearance }` | PAdES signing |
| `pdf_flatten { path }` | Annotations and fields into page content |
| `pdf_print { path, options }` | Section 4.12 |

## 6. Milestones

| # | Milestone | Done when |
|---|---|---|
| P0 | **Viewer**: the PDF app in Office, `PDFViewer` with thumbnails, outline, search and zoom, range loading, opening from Files | A 1,000-page manual scrolls smoothly and search finds every hit. A 500 MB scan opens in under 2 seconds |
| P1 | **Comment and Fill & Sign**: pdf.js editors, comment panel, forms, signature library, save, recovery and versions | Annotations and form values saved in Zazabor show correctly in Acrobat Reader, Firefox and Chrome |
| P2 | **Organise and Combine**: thumbnail grid, drag to reorder, rotate, delete, insert, extract, split, merge, images → PDF | Merging three PDFs and reordering their pages gives a file that opens everywhere, with bookmarks kept where pdf.js keeps them |
| P3 | **Rust engine**: pdfium-render with the shipped PDFium, extra annotation kinds, add text and images, edit one run of text, flatten, watermark, print | Edits survive a round trip through Acrobat Reader. The .deb and AppImage include PDFium |
| P4 | **Redact, Protect, Compress** | A redaction test corpus (text, images, overlapping runs, form fields) passes the text check, and no redacted string can be found with `strings` or `pdftotext`. An encrypted file opens in Acrobat Reader with its password |
| P5 | **Scan & OCR, digital signatures, paragraph text editing, form creation** | An English or Bangla scan becomes searchable. A signature made with a test .p12 validates in Acrobat Reader |
| P6 | **Conversions**: PDF → Docs and Sheets | Text documents convert with their headings, paragraphs and images in order |

## 7. Effort, roughly

P0 and P1 take about one session each (pdf.js does the heavy lifting), and P2 one. P3 takes 2,
mostly the PDFium packaging and the text runs. P4 takes 2: redaction has to be right. P5 takes 2–3,
and P6 1–2.

## 8. Risks

| Risk | Mitigation |
|---|---|
| A redaction leaves recoverable text | The full rewrite, the automatic check, the corpus in P4, and a rasterise option. Never call a black box a redaction |
| pdf.js editor APIs change between versions (they are newer and less documented than its viewer) | Pin the version; wrap the editor calls in one module; read the changelog before upgrading |
| Shipping PDFium (one native library per platform) | Bundle it like libVLC: the AppImage carries it, and the .deb installs it under Zazabor's own lib folder. The wasm build is the fallback (section 3) |
| Text editing breaks a document's text | Edit only when the font has the glyphs, mark substitutions, keep Undo and versions |
| Malicious PDFs (JavaScript, exploits in parsers) | pdf.js runs in the page's sandbox with scripting off (`PDFScriptingManager` disabled). PDFium runs in a worker thread with limits; keep it updated weekly as pdfium-binaries is |
| Digital-signature details (byte ranges, certificate chains) | Test against Acrobat Reader and pdf.js validation with test certificates before release |

## 9. Licensing summary

Everything recommended is Apache-2.0, MIT, BSD or MPL-2.0. AGPL (MuPDF, Ghostscript) and GPL
(Poppler) stay out of Zazabor's code. Ghostscript and Poppler's tools may be run as separate
programs when installed, as LibreOffice is, but never shipped with it.

## 10. What exists today

`pdfjs-dist` 6.4.299 and its worker load lazily for Quick Look (`src/shared/quicklook/pdf.ts`)
and file thumbnails (`src/shared/file-thumbs.ts`). LibreOffice, Ghostscript 9.55, `pdftoppm` and
`libqpdf28` are on this machine. `qpdf`, `mutool` and `tesseract` aren't.

## 11. Decisions to make

1. **Where it lives:** a third app in Office (recommended), or its own section on the rail? What
   should it be called: PDF, Zazabor PDF, or another name?
2. **Default PDF app:** should Zazabor offer to become the system's default for PDFs (off by
   default, like the other switches)?
3. **Ship PDFium** (one native library, about 5–6 MB, in the .deb and AppImage), or use the wasm
   build inside the page and accept its limits on long documents?
4. **Digital signatures in the first version?** If so, do you use a .p12/.pfx file or a USB token,
   and from which CA? A test certificate from it would help.
5. **OCR languages:** English and Bangla downloaded on first use (about 1 MB for the fast models,
   12 MB for the best ones), or bundled?
6. **External helpers:** fine to call Ghostscript (AGPL) and LibreOffice as separate programs
   when they're installed, for compression and Office conversions?
7. **Redaction default:** apply as object removal with the check (recommended), or always
   rasterise redacted pages?
8. **Signature library:** keep saved signatures encrypted with the privacy lock, and always ask
   before using one?
