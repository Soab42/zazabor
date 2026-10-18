import type { FilesView } from "../../config";
import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { PathBar } from "./pathbar";

export interface ToolbarHooks {
  back(): void;
  forward(): void;
  navigate(path: string): void;
  submitPath(text: string): void;
  setView(view: FilesView): void;
  /** Open the sort menu below the button at these screen coordinates. */
  sortMenu(x: number, y: number): void;
  toggleHidden(): void;
  search(query: string): void;
  /** Escape in the search field, after it was cleared. */
  searchDone(): void;
}

export interface ToolbarState {
  canBack: boolean;
  canForward: boolean;
  path: string;
  view: FilesView;
  showHidden: boolean;
}

const VIEWS: { view: FilesView; icon: IconName; label: string }[] = [
  { view: "icon", icon: "grid", label: "as Icons" },
  { view: "list", icon: "list", label: "as List" },
  { view: "column", icon: "columns", label: "as Columns" },
  { view: "gallery", icon: "galleryView", label: "as Gallery" },
];

/** The glass toolbar: history, path bar, view switcher, sort, hidden files and search. */
export class Toolbar {
  readonly el = h("div", { class: "fs-toolbar" });
  private pathBar: PathBar;
  private back = h("button", { class: "icon-btn", type: "button", title: "Back (Alt+←)" }, icon("chevronLeft", 18));
  private forward = h("button", { class: "icon-btn", type: "button", title: "Forward (Alt+→)" }, icon("chevronRight", 18));
  private views = new Map<FilesView, HTMLButtonElement>();
  private hidden = h("button", { class: "icon-btn", type: "button" }, icon("eye", 17));
  private sort = h("button", { class: "icon-btn", type: "button", title: "Sort By" }, icon("sort", 17));
  private search = h("input", { class: "search-input", type: "text", placeholder: "Search", spellcheck: false, autocomplete: "off", "aria-label": "Filter this folder" });
  private searchBox = h("label", { class: "search fs-search" }, icon("search", 14), this.search);

  constructor(private readonly hooks: ToolbarHooks) {
    this.pathBar = new PathBar({ navigate: (p) => hooks.navigate(p), submit: (t) => hooks.submitPath(t) });
    this.back.addEventListener("click", () => hooks.back());
    this.forward.addEventListener("click", () => hooks.forward());

    const segmented = h("div", { class: "segmented fs-views", role: "group", "aria-label": "View" });
    for (const v of VIEWS) {
      const button = h("button", { type: "button", title: `View ${v.label}`, "aria-label": v.label }, icon(v.icon, 16));
      button.addEventListener("click", () => hooks.setView(v.view));
      this.views.set(v.view, button);
      segmented.append(button);
    }

    this.sort.addEventListener("click", () => {
      const r = this.sort.getBoundingClientRect();
      hooks.sortMenu(r.left, r.bottom + 6);
    });
    this.hidden.addEventListener("click", () => hooks.toggleHidden());

    this.search.addEventListener("input", () => hooks.search(this.search.value));
    this.search.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      this.clearSearch();
      this.search.blur();
      hooks.searchDone();
    });

    this.el.append(
      h("div", { class: "fs-nav" }, this.back, this.forward),
      this.pathBar.el,
      segmented,
      h("div", { class: "fs-tools" }, this.sort, this.hidden),
      this.searchBox,
    );
  }

  update(state: ToolbarState) {
    this.back.disabled = !state.canBack;
    this.forward.disabled = !state.canForward;
    this.pathBar.setPath(state.path);
    for (const [view, button] of this.views) button.classList.toggle("active", view === state.view);
    this.hidden.classList.toggle("active", state.showHidden);
    this.hidden.replaceChildren(icon(state.showHidden ? "eye" : "eyeOff", 17));
    this.hidden.title = `${state.showHidden ? "Hide" : "Show"} Hidden Files (Ctrl+H)`;
  }

  editPath() {
    this.pathBar.edit();
  }

  focusSearch() {
    this.search.focus();
    this.search.select();
  }

  clearSearch() {
    if (this.search.value === "") return;
    this.search.value = "";
    this.hooks.search("");
  }

  get query() {
    return this.search.value;
  }

  /** Empties the field without telling the browser (used when navigating). */
  resetSearch() {
    this.search.value = "";
  }
}
