import type { GuideArticle } from "../types";

export const docs: GuideArticle = {
  id: "docs",
  title: "Docs",
  icon: "docFile",
  group: "office",
  summary: "A Word-like word processor that opens and saves .docx files.",
  open: { module: "office", target: "doc", label: "Open Docs" },
  topics: [
    {
      title: "Write and format",
      steps: [
        "Start from **Blank document** or a template, or open a .docx, .md, .txt or .html file.",
        "The **Home** tab has the font, size, bold and colours, lists, alignment and spacing, and the **Styles** (Normal, Heading 1, Heading 2, Title…).",
        "**Format Painter** copies formatting: click it, then select the text that should look the same.",
        "**Layout** sets margins, orientation, paper size and breaks; **View** switches **Print Layout** and **Web Layout**, shows formatting marks and zooms.",
      ],
      keys: [
        ["Ctrl+B", "Bold (Ctrl+I italic, Ctrl+U underline)"],
        ["Ctrl+L", "Align left (Ctrl+E centre, Ctrl+R right, Ctrl+J justify)"],
        ["Ctrl+Shift+>", "Bigger text (Ctrl+Shift+< smaller)"],
        ["Ctrl+K", "Insert a link"],
        ["Ctrl+Enter", "Page break"],
        ["Ctrl+F", "Find (Ctrl+H replace)"],
        ["Ctrl+Shift+V", "Paste as plain text"],
      ],
    },
    {
      title: "Tables, links and more",
      steps: [
        "**Insert → Table** picks the size. Inside a table, the **Table** tab adds and deletes rows and columns, merges cells and shades them.",
        "**Insert** also has **Page Break**, **Link**, **Horizontal Line**, **Date & Time** and **Symbol**.",
        "**Review** has **Spelling** and **Word Count**; the status bar shows the page and word count too.",
      ],
    },
    {
      title: "Pictures, placed like in Word",
      steps: [
        "Press **Insert → Pictures** and pick one or more pictures.",
        "Click a picture to select it: handles appear, with the **Layout Options** button beside it, and the **Picture Format** tab opens.",
        "**Wrap Text**: **In Line with Text**, **Square**, **Top and Bottom**, **Behind Text** or **In Front of Text**.",
        "**Position** puts it left, centre or right. Behind or in front of the text, drag it anywhere, or nudge it with the arrow keys (Shift for bigger steps).",
        "Type a **Height** or **Width** in centimetres (the shape is kept), or drag a corner handle. **Reset Size** goes back to the picture's own size.",
        "**Rotate** turns or flips it; **Alt Text** describes it for screen readers.",
      ],
      tips: [
        "Saved as .docx, the layout comes with it. Pictures behind or in front of the text are saved with Square wrapping, and Zazabor tells you so.",
      ],
    },
    {
      title: "Save and print",
      steps: [
        "Press {Ctrl+S}. The first time, choose where and the format: Word (.docx), web page, Markdown or plain text.",
        "**File → Print** shows the pages first; Print to File in the print window makes a PDF.",
      ],
      tips: [
        "If a Word file has parts Docs can't keep (headers and footers, footnotes, comments…), saving over it asks first and offers to save a copy instead.",
      ],
    },
  ],
  related: ["office", "sheets", "pdf"],
};
