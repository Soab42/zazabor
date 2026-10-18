import { h } from "../../../../ui/dom";
import type { MediaSettings } from "../profiles/settings";
import { openDialog } from "../open/dialog";

/** A shortcut group: each row is a label and the key combinations that do it (alternatives). */
export interface ShortcutGroup {
  title: string;
  rows: [string, string[][]][];
}

type Steps = Pick<MediaSettings, "skipSeconds" | "bigSkipSeconds" | "volumeStep">;

const seconds = (n: number) => (n % 60 === 0 && n >= 60 ? `${n / 60} min` : `${n} s`);

/** The player's keys, grouped; the skip and volume steps follow the settings. */
export function videoShortcuts(steps: Steps): ShortcutGroup[] {
  return [
    {
      title: "Playback",
      rows: [
        ["Play or pause", [["Space"], ["K"]]],
        [`Jump back or forward ${seconds(steps.skipSeconds)}`, [["←"], ["→"]]],
        [`Jump back or forward ${seconds(steps.bigSkipSeconds)}`, [["Shift", "←"], ["Shift", "→"]]],
        ["Next and previous in the queue", [["N"], ["P"]]],
        ["Slower and faster", [["["], ["]"]]],
      ],
    },
    {
      title: "Sound and picture",
      rows: [
        [`Volume up and down ${steps.volumeStep}%`, [["↑"], ["↓"]]],
        ["Mute or unmute", [["M"]]],
        ["Fullscreen", [["F"], ["Double-click"]]],
        ["Leave fullscreen", [["Esc"]]],
        ["Hide or show the controls", [["Ctrl", "H"]]],
        ["Subtitles earlier or later", [["G"], ["H"]]],
      ],
    },
    {
      title: "Library and panels",
      rows: [
        ["Open a file", [["Ctrl", "O"]]],
        ["Add a bookmark here", [["Ctrl", "B"]]],
        ["Mini player", [["Ctrl", "M"]]],
        ["Show these shortcuts", [["?"]]],
      ],
    },
  ];
}

export function keycaps(combos: string[][]): HTMLElement {
  const keys = h("div", { class: "mt-keys" });
  combos.forEach((combo, i) => {
    if (i > 0) keys.append(h("span", { class: "mt-or" }, "or"));
    keys.append(h("span", { class: "mt-combo" }, ...combo.map((k) => h("kbd", { class: "mt-kbd" }, k))));
  });
  return keys;
}

/** The Keyboard Shortcuts dialog: a glass sheet of key caps by group. */
export function openShortcuts(steps: Steps) {
  const dialog = openDialog({ title: "Keyboard Shortcuts", subtitle: "Everything you can do without the mouse.", icon: "terminal", width: 680 });
  const groups = videoShortcuts(steps).map((group) =>
    h("section", { class: "mt-shortcuts" },
      h("div", { class: "mt-section" }, h("span", null, group.title)),
      h("div", { class: "mt-card" }, ...group.rows.map(([label, combos]) =>
        h("div", { class: "mt-row" }, h("span", { class: "mt-row-label" }, label), keycaps(combos))))));
  dialog.body.append(...groups);
  const close = h("button", { class: "btn", type: "button" }, "Done");
  close.addEventListener("click", () => dialog.close());
  dialog.foot.append(h("span", { class: "mt-hint tight" }, "Press ? at any time to open this."), h("div", { class: "spacer" }), close);
  close.focus();
}
