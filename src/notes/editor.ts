import { h } from "../ui/dom";
import { icon, type IconName } from "../ui/icons";
import { parse, read, render, toHtml, toMarkdown, type Block, type Run } from "./markdown";

export interface EditorHost {
  /** The text changed (shortly after typing stops, or on `flush`). */
  change(body: string): void;
  /** Ctrl+click on a web address, or a click on an image. */
  openLink(url: string): void;
  /** ↑ or Backspace at the very start of the text: back to what's above it (the title). */
  leaveTop?(): void;
}

const SAVE_AFTER_MS = 350;

/** Private-use characters that mark where a paste goes and where the caret ends up. */
const PASTE_AT = "\uE000";
const CARET_AT = "\uE001";

/** The checkbox of a checklist item takes this much of its left edge. */
const CHECK_ZONE = 24;

type ListKind = "bullet" | "ordered" | "check";

/**
 * A note's rich text: a contenteditable kept to what a note's Markdown can say (see
 * `markdown.ts`), with a formatting bar.
 *
 * Markdown typed at the start of a line formats it ("# " a heading, "- " or "1. " a list, "[] "
 * a checklist, "> " a quote; "```" or "---" and Enter a code block or a rule). Pasted Markdown is
 * formatted, and so is rich text from documents and web pages; copying gives Markdown.
 */
export class NoteEditor {
  readonly area = h("div", { class: "note-text note-editor", contenteditable: "true", spellcheck: "true", role: "textbox", "aria-multiline": "true", "aria-label": "Note" });
  readonly tools = h("div", { class: "note-tools", role: "toolbar", "aria-label": "Formatting" });
  private body = "";
  private timer = 0;
  private toolButtons: [string, HTMLButtonElement][] = [];

  constructor(private readonly host: EditorHost) {
    const tool = (title: string, run: () => void, content: Node | string, state?: string) => {
      const button = h("button", { type: "button", class: "note-tool", title, "aria-label": title, onmousedown: (e: MouseEvent) => e.preventDefault(), onclick: () => (run(), this.changed(), this.syncTools()) }, content);
      if (state) this.toolButtons.push([state, button]);
      return button;
    };
    const glyph = (text: string, cls: string) => h("span", { class: `note-glyph ${cls}` }, text);
    const svg = (name: IconName) => icon(name, 17);
    const sep = () => h("span", { class: "note-tools-sep" });
    this.tools.append(
      tool("Bold (Ctrl+B)", () => exec("bold"), glyph("B", "bold"), "bold"),
      tool("Italic (Ctrl+I)", () => exec("italic"), glyph("I", "italic"), "italic"),
      tool("Underline (Ctrl+U)", () => exec("underline"), glyph("U", "underline"), "underline"),
      tool("Strikethrough (Ctrl+T)", () => exec("strikeThrough"), glyph("ab", "strike"), "strikeThrough"),
      sep(),
      tool("Bulleted list (Ctrl+Shift+L)", () => this.toggleList("bullet"), svg("bullets")),
      tool("Numbered list (Ctrl+Shift+O)", () => this.toggleList("ordered"), glyph("1.", "numbered")),
      tool("Checklist (Ctrl+Shift+K)", () => this.toggleList("check"), svg("checklist")),
      sep(),
      tool("Heading (Ctrl+Shift+H)", () => this.cycleHeading(), glyph("H", "heading")),
      tool("Quote (Ctrl+Shift+Q)", () => this.toggleBlock("blockquote"), glyph("❝", "quote")),
      tool("Code block (Ctrl+Shift+C)", () => this.toggleBlock("pre"), glyph("{ }", "code")),
    );

    this.area.addEventListener("input", (e) => this.onInput(e as InputEvent));
    this.area.addEventListener("keydown", (e) => this.onKey(e));
    this.area.addEventListener("paste", (e) => this.onPaste(e));
    this.area.addEventListener("copy", (e) => this.onCopy(e, false));
    this.area.addEventListener("cut", (e) => this.onCopy(e, true));
    this.area.addEventListener("drop", (e) => {
      // Dropped text and rich text come in like pasted text.
      const data = e.dataTransfer;
      if (!data?.getData("text/plain") && !data?.getData("text/html")) return;
      e.preventDefault();
      const at = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (at) getSelection()?.removeAllRanges(), getSelection()?.addRange(at);
      this.insert(data);
    });
    this.area.addEventListener("pointerdown", (e) => this.onPointer(e));
    this.area.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const image = target.closest?.(".note-image") as HTMLElement | null;
      if (image?.dataset.src) return host.openLink(image.dataset.src);
      const link = target.closest?.("a");
      if (link && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        host.openLink(link.href);
      }
    });
    document.addEventListener("selectionchange", () => this.syncTools());
    render(this.area, []);
    this.syncEmpty();
  }

  /** Shows `body`, unless it is what the editor already holds. Keeps the caret where it was. */
  setBody(body: string) {
    if (body === this.body) return;
    clearTimeout(this.timer);
    this.timer = 0;
    this.body = body;
    const caret = document.activeElement === this.area ? caretOffset(this.area) : null;
    render(this.area, parse(body));
    if (caret !== null) placeCaret(this.area, caret);
    this.syncEmpty();
  }

  /** Hands over a pending change now (before the window closes). */
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = 0;
    const body = toMarkdown(read(this.area));
    if (body === this.body) return;
    this.body = body;
    this.host.change(body);
  }

  focus(atEnd = true) {
    this.area.focus();
    if (atEnd) placeCaret(this.area, Infinity);
  }

  private changed() {
    this.syncEmpty();
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), SAVE_AFTER_MS);
  }

  private syncEmpty() {
    const empty = !this.area.textContent?.trim() && !this.area.querySelector("li, hr, table, pre, .note-image, h1, h2, h3, h4, h5, h6, blockquote");
    this.area.classList.toggle("is-empty", empty);
  }

  private syncTools() {
    if (!this.area.contains(getSelection()?.anchorNode ?? null)) return;
    for (const [command, button] of this.toolButtons) button.classList.toggle("active", document.queryCommandState(command));
  }

  // ---- typing

  private onInput(e: InputEvent) {
    if (e.inputType === "insertText" && e.data === " ") this.lineShortcut();
    if (e.inputType === "insertParagraph") {
      // A new checklist item starts unticked, whatever the one it came from was.
      const li = blockAtCaret(this.area);
      if (li instanceof HTMLLIElement && li.parentElement?.classList.contains("checks") && !li.textContent) li.dataset.checked = "false";
    }
    this.changed();
  }

  /** Markdown typed at the start of a line, then a space: "# ", "- ", "1. ", "[] ", "> ". */
  private lineShortcut() {
    const block = blockAtCaret(this.area);
    if (!block || block instanceof HTMLLIElement || block.closest("pre")) return;
    const text = (block === this.area ? "" : block.textContent ?? "").replace(/ /g, " ");
    const heading = /^(#{1,6}) $/.exec(text);
    const ordered = /^(\d{1,9})[.)] $/.exec(text);
    const kind = text === "- " || text === "* " || text === "+ " ? "bullet"
      : text === "[] " || text === "[ ] " || text === "- [ ] " ? "check"
        : text === "[x] " || text === "- [x] " ? "checked"
          : ordered ? "ordered" : heading ? "heading" : text === "> " ? "quote" : null;
    if (!kind) return;
    block.replaceChildren(document.createElement("br"));
    placeCaretIn(block);
    if (kind === "heading") exec("formatBlock", `<h${heading![1].length}>`);
    else if (kind === "quote") exec("formatBlock", "<blockquote>");
    else {
      this.toggleList(kind === "checked" ? "check" : kind);
      const li = blockAtCaret(this.area);
      if (kind === "checked" && li instanceof HTMLLIElement) li.dataset.checked = "true";
      if (kind === "ordered" && ordered![1] !== "1") li?.closest("ol")?.setAttribute("start", ordered![1]);
    }
  }

  /** "```" (with a language) or "---" alone on a line, then Enter: a code block or a rule. */
  private blockShortcut(): boolean {
    const block = blockAtCaret(this.area);
    if (!block || block === this.area || block instanceof HTMLLIElement || block.closest("pre, blockquote")) return false;
    const text = (block.textContent ?? "").replace(/ /g, " ").trim();
    const fence = /^```([\w+#.-]*)$/.exec(text);
    if (!fence && !/^(-{3,}|\*{3,}|_{3,})$/.test(text)) return false;
    const after = document.createElement("div");
    after.append(document.createElement("br"));
    if (fence) {
      const pre = document.createElement("pre");
      if (fence[1]) pre.dataset.lang = fence[1];
      const code = document.createElement("code");
      code.append(document.createElement("br"));
      pre.append(code);
      block.replaceWith(pre, after);
      placeCaretIn(code);
    } else {
      block.replaceWith(document.createElement("hr"), after);
      placeCaretIn(after);
    }
    return true;
  }

  /**
   * The caret is at the very start, with nothing selected. For Backspace, also on a plain line
   * (Backspace at the start of a list item or heading turns it back into a plain line first).
   */
  private atStart(plainLineOnly: boolean): boolean {
    const selection = getSelection();
    if (!selection?.isCollapsed || caretOffset(this.area) !== 0) return false;
    // An empty first line followed by more lines isn't the start of the text being left.
    const first = this.area.firstElementChild;
    if (plainLineOnly && first && first.tagName !== "DIV") return false;
    const block = blockAtCaret(this.area);
    return !block || block === this.area || block === first || first?.contains(block) === true;
  }

  /** Enter on an empty line of a quote ends the quote (one level of it), as in a list. */
  private leaveQuote(): boolean {
    const anchor = getSelection()?.anchorNode;
    const el = anchor?.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor?.parentElement;
    if (!el || !this.area.contains(el) || !el.closest("blockquote")) return false;
    // Where the caret is, as the note's blocks see it (however contenteditable built the quote).
    exec("insertText", PASTE_AT);
    const blocks = read(this.area);
    const at = blocks.findIndex((b) => "runs" in b && b.runs.some((r) => r.text.includes(PASTE_AT)));
    const line = blocks[at];
    if (line?.kind !== "quote" || line.runs.some((r) => r.text.replace(PASTE_AT, ""))) {
      exec("delete");
      return false;
    }
    const caret: Run = { text: CARET_AT, marks: [] };
    blocks.splice(at, 1, line.depth > 1 ? { kind: "quote", depth: line.depth - 1, runs: [caret] } : { kind: "p", runs: [caret] });
    this.renderWithCaret(blocks);
    return true;
  }

  private onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if ((e.key === "ArrowUp" || e.key === "Backspace") && !mod && !e.shiftKey && !e.altKey && this.host.leaveTop && this.atStart(e.key === "Backspace")) {
      this.host.leaveTop();
      return e.preventDefault();
    }
    if (e.key === "Enter" && !mod && !e.altKey) {
      if (!e.shiftKey && (this.blockShortcut() || this.leaveQuote())) return this.handled(e);
      // In a code block, Enter is a new line of code.
      if (blockAtCaret(this.area)?.closest("pre")) {
        exec("insertLineBreak");
        return this.handled(e);
      }
      return;
    }
    if (e.key === "Tab" && !mod && !e.altKey) {
      const block = blockAtCaret(this.area);
      if (block?.closest("pre")) {
        exec("insertText", "  ");
        return this.handled(e);
      }
      if (block instanceof HTMLLIElement) {
        exec(e.shiftKey ? "outdent" : "indent");
        return this.handled(e);
      }
      return;
    }
    if (!mod || e.altKey) return;
    const key = e.key.toLowerCase();
    if (!e.shiftKey && key === "t") exec("strikeThrough");
    else if (e.shiftKey && key === "l") this.toggleList("bullet");
    else if (e.shiftKey && key === "o") this.toggleList("ordered");
    else if (e.shiftKey && key === "k") this.toggleList("check");
    else if (e.shiftKey && key === "h") this.cycleHeading();
    else if (e.shiftKey && key === "q") this.toggleBlock("blockquote");
    else if (e.shiftKey && key === "c") this.toggleBlock("pre");
    else return;
    this.handled(e);
  }

  private handled(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    this.changed();
    this.syncTools();
  }

  /** Ticks a checklist item when its box is clicked. */
  private onPointer(e: PointerEvent) {
    const li = (e.target as HTMLElement).closest?.("li");
    if (!(li instanceof HTMLLIElement) || !li.parentElement?.classList.contains("checks")) return;
    if (e.clientX - li.getBoundingClientRect().left > CHECK_ZONE) return;
    e.preventDefault();
    li.dataset.checked = String(li.dataset.checked !== "true");
    this.changed();
  }

  // ---- block formats

  /** Bullets, numbers or a checklist for the lines at the caret; again, back to plain lines. */
  private toggleList(kind: ListKind) {
    this.area.focus();
    const list = blockAtCaret(this.area)?.closest("ul, ol") as HTMLElement | null;
    const current: ListKind | null = !list || !this.area.contains(list) ? null
      : list.tagName === "OL" ? "ordered" : list.classList.contains("checks") ? "check" : "bullet";
    if (current === kind) {
      exec(kind === "ordered" ? "insertOrderedList" : "insertUnorderedList");
      return;
    }
    if (current && (current === "ordered") === (kind === "ordered")) {
      // A bulleted list becomes a checklist, or the other way round.
      list!.classList.toggle("checks", kind === "check");
      for (const li of Array.from(list!.children) as HTMLElement[]) {
        if (kind === "check") li.dataset.checked ??= "false";
        else delete li.dataset.checked;
      }
      return;
    }
    exec(kind === "ordered" ? "insertOrderedList" : "insertUnorderedList");
    const made = blockAtCaret(this.area)?.closest("ul, ol") as HTMLElement | null;
    if (made && kind !== "ordered") {
      made.classList.toggle("checks", kind === "check");
      for (const li of Array.from(made.children) as HTMLElement[]) {
        if (kind === "check") li.dataset.checked ??= "false";
        else delete li.dataset.checked;
      }
    }
  }

  /** Plain line → heading 1 → 2 → 3 → plain line. */
  private cycleHeading() {
    this.area.focus();
    const heading = blockAtCaret(this.area)?.closest("h1, h2, h3, h4, h5, h6");
    const level = heading ? Number(heading.tagName[1]) : 0;
    exec("formatBlock", level >= 3 ? "<div>" : `<h${level + 1}>`);
  }

  /** A quote or a code block for the lines at the caret; again, back to plain lines. */
  private toggleBlock(tag: "blockquote" | "pre") {
    this.area.focus();
    const inside = blockAtCaret(this.area)?.closest(tag);
    if (inside && this.area.contains(inside)) {
      if (tag === "pre") {
        // Each line of code becomes a plain line.
        const lines = (inside.textContent ?? "").replace(/\n$/, "").split("\n");
        const divs = lines.map((line) => {
          const div = document.createElement("div");
          div.append(line ? document.createTextNode(line) : document.createElement("br"));
          return div;
        });
        inside.replaceWith(...divs);
        placeCaretIn(divs[0]);
      } else exec("outdent");
      return;
    }
    exec("formatBlock", `<${tag}>`);
  }

  // ---- clipboard

  private onPaste(e: ClipboardEvent) {
    if (!e.clipboardData) return;
    e.preventDefault();
    this.insert(e.clipboardData);
  }

  /** Inserts clipboard data at the caret: rich text keeps its formatting, Markdown is formatted. */
  private insert(data: DataTransfer) {
    const inCode = blockAtCaret(this.area)?.closest("pre");
    const plain = data.getData("text/plain").replace(/\r\n?/g, "\n");
    if (inCode) {
      exec("insertText", plain);
      return this.changed();
    }
    const html = data.getData("text/html");
    const blocks = html && isRichText(html, plain) ? fromHtml(html) : parse(plain);
    if (!blocks.length) return;
    const single = blocks.length === 1 && blocks[0].kind === "p" ? blocks[0] : null;
    if (single && single.runs.every((r) => !r.marks.length && !r.code && !r.href && !r.image)) {
      exec("insertText", single.runs.map((r) => r.text).join(""));
    } else if (single) {
      // Formatted text within the line at the caret.
      exec("insertHTML", toHtml(blocks).replace(/^<div>|<\/div>$/g, ""));
    } else {
      this.insertBlocks(blocks);
    }
    this.changed();
  }

  /**
   * Lines pasted at the caret (replacing the selection): the line there splits around them, its
   * first part taking the first pasted line's text and its rest the last's. Done on the note's
   * blocks rather than with contenteditable's insertHTML, which lets the line at the caret (a
   * heading, say) restyle everything pasted into it. The caret goes where the pasted text ends.
   */
  private insertBlocks(pasted: Block[]) {
    exec("insertText", PASTE_AT);
    const blocks = read(this.area);
    const at = blocks.findIndex((b) => "runs" in b && b.runs.some((r) => r.text.includes(PASTE_AT)));
    const target = blocks[at];
    if (!target || !("runs" in target)) return;
    const [before, after] = splitRuns(target.runs);
    const body = pasted.map((b) => ("runs" in b ? { ...b, runs: [...b.runs] } : b));
    const out: Block[] = [];
    const first = body[0];
    if (first.kind === "p") {
      out.push({ ...target, runs: [...before, ...first.runs] });
      body.shift();
    } else if (before.length || target.kind !== "p") out.push({ ...target, runs: before });
    out.push(...body);
    const last = out[out.length - 1];
    if (body.length && last.kind === "p") {
      last.runs.push({ text: CARET_AT, marks: [] }, ...after);
    } else if (!body.length && "runs" in last) {
      last.runs.push({ text: CARET_AT, marks: [] }, ...after);
    } else {
      out.push({ ...target, runs: [{ text: CARET_AT, marks: [] }, ...after] } as Block);
    }
    blocks.splice(at, 1, ...out);
    this.renderWithCaret(blocks);
  }

  /** Shows the blocks, with the caret where a `CARET_AT` in them was. */
  private renderWithCaret(blocks: Block[]) {
    render(this.area, blocks);
    const walker = document.createTreeWalker(this.area, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const index = node.data.indexOf(CARET_AT);
      if (index < 0) continue;
      node.data = node.data.replace(CARET_AT, "");
      const parent = node.parentElement;
      if (!node.data && parent && !parent.textContent) parent.append(document.createElement("br"));
      collapseAt(node, index);
      break;
    }
  }

  /**
   * Copying gives Markdown as text, and the formatting for apps that take rich text. Part of one
   * line copies as that text (with its bold, links…), part of a code block as plain code.
   */
  private onCopy(e: ClipboardEvent, cut: boolean) {
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !e.clipboardData) return;
    const range = selection.getRangeAt(0);
    if (!this.area.contains(range.commonAncestorContainer)) return;
    const holder = document.createElement("div");
    holder.append(range.cloneContents());
    const inCode = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement)?.closest("pre");
    e.preventDefault();
    e.clipboardData.setData("text/plain", inCode ? range.toString() : toMarkdown(read(holder)));
    e.clipboardData.setData("text/html", holder.innerHTML);
    if (cut) {
      exec("delete");
      this.changed();
    }
  }
}

/** A line's runs split at the paste marker, which goes. */
function splitRuns(runs: Run[]): [Run[], Run[]] {
  const before: Run[] = [];
  const after: Run[] = [];
  let found = false;
  for (const run of runs) {
    const index = found ? -1 : run.text.indexOf(PASTE_AT);
    if (index < 0) {
      (found ? after : before).push(run);
      continue;
    }
    found = true;
    const head = run.text.slice(0, index);
    const tail = run.text.slice(index + PASTE_AT.length);
    if (head) before.push({ ...run, text: head });
    if (tail) after.push({ ...run, text: tail });
  }
  return [before, after];
}

/**
 * Whether pasted HTML carries formatting worth keeping. Code editors (VS Code and the like) put
 * coloured monospace text on the clipboard; its plain text, often Markdown, says more.
 */
function isRichText(html: string, plain: string): boolean {
  if (!plain.trim()) return true;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const outer = doc.body.firstElementChild?.getAttribute("style") ?? "";
  if (/white-space:\s*pre/i.test(outer) && /font-family:[^;]*(mono|consolas|menlo|courier)/i.test(outer)) return false;
  const semantic = doc.body.querySelector("h1, h2, h3, h4, h5, h6, ul, ol, li, table, blockquote, b, strong, i, em, u, s, del, a[href], pre, hr, img, p");
  const styled = Array.from(doc.body.querySelectorAll<HTMLElement>("[style]")).some((el) => /font-weight:\s*(bold|[6-9]00)|font-style:\s*italic|text-decoration[^;]*(underline|line-through)/i.test(el.getAttribute("style") ?? ""));
  return !!semantic || styled;
}

/** Pasted HTML as blocks, read without ever being put into the page. */
function fromHtml(html: string): Block[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return read(doc.body, { pasted: true });
}

function exec(command: string, value?: string) {
  document.execCommand(command, false, value);
}

/** The line (div, list item, heading, code block) the caret is in, or `root` for text directly inside it. */
function blockAtCaret(root: HTMLElement): HTMLElement | null {
  let node = getSelection()?.anchorNode ?? null;
  if (!node || !root.contains(node)) return null;
  if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
  const el = node as HTMLElement;
  return (el.closest("li, pre, h1, h2, h3, h4, h5, h6, td, th, div:not(.note-editor)") as HTMLElement | null) ?? root;
}

/** How many characters come before the caret. */
function caretOffset(root: HTMLElement): number | null {
  const selection = getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

/** Puts the caret `offset` characters in (at the end when there aren't that many). */
function placeCaret(root: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let left = offset;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    last = node;
    if (left <= node.length) return collapseAt(node, left);
    left -= node.length;
  }
  if (last) collapseAt(last, last.length);
  else placeCaretIn(root.lastElementChild ?? root);
}

function placeCaretIn(el: Element) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
}

function collapseAt(node: Text, offset: number) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
}
