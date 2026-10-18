import { h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";

function card(name: IconName, title: string, text: string, ...extra: (Node | null)[]) {
  return h("div", { class: "fs-state-card" },
    h("div", { class: "fs-state-icon" }, icon(name, 34)),
    h("h2", null, title),
    h("p", null, text),
    ...extra);
}

/** Shown over a folder that takes a while to list. */
export function loadingState() {
  return h("div", { class: "fs-state-card plain" }, h("span", { class: "spinner large" }));
}

/** An empty folder, or a search that matched nothing. */
export function emptyState(query: string) {
  return query
    ? card("search", "No Matches", `Nothing in this folder is named like “${query}”.`)
    : card("folder", "This Folder Is Empty", "Files you add to it will appear here right away.");
}

/** A folder that cannot be opened: missing, denied or not a folder. */
export function errorState(message: string, goHome: () => void) {
  const button = h("button", { class: "btn primary", type: "button" }, icon("home", 15), "Go Home");
  button.addEventListener("click", goHome);
  return card("folder", "Can’t Open This Folder", message || "It may have been moved, or you may not have permission to see it.", button);
}
