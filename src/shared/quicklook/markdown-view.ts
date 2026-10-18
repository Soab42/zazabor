import { h } from "../../ui/dom";
import { renderCode } from "./code-view";
import { languageForTag } from "./highlight";
import { parseMarkdown, type Block, type Inline } from "./markdown";

function inline(nodes: Inline[]): Node[] {
  return nodes.map((node): Node => {
    switch (node.t) {
      case "text": return document.createTextNode(node.v);
      case "code": return h("code", { class: "md-code" }, node.v);
      case "strong": return h("strong", null, ...inline(node.c));
      case "em": return h("em", null, ...inline(node.c));
      case "del": return h("del", null, ...inline(node.c));
      // Links are shown, never followed: the address is only a tooltip.
      case "link": return h("span", { class: "md-link", title: node.href }, ...inline(node.c));
      case "image": return h("span", { class: "md-image" }, node.alt || "image");
      case "br": return h("br");
    }
  });
}

function block(node: Block): Node {
  switch (node.t) {
    case "heading": return h(`h${node.level}` as "h1", { class: "md-h" }, ...inline(node.c));
    case "para": return h("p", null, ...inline(node.c));
    case "code": {
      const code = renderCode(node.v, languageForTag(node.lang));
      code.classList.add("md-pre");
      return code;
    }
    case "list": {
      const list = h(node.ordered ? "ol" : "ul", node.ordered && node.start !== 1 ? { start: String(node.start) } : null);
      for (const item of node.items) list.append(h("li", null, ...item.map(block)));
      return list;
    }
    case "quote": return h("blockquote", null, ...node.c.map(block));
    case "hr": return h("hr");
    case "table":
      return h("div", { class: "md-table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, ...node.head.map((cell) => h("th", null, ...inline(cell))))),
        h("tbody", null, ...node.rows.map((row) => h("tr", null, ...row.map((cell) => h("td", null, ...inline(cell))))))));
  }
}

/** Renders Markdown as DOM nodes (see markdown.ts for what is supported). */
export function renderMarkdown(source: string): HTMLElement {
  return h("div", { class: "md" }, ...parseMarkdown(source).map(block));
}
