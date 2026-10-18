/**
 * A small Markdown parser for Quick Look. It produces a plain tree (no HTML); `markdown-view.ts`
 * turns the tree into DOM nodes with `textContent`, so file content is never interpreted as markup.
 * Supported: headings, paragraphs, lists (nested), block quotes, fenced and indented code, rules,
 * tables, inline code, emphasis, strikethrough, links (shown as text) and images (shown as alt text).
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "image"; alt: string }
  | { t: "br" };

export type Block =
  | { t: "heading"; level: number; c: Inline[] }
  | { t: "para"; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "quote"; c: Block[] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Parses inline syntax; unmatched markers stay as text. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!~|>]/.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const ticks = /^`+/.exec(src.slice(i))![0];
      const close = src.indexOf(ticks, i + ticks.length);
      if (close > 0) {
        flush();
        out.push({ t: "code", v: src.slice(i + ticks.length, close).replace(/^ (.*) $/, "$1") });
        i = close + ticks.length;
        continue;
      }
    }
    if (c === "!" && src[i + 1] === "[") {
      const m = /^!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: "image", alt: m[1] });
        i += m[0].length;
        continue;
      }
    }
    if (c === "[") {
      const close = matchBracket(src, i);
      if (close > 0) {
        const m = /^\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(src.slice(close + 1));
        if (m) {
          flush();
          out.push({ t: "link", href: m[1], c: parseInline(src.slice(i + 1, close)) });
          i = close + 1 + m[0].length;
          continue;
        }
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      const marker = src.startsWith(c.repeat(2), i) ? c.repeat(2) : c;
      const intraword = c === "_" && /\w/.test(src[i - 1] ?? " ");
      if (!intraword && !(c === "~" && marker.length === 1)) {
        const close = findClose(src, i + marker.length, marker);
        if (close > 0) {
          flush();
          const kind = c === "~" ? "del" : marker.length === 2 ? "strong" : "em";
          out.push({ t: kind, c: parseInline(src.slice(i + marker.length, close)) });
          i = close + marker.length;
          continue;
        }
      }
    }
    if (c === " " && src.startsWith("  \n", i)) {
      flush();
      out.push({ t: "br" });
      i += 3;
      continue;
    }
    text += c === "\n" ? " " : c;
    i++;
  }
  flush();
  return out;
}

function matchBracket(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

/** The index of the closing `marker`, which must follow a non-space and not be empty. */
function findClose(src: string, from: number, marker: string): number {
  if (!src[from] || /\s/.test(src[from])) return -1;
  for (let i = from + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "`") {
      const close = src.indexOf("`", i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (src.startsWith(marker, i) && !/\s/.test(src[i - 1]) && src[i + marker.length] !== marker[0]) return i;
  }
  return -1;
}

const splitRow = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));

/** Parses a Markdown document into blocks. */
export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  const blank = (line: string) => !line.trim();
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const [, ticks, lang] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${ticks[0]}{${ticks.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ t: "code", lang, v: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: "heading", level: heading[1].length, c: parseInline(heading[2]) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^ {4}|^\t/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^ {4}|^\t/.test(lines[i]) || (blank(lines[i]) && /^ {4}|^\t/.test(lines[i + 1] ?? "")))) {
        body.push(lines[i].replace(/^ {4}|^\t/, ""));
        i++;
      }
      blocks.push({ t: "code", lang: "", v: body.join("\n") });
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}> ?/, ""));
      blocks.push({ t: "quote", c: parseBlocks(body) });
      continue;
    }
    if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
      const head = splitRow(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) rows.push(splitRow(lines[i++]).map(parseInline));
      blocks.push({ t: "table", head, rows });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const result = parseList(lines, i);
      blocks.push(result.block);
      i = result.next;
      continue;
    }
    // Paragraph: runs until a blank line or the start of another block.
    const body: string[] = [line.trimStart()];
    i++;
    while (i < lines.length && !blank(lines[i]) && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !HR.test(lines[i])
      && !/^\s{0,3}>/.test(lines[i]) && !ITEM.test(lines[i])) {
      body.push(lines[i].trimStart());
      i++;
    }
    blocks.push({ t: "para", c: parseInline(body.join("\n").trimEnd()) });
  }
  return blocks;
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = ITEM.exec(lines[start])!;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: Block[][] = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = baseIndent + m[2].length + 1;
    const body: string[] = [m[3]];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // A blank line continues the item only when an indented line follows.
        const nextLine = lines[i + 1] ?? "";
        if (nextLine.trim() && (nextLine.length - nextLine.trimStart().length) >= contentIndent) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      const indent = line.length - line.trimStart().length;
      if (indent >= contentIndent) body.push(line.slice(contentIndent));
      else if (indent > baseIndent && !ITEM.test(line)) body.push(line.trim());
      else if (indent > baseIndent) body.push(line.slice(Math.min(indent, contentIndent)));
      else break;
      i++;
    }
    items.push(parseBlocks(body));
  }
  const startNumber = ordered ? parseInt(first[2], 10) : 1;
  return { block: { t: "list", ordered, start: startNumber, items }, next: i };
}
