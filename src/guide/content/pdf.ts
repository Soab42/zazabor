import type { GuideArticle } from "../types";

export const pdf: GuideArticle = {
  id: "pdf",
  title: "PDF",
  icon: "pdfFile",
  group: "office",
  summary: "Read, comment on, fill, sign, organise, edit, protect, redact, OCR and convert PDFs, like Acrobat.",
  open: { module: "office", target: "pdf", label: "Open PDF" },
  needs: "Redaction that keeps the rest of the page as text, and **Edit Text**, use PDFium (Google's PDF engine). The installer adds it; without it those tools say so and redaction turns pages into pictures instead. **Recognize Text** downloads its English and Bangla language data once, after asking.",
  topics: [
    {
      title: "Read",
      steps: [
        "Open a PDF from Office, Files or the Open window. Password-protected files ask for the password.",
        "Use the **Navigation Pane** ({F4}) for page **Thumbnails**, **Bookmarks**, **Comments** and **Attachments**.",
        "Zoom with {Ctrl+=}/{Ctrl+-}, or **Fit Width** and **Actual Size**. **View** has **Single Page**, **Two Page**, **Scrolling**, **Wrapped**, **Read Mode** ({Ctrl+H}), **Full Screen** and **Dark Pages**.",
        "Press {Ctrl+F} to find words; {Ctrl+Shift+N} goes to a page.",
      ],
      keys: [
        ["Ctrl+F", "Find"],
        ["F4", "Navigation pane"],
        ["Ctrl+0", "Fit the page"],
        ["Ctrl+Shift+N", "Go to a page"],
        ["Ctrl+H", "Read Mode"],
        ["Ctrl+D", "Document properties"],
        ["Ctrl+S", "Save"],
        ["Ctrl+P", "Print"],
      ],
    },
    {
      title: "Comment",
      steps: [
        "On the **Comment** tab, select text and press **Highlight**, **Underline**, **Strikethrough** or **Squiggly**.",
        "Add a **Text Box**, a **Note**, a drawing with **Draw**, or **Shapes**: rectangle, oval, line, arrow, polygon (double-click to finish one).",
        "Open the **Comments List** to read every comment, reply to one, or delete it.",
      ],
      tips: ["Comments are standard PDF comments, so Acrobat and other readers show them."],
    },
    {
      title: "Fill & Sign",
      steps: [
        "On **Fill & Sign**, click into a form's fields and type; **Highlight Fields** shows where they are.",
        "**Add Text**, **Date**, **Check**, **Cross** and **Dot** place text and marks where you click.",
        "**Sign** places your signature: typed, drawn or from a picture. It's kept for next time.",
        "**Certificate** signs with a digital certificate (a .p12 or .pfx file and its password). **Signatures** shows whether each signature still covers the whole file.",
      ],
      tips: ["A drawn or typed signature is a picture on the page; only **Certificate** makes a verifiable digital signature."],
    },
    {
      title: "Organize pages",
      steps: [
        "Press **Organize Pages** for a grid of pages. Click, Ctrl-click or Shift-click to select.",
        "Drag pages to reorder; **Rotate Left**/**Rotate Right**; **Delete**.",
        "**Insert** pages **From File…** or a **Blank Page**; **Replace Pages…** swaps pages for pages from another file.",
        "**Extract** saves pages as a new file; **Split** cuts the file every few pages or at its bookmarks.",
        "To join files, press **New → Combine files** in Office; **Pictures to PDF** turns photos into pages.",
      ],
    },
    {
      title: "Edit",
      steps: [
        "On **Edit**, **Add Text** and **Add Picture** put new text and pictures on the page.",
        "**Edit Text**: click a line of existing text and type over it. It keeps the file's own font when that font has every letter; otherwise the line switches to a standard font and tells you.",
        "**Watermark**, **Header & Footer** and **Bates Numbering** stamp pages.",
        "**Flatten** turns comments and form fields into plain page content.",
      ],
      tips: ["**Edit Text** changes one line at a time and doesn't re-flow a paragraph. Bangla and other joined scripts can't be edited this way; use **Add Text**."],
    },
    {
      title: "Protect and redact",
      steps: [
        "On **Protect**, press **Mark Area** and drag over what must go, or **Find & Mark** for words, phone numbers, emails or ID numbers.",
        "Press **Apply Redactions**. Only the marked text, pictures and shapes are removed; the rest of the page stays real, selectable text. A check afterwards makes sure nothing marked is left.",
        "Prefer the safest way? In the same window, choose **Replace marked pages with pictures** instead of **Remove what's under the marks**.",
        "**Protect** sets a password (AES-256) and permissions; **Remove Security** takes them off.",
        "**Remove Hidden Info** removes metadata, attachments and scripts; **Reduce Size** compresses the file.",
      ],
      tips: [
        "Redacting a signed file makes its signatures show as invalid; Zazabor warns you first.",
        "Redaction can't be undone once the file is saved: keep a copy of the original.",
      ],
    },
    {
      title: "Scans, conversions and statements",
      steps: [
        "**Scan & OCR → Recognize Text** makes a scanned PDF searchable and selectable, in English and Bangla. It takes about 15–20 seconds a page.",
        "**Convert → To Word** makes a .docx: \"Flowing text\" opens in Docs; \"Keep the layout\" uses LibreOffice when it's installed.",
        "**Statement to Excel** turns a bank statement into a checked workbook; **Tables to Excel** turns any tables into a workbook.",
      ],
      tips: ["The OCR languages are listed in **Settings → PDF**, with **Remove**."],
    },
  ],
  related: ["office", "wallet-statements", "install"],
};
