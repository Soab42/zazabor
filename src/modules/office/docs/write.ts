import type { JSONContent } from "@tiptap/core";
import { Document, Packer, PageOrientation } from "docx";
import { htmlToContent } from "docx/html";
import type { PageSetup } from "./read";
import { layoutPictures } from "./picture";

/**
 * Saving Docs content. A .docx is built with the `docx` package from the editor's HTML (its
 * HTML reader keeps paragraphs' styles and formatting, lists, tables, pictures, links and page
 * breaks), with Word's own styles for headings, Title, Subtitle and Quote so the file looks and
 * behaves the same in Word. Also a web page, plain text and Markdown.
 */

const twips = (pt: number) => Math.round(pt * 20);

/** Word's look for the styles Docs uses, matched by docs.css. */
const STYLES = {
  default: {
    document: { run: { font: "Calibri", size: 22 }, paragraph: { spacing: { after: 160, line: 259 } } },
    title: { run: { font: "Calibri Light", size: 56 }, paragraph: { spacing: { after: 0, line: 240 } } },
    heading1: { run: { font: "Calibri Light", size: 32, color: "2F5496" }, paragraph: { spacing: { before: 240, after: 0 }, keepNext: true } },
    heading2: { run: { font: "Calibri Light", size: 26, color: "2F5496" }, paragraph: { spacing: { before: 40, after: 0 }, keepNext: true } },
    heading3: { run: { font: "Calibri Light", size: 24, color: "1F3763" }, paragraph: { spacing: { before: 40, after: 0 }, keepNext: true } },
    heading4: { run: { font: "Calibri Light", italics: true, color: "2F5496" }, paragraph: { spacing: { before: 40, after: 0 }, keepNext: true } },
  },
  paragraphStyles: [
    { id: "Subtitle", name: "Subtitle", basedOn: "Normal", next: "Normal", run: { color: "5A5A5A", characterSpacing: 15 }, paragraph: { spacing: { after: 160 } } },
    { id: "Quote", name: "Quote", basedOn: "Normal", next: "Normal", run: { italics: true, color: "404040" }, paragraph: { spacing: { before: 200, after: 160 }, indent: { left: 864, right: 864 }, alignment: "center" as const } },
    { id: "Code", name: "Code", basedOn: "Normal", next: "Normal", run: { font: "Liberation Mono", size: 20 }, paragraph: { spacing: { after: 0, line: 240 } } },
    // List items sit close together, as in Word (no space between paragraphs of the same style).
    { id: "ListParagraph", name: "List Paragraph", basedOn: "Normal", uiPriority: 34, paragraph: { contextualSpacing: true, indent: { left: 720 } } },
  ],
};

/** The editor's HTML as the .docx reader should see it. */
function prepare(html: string, warn: (text: string) => void): string {
  const root = document.createElement("template");
  root.innerHTML = html;
  // Pictures' wrapping as Word's: floats, or a paragraph of their own (picture.ts).
  layoutPictures(root.content, true, warn);
  // A page break starts the paragraph after it on a new page (no empty paragraph in between).
  for (const br of Array.from(root.content.querySelectorAll("[data-page-break]"))) {
    const next = br.nextElementSibling as HTMLElement | null;
    if (next && /^(P|H[1-6])$/.test(next.tagName)) next.style.breakBefore = "page";
    else {
      const p = document.createElement("p");
      p.style.breakBefore = "page";
      p.style.margin = "0";
      br.after(p);
    }
    br.remove();
  }
  // Code blocks are paragraphs in the Code style, one per line.
  for (const pre of Array.from(root.content.querySelectorAll("pre"))) {
    const lines = (pre.textContent ?? "").split("\n");
    pre.replaceWith(...lines.map((line) => {
      const p = document.createElement("p");
      p.className = "ds-code";
      p.textContent = line || "\u00a0";
      return p;
    }));
  }
  return root.innerHTML;
}

export async function writeDocx(html: string, page: PageSetup, title: string): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const warnings: string[] = [];
  const contentWidth = ((page.orientation === "landscape" ? page.height : page.width) - page.margins.left - page.margins.right) / 0.75;
  const children = htmlToContent(prepare(html, (w) => warnings.push(w)), {
    styleMap: { "p.ds-title": "Title", "p.ds-subtitle": "Subtitle", "p.ds-quote": "Quote", "p.ds-code": "Code" },
    // As the page shows them: header cells aren't centred (a browser centres <th>), and the
    // Normal style's line spacing is the document's default, not repeated on every paragraph.
    stylesheet: "th { text-align: left; }",
    maxImageWidth: Math.round(contentWidth),
    onWarning: (w) => warnings.push(w.message),
  });
  const doc = new Document({
    creator: "Zazabor Docs",
    title,
    styles: STYLES,
    sections: [{
      properties: {
        page: {
          size: { width: twips(page.width), height: twips(page.height), orientation: page.orientation === "landscape" ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
          margin: { top: twips(page.margins.top), right: twips(page.margins.right), bottom: twips(page.margins.bottom), left: twips(page.margins.left), header: 708, footer: 708 },
        },
      },
      children: [...children],
    }],
  });
  return { bytes: await Packer.pack(doc, "uint8array"), warnings };
}

/** A web page that looks like the document (fonts, styles), readable in any browser. */
export function writeHtml(html: string, title: string, css: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Zazabor Docs">
<title>${esc(title)}</title>
<style>
body { max-width: 46em; margin: 3em auto; padding: 0 1.5em; }
${css}
</style>
</head>
<body class="dc-content">
${html.replace(/<div[^>]*data-page-break[^>]*><\/div>/g, '<div style="break-after: page"></div>')}
</body>
</html>
`;
}

/** Markdown for what it can say: headings, paragraphs, lists, quotes, code, tables, emphasis, links, images. */
export function writeMarkdown(doc: JSONContent): string {
  const inline = (nodes: JSONContent[] = []): string => nodes.map((n) => {
    if (n.type === "hardBreak") return "  \n";
    if (n.type === "image") return `![${n.attrs?.alt ?? ""}](${String(n.attrs?.src ?? "").startsWith("data:") ? "image" : n.attrs?.src})`;
    if (n.type !== "text") return "";
    let text = (n.text ?? "").replace(/([*_`[\]\\])/g, "\\$1");
    const marks = n.marks ?? [];
    if (marks.some((m) => m.type === "code")) text = `\`${n.text}\``;
    if (marks.some((m) => m.type === "bold")) text = `**${text}**`;
    if (marks.some((m) => m.type === "italic")) text = `*${text}*`;
    if (marks.some((m) => m.type === "strike")) text = `~~${text}~~`;
    const link = marks.find((m) => m.type === "link");
    if (link) text = `[${text}](${link.attrs?.href})`;
    return text;
  }).join("");
  const block = (n: JSONContent, indent = ""): string => {
    switch (n.type) {
      case "heading": return `${"#".repeat(n.attrs?.level ?? 1)} ${inline(n.content)}`;
      case "paragraph": {
        const text = inline(n.content);
        const style = n.attrs?.docStyle;
        return style === "title" ? `# ${text}` : style === "subtitle" ? `*${text}*` : style === "quote" ? `> ${text}` : text;
      }
      case "blockquote": return (n.content ?? []).map((c) => block(c)).join("\n\n").split("\n").map((l) => `> ${l}`).join("\n");
      case "codeBlock": return `\`\`\`\n${(n.content ?? []).map((c) => c.text ?? "").join("")}\n\`\`\``;
      case "horizontalRule": return "---";
      case "pageBreak": return "---";
      case "bulletList": case "orderedList": case "taskList":
        return (n.content ?? []).map((item, i) => {
          const marker = n.type === "orderedList" ? `${(n.attrs?.start ?? 1) + i}.` : n.type === "taskList" ? `- [${item.attrs?.checked ? "x" : " "}]` : "-";
          const [first, ...rest] = item.content ?? [];
          const head = `${indent}${marker} ${first ? block(first, `${indent}  `) : ""}`;
          return [head, ...rest.map((c) => block(c, `${indent}  `).split("\n").map((l) => (l.startsWith(indent) ? l : `${indent}  ${l}`)).join("\n"))].join("\n");
        }).join("\n");
      case "table": {
        const rows = (n.content ?? []).map((row) => (row.content ?? []).map((cell) => (cell.content ?? []).map((c) => inline(c.content)).join(" ").replace(/\|/g, "\\|")));
        if (!rows.length) return "";
        const width = Math.max(...rows.map((r) => r.length));
        const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
        return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
      }
      default: return (n.content ?? []).map((c) => block(c, indent)).join("\n\n");
    }
  };
  return `${(doc.content ?? []).map((n) => block(n)).join("\n\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
