import { ago, notesApi, type Note } from "../../notes/api";
import { parse, plainText, render, toMarkdown } from "../../notes/markdown";
import { openNoteMenu } from "../../notes/menu";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { openMenu, type MenuItem } from "../../ui/menu";

/** The checkbox of a checklist item takes this much of its left edge (as in the editor). */
const CHECK_ZONE = 24;

export interface CardHost {
  openExternally(url: string): void;
  /** The Kanban columns, for a card's Status menu. */
  columns(): string[];
  /** True right after a card was dragged, so the click that ends a drag doesn't open the note. */
  dragging(): boolean;
}

/**
 * A note as a card of its colour: when it was edited, its title, and its text (checklist items
 * tick right here). A click opens the note on the desktop; the menu sets colour, status, pin.
 */
export function noteCard(note: Note, host: CardHost): HTMLElement {
  const lines = parse(note.body);
  const text = h("div", { class: "note-text nm-card-text" });
  render(text, lines);
  const more = h("button", { type: "button", class: "nm-card-more", title: "More", "aria-label": "More" }, icon("more", 16));
  const meta = h("div", { class: "nm-card-meta" },
    note.pinned && !note.deleted ? h("span", { class: "nm-pin", title: "Pinned" }, icon("pin", 13)) : null,
    h("span", { class: "nm-date" }, note.deleted ? `Deleted ${ago(note.deleted)}` : ago(note.updated)), more);
  const title = note.title ? h("h3", { class: "nm-card-title", title: note.title }, note.title) : null;
  const el = h("article", {
    class: `nm-card${note.deleted ? " deleted" : ""}`, role: "listitem", tabindex: 0, "data-id": note.id, "data-note-color": note.color,
  }, meta, title, text);
  if (!note.body.trim()) text.classList.add(note.title ? "nm-card-none" : "nm-card-blank");

  const statusMenu = (x: number, y: number) => {
    const names = [...host.columns()];
    if (note.status && !names.includes(note.status)) names.push(note.status);
    openMenu(x, y, [
      ...names.map((name): MenuItem => ({ label: name, icon: note.status === name ? "check" : undefined, action: () => void notesApi.update(note.id, { status: name }) })),
      "separator",
      { label: "No Status", icon: note.status ? undefined : "check", action: () => void notesApi.update(note.id, { status: null }) },
    ]);
  };
  const showMenu = (x: number, y: number) => {
    if (note.deleted) {
      openMenu(x, y, [
        { label: "Restore", icon: "undo", action: () => void notesApi.restore(note.id) },
        "separator",
        { label: "Delete Forever", icon: "trash", danger: true, action: () => void notesApi.purge([note.id]) },
      ]);
      return;
    }
    openNoteMenu(x, y, note, (color) => void notesApi.update(note.id, { color }), [
      { label: "Open Note", icon: "external", shortcut: "Enter", action: () => void notesApi.open(note.id) },
      { label: note.pinned ? "Unpin" : "Pin to Top", icon: "pin", action: () => void notesApi.update(note.id, { pinned: !note.pinned }) },
      { label: `Status: ${note.status ?? "None"}…`, icon: "columns", action: () => statusMenu(x, y) },
      { label: "Copy Text", icon: "copy", action: () => void navigator.clipboard.writeText([note.title, plainText(lines)].filter(Boolean).join("\n")).catch(() => undefined) },
      "separator",
      { label: "Delete Note", icon: "trash", danger: true, shortcut: "Delete", action: () => void notesApi.remove(note.id) },
    ]);
  };
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const rect = more.getBoundingClientRect();
    showMenu(rect.left, rect.bottom + 4);
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY);
  });
  el.addEventListener("click", (e) => {
    if (note.deleted || host.dragging()) return;
    const link = (e.target as HTMLElement).closest("a");
    if (link) {
      e.preventDefault();
      host.openExternally(link.href);
      return;
    }
    // A checklist item's box ticks it here; anywhere else opens the note.
    const li = (e.target as HTMLElement).closest("ul.checks > li");
    if (li && e.clientX - li.getBoundingClientRect().left <= CHECK_ZONE) {
      const index = Array.from(text.querySelectorAll("ul.checks > li")).indexOf(li);
      const target = lines.filter((b) => b.kind === "item" && b.list === "check")[index];
      if (target?.kind === "item") {
        target.checked = !target.checked;
        void notesApi.update(note.id, { body: toMarkdown(lines) });
      }
      return;
    }
    void notesApi.open(note.id);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !note.deleted) void notesApi.open(note.id);
    else if (e.key === "Delete") void (note.deleted ? notesApi.purge([note.id]) : notesApi.remove(note.id));
    else return;
    e.preventDefault();
  });
  return el;
}

/** Whether a note's title or text has every search term. */
export function matches(note: Note, terms: string[]): boolean {
  if (!terms.length) return true;
  const text = `${note.title}\n${plainText(parse(note.body))}`.toLowerCase();
  return terms.every((t) => text.includes(t));
}
