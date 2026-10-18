import { h } from "../../ui/dom";
import { tokenize, toLines } from "./highlight";

/** Above this many characters the text is shown without highlighting, to stay responsive. */
const HIGHLIGHT_LIMIT = 300_000;

/**
 * Monospace text with a line-number gutter and syntax colours. Everything is built from text
 * nodes, so the file's content is never parsed as HTML.
 */
export function renderCode(text: string, language: string): HTMLElement {
  const lines = toLines(tokenize(text, text.length > HIGHLIGHT_LIMIT ? "" : language));
  // A trailing newline does not start another visible line.
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  const code = h("code", { class: "ql-lines" });
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const row = h("span", { class: "ql-line" });
    for (const token of line) row.append(token.cls ? h("span", { class: `hl-${token.cls}` }, token.text) : token.text);
    // Empty lines still need a line break to keep their height.
    row.append("\n");
    frag.append(row);
  }
  code.append(frag);
  const gutter = h("div", { class: "ql-gutter", "aria-hidden": "true" }, lines.map((_, i) => String(i + 1)).join("\n"));
  return h("div", { class: "ql-code" }, gutter, h("pre", { class: "ql-pre" }, code));
}
