import { notesApi, orderOf, positionBetween, type Note } from "../../notes/api";
import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { openMenu, type MenuItem } from "../../ui/menu";
import { CardDrag } from "./drag";

export interface KanbanHost {
  makeCard(note: Note): HTMLElement;
  /** The columns set up in Settings (status names), left to right. */
  columns(): string[];
  setColumns(columns: string[]): void;
  /** `null` takes the note out of every column. */
  setStatus(id: string, status: string | null): void;
  /** A new note in a column, opened on the desktop. */
  addNote(status: string | null): void;
  /** Renames a status on the board and on every note that has it. */
  renameStatus(from: string, to: string): void;
}

/** The column of notes without a status; shown only while there are some. */
const NONE = "";

interface Column {
  el: HTMLElement;
  name: HTMLElement;
  count: HTMLElement;
  list: HTMLElement;
}

/**
 * The notes in Kanban columns by status, each column the full height of the view. Drag a card
 * to another column (or to another place in its own) and a shadow card shows where it lands;
 * dropping sets its status and its place. "+ Add note" makes a note right in a column. Columns
 * come from Settings, plus any status a note has that isn't one of them (set on another
 * computer, say). Cards are kept, not rebuilt, as on the board.
 */
export class Kanban {
  readonly el = h("div", { class: "nm-kanban" });
  readonly drag: CardDrag;
  private cards = new Map<string, { el: HTMLElement; note: Note }>();
  private columns = new Map<string, Column>();
  private addColumn = h("button", { type: "button", class: "nk-new-column", onclick: () => this.newColumn() }, icon("plus", 15), "Add column");
  private drawn = false;
  private notes: Note[] = [];
  // While a card is dragged: which, where it came from, and notes that arrived meanwhile.
  private dragged: string | null = null;
  private origin: { list: HTMLElement; next: Element | null } | null = null;
  private over: Column | null = null;
  private pending: Note[] | null = null;

  constructor(private readonly host: KanbanHost) {
    this.drag = new CardDrag(this.el, {
      start: (card) => this.startDrag(card),
      move: (x, y) => this.dragOver(x, y),
      end: (drop) => this.endDrag(drop),
      scrollers: (x, y) => {
        const list = this.columnAt(x)?.list;
        const r = list?.getBoundingClientRect();
        const inList = r && y >= r.top - 60 && y <= r.bottom + 60;
        return [{ el: this.el, axis: "x" as const }, ...(list && inList ? [{ el: list, axis: "y" as const }] : [])];
      },
    });
  }

  show(notes: Note[]) {
    if (this.dragged) {
      this.pending = notes;
      return;
    }
    this.notes = notes;
    const configured = this.host.columns();
    const extra = [...new Set(notes.map((n) => n.status).filter((s): s is string => !!s && !configured.includes(s)))];
    const keys = [...(notes.some((n) => !n.status) ? [NONE] : []), ...configured, ...extra];

    // Cards: kept unless their note changed.
    const showing = new Set(notes.map((n) => n.id));
    for (const [id, card] of this.cards) {
      if (showing.has(id)) continue;
      card.el.remove();
      this.cards.delete(id);
    }
    for (const note of notes) {
      const card = this.cards.get(note.id);
      if (card?.note === note) continue;
      const el = this.host.makeCard(note);
      if (card) {
        const focused = card.el.contains(document.activeElement);
        card.el.replaceWith(el);
        if (focused) el.focus();
      } else if (this.drawn) {
        el.classList.add("entering");
        el.addEventListener("animationend", () => el.classList.remove("entering"), { once: true });
      }
      this.cards.set(note.id, { el, note });
    }

    // Columns, in order, each with its cards in order.
    for (const [key, column] of this.columns) {
      if (keys.includes(key)) continue;
      column.el.remove();
      this.columns.delete(key);
    }
    keys.forEach((key, i) => {
      const column = this.columns.get(key) ?? this.makeColumn(key);
      this.columns.set(key, column);
      column.el.classList.toggle("unlisted", key !== NONE && !configured.includes(key));
      const inColumn = notes.filter((n) => (n.status ?? NONE) === key);
      column.count.textContent = String(inColumn.length);
      inColumn.forEach((note, j) => {
        const el = this.cards.get(note.id)!.el;
        if (column.list.children[j] !== el) column.list.insertBefore(el, column.list.children[j] ?? null);
      });
      if (this.el.children[i] !== column.el) this.el.insertBefore(column.el, this.el.children[i] ?? null);
    });
    this.el.append(this.addColumn);
    this.drawn = true;
  }

  private makeColumn(key: string): Column {
    const name = h("span", { class: "nk-name" }, key === NONE ? "No status" : key);
    const count = h("span", { class: "nk-count" });
    const more = key === NONE ? null : h("button", { type: "button", class: "nk-more", title: "Column", "aria-label": `${key} column` }, icon("more", 16));
    const list = h("div", { class: "nk-cards", role: "list" });
    const add = h("button", { type: "button", class: "nk-add", onclick: () => this.host.addNote(key === NONE ? null : key) }, icon("plus", 15), "Add note");
    const el = h("section", { class: "nk-column", "data-status": key, "aria-label": key || "No status" },
      h("header", { class: "nk-head" }, name, count, h("span", { class: "spacer" }), more), list, add);
    const column = { el, name, count, list };
    more?.addEventListener("click", () => {
      const rect = more.getBoundingClientRect();
      this.columnMenu(key, column, rect.left, rect.bottom + 4);
    });
    name.addEventListener("dblclick", () => key !== NONE && this.rename(key, column));
    return column;
  }

  private columnMenu(key: string, column: Column, x: number, y: number) {
    const configured = this.host.columns();
    const at = configured.indexOf(key);
    const move = (by: number) => {
      const next = [...configured];
      next.splice(at, 1);
      next.splice(at + by, 0, key);
      this.host.setColumns(next);
    };
    const items: MenuItem[] = at < 0
      ? [
        { label: "Add to Columns", icon: "plus", action: () => this.host.setColumns([...configured, key]) },
        { label: "Rename…", icon: "pencil", action: () => this.rename(key, column) },
      ]
      : [
        { label: "Rename…", icon: "pencil", action: () => this.rename(key, column) },
        { label: "Move Left", icon: "chevronLeft", disabled: at === 0, action: () => move(-1) },
        { label: "Move Right", icon: "chevronRight", disabled: at === configured.length - 1, action: () => move(1) },
        "separator",
        {
          label: "Delete Column", icon: "trash", danger: true,
          // Its notes stay; they just have no status any more.
          action: () => {
            for (const note of this.notes) if (note.status === key) this.host.setStatus(note.id, null);
            this.host.setColumns(configured.filter((c) => c !== key));
          },
        },
      ];
    openMenu(x, y, items);
  }

  /** Renames a column in place: Enter or leaving the field keeps it, Escape doesn't. */
  private rename(key: string, column: Column) {
    const input = h("input", { class: "nk-rename", type: "text", value: key, maxlength: 60, "aria-label": "Column name" });
    column.name.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      input.replaceWith(column.name);
      const to = input.value.trim();
      if (keep && to && to !== key) this.host.renameStatus(key, to);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  /** A new column at the end, named and ready to rename. */
  private newColumn() {
    const configured = this.host.columns();
    let name = "New column";
    for (let n = 2; configured.includes(name); n++) name = `New column ${n}`;
    this.host.setColumns([...configured, name]);
    const column = this.columns.get(name);
    if (column) {
      column.el.scrollIntoView({ inline: "end", block: "nearest" });
      this.rename(name, column);
    }
  }

  // ---- dragging

  private noteOf(el: Element): Note | undefined {
    const id = (el as HTMLElement).dataset.id;
    return id ? this.cards.get(id)?.note : undefined;
  }

  /** The column at `x`, or the nearest one. */
  private columnAt(x: number): Column | null {
    let best: Column | null = null;
    let distance = Infinity;
    for (const column of this.columns.values()) {
      const r = column.el.getBoundingClientRect();
      const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (d < distance) {
        distance = d;
        best = column;
      }
    }
    return best;
  }

  private startDrag(card: HTMLElement): boolean {
    const id = card.dataset.id;
    if (!id || !card.parentElement) return false;
    this.dragged = id;
    this.origin = { list: card.parentElement, next: card.nextElementSibling };
    return true;
  }

  /** The shadow goes to the column under the pointer, between the cards above and below it. */
  private dragOver(x: number, y: number) {
    const card = this.dragged ? this.cards.get(this.dragged) : undefined;
    const column = this.columnAt(x);
    if (!card || !column) return;
    if (column !== this.over) {
      this.over?.el.classList.remove("drop");
      this.over = column;
      column.el.classList.add("drop");
    }
    const others = (Array.from(column.list.children) as HTMLElement[]).filter((c) => c !== card.el);
    let index = others.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    if (index < 0) index = others.length;
    // Pinned notes stay above the others.
    const pinned = others.filter((c) => this.noteOf(c)?.pinned).length;
    index = card.note.pinned ? Math.min(index, pinned) : Math.max(index, pinned);
    const before = others[index] ?? null;
    if (card.el.parentElement !== column.list || card.el.nextElementSibling !== before) {
      column.list.insertBefore(card.el, before);
      for (const c of this.columns.values()) c.count.textContent = String(c.list.children.length);
    }
  }

  private endDrag(drop: boolean) {
    const id = this.dragged!;
    const card = this.cards.get(id)!;
    const origin = this.origin!;
    this.dragged = null;
    this.origin = null;
    this.over?.el.classList.remove("drop");
    this.over = null;
    const list = card.el.parentElement!;
    const moved = list !== origin.list || card.el.nextElementSibling !== origin.next;
    if (!drop || !moved) {
      origin.list.insertBefore(card.el, origin.next);
    } else {
      const key = (list.closest(".nk-column") as HTMLElement | null)?.dataset.status ?? NONE;
      const status = key === NONE ? null : key;
      const neighbour = (el: Element | null) => {
        const note = el ? this.noteOf(el) : undefined;
        return note && note.pinned === card.note.pinned ? note : undefined;
      };
      const position = positionBetween(neighbour(card.el.previousElementSibling), neighbour(card.el.nextElementSibling), orderOf(card.note));
      void notesApi.update(id, { position, ...((card.note.status ?? null) !== status ? { status } : {}) })
        .catch((err) => console.warn("Could not move the note:", err));
    }
    for (const c of this.columns.values()) c.count.textContent = String(c.list.children.length);
    const pending = this.pending;
    this.pending = null;
    if (pending) this.show(pending);
  }
}
