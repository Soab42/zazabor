import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { openMenu } from "../../../ui/menu";
import { colorPanel } from "../ribbon";
import type { Model } from "./engine";

export interface TabsHost {
  model(): Model;
  sheet(): number;
  select(sheet: number): void;
  /** The workbook's sheets changed (added, renamed, moved…). */
  changed(): void;
  toast(text: string): void;
  confirm(title: string, text: string, yes: string): Promise<boolean>;
}

/**
 * The sheet tabs along the bottom, as in Excel: ◀ ▶ to scroll them, a tab per visible sheet
 * (double-click renames, drag reorders, right-click for the rest), and + for a new sheet.
 */
export class SheetTabs {
  readonly el: HTMLElement;
  private strip = h("div", { class: "sh-tabs-strip", role: "tablist" });

  constructor(private readonly host: TabsHost) {
    const scroll = (by: number) => this.strip.scrollBy({ left: by, behavior: "smooth" });
    this.el = h("div", { class: "sh-tabs" },
      h("button", { class: "icon-btn small", type: "button", title: "Scroll tabs left", "aria-label": "Scroll tabs left", onclick: () => scroll(-160) }, icon("chevronLeft", 13)),
      h("button", { class: "icon-btn small", type: "button", title: "Scroll tabs right", "aria-label": "Scroll tabs right", onclick: () => scroll(160) }, icon("chevronRight", 13)),
      this.strip,
      h("button", { class: "icon-btn small sh-tab-add", type: "button", title: "New Sheet (Shift+F11)", "aria-label": "New sheet", onclick: () => this.add() }, icon("sheetAdd", 15)));
  }

  add() {
    const m = this.host.model();
    m.newSheet();
    const sheets = m.getWorksheetsProperties();
    this.host.select(sheets.length - 1);
    this.host.changed();
  }

  /** The sheets as last drawn; when only the selection moved, the tabs are kept (so a double click lands on the same tab). */
  private drawn = "";

  draw() {
    const m = this.host.model();
    const current = this.host.sheet();
    const sheets = m.getWorksheetsProperties();
    const key = JSON.stringify(sheets.map((s) => [s.name, s.color ?? null, s.state]));
    if (key === this.drawn && !this.strip.querySelector("input")) {
      this.strip.querySelectorAll<HTMLElement>(".sh-tab").forEach((tab) => {
        const on = Number(tab.dataset.index) === current;
        tab.classList.toggle("active", on);
        tab.setAttribute("aria-selected", String(on));
      });
      this.strip.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    this.drawn = key;
    this.strip.replaceChildren(...sheets.map((s, i) => {
      if (s.state !== "visible") return null;
      const color = s.color ? m.resolveColor(s.color) : "";
      const tab = h("button", {
        class: `sh-tab${i === current ? " active" : ""}`, type: "button", role: "tab", "aria-selected": String(i === current),
        draggable: "true", title: s.name, "data-index": String(i), onclick: () => this.host.select(i),
        style: color ? { boxShadow: `inset 0 -3px 0 ${color}` } : {},
      }, s.name);
      tab.addEventListener("dblclick", () => this.rename(i, tab));
      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.host.select(i);
        this.menu(i, e.clientX, e.clientY, tab);
      });
      tab.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/x-sheet", String(i)));
      tab.addEventListener("dragover", (e) => e.preventDefault());
      tab.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer?.getData("text/x-sheet"));
        if (Number.isNaN(from) || from === i) return;
        m.moveSheet(from, i);
        this.host.select(i);
        this.host.changed();
      });
      return tab;
    }).filter((t): t is HTMLButtonElement => !!t));
    this.strip.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private rename(sheet: number, tab: HTMLElement) {
    const m = this.host.model();
    const name = m.getWorksheetsProperties()[sheet].name;
    const input = h("input", { class: "sh-tab-rename", value: name, spellcheck: "false", "aria-label": "Sheet name" });
    tab.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.drawn = "";
      const next = input.value.trim();
      if (save && next && next !== name) {
        try {
          m.renameSheet(sheet, next);
          this.host.changed();
        } catch (err) {
          this.host.toast(String(err));
        }
      }
      this.draw();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  private menu(sheet: number, x: number, y: number, tab: HTMLElement) {
    const m = this.host.model();
    const sheets = m.getWorksheetsProperties();
    const hidden = sheets.map((s, i) => ({ s, i })).filter(({ s }) => s.state !== "visible");
    const visible = sheets.filter((s) => s.state === "visible").length;
    openMenu(x, y, [
      { label: "Insert Sheet", icon: "plus", shortcut: "Shift+F11", action: () => this.add() },
      { label: "Duplicate", icon: "copy", action: () => (m.duplicateSheet(sheet), this.host.select(sheet + 1), this.host.changed()) },
      { label: "Rename", icon: "pencil", action: () => this.rename(sheet, tab) },
      {
        label: "Tab Colour…", icon: "palette",
        action: () => colorPanel(tab, { noneLabel: "No Colour", pick: (c) => (m.setSheetColor(sheet, c ?? ""), this.host.changed()) }),
      },
      "separator",
      { label: "Move Left", icon: "chevronLeft", disabled: sheet === 0, action: () => (m.moveSheet(sheet, sheet - 1), this.host.select(sheet - 1), this.host.changed()) },
      { label: "Move Right", icon: "chevronRight", disabled: sheet === sheets.length - 1, action: () => (m.moveSheet(sheet, sheet + 1), this.host.select(sheet + 1), this.host.changed()) },
      "separator",
      { label: "Hide", icon: "eyeOff", disabled: visible <= 1, action: () => (m.hideSheet(sheet), this.host.select(sheets.findIndex((s, i) => i !== sheet && s.state === "visible")), this.host.changed()) },
      ...hidden.map(({ s, i }) => ({ label: `Unhide “${s.name}”`, icon: "eye" as const, action: () => (m.unhideSheet(i), this.host.select(i), this.host.changed()) })),
      "separator",
      {
        label: "Delete", icon: "trash", danger: true, disabled: visible <= 1,
        action: () => void this.host.confirm(`Delete “${sheets[sheet].name}”?`, "The sheet and everything on it go. Undo brings it back.", "Delete").then((yes) => {
          if (!yes) return;
          m.deleteSheet(sheet);
          this.host.select(Math.max(0, sheet - 1));
          this.host.changed();
        }),
      },
    ]);
  }
}
