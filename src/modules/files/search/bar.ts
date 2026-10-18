import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import {
  hasFilters, KIND_CHIPS, MODIFIED_CHIPS, newFilters, SIZE_CHIPS,
  type KindFilter, type ModifiedFilter, type SearchFilters, type SizeFilter,
} from "./filters";

export type SearchScope = "folder" | "subfolders";

export interface SearchBarHooks {
  scopeChanged(scope: SearchScope): void;
  filtersChanged(): void;
}

const SCOPES: { id: SearchScope; label: string }[] = [
  { id: "folder", label: "This Folder" },
  { id: "subfolders", label: "Subfolders" },
];

/**
 * The strip under the toolbar while searching: the scope switch (This Folder | Subfolders) and
 * the filter chips (kind, modified, size). It slides open with the search field's focus or text.
 */
export class SearchBar {
  readonly el = h("div", { class: "fs-searchbar", "aria-label": "Search options" });
  readonly filters: SearchFilters = newFilters();
  scope: SearchScope = "folder";
  private readonly scopeButtons = new Map<SearchScope, HTMLButtonElement>();
  private readonly chips = new Map<string, HTMLButtonElement>();
  private readonly reset = h("button", { class: "fs-chip-reset", type: "button", title: "Clear filters" }, icon("close", 11), "Clear");

  constructor(private readonly hooks: SearchBarHooks) {
    const segmented = h("div", { class: "segmented fs-scope", role: "group", "aria-label": "Search in" });
    for (const s of SCOPES) {
      const button = h("button", { type: "button", title: `Search ${s.label.toLowerCase()}` }, s.label);
      button.addEventListener("click", () => this.setScope(s.id, true));
      this.scopeButtons.set(s.id, button);
      segmented.append(button);
    }

    const group = (label: string, chips: { id: string; label: string }[], toggle: (id: string) => void) => {
      const box = h("div", { class: "fs-chip-group", role: "group", "aria-label": label }, h("span", { class: "fs-chip-label" }, label));
      for (const chip of chips) {
        const button = h("button", { class: "fs-chip", type: "button", "aria-pressed": "false" }, chip.label);
        button.addEventListener("click", () => {
          toggle(chip.id);
          this.paint();
          hooks.filtersChanged();
        });
        this.chips.set(`${label}:${chip.id}`, button);
        box.append(button);
      }
      return box;
    };
    const f = this.filters;
    const toggleKind = (id: string) => {
      const kind = id as KindFilter;
      if (!f.kinds.delete(kind)) f.kinds.add(kind);
    };
    const pickModified = (id: string) => void (f.modified = f.modified === id ? null : (id as ModifiedFilter));
    const pickSize = (id: string) => void (f.size = f.size === id ? null : (id as SizeFilter));

    this.reset.addEventListener("click", () => {
      this.clearFilters();
      hooks.filtersChanged();
    });
    this.el.append(h("div", { class: "fs-searchbar-inner" },
      segmented,
      h("span", { class: "fs-searchbar-sep" }),
      group("Kind", KIND_CHIPS, toggleKind),
      h("span", { class: "fs-searchbar-sep" }),
      group("Modified", MODIFIED_CHIPS, pickModified),
      h("span", { class: "fs-searchbar-sep" }),
      group("Size", SIZE_CHIPS, pickSize),
      this.reset));
    // Clicking here must not take focus from the search field (that would close the strip).
    this.el.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("button")) e.preventDefault();
    });
    this.paint();
  }

  get open() {
    return this.el.classList.contains("open");
  }

  setOpen(open: boolean) {
    this.el.classList.toggle("open", open);
    this.el.inert = !open;
  }

  setScope(scope: SearchScope, notify = false) {
    if (scope === this.scope && !notify) return;
    const changed = scope !== this.scope;
    this.scope = scope;
    this.paint();
    if (changed && notify) this.hooks.scopeChanged(scope);
  }

  /** Turns every chip off (the caller repaints the list). */
  clearFilters() {
    this.filters.kinds.clear();
    this.filters.modified = this.filters.size = null;
    this.paint();
  }

  private paint() {
    for (const [id, button] of this.scopeButtons) button.classList.toggle("active", id === this.scope);
    const f = this.filters;
    const on = (key: string, active: boolean) => {
      const button = this.chips.get(key);
      if (!button) return;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    };
    for (const chip of KIND_CHIPS) on(`Kind:${chip.id}`, f.kinds.has(chip.id));
    for (const chip of MODIFIED_CHIPS) on(`Modified:${chip.id}`, f.modified === chip.id);
    for (const chip of SIZE_CHIPS) on(`Size:${chip.id}`, f.size === chip.id);
    this.reset.hidden = !hasFilters(f);
  }
}
