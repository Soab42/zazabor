import { basename, dirname, h } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import type { Decision, JobConflict } from "../ops-api";

/** Opens a glass sheet over the app; keys inside never reach the shortcuts behind it. */
function openSheet(card: HTMLElement, onEscape: () => void): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = h("div", { class: "modal-overlay ops-overlay" }, card);
  overlay.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onEscape();
    }
  });
  document.body.append(overlay);
  return () => {
    overlay.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
}

const button = (label: string, kind: "primary" | "danger" | "ghost" | "", onClick: () => void) =>
  h("button", { class: `btn${kind ? ` ${kind}` : ""}`, type: "button", onclick: onClick }, label);

function sheetCard(iconName: IconName, tone: "" | "danger", title: string, content: Node[], foot: Node[]): HTMLElement {
  return h("div", { class: "modal ops-sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "ops-sheet-body" },
      h("div", { class: `ops-sheet-icon${tone ? ` ${tone}` : ""}` }, icon(iconName, 20)),
      h("div", { class: "ops-sheet-text" }, h("h2", null, title), ...content)),
    h("div", { class: "modal-foot ops-sheet-foot" }, ...foot));
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  /** A red confirm button, and Cancel (not the destructive action) is focused first. */
  destructive?: boolean;
  icon?: IconName;
}

/** Asks a yes/no question; resolves true when confirmed. */
export function confirmSheet(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let close = () => {};
    const finish = (value: boolean) => {
      close();
      resolve(value);
    };
    const cancel = button("Cancel", "ghost", () => finish(false));
    const confirm = button(options.confirmLabel, options.destructive ? "danger" : "primary", () => finish(true));
    const card = sheetCard(options.icon ?? (options.destructive ? "trash" : "info"), options.destructive ? "danger" : "", options.title,
      [h("p", { class: "ops-sheet-msg" }, options.message)], [h("span", { class: "ops-spacer" }), cancel, confirm]);
    close = openSheet(card, () => finish(false));
    (options.destructive ? cancel : confirm).focus();
  });
}

export interface NameOptions {
  title: string;
  /** The current name; its base name (without the extension) starts out selected. */
  name: string;
  isDir: boolean;
  submitLabel: string;
  /** Names that are already used next to it (the item's own name excluded). */
  taken: ReadonlySet<string>;
  /** Applies the name. Throw an Error with a readable message to show it in the sheet. */
  apply: (name: string) => Promise<void>;
}

/** The problem with a typed name, or null when it is usable. */
export function nameProblem(name: string, taken: ReadonlySet<string>): string | null {
  if (!name.trim()) return "The name can’t be empty.";
  if (name.includes("/")) return "The name can’t contain “/”.";
  if (name === "." || name === "..") return "That name isn’t allowed.";
  if (taken.has(name)) return `An item named “${name}” already exists here.`;
  return null;
}

/** A small sheet with a name field. Resolves true once `apply` succeeded, false when dismissed. */
export function nameSheet(options: NameOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let close = () => {};
    let busy = false;
    const input = h("input", { class: "ops-input", type: "text", value: options.name, spellcheck: false, autocomplete: "off", "aria-label": "Name" });
    const message = h("p", { class: "ops-field-msg", role: "alert" });
    const submit = button(options.submitLabel, "primary", () => void apply());
    const finish = (value: boolean) => {
      close();
      resolve(value);
    };
    const show = (text: string | null) => {
      message.textContent = text ?? "";
      input.classList.toggle("invalid", !!text);
    };
    const check = () => {
      const problem = input.value === options.name ? null : nameProblem(input.value, options.taken);
      show(problem);
      submit.disabled = busy || !!nameProblem(input.value, new Set());
      return problem;
    };
    const apply = async () => {
      const value = input.value;
      if (busy) return;
      if (value === options.name) return finish(true);
      if (check()) return;
      busy = true;
      submit.disabled = true;
      try {
        await options.apply(value);
        finish(true);
      } catch (err) {
        busy = false;
        show(err instanceof Error ? err.message : String(err));
        submit.disabled = false;
        input.focus();
      }
    };
    input.addEventListener("input", check);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void apply();
      }
    });
    const card = sheetCard(options.isDir ? "folder" : "pencil", "", options.title,
      [input, message], [h("span", { class: "ops-spacer" }), button("Cancel", "ghost", () => finish(false)), submit]);
    close = openSheet(card, () => finish(false));
    input.focus();
    const dot = options.name.lastIndexOf(".");
    input.setSelectionRange(0, !options.isDir && dot > 0 ? dot : options.name.length);
  });
}

/** The answer to a conflict question; `cancel` means stop the whole job. */
export type ConflictAnswer = { decision: Decision; applyToAll: boolean } | "cancel";

export interface ConflictSheet {
  answer: Promise<ConflictAnswer>;
  /** Closes the sheet without answering (the job ended or was cancelled elsewhere). */
  dismiss(): void;
}

/** “An item named “x” already exists in “Folder”. Do you want to replace it?” */
export function conflictSheet(conflict: JobConflict): ConflictSheet {
  let close = () => {};
  let settle: (a: ConflictAnswer) => void = () => {};
  const answer = new Promise<ConflictAnswer>((resolve) => (settle = resolve));
  const all = h("input", { type: "checkbox", id: "ops-apply-all" });
  const finish = (a: ConflictAnswer) => {
    close();
    settle(a);
  };
  const pick = (decision: Decision) => finish({ decision, applyToAll: all.checked });
  const name = basename(conflict.target);
  const folder = basename(dirname(conflict.target));
  const keep = button("Keep Both", "primary", () => pick("keepBoth"));
  const card = sheetCard("copy", "", "Item already exists", [
    h("p", { class: "ops-sheet-msg" }, `An item named “${name}” already exists in “${folder}”. Do you want to replace it?`),
    h("p", { class: "ops-sheet-hint" }, "Replacing moves the existing item to the Trash."),
    h("label", { class: "ops-check", for: "ops-apply-all" }, all, "Apply to all"),
  ], [
    button("Cancel", "ghost", () => finish("cancel")),
    h("span", { class: "ops-spacer" }),
    button("Skip", "", () => pick("skip")),
    button("Replace", "", () => pick("replace")),
    keep,
  ]);
  close = openSheet(card, () => finish("cancel"));
  keep.focus();
  return { answer, dismiss: close };
}
