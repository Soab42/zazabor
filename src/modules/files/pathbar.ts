import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { crumbs } from "./path";

export interface PathBarHooks {
  navigate(path: string): void;
  /** Enter pressed in the editable field. */
  submit(text: string): void;
}

/** A breadcrumb of clickable folders that turns into a text field on Ctrl+L or a click on empty space. */
export class PathBar {
  readonly el = h("div", { class: "fs-pathbar" });
  private trail = h("div", { class: "pb-trail" });
  private input = h("input", { class: "pb-input", type: "text", spellcheck: false, autocomplete: "off", "aria-label": "Path" });
  private path = "";
  private editing = false;

  constructor(private readonly hooks: PathBarHooks) {
    this.input.hidden = true;
    this.el.append(this.trail, this.input);
    this.trail.addEventListener("click", (e) => {
      // A crumb handles its own click; the rest of the bar starts editing.
      if (e.target === this.trail) this.edit();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const text = this.input.value;
        this.stopEditing();
        this.hooks.submit(text);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.stopEditing();
      }
    });
    this.input.addEventListener("blur", () => this.stopEditing());
    new ResizeObserver(() => this.scrollToEnd()).observe(this.el);
  }

  setPath(path: string) {
    this.path = path;
    this.renderTrail();
    if (this.editing) this.input.value = path;
  }

  private renderTrail() {
    const list = crumbs(this.path || "/");
    const nodes: Node[] = [];
    list.forEach((crumb, i) => {
      if (i > 0) nodes.push(h("span", { class: "pb-sep" }, icon("chevronRight", 11)));
      const last = i === list.length - 1;
      const button = h("button", { class: `pb-crumb${last ? " current" : ""}`, type: "button", title: crumb.path },
        icon("folder", 14), h("span", null, crumb.name));
      button.addEventListener("click", () => this.hooks.navigate(crumb.path));
      nodes.push(button);
    });
    this.trail.replaceChildren(...nodes);
    this.scrollToEnd();
  }

  /** Long paths show their tail, which holds the folder you are in. */
  private scrollToEnd() {
    requestAnimationFrame(() => {
      this.trail.scrollLeft = this.trail.scrollWidth;
    });
  }

  edit() {
    if (this.editing) return;
    this.editing = true;
    this.el.classList.add("editing");
    this.trail.hidden = true;
    this.input.hidden = false;
    this.input.value = this.path;
    this.input.focus();
    this.input.select();
  }

  private stopEditing() {
    if (!this.editing) return;
    this.editing = false;
    this.el.classList.remove("editing");
    this.input.hidden = true;
    this.trail.hidden = false;
    this.scrollToEnd();
  }
}
