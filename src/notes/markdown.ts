/**
 * A note's text, between its Markdown (what's saved and synced) and the editor's DOM.
 *
 * A note is Markdown read line by line: every line of the file is a line of the note (wrapped
 * lines aren't joined into paragraphs), so a note looks the same typed, saved and on a drive's
 * website. Blocks: plain lines, headings, bulleted, numbered and checklist items (nested),
 * quotes, fenced code, rules and tables. Inline: **bold**, *italic*, <u>underline</u>,
 * ~~strikethrough~~, `code`, [links](url) and ![images](url).
 *
 * `toMarkdown(parse(md))` gives `md` back for anything this module wrote, so a note never looks
 * changed when it isn't. `read` takes the editor's DOM, or HTML pasted from a document or a web
 * page, back to blocks.
 */

export type Mark = "b" | "i" | "u" | "s";

export interface Run {
  text: string;
  /** In `MARKS` order. */
  marks: Mark[];
  /** Inline code: literal text. */
  code?: boolean;
  /** Part of a link to this address. */
  href?: string;
  /** An image at this address; `text` is its description. */
  image?: string;
}

export type ListKind = "bullet" | "ordered" | "check";
export type Align = "left" | "center" | "right" | null;

export type Block =
  | { kind: "p"; runs: Run[] }
  | { kind: "heading"; level: number; runs: Run[] }
  /** A list item; `depth` 0 is the outermost list, `number` counts for numbered lists. */
  | { kind: "item"; list: ListKind; depth: number; checked: boolean; number: number; runs: Run[] }
  /** One line of a quote, `depth` levels deep (1 for "> "). */
  | { kind: "quote"; depth: number; runs: Run[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "rule" }
  | { kind: "table"; align: Align[]; head: Run[][]; rows: Run[][][] };

type LineBlock = Extract<Block, { runs: Run[] }>;

/** Outermost first, both in Markdown and in the DOM. */
const MARKS: Mark[] = ["b", "i", "u", "s"];

// ---- Markdown → blocks ---------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+|$)(\[[ xX]\](?:[ \t]+|$))?(.*)$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

export function parse(body: string): Block[] {
  if (!body) return [];
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  // Indents of the open list levels, to tell nesting whatever the indent width.
  let indents: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const [, marker, lang] = fence;
      const text: string[] = [];
      let j = i + 1;
      const closes = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
      while (j < lines.length && !closes.test(lines[j])) text.push(lines[j++]);
      blocks.push({ kind: "code", lang, text: text.join("\n") });
      i = j;
      indents = [];
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => alignOf(c.trim()));
      const rows: Run[][][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim()) rows.push(cells(lines[j++]).map((cell) => parseInline(cell)));
      const width = head.length;
      blocks.push({
        kind: "table",
        align: Array.from({ length: width }, (_, k) => align[k] ?? null),
        head: head.map((cell) => parseInline(cell)),
        rows: rows.map((r) => Array.from({ length: width }, (_, k) => r[k] ?? [])),
      });
      i = j - 1;
      indents = [];
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      indents = [];
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, runs: parseInline(heading[2] ?? "") });
      indents = [];
      continue;
    }
    if (QUOTE.test(line)) {
      let rest = line;
      let depth = 0;
      while (QUOTE.test(rest)) {
        rest = rest.replace(QUOTE, "");
        depth++;
      }
      blocks.push({ kind: "quote", depth, runs: parseInline(rest) });
      indents = [];
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const [, lead, marker, box, content] = item;
      const indent = lead.replace(/\t/g, "    ").length;
      while (indents.length && indent < indents[indents.length - 1]) indents.pop();
      if (!indents.length || indent > indents[indents.length - 1]) indents.push(indent);
      const ordered = /\d/.test(marker[0]);
      blocks.push({
        kind: "item",
        list: box ? "check" : ordered ? "ordered" : "bullet",
        depth: indents.length - 1,
        checked: !!box && box[1] !== " ",
        number: ordered ? Number.parseInt(marker, 10) : 1,
        runs: parseInline(content),
      });
      continue;
    }
    indents = [];
    blocks.push({ kind: "p", runs: parseInline(line) });
  }
  return blocks;
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

/** A table row's cells, split at unescaped pipes. */
function cells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const out: string[] = [];
  let cell = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      cell += "\\|";
      i++;
    } else if (text[i] === "|") {
      out.push(cell.trim());
      cell = "";
    } else cell += text[i];
  }
  out.push(cell.trim());
  return out;
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const SPACE = /\s/;
const WORD = /[\p{L}\p{N}]/u;

/** Inline Markdown. Delimiters that open and never close stay as text. */
export function parseInline(src: string, inherited: { marks?: Mark[]; href?: string } = {}): Run[] {
  const runs: Run[] = [];
  // Emphasis opened in this span, innermost last, with the character that opened it.
  const stack: { mark: Mark; char: string }[] = [];
  const marks = () => {
    const on = new Set<Mark>([...(inherited.marks ?? []), ...stack.map((s) => s.mark)]);
    return MARKS.filter((m) => on.has(m));
  };
  let text = "";
  const flush = () => {
    if (text) runs.push(withHref({ text, marks: marks() }, inherited.href));
    text = "";
  };
  const active = (mark: Mark, char?: string) => stack.some((s) => s.mark === mark && (!char || s.char === char));
  const close = (mark: Mark) => {
    flush();
    stack.splice(stack.map((s) => s.mark).lastIndexOf(mark), 1);
  };
  const open = (mark: Mark, char: string) => {
    flush();
    stack.push({ mark, char });
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length && PUNCTUATION.test(src[i + 1])) {
      text += src[++i];
      continue;
    }
    if (c === "`") {
      const ticks = /^`+/.exec(src.slice(i))![0];
      const end = findTicks(src, i + ticks.length, ticks.length);
      if (end >= 0) {
        flush();
        let code = src.slice(i + ticks.length, end);
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        runs.push(withHref({ text: code, marks: marks(), code: true }, inherited.href));
        i = end + ticks.length - 1;
        continue;
      }
      text += ticks;
      i += ticks.length - 1;
      continue;
    }
    if ((c === "!" && src[i + 1] === "[") || c === "[") {
      const image = c === "!";
      const link = linkAt(src, image ? i + 1 : i);
      if (link && !inherited.href) {
        flush();
        if (image) runs.push({ text: unescape(link.label), marks: marks(), image: link.url });
        else runs.push(...parseInline(link.label, { marks: marks(), href: link.url }));
        i = link.end - 1;
        continue;
      }
    }
    if (c === "<") {
      const auto = /^<((?:https?|mailto|file):[^\s<>]+)>/.exec(src.slice(i));
      if (auto && !inherited.href) {
        flush();
        runs.push({ text: auto[1], marks: marks(), href: auto[1] });
        i += auto[0].length - 1;
        continue;
      }
      if (src.startsWith("<u>", i) && !active("u") && src.indexOf("</u>", i + 3) > 0) {
        open("u", "<");
        i += 2;
        continue;
      }
      if (src.startsWith("</u>", i) && active("u")) {
        close("u");
        i += 3;
        continue;
      }
    }
    if (c === "~" && src[i + 1] === "~") {
      if (active("s")) {
        close("s");
        i++;
        continue;
      }
      if (src.indexOf("~~", i + 2) > 0 && !SPACE.test(src[i + 2] ?? " ")) {
        open("s", "~");
        i++;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      const length = runLength(src, i);
      const before = src[i - 1] ?? " ";
      const after = src[i + length] ?? " ";
      const canClose = !SPACE.test(before) && (c === "*" || !WORD.test(after));
      const canOpen = !SPACE.test(after) && (c === "*" || !WORD.test(before));
      let left = length;
      while (left > 0) {
        const top = stack[stack.length - 1];
        if (canClose && top?.char === c && top.mark === "b" && left >= 2) {
          close("b");
          left -= 2;
        } else if (canClose && top?.char === c && top.mark === "i") {
          close("i");
          left -= 1;
        } else if (canClose && left >= 2 && active("b", c)) {
          close("b");
          left -= 2;
        } else if (canClose && active("i", c)) {
          close("i");
          left -= 1;
        } else if (canOpen && left >= 2 && closes(src, i + length, c, 2)) {
          open("b", c);
          left -= 2;
        } else if (canOpen && closes(src, i + length, c, 1)) {
          open("i", c);
          left -= 1;
        } else {
          text += c.repeat(left);
          left = 0;
        }
      }
      i += length - 1;
      continue;
    }
    text += c;
  }
  flush();
  return mergeRuns(runs);
}

function withHref(run: Run, href?: string): Run {
  return href ? { ...run, href } : run;
}

function unescape(text: string) {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/** Where a run of exactly `count` backticks starts at or after `from`, or -1. */
function findTicks(src: string, from: number, count: number): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] !== "`") continue;
    const run = /^`+/.exec(src.slice(i))![0].length;
    if (run === count) return i;
    i += run - 1;
  }
  return -1;
}

/** How many times the character at `at` repeats from there. */
function runLength(src: string, at: number): number {
  let length = 1;
  while (src[at + length] === src[at]) length++;
  return length;
}

/** Whether a closing run of `char` (at least `count` long) follows. */
function closes(src: string, from: number, char: string, count: number): boolean {
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      const ticks = /^`+/.exec(src.slice(i))![0].length;
      const end = findTicks(src, i + ticks, ticks);
      if (end >= 0) i = end + ticks - 1;
      continue;
    }
    if (c !== char) continue;
    const run = runLength(src, i);
    const before = src[i - 1] ?? " ";
    const after = src[i + run] ?? " ";
    if (!SPACE.test(before) && (char === "*" || !WORD.test(after)) && run >= count) return true;
    i += run - 1;
  }
  return false;
}

/** `[label](url "title")` starting at `at` (the "["). */
function linkAt(src: string, at: number): { label: string; url: string; end: number } | null {
  let depth = 0;
  let close = -1;
  for (let i = at; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0 || src[close + 1] !== "(") return null;
  const target = /^\(\s*(<[^>]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+("[^"]*"|'[^']*'))?\s*\)/.exec(src.slice(close + 1));
  if (!target) return null;
  const url = target[1].replace(/^<|>$/g, "");
  return { label: src.slice(at + 1, close), url: unescape(url), end: close + 1 + target[0].length };
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (!run.text && !run.image) continue;
    const last = out[out.length - 1];
    if (last && !last.image && !run.image && sameStyle(last, run)) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

function sameStyle(a: Run, b: Run) {
  return a.marks.join() === b.marks.join() && !!a.code === !!b.code && a.href === b.href;
}

// ---- blocks → Markdown ---------------------------------------------------------------------------

export function toMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  // Where each open list level's text starts, so nested items line up under it (three spaces
  // under "1. ", two under "- "), as every Markdown reader expects.
  let columns: number[] = [];
  for (const block of blocks) {
    if (block.kind !== "item") {
      columns = [];
      out.push(...blockToMarkdown(block));
      continue;
    }
    const depth = Math.min(block.depth, columns.length);
    const indent = depth > 0 ? columns[depth - 1] : 0;
    const marker = block.list === "ordered" ? `${block.number}.` : "-";
    columns = columns.slice(0, depth);
    columns[depth] = indent + marker.length + 1;
    let text = inlineToMarkdown(block.runs);
    // "[ ] milk" as a bullet's text must not turn it into a checklist item.
    if (block.list !== "check" && /^\[[ xX]\]( |$)/.test(text)) text = `\\${text}`;
    const box = block.list === "check" ? ` [${block.checked ? "x" : " "}]` : "";
    out.push(`${" ".repeat(indent)}${marker}${box}${text ? " " + text : ""}`);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

function blockToMarkdown(block: Block): string[] {
  switch (block.kind) {
    case "p":
      return [escapeLineStart(inlineToMarkdown(block.runs))];
    case "heading": {
      const text = inlineToMarkdown(block.runs).replace(/(\s)(#+)$/, (_, s, hashes) => `${s}\\${hashes}`);
      return [`${"#".repeat(Math.min(6, Math.max(1, block.level)))}${text ? " " + text : ""}`];
    }
    case "item":
      return toMarkdown([block]).split("\n");
    case "quote": {
      const text = inlineToMarkdown(block.runs);
      return [`${"> ".repeat(Math.max(1, block.depth))}${text}`.trimEnd()];
    }
    case "code": {
      const longest = Math.max(2, ...(block.text.match(/`+/g) ?? []).map((t) => t.length));
      const fence = "`".repeat(longest + 1);
      return [`${fence}${block.lang}`, ...(block.text ? block.text.split("\n") : []), fence];
    }
    case "rule":
      return ["---"];
    case "table": {
      const row = (cells: Run[][]) => `| ${cells.map((c) => inlineToMarkdown(c).replace(/\|/g, "\\|")).join(" | ")} |`;
      const sep = block.align.map((a) => (a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---"));
      return [row(block.head), `| ${sep.join(" | ")} |`, ...block.rows.map(row)];
    }
  }
}

/** A plain line that would read as another kind of block keeps its first mark literal. */
function escapeLineStart(text: string): string {
  if (!text) return text;
  const kind = parse(text)[0]?.kind ?? "p";
  const asTable = TABLE_SEP.test(text) && text.includes("-") && text.includes("|");
  if (kind === "p" && !asTable) return text;
  const ordered = /^(\s*\d{1,9})([.)])/.exec(text);
  if (ordered && kind === "item") return text.replace(ordered[0], `${ordered[1]}\\${ordered[2]}`);
  return text.replace(/^(\s*)(\S)/, "$1\\$2");
}

/**
 * Backslashes before characters that would mean something: always `\\`, `*` and backticks; `_`
 * at a word's edge (not in snake_case); `~` in pairs; `<` before a tag or address; `[` when a
 * "](" follows (it would start a link), and brackets inside a link's text.
 */
function escapeText(text: string, inLink = false): string {
  const linkish = !inLink && /\]\s*\(/.test(text);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const prev = text[i - 1] ?? " ";
    const next = text[i + 1] ?? " ";
    const escape = c === "\\" || c === "*" || c === "`"
      || (c === "_" && !(WORD.test(prev) && WORD.test(next)))
      || (c === "~" && (prev === "~" || next === "~"))
      || (c === "<" && /[A-Za-z/]/.test(next))
      || ((c === "[" || c === "]") && inLink)
      || (c === "[" && linkish);
    out += escape ? `\\${c}` : c;
  }
  return out;
}

const OPEN: Record<Mark, string> = { b: "**", i: "*", u: "<u>", s: "~~" };
const CLOSE: Record<Mark, string> = { b: "**", i: "*", u: "</u>", s: "~~" };

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((t) => t.length));
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || /^ .* $/.test(text) ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/** Splits whitespace at the edges of marked runs off as plain text (`**a** b`, not `**a **b`). */
function trimMarked(input: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of input) {
    if (!run.marks.length || run.code || run.image) {
      out.push(run);
      continue;
    }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(run.text)!;
    if (m[1]) out.push({ ...run, text: m[1], marks: [] });
    if (m[2]) out.push({ ...run, text: m[2] });
    if (m[3]) out.push({ ...run, text: m[3], marks: [] });
  }
  return mergeRuns(out);
}

export function inlineToMarkdown(input: Run[], inLink = false): string {
  const runs = trimMarked(input);
  let out = "";
  const stack: Mark[] = [];
  const closeTo = (keep: Mark[]) => {
    const at = stack.findIndex((m) => !keep.includes(m));
    if (at >= 0) for (const m of stack.splice(at).reverse()) out += CLOSE[m];
  };
  const openAll = (marks: Mark[]) => {
    for (const m of marks) {
      if (!stack.includes(m)) {
        stack.push(m);
        out += OPEN[m];
      }
    }
  };
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.href && !inLink) {
      // A link: the runs that share its address, inside one pair of brackets. Marks they all
      // have stay outside; the rest open and close within.
      let j = i;
      while (j + 1 < runs.length && runs[j + 1].href === run.href) j++;
      const group = runs.slice(i, j + 1);
      const shared = MARKS.filter((m) => group.every((r) => r.marks.includes(m)));
      closeTo(shared);
      openAll(shared);
      const inner = inlineToMarkdown(group.map((r) => ({ ...r, href: undefined, marks: r.marks.filter((m) => !shared.includes(m)) })), true);
      // A link that shows its own address is written as one: <https://…>.
      const own = group.length === 1 && !group[0].code && group[0].text === run.href && /^(https?|mailto|file):[^\s<>]+$/.test(run.href);
      out += own ? `<${run.href}>` : `[${inner}](${escapeUrl(run.href)})`;
      i = j;
      continue;
    }
    closeTo(run.marks);
    openAll(run.marks);
    if (run.image) out += `![${run.text.replace(/[[\]\\]/g, "\\$&")}](${escapeUrl(run.image)})`;
    else if (run.code) out += codeSpan(run.text);
    else out += escapeText(run.text, inLink);
  }
  closeTo([]);
  return out;
}

function escapeUrl(url: string) {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url;
}

// ---- reading blocks ------------------------------------------------------------------------------

function runsOf(block: Block): Run[] {
  if ("runs" in block) return block.runs;
  if (block.kind === "code") return [{ text: block.text, marks: [] }];
  if (block.kind === "table") return [block.head, ...block.rows].flatMap((row) => row.flatMap((cell) => [...cell, { text: " ", marks: [] }]));
  return [];
}

/** The note's text without Markdown, for search, titles and copying. */
export function plainText(blocks: Block[]): string {
  return blocks.map((b) => {
    const text = runsOf(b).map((r) => r.text).join("");
    if (b.kind === "item") return "  ".repeat(b.depth) + (b.list === "check" ? (b.checked ? "☑ " : "☐ ") : b.list === "ordered" ? `${b.number}. ` : "• ") + text;
    return text;
  }).join("\n");
}

/** The first line with text, or "". */
export function titleOf(blocks: Block[]): string {
  for (const block of blocks) {
    const text = runsOf(block).map((r) => r.text).join("").trim();
    if (text) return text.split("\n")[0];
  }
  return "";
}

// ---- blocks → DOM --------------------------------------------------------------------------------

const TAGS: Record<Mark, string> = { b: "b", i: "i", u: "u", s: "s" };
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** Fills `root` with the blocks. A code block, rule or table at the end gets an empty line after it to type in. */
export function render(root: HTMLElement, blocks: Block[]) {
  root.replaceChildren(...renderBlocks(blocks));
  const last = blocks[blocks.length - 1];
  if (!root.firstChild || (last && (last.kind === "code" || last.kind === "rule" || last.kind === "table"))) root.append(emptyLine());
}

/** The blocks as HTML, for pasting into the editor. */
export function toHtml(blocks: Block[]): string {
  const holder = document.createElement("div");
  holder.append(...renderBlocks(blocks));
  return holder.innerHTML;
}

function emptyLine() {
  const div = document.createElement("div");
  div.append(document.createElement("br"));
  return div;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, content: Node[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.append(...content);
  return node;
}

function lineContent(runs: Run[]): Node[] {
  const nodes = inlineNodes(runs);
  return nodes.length ? nodes : [document.createElement("br")];
}

function renderBlocks(blocks: Block[]): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind === "item" || block.kind === "quote") {
      let j = i;
      while (j + 1 < blocks.length && blocks[j + 1].kind === block.kind) j++;
      const group = blocks.slice(i, j + 1);
      out.push(...(block.kind === "item" ? buildLists(group as Extract<Block, { kind: "item" }>[]) : buildQuotes(group as Extract<Block, { kind: "quote" }>[])));
      i = j;
      continue;
    }
    switch (block.kind) {
      case "p":
        out.push(el("div", lineContent(block.runs)));
        break;
      case "heading":
        out.push(el(`h${Math.min(6, Math.max(1, block.level))}` as "h1", lineContent(block.runs)));
        break;
      case "rule":
        out.push(el("hr"));
        break;
      case "code": {
        const pre = el("pre", [el("code", [document.createTextNode(block.text)])]);
        if (block.lang) pre.dataset.lang = block.lang;
        // An empty last line only shows with a break after it.
        if (!block.text || block.text.endsWith("\n")) pre.firstChild!.appendChild(document.createElement("br"));
        out.push(pre);
        break;
      }
      case "table": {
        const row = (cells: Run[][], tag: "th" | "td") => el("tr", cells.map((cell, k) => {
          const td = el(tag, lineContent(cell));
          if (block.align[k]) td.style.textAlign = block.align[k]!;
          return td;
        }));
        out.push(el("table", [el("thead", [row(block.head, "th")]), el("tbody", block.rows.map((r) => row(r, "td")))]));
        break;
      }
    }
  }
  return out;
}

function buildLists(items: Extract<Block, { kind: "item" }>[]): HTMLElement[] {
  const roots: HTMLElement[] = [];
  const levels: { list: HTMLElement; kind: ListKind; li: HTMLLIElement | null }[] = [];
  for (const item of items) {
    const depth = Math.min(item.depth, levels.length);
    while (levels.length > depth + 1) levels.pop();
    if (levels.length === depth + 1 && levels[depth].kind !== item.list) levels.pop();
    if (levels.length === depth) {
      const list = el(item.list === "ordered" ? "ol" : "ul");
      if (item.list === "check") list.className = "checks";
      if (item.list === "ordered" && item.number !== 1) list.setAttribute("start", String(item.number));
      const parent = depth > 0 ? levels[depth - 1].li : null;
      if (parent) parent.append(list);
      else roots.push(list);
      levels.push({ list, kind: item.list, li: null });
    }
    const li = el("li", lineContent(item.runs));
    if (item.list === "check") li.dataset.checked = String(item.checked);
    levels[depth].list.append(li);
    levels[depth].li = li;
  }
  return roots;
}

function buildQuotes(lines: Extract<Block, { kind: "quote" }>[]): HTMLElement[] {
  const roots: HTMLElement[] = [];
  const levels: HTMLElement[] = [];
  for (const line of lines) {
    const depth = Math.max(1, line.depth);
    while (levels.length > depth) levels.pop();
    while (levels.length < depth) {
      const quote = el("blockquote");
      if (levels.length) levels[levels.length - 1].append(quote);
      else roots.push(quote);
      levels.push(quote);
    }
    levels[depth - 1].append(el("div", lineContent(line.runs)));
  }
  return roots;
}

function inlineNodes(runs: Run[]): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.href) {
      let j = i;
      while (j + 1 < runs.length && runs[j + 1].href === run.href) j++;
      const a = el("a", inlineNodes(runs.slice(i, j + 1).map((r) => ({ ...r, href: undefined }))));
      a.href = run.href;
      out.push(a);
      i = j;
      continue;
    }
    let node: Node;
    if (run.image) {
      const chip = el("span", [document.createTextNode(run.text || "Image")]);
      chip.className = "note-image";
      chip.contentEditable = "false";
      chip.dataset.src = run.image;
      chip.title = run.image;
      node = chip;
    } else if (run.code) {
      node = el("code", [document.createTextNode(run.text)]);
    } else {
      const fragment = document.createDocumentFragment();
      appendLinked(fragment, run.text);
      node = fragment;
    }
    for (const mark of [...run.marks].reverse()) node = el(TAGS[mark] as "b", [node]);
    out.push(node);
  }
  return out;
}

/** Text with its bare web addresses as links (Ctrl+click opens them). */
function appendLinked(parent: DocumentFragment, text: string) {
  let at = 0;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    if (m.index! > at) parent.append(text.slice(at, m.index));
    const a = el("a", [document.createTextNode(m[0])]);
    a.href = m[0];
    a.dataset.auto = "";
    parent.append(a);
    at = m.index! + m[0].length;
  }
  if (at < text.length) parent.append(text.slice(at));
}

// ---- DOM → blocks --------------------------------------------------------------------------------

const BLOCK_TAGS = new Set(["DIV", "P", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "FIGURE", "FIGCAPTION",
  "DL", "DT", "DD", "DETAILS", "SUMMARY", "ADDRESS", "CENTER", "FORM", "FIELDSET", "BODY", "HTML"]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "META", "LINK", "TITLE", "HEAD", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "VIDEO",
  "AUDIO", "IFRAME", "OBJECT", "BUTTON", "SELECT", "TEXTAREA", "INPUT"]);
const SAFE_URL = /^(https?:|mailto:|file:|tel:|#)/i;

interface ReadOptions {
  /** HTML from the clipboard: whitespace collapses as a browser shows it. */
  pasted?: boolean;
}

interface Ctx {
  list: ListKind | null;
  depth: number;
  checked: boolean;
  number: number;
  quote: number;
  heading: number;
}

interface Style {
  marks: Set<Mark>;
  code: boolean;
  href?: string;
}

/**
 * Reads the editor (or pasted HTML) back into blocks. Copes with what contenteditable makes
 * (nested divs, `<br>`s, spans with inline styles, lists nested inside lists) and with what
 * documents and web pages put on the clipboard (Google Docs' styled spans, `aria-level` list
 * nesting, task-list checkboxes, tables, code blocks).
 */
export function read(root: Node, options: ReadOptions = {}): Block[] {
  const blocks: Block[] = [];
  let cur: LineBlock | null = null;
  const base: Ctx = { list: null, depth: 0, checked: false, number: 1, quote: 0, heading: 0 };

  const start = (ctx: Ctx): LineBlock => {
    const block: LineBlock = ctx.heading
      ? { kind: "heading", level: ctx.heading, runs: [] }
      : ctx.list
        ? { kind: "item", list: ctx.list, depth: ctx.depth, checked: ctx.checked, number: ctx.number, runs: [] }
        : ctx.quote
          ? { kind: "quote", depth: ctx.quote, runs: [] }
          : { kind: "p", runs: [] };
    blocks.push(block);
    cur = block;
    return block;
  };
  const end = () => {
    if (cur && options.pasted) {
      const last = cur.runs[cur.runs.length - 1];
      if (last && !last.code) last.text = last.text.replace(/\s+$/, "");
    }
    cur = null;
  };
  const push = (run: Run, ctx: Ctx) => (cur ?? start(ctx)).runs.push(run);

  const text = (value: string, style: Style, ctx: Ctx) => {
    value = value.replace(/\u200b|\ufeff/g, "");
    const marks = MARKS.filter((m) => style.marks.has(m));
    if (options.pasted) {
      // As a browser shows it: runs of spaces and line breaks are one space (non-breaking ones stay).
      value = value.replace(/[ \t\n\r\f]+/g, " ");
      if (!cur) value = value.replace(/^ +/, "");
      if (!value) return;
      push({ text: value.replace(/\u00a0/g, " "), marks, code: style.code || undefined, href: style.href }, ctx);
      return;
    }
    const parts = value.replace(/\u00a0/g, " ").split("\n");
    parts.forEach((part, i) => {
      if (i > 0) end();
      if (!part && i === 0 && parts.length === 1) return;
      const line = cur ?? start(ctx);
      if (part) line.runs.push({ text: part, marks, code: style.code || undefined, href: style.href });
    });
  };

  const walk = (node: Node, style: Style, ctx: Ctx) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        text((child as Text).data, style, ctx);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const elem = child as HTMLElement;
      const tag = elem.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag) || elem.getAttribute("aria-hidden") === "true" && tag !== "SPAN") continue;
      if (tag === "BR") {
        if (!cur) start(ctx);
        end();
      } else if (/^H[1-6]$/.test(tag)) {
        end();
        walk(elem, style, { ...ctx, heading: Number(tag[1]), list: null });
        end();
      } else if (tag === "UL" || tag === "OL") {
        end();
        readList(elem, style, ctx);
        end();
      } else if (tag === "LI") {
        end();
        readItem(elem, style, { ...ctx, list: ctx.list ?? "bullet" }, 1);
        end();
      } else if (tag === "BLOCKQUOTE") {
        end();
        walk(elem, style, { ...ctx, quote: ctx.quote + 1, list: null, heading: 0 });
        end();
      } else if (tag === "PRE") {
        end();
        blocks.push({ kind: "code", lang: languageOf(elem), text: preText(elem).replace(/\n$/, "") });
      } else if (tag === "HR") {
        end();
        blocks.push({ kind: "rule" });
      } else if (tag === "TABLE") {
        end();
        const table = readTable(elem as HTMLTableElement, options);
        if (table) blocks.push(table);
      } else if (tag === "IMG") {
        const src = elem.getAttribute("src") ?? "";
        // Pasted pictures inlined as data would swell the note; only links to pictures stay.
        if (/^(https?|file):/i.test(src)) push({ text: elem.getAttribute("alt") ?? "", marks: MARKS.filter((m) => style.marks.has(m)), image: src }, ctx);
      } else if (elem.classList.contains("note-image") && elem.dataset.src) {
        push({ text: elem.textContent ?? "", marks: MARKS.filter((m) => style.marks.has(m)), image: elem.dataset.src }, ctx);
      } else if (BLOCK_TAGS.has(tag)) {
        end();
        walk(elem, withStyle(elem, style), ctx);
        end();
      } else if (tag === "A") {
        const href = elem.getAttribute("href") ?? "";
        const auto = elem.hasAttribute("data-auto");
        walk(elem, { ...withStyle(elem, style), href: SAFE_URL.test(href) && !auto ? href : style.href }, ctx);
      } else {
        walk(elem, withStyle(elem, style), ctx);
      }
    }
  };

  /** A list's items; lists nested in it (directly, as contenteditable makes them, or in an item) go one deeper. */
  const readList = (list: HTMLElement, style: Style, ctx: Ctx) => {
    const ordered = list.tagName.toUpperCase() === "OL";
    const depth = ctx.list ? ctx.depth + 1 : 0;
    const kind: ListKind = list.classList.contains("checks") || list.classList.contains("contains-task-list") ? "check" : ordered ? "ordered" : "bullet";
    // Numbers count per level: documents (Google Docs) keep nested items in the same list, with
    // an `aria-level` each.
    const counters = [ordered ? Number(list.getAttribute("start")) || 1 : 1];
    const listCtx: Ctx = { ...ctx, list: kind, depth, heading: 0 };
    for (const child of Array.from(list.childNodes)) {
      if (child.nodeType === 1 && (child as HTMLElement).tagName.toUpperCase() === "LI") {
        const level = Math.max(1, Number((child as HTMLElement).getAttribute("aria-level")) || 1);
        counters.length = level;
        counters[level - 1] ??= 1;
        end();
        readItem(child as HTMLElement, style, listCtx, counters[level - 1]++);
        end();
      } else if (child.nodeType === 1) {
        end();
        walk({ childNodes: [child] } as unknown as Node, style, { ...listCtx, depth: depth });
        end();
      } else if (child.nodeType === 3 && (child as Text).data.trim()) {
        walk({ childNodes: [child] } as unknown as Node, style, listCtx);
      }
    }
  };

  const readItem = (li: HTMLElement, style: Style, ctx: Ctx, number: number) => {
    // A task list's checkbox (GitHub, many Markdown viewers), but not one in a nested item.
    const box = Array.from(li.querySelectorAll("input")).find((input) => input.type === "checkbox" && input.closest("li") === li);
    const level = Number(li.getAttribute("aria-level"));
    const kind: ListKind = box || li.hasAttribute("data-checked") ? "check" : ctx.list ?? "bullet";
    const itemCtx: Ctx = {
      ...ctx,
      list: kind,
      depth: level >= 1 ? level - 1 : ctx.depth,
      checked: box ? box.checked || box.hasAttribute("checked") : li.getAttribute("data-checked") === "true",
      number,
    };
    const before = blocks.length;
    walk(li, style, itemCtx);
    if (blocks.length === before) start(itemCtx);
  };

  walk(root, { marks: new Set(), code: false }, base);
  end();
  return blocks.map((b) => ("runs" in b ? { ...b, runs: options.pasted ? tidyPasted(b.runs) : mergeRuns(b.runs) } : b));
}

/**
 * Pasted text as it reads: documents underline every link (a link shows as one anyway), and
 * what was left out (a picture inlined as data) leaves no double space.
 */
function tidyPasted(runs: Run[]): Run[] {
  const merged = mergeRuns(runs.map((r) => (r.href ? { ...r, marks: r.marks.filter((m) => m !== "u") } : r)));
  for (const run of merged) if (!run.code && !run.image) run.text = run.text.replace(/ {2,}/g, " ");
  return merged.filter((r) => r.text || r.image);
}

function withStyle(elem: HTMLElement, style: Style): Style {
  const marks = new Set(style.marks);
  const tag = elem.tagName.toUpperCase();
  if (tag === "B" || tag === "STRONG") marks.add("b");
  if (tag === "I" || tag === "EM" || tag === "CITE" || tag === "VAR") marks.add("i");
  if (tag === "U" || tag === "INS") marks.add("u");
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") marks.add("s");
  const css = elem.style;
  if (css) {
    if (css.fontWeight === "bold" || css.fontWeight === "bolder" || Number(css.fontWeight) >= 600) marks.add("b");
    else if (css.fontWeight === "normal" || (Number(css.fontWeight) > 0 && Number(css.fontWeight) < 600)) marks.delete("b");
    if (css.fontStyle === "italic") marks.add("i");
    else if (css.fontStyle === "normal") marks.delete("i");
    const decoration = `${css.textDecoration} ${css.textDecorationLine}`;
    if (decoration.includes("underline")) marks.add("u");
    if (decoration.includes("line-through")) marks.add("s");
  }
  const code = style.code || tag === "CODE" || tag === "KBD" || tag === "SAMP" || tag === "TT" || /mono|courier|consolas|menlo/i.test(css?.fontFamily ?? "");
  return { ...style, marks, code };
}

function languageOf(pre: HTMLElement): string {
  if (pre.dataset.lang) return pre.dataset.lang;
  const classes = `${pre.className} ${pre.querySelector("code")?.className ?? ""}`;
  return /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(classes)?.[1] ?? "";
}

/** A code block's text: line breaks from text, `<br>`s and line elements alike. */
function preText(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) out += (child as Text).data.replace(/\u00a0/g, " ");
    else if (child.nodeType === 1) {
      const tag = (child as HTMLElement).tagName.toUpperCase();
      if (tag === "BR") out += "\n";
      else if (BLOCK_TAGS.has(tag) && out && !out.endsWith("\n")) out += "\n" + preText(child);
      else out += preText(child);
    }
  }
  return out;
}

function readTable(table: HTMLTableElement, options: ReadOptions): Block | null {
  const rows = Array.from(table.querySelectorAll("tr")).filter((tr) => tr.closest("table") === table);
  if (!rows.length) return null;
  const cellsOf = (tr: HTMLTableRowElement) => Array.from(tr.children).filter((c) => /^T[HD]$/i.test(c.tagName)) as HTMLElement[];
  const readCell = (cell: HTMLElement): Run[] => {
    const lines = read(cell, options);
    const runs: Run[] = [];
    lines.forEach((line, i) => {
      if (i > 0) runs.push({ text: " ", marks: [] });
      runs.push(...runsOf(line).map((r) => ({ ...r, text: r.text.replace(/\n/g, " ") })));
    });
    return mergeRuns(runs);
  };
  const head = cellsOf(rows[0]);
  const width = Math.max(...rows.map((r) => cellsOf(r).length));
  const pad = (cells: Run[][]) => Array.from({ length: width }, (_, k) => cells[k] ?? []);
  const align = Array.from({ length: width }, (_, k) => {
    const cell = head[k];
    const value = (cell?.style.textAlign || cell?.getAttribute("align") || "").toLowerCase();
    return value === "center" || value === "right" || value === "left" ? value : null;
  });
  // A header row shows bold anyway.
  const headCell = (cell: HTMLElement) => readCell(cell).map((r) => ({ ...r, marks: r.marks.filter((m) => m !== "b") }));
  return { kind: "table", align, head: pad(head.map(headCell)), rows: rows.slice(1).map((r) => pad(cellsOf(r).map(readCell))) };
}
