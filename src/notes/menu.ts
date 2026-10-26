import { h } from "../ui/dom";
import { closeMenu, openMenu, type MenuItem } from "../ui/menu";
import { COLOR_NAMES, NOTE_COLORS, type Note, type NoteColor } from "./api";

/** A note's menu: its colours as swatches over the given items. */
export function openNoteMenu(x: number, y: number, note: Note, setColor: (color: NoteColor) => void, items: MenuItem[]) {
  const swatches = h("div", { class: "note-swatches", role: "group", "aria-label": "Colour" },
    ...NOTE_COLORS.map((color) =>
      h("button", {
        type: "button",
        class: `note-swatch${color === note.color ? " active" : ""}`,
        "data-note-color": color,
        title: COLOR_NAMES[color],
        "aria-label": COLOR_NAMES[color],
        onclick: () => {
          closeMenu();
          if (color !== note.color) setColor(color);
        },
      })));
  openMenu(x, y, items, swatches);
}
