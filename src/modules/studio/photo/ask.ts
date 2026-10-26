import { h } from "../../../ui/dom";
import type { IconName } from "../../../ui/icons";
import { openDialog } from "../../time/dialog";
import "../../time/time-module.css";

export interface Choice<T extends string> {
  id: T;
  label: string;
  /** The default (Enter, and the coloured button). */
  primary?: boolean;
  /** Placed on the left, apart from the others ("Don't Save"). */
  aside?: boolean;
}

/** A question with buttons; resolves with the chosen id, or `cancel` when dismissed. */
export function ask<T extends string>(o: { title: string; text: string; icon?: IconName; choices: Choice<T>[]; cancel: T }): Promise<T> {
  return new Promise((resolve) => {
    let answer = o.cancel;
    const button = (c: Choice<T>) =>
      h("button", { class: `btn${c.primary ? " primary" : ""}`, type: "button", "data-autofocus": c.primary ? "" : null, onclick: () => ((answer = c.id), dialog.close()) }, c.label);
    const dialog = openDialog({
      title: o.title,
      icon: o.icon ?? "photoEdit",
      tone: "work",
      class: "tt-confirm",
      body: [h("p", { class: "tt-dialog-text" }, o.text)],
      foot: [...o.choices.filter((c) => c.aside).map(button), h("span", { class: "spacer" }), ...o.choices.filter((c) => !c.aside).map(button)],
      onClose: () => resolve(answer),
    });
  });
}
