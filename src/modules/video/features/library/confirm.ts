import { h } from "../../../../ui/dom";

/** A yes/no dialog; resolves true when confirmed. */
export function confirmDialog(options: { title: string; text: string; confirm: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const confirm = h("button", { class: "btn primary", type: "button", onclick: () => done(true) }, options.confirm);
    const overlay = h("div", { class: "modal-overlay lib-dialog" },
      h("div", { class: "modal lib-dialog-card", role: "alertdialog", "aria-label": options.title },
        h("div", { class: "modal-head" }, h("h2", null, options.title)),
        h("div", { class: "modal-body" }, h("p", { class: "lib-dialog-text" }, options.text)),
        h("div", { class: "modal-foot" }, h("span", { class: "lib-grow" }),
          h("button", { class: "btn", type: "button", onclick: () => done(false) }, "Cancel"), confirm)));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(false);
      }
    };
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) done(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    confirm.focus();
  });
}
