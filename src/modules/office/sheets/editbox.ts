import { getTokens } from "@ironcalc/wasm";
import { h } from "../../../ui/dom";
import { FUNCTION_HELP, FUNCTION_NAMES } from "./functions";

type Range = [number, number, number, number];

/** Colours Excel gives a formula's references, in order. */
export const REFERENCE_COLORS = ["#2f6fdb", "#d6336c", "#7b4fd6", "#1d9a6c", "#d9822b", "#0f8fb3", "#b5428f", "#5c7f1f"];

export interface EditHost {
  /** Commit the text; `move` says where the selection goes next (Enter, Tab…). */
  commit(text: string, move: "down" | "up" | "right" | "left" | "none", fillSelection: boolean): void;
  cancel(): void;
  /** The text changed (the formula bar and the reference outlines follow). */
  changed(text: string): void;
  /** Where the engine thinks the cursor's formula is going: a function name being typed, an argument. */
  completion(text: string, cursor: number): { from: number; prefix: string } | null;
  /** Formula point mode: arrows move a reference instead of the caret. */
  point(direction: "up" | "down" | "left" | "right", extend: boolean): void;
}

/**
 * The text field that edits a cell, in the cell (over the grid) and in the formula bar. One
 * `EditBox` per place; both edit the same text, so typing in either shows in both.
 *
 * "Enter" mode (typing over a cell) commits on arrow keys, like Excel; "Edit" mode (F2, a double
 * click, a click in the formula bar) moves the caret. While a formula is typed, a click on the
 * grid inserts that cell's reference where the caret is (see `insertReference`).
 */
export class EditBox {
  readonly el: HTMLTextAreaElement;
  /** Typing replaced the cell (Enter mode), not F2 (Edit mode). */
  enterMode = true;
  /** Where the reference being pointed at sits in the text, while pointing. */
  private pointed: { start: number; end: number } | null = null;
  private suggest = h("div", { class: "sh-suggest", role: "listbox", hidden: true });
  private suggestIndex = 0;
  private suggestions: string[] = [];
  private suggestFrom = 0;

  constructor(private readonly host: EditHost, className: string) {
    this.el = h("textarea", { class: className, rows: 1, spellcheck: "false", autocomplete: "off", "aria-label": "Cell contents" });
    this.el.addEventListener("input", () => {
      this.pointed = null;
      this.host.changed(this.el.value);
      this.updateSuggest();
    });
    this.el.addEventListener("keydown", (e) => this.key(e));
    this.el.addEventListener("blur", () => (this.suggest.hidden = true));
    document.body.append(this.suggest);
  }

  get value() {
    return this.el.value;
  }

  set value(text: string) {
    this.el.value = text;
    this.pointed = null;
  }

  get isFormula() {
    return this.el.value.startsWith("=");
  }

  /**
   * Whether a click on the grid should insert a reference now: the formula's caret sits where a
   * reference can go (after "=", an operator, "(", "," or ":"), or a pointed reference is there.
   */
  wantsReference(): boolean {
    if (!this.isFormula) return false;
    if (this.pointed) return true;
    const before = this.el.value.slice(0, this.el.selectionStart).trimEnd();
    return /[=+\-*/^&(,:<>;%]$/.test(before);
  }

  /** Puts a reference at the caret, or replaces the one being pointed at. */
  insertReference(ref: string) {
    const v = this.el.value;
    const start = this.pointed?.start ?? this.el.selectionStart;
    const end = this.pointed?.end ?? this.el.selectionEnd;
    this.el.value = v.slice(0, start) + ref + v.slice(end);
    this.pointed = { start, end: start + ref.length };
    this.el.setSelectionRange(start + ref.length, start + ref.length);
    this.host.changed(this.el.value);
  }

  /** Stops pointing: the next click or arrow adds a new reference rather than moving this one. */
  endPointing() {
    this.pointed = null;
  }

  /** The references in the formula, coloured as Excel colours them. */
  references(): { text: string; range: Range | null; sheet: string | null; color: string }[] {
    if (!this.isFormula) return [];
    let tokens: ReturnType<typeof getTokens> = [];
    try {
      tokens = getTokens(this.el.value.slice(1));
    } catch {
      return [];
    }
    const out: { text: string; range: Range | null; sheet: string | null; color: string }[] = [];
    const colors = new Map<string, string>();
    for (const t of tokens) {
      const tok = t.token as unknown;
      let range: Range | null = null;
      let sheet: string | null = null;
      if (tok && typeof tok === "object" && "Reference" in tok) {
        const r = (tok as { Reference: { row: number; column: number; sheet: string | null } }).Reference;
        range = [r.row, r.column, r.row, r.column];
        sheet = r.sheet;
      } else if (tok && typeof tok === "object" && "Range" in tok) {
        const r = (tok as { Range: { sheet: string | null; left: { row: number; column: number }; right: { row: number; column: number } } }).Range;
        range = [r.left.row, r.left.column, r.right.row, r.right.column];
        sheet = r.sheet;
      } else continue;
      const text = this.el.value.slice(1 + t.start, 1 + t.end).toUpperCase().replace(/\$/g, "");
      if (!colors.has(text)) colors.set(text, REFERENCE_COLORS[colors.size % REFERENCE_COLORS.length]);
      out.push({ text, range, sheet, color: colors.get(text)! });
    }
    return out;
  }

  focus(at: "end" | "all" = "end") {
    this.el.focus({ preventScroll: true });
    if (at === "end") this.el.setSelectionRange(this.el.value.length, this.el.value.length);
    else this.el.select();
  }

  private key(e: KeyboardEvent) {
    // Every key typed here is the editor's (the shell's shortcuts mean other things in a cell).
    e.stopPropagation();
    if (!this.suggest.hidden) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.suggestIndex = (this.suggestIndex + (e.key === "ArrowDown" ? 1 : -1) + this.suggestions.length) % this.suggestions.length;
        this.drawSuggest();
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && this.suggestions.length)) {
        e.preventDefault();
        this.acceptSuggestion(this.suggestions[this.suggestIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.suggest.hidden = true;
        return;
      }
    }
    const fill = e.ctrlKey || e.metaKey;
    if (e.key === "Enter" && e.altKey) {
      // Alt+Enter: a new line in the cell.
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end, value } = this.el;
      this.el.value = value.slice(0, s) + "\n" + value.slice(end);
      this.el.setSelectionRange(s + 1, s + 1);
      this.host.changed(this.el.value);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.suggest.hidden = true;
      this.host.commit(this.el.value, fill ? "none" : e.shiftKey ? "up" : "down", fill);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      this.suggest.hidden = true;
      this.host.commit(this.el.value, e.shiftKey ? "left" : "right", false);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      this.suggest.hidden = true;
      this.host.cancel();
      return;
    }
    if (e.key === "F2") {
      e.preventDefault();
      this.enterMode = !this.enterMode;
      return;
    }
    const arrows: Record<string, "up" | "down" | "left" | "right"> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    const dir = arrows[e.key];
    if (dir && this.enterMode) {
      if (this.wantsReference()) {
        // Point mode: the arrow picks a cell for the formula.
        e.preventDefault();
        this.host.point(dir, e.shiftKey);
        return;
      }
      if (!e.shiftKey) {
        e.preventDefault();
        this.host.commit(this.el.value, dir, false);
      }
    }
  }

  // ---- function names

  private updateSuggest() {
    if (!this.isFormula) {
      this.suggest.hidden = true;
      return;
    }
    const hint = this.host.completion(this.el.value, this.el.selectionStart);
    if (!hint || hint.prefix.length < 1) {
      this.suggest.hidden = true;
      return;
    }
    const prefix = hint.prefix.toUpperCase();
    this.suggestions = FUNCTION_NAMES.filter((n) => n.startsWith(prefix)).slice(0, 12);
    // The engine's offset doesn't count the "=": where the name being typed starts, from the caret.
    this.suggestFrom = this.el.selectionStart - hint.prefix.length;
    this.suggestIndex = 0;
    if (!this.suggestions.length) {
      this.suggest.hidden = true;
      return;
    }
    this.drawSuggest();
  }

  private drawSuggest() {
    this.suggest.replaceChildren(...this.suggestions.map((name, i) => h("div", {
      class: `sh-suggest-item${i === this.suggestIndex ? " active" : ""}`, role: "option",
      onmousedown: (e: Event) => (e.preventDefault(), this.acceptSuggestion(name)),
    }, h("b", null, name), FUNCTION_HELP[name] ? h("span", null, FUNCTION_HELP[name].text) : null)));
    const r = this.el.getBoundingClientRect();
    this.suggest.hidden = false;
    Object.assign(this.suggest.style, { left: `${r.left}px`, top: `${r.bottom + 2}px` });
  }

  private acceptSuggestion(name: string) {
    const v = this.el.value;
    const caret = this.el.selectionStart;
    const insert = `${name}(`;
    this.el.value = v.slice(0, this.suggestFrom) + insert + v.slice(caret);
    const at = this.suggestFrom + insert.length;
    this.el.setSelectionRange(at, at);
    this.suggest.hidden = true;
    this.host.changed(this.el.value);
  }

  dispose() {
    this.suggest.remove();
  }
}
