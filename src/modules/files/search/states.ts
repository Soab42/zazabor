import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";

/** Shown over the results while a search that has found nothing yet is still looking. */
export function searchingState() {
  return h("div", { class: "fs-state-card plain" }, h("span", { class: "spinner large" }));
}

/** A search that matched nothing; says where it looked and mentions active filters. */
export function noMatchesState(query: string, subfolders: boolean, filtered: boolean, error: string | null) {
  const where = subfolders ? "this folder or its subfolders" : "this folder";
  const text = error
    ?? (filtered
      ? `Nothing in ${where} is named like “${query}” and fits the filters. Try clearing a filter.`
      : `Nothing in ${where} is named like “${query}”.`);
  return h("div", { class: "fs-state-card" },
    h("div", { class: "fs-state-icon" }, icon("search", 34)),
    h("h2", null, error ? "Search Failed" : "No Matches"),
    h("p", null, text));
}
