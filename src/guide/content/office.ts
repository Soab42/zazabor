import type { GuideArticle } from "../types";

export const office: GuideArticle = {
  id: "office",
  title: "Office",
  icon: "office",
  group: "office",
  summary: "Docs, Sheets and PDF: open and save Word, Excel and PDF files, laid out like Microsoft 365.",
  open: { module: "office", target: "home", label: "Open Office" },
  topics: [
    {
      title: "Start or open a file",
      steps: [
        "Office has its own rail: **Home**, **New** and **Open**, then pages for **Docs**, **Sheets** and **PDF**, then the files you have open (a dot marks unsaved ones).",
        "On **Home** or **New**, pick a blank file or a template: letter, report, resume, meeting notes; monthly budget, invoice, to-do list, timesheet; combine files or pictures to PDF.",
        "Press **Open** ({Ctrl+O}) to pick a file, or choose one from Recent. Pin files you use often to keep them at the top.",
        "Word, Excel and PDF files opened from Files get an Office window of their own.",
      ],
    },
    {
      title: "The File tab (backstage)",
      steps: [
        "In an open file, click **File** (the coloured tab). A list opens on the left, as in Word and Excel.",
        "**Info**: where the file is, its size and pages or sheets, and **Open File Location**.",
        "**Save** saves; **Save As** picks a folder, a name and a format (Word, web page, Markdown or text; Excel, CSV or TSV).",
        "**Print** shows a preview of the pages; press **Print** to choose the printer. Print to File in the print window saves a PDF.",
        "**Export** makes a PDF or changes the file type. **Close** closes the file.",
        "Press the round arrow or {Esc} to go back to the file.",
      ],
      keys: [
        ["Ctrl+N", "New file of the same kind"],
        ["Ctrl+O", "Open"],
        ["Ctrl+S", "Save"],
        ["Ctrl+Shift+S", "Save As"],
        ["Ctrl+P", "Print"],
        ["Ctrl+W", "Close the file"],
      ],
    },
    {
      title: "AutoRecover",
      tips: [
        "Unsaved work is copied every 20 seconds. If Zazabor stops before you save (a crash, a power cut), Home offers it back under **Recovered**.",
        "Closing the window with unsaved files asks about each one.",
      ],
    },
  ],
  related: ["docs", "sheets", "pdf"],
};
