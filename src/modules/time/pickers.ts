import { clamp, h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { errorText, timeApi, type Task, type TaskKind } from "./api";
import { textInput } from "./dialog";
import { dateTime, startOfDay } from "./model";

// ---- popover

export interface Popover {
  readonly el: HTMLElement;
  close(): void;
}

let openPopover: Popover | null = null;

/**
 * A glass panel under `anchor` (above it when there's no room below), added to `host`: a
 * dialog's overlay, so it stays inside the dialog's focus loop, or the page. Esc and a click
 * outside close it. `matchWidth` makes it as wide as the anchor (a list under a field).
 */
export function popover(anchor: HTMLElement, content: HTMLElement, host: HTMLElement, onClose?: () => void, matchWidth = false): Popover {
  openPopover?.close();
  const el = h("div", { class: "tt-popover glass-strong", role: "dialog" }, content);
  host.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    // A list under a field is as wide as the field; a calendar keeps its own size.
    if (matchWidth) el.style.width = `${Math.max(r.width, 320)}px`;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const below = innerHeight - r.bottom - 8;
    const top = below >= height || r.top < height ? r.bottom + 6 : r.top - height - 6;
    el.style.left = `${clamp(r.left, 8, innerWidth - width - 8)}px`;
    el.style.top = `${clamp(top, 8, Math.max(8, innerHeight - height - 8))}px`;
  };
  place();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      pop.close();
      anchor.focus({ preventScroll: true });
    }
  };
  const onPointer = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) pop.close();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("resize", place);
  const resize = new ResizeObserver(place);
  resize.observe(el);
  const pop: Popover = {
    el,
    close() {
      if (!el.isConnected) return;
      el.remove();
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("resize", place);
      resize.disconnect();
      anchor.setAttribute("aria-expanded", "false");
      if (openPopover === pop) openPopover = null;
      onClose?.();
    },
  };
  anchor.setAttribute("aria-expanded", "true");
  openPopover = pop;
  return pop;
}

// ---- date and time

/** The first day of the week where the user lives (0 = Sunday), as far as the system says. */
function weekStart(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;
    if (first) return first % 7;
  } catch {
    // Older engines: Sunday.
  }
  return 0;
}

const uses12h = (() => {
  const options = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions() as Intl.ResolvedDateTimeFormatOptions & { hourCycle?: string };
  return options.hour12 ?? (options.hourCycle === "h12" || options.hourCycle === "h11");
})();

export interface DateTimeOptions {
  value: number | null;
  /** Text while empty ("Pick start time", "Any", "Now"). */
  placeholder: string;
  /** Days only (the From/To filters); the value is that day's midnight. */
  dateOnly?: boolean;
  /** Shows a × that empties the field. */
  clearable?: boolean;
  /** Where the panel goes (a dialog's overlay, or the page). */
  host: () => HTMLElement;
  onChange?: (value: number | null) => void;
  label?: string;
  /** Days after today can be picked too (a bill's next due date). */
  future?: boolean;
}

/**
 * A button that shows "Oct 26, 2026 · 3:33 PM" and opens a month calendar with the time under
 * it. Days after today are off: nothing here happens in the future.
 */
export class DateTimeField {
  readonly el: HTMLElement;
  private button: HTMLButtonElement;
  private clearButton: HTMLButtonElement | null = null;
  private value: number | null;
  private pop: Popover | null = null;

  constructor(private readonly options: DateTimeOptions) {
    this.value = options.value;
    this.button = h("button", { class: "tt-select tt-datetime", type: "button", "aria-haspopup": "dialog", "aria-label": options.label ?? options.placeholder, onclick: () => this.toggle() });
    this.el = h("div", { class: "tt-datetime-wrap" }, this.button);
    if (options.clearable) {
      this.clearButton = h("button", { class: "tt-clear", type: "button", title: "Clear", "aria-label": "Clear", onclick: () => this.set(null) }, icon("close", 12));
      this.el.append(this.clearButton);
    }
    this.render();
  }

  get(): number | null {
    return this.value;
  }

  set(value: number | null, notify = true) {
    this.value = value;
    this.render();
    if (notify) this.options.onChange?.(value);
  }

  private render() {
    const empty = this.value == null;
    const text = empty ? this.options.placeholder : this.options.dateOnly
      ? new Date(this.value!).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
      : dateTime(this.value!);
    this.button.replaceChildren(icon(this.options.dateOnly ? "calendar" : "clock", 15), h("span", { class: empty ? "tt-placeholder" : "" }, text), icon("chevronDown", 13));
    if (this.clearButton) this.clearButton.hidden = empty;
  }

  private toggle() {
    if (this.pop) {
      this.pop.close();
      return;
    }
    this.pop = popover(this.button, this.panel(), this.options.host(), () => (this.pop = null));
  }

  private panel(): HTMLElement {
    const now = Date.now();
    let shown = new Date(this.value ?? now);
    shown.setDate(1);
    const pick = () => new Date(this.value ?? now);
    const title = h("div", { class: "tt-cal-title", "aria-live": "polite" });
    const grid = h("div", { class: "tt-cal-grid", role: "grid" });
    const month = (step: number) => {
      shown = new Date(shown.getFullYear(), shown.getMonth() + step, 1);
      draw();
    };
    const next = h("button", { class: "icon-btn small", type: "button", "aria-label": "Next month", onclick: () => month(1) }, icon("chevronRight", 14));
    const head = h("div", { class: "tt-cal-head" },
      h("button", { class: "icon-btn small", type: "button", "aria-label": "Previous month", onclick: () => month(-1) }, icon("chevronLeft", 14)),
      title, next);
    const first = weekStart();
    const weekdays = h("div", { class: "tt-cal-weekdays" });
    for (let i = 0; i < 7; i++) {
      const day = new Date(2026, 0, 4 + ((first + i) % 7)); // 4 Jan 2026 is a Sunday.
      weekdays.append(h("span", null, day.toLocaleDateString(undefined, { weekday: "narrow" })));
    }

    const choose = (day: Date) => {
      const at = pick();
      const next = new Date(day.getFullYear(), day.getMonth(), day.getDate(), this.options.dateOnly ? 0 : at.getHours(), this.options.dateOnly ? 0 : at.getMinutes());
      this.set(this.options.future ? next.getTime() : Math.min(next.getTime(), this.options.dateOnly ? startOfDay(Date.now()) : Date.now()));
      if (this.options.dateOnly) this.pop?.close();
      else draw();
    };

    const draw = () => {
      title.textContent = shown.toLocaleDateString(undefined, { month: "long", year: "numeric" });
      const today = startOfDay(Date.now());
      next.disabled = !this.options.future && new Date(shown.getFullYear(), shown.getMonth() + 1, 1).getTime() > today;
      const selected = this.value == null ? null : startOfDay(this.value);
      const lead = (shown.getDay() - first + 7) % 7;
      const cells: HTMLElement[] = [];
      for (let i = 0; i < 42; i++) {
        const day = new Date(shown.getFullYear(), shown.getMonth(), 1 - lead + i);
        const ms = day.getTime();
        const cell = h("button", {
          class: `tt-cal-day${day.getMonth() !== shown.getMonth() ? " outside" : ""}${ms === today ? " today" : ""}${ms === selected ? " selected" : ""}`,
          type: "button", role: "gridcell", disabled: !this.options.future && ms > today, "aria-selected": ms === selected ? "true" : "false",
          "aria-label": day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
          onclick: () => choose(day),
        }, String(day.getDate()));
        cells.push(cell);
      }
      grid.replaceChildren(...cells);
    };
    draw();

    const panel = h("div", { class: "tt-cal" }, head, weekdays, grid);
    if (!this.options.dateOnly) panel.append(this.timeRow(pick, draw));
    else if (this.options.clearable) {
      panel.append(h("div", { class: "tt-cal-foot" },
        h("button", { class: "text-btn", type: "button", onclick: () => ((this.set(null)), this.pop?.close()) }, this.options.placeholder),
        h("span", { class: "spacer" }),
        h("button", { class: "text-btn", type: "button", onclick: () => choose(new Date()) }, "Today")));
    }
    requestAnimationFrame(() => panel.querySelector<HTMLElement>(".tt-cal-day.selected, .tt-cal-day.today")?.focus());
    return panel;
  }

  /** Hour and minute fields (with AM/PM where the system uses it), and Now. */
  private timeRow(pick: () => Date, redraw: () => void): HTMLElement {
    const hour = textInput({ class: "tt-input tt-num", inputmode: "numeric", maxlength: 2, "aria-label": "Hour" });
    const minute = textInput({ class: "tt-input tt-num", inputmode: "numeric", maxlength: 2, "aria-label": "Minute" });
    const am = h("button", { type: "button", onclick: () => setHalf(false) }, "AM");
    const pm = h("button", { type: "button", onclick: () => setHalf(true) }, "PM");
    const fill = () => {
      const at = pick();
      const hours = at.getHours();
      hour.value = uses12h ? String(hours % 12 || 12) : String(hours).padStart(2, "0");
      minute.value = String(at.getMinutes()).padStart(2, "0");
      am.classList.toggle("active", hours < 12);
      pm.classList.toggle("active", hours >= 12);
    };
    const apply = (hours: number, minutes: number) => {
      const at = pick();
      at.setHours(hours, minutes, 0, 0);
      this.set(Math.min(at.getTime(), Date.now()));
      fill();
      redraw();
    };
    const fromFields = () => {
      const typedHour = Number.parseInt(hour.value, 10);
      const typedMinute = Number.parseInt(minute.value, 10);
      if (Number.isNaN(typedHour) || Number.isNaN(typedMinute)) return fill();
      const pmNow = pick().getHours() >= 12;
      const hours = uses12h ? (clamp(typedHour, 1, 12) % 12) + (pmNow ? 12 : 0) : clamp(typedHour, 0, 23);
      apply(hours, clamp(typedMinute, 0, 59));
    };
    const setHalf = (afternoon: boolean) => {
      const at = pick();
      apply((at.getHours() % 12) + (afternoon ? 12 : 0), at.getMinutes());
    };
    for (const input of [hour, minute]) {
      input.addEventListener("change", fromFields);
      // A click selects the whole number, so typing replaces it (the mouseup would undo a select on focus).
      input.addEventListener("pointerdown", (e) => {
        if (document.activeElement === input) return;
        e.preventDefault();
        input.focus();
      });
      input.addEventListener("focus", () => input.select());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          fromFields();
          this.pop?.close();
          this.button.focus();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const at = pick();
          const step = e.key === "ArrowUp" ? 1 : -1;
          if (input === hour) apply((at.getHours() + step + 24) % 24, at.getMinutes());
          else apply(at.getHours(), (at.getMinutes() + step + 60) % 60);
        }
      });
    }
    fill();
    return h("div", { class: "tt-cal-time" },
      icon("clock", 14), hour, h("span", { class: "tt-colon" }, ":"), minute,
      uses12h ? h("div", { class: "segmented tt-ampm" }, am, pm) : null,
      h("span", { class: "spacer" }),
      h("button", { class: "text-btn", type: "button", onclick: () => (this.set(Date.now()), fill(), redraw()) }, "Now"),
      h("button", { class: "btn small primary", type: "button", onclick: () => (this.pop?.close(), this.button.focus()) }, "Done"));
  }
}

// ---- tasks

export interface TaskPickerOptions {
  /** The tasks as the section knows them. */
  tasks: () => Task[];
  /** Only tasks of this kind; null for any. */
  kind: () => TaskKind | null;
  value: string | null;
  host: () => HTMLElement;
  onChange?: (task: Task | null) => void;
}

/**
 * A searchable list of the tasks in progress (not done): title, with the project in small muted
 * text. "New task" adds one right here, and a task can be marked done from the list.
 */
export class TaskPicker {
  readonly el: HTMLButtonElement;
  private value: string | null;
  private pop: Popover | null = null;
  /** Tasks added or changed here, before the section hears about them. */
  private local = new Map<string, Task>();

  constructor(private readonly options: TaskPickerOptions) {
    this.value = options.value;
    this.el = h("button", { class: "tt-select tt-task-select", type: "button", "aria-haspopup": "listbox", onclick: () => this.toggle() });
    this.render();
  }

  get(): Task | null {
    return this.all().find((t) => t.id === this.value) ?? null;
  }

  /** Picks again after the kind changed: a task of another kind no longer fits. */
  refresh() {
    const kind = this.options.kind();
    const task = this.get();
    if (task && kind && task.kind !== kind) this.choose(null);
    else this.render();
  }

  private all(): Task[] {
    const merged = new Map(this.options.tasks().map((t) => [t.id, t]));
    for (const [id, t] of this.local) merged.set(id, t);
    return [...merged.values()];
  }

  private choose(task: Task | null) {
    this.value = task?.id ?? null;
    this.render();
    this.options.onChange?.(task);
  }

  private render() {
    const task = this.get();
    this.el.replaceChildren(
      task
        ? h("span", { class: "tt-task-name" }, h("span", { class: "tt-task-title" }, task.title), task.project ? h("span", { class: "tt-task-project" }, task.project) : null)
        : h("span", { class: "tt-placeholder" }, "Select a task"),
      icon("chevronDown", 13));
    this.el.title = task ? `${task.title}${task.project ? ` — ${task.project}` : ""}` : "";
  }

  private toggle() {
    if (this.pop) {
      this.pop.close();
      return;
    }
    this.pop = popover(this.el, this.panel(), this.options.host(), () => (this.pop = null), true);
  }

  private panel(): HTMLElement {
    const kind = this.options.kind();
    const search = h("input", { class: "search-input", type: "search", placeholder: "Search tasks", "aria-label": "Search tasks", spellcheck: "false" });
    const list = h("div", { class: "tt-options", role: "listbox" });
    const panel = h("div", { class: "tt-task-panel" });
    let showDone = false;
    let active = 0;

    const options = () => [...list.querySelectorAll<HTMLElement>(".tt-option")];
    const highlight = (index: number) => {
      const items = options();
      active = clamp(index, 0, items.length - 1);
      items.forEach((item, i) => item.classList.toggle("active", i === active));
      items[active]?.scrollIntoView({ block: "nearest" });
    };

    const draw = () => {
      const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const ofKind = this.all().filter((t) => !kind || t.kind === kind);
      const shown = ofKind
        .filter((t) => showDone || !t.done)
        .filter((t) => terms.every((term) => `${t.title} ${t.project}`.toLowerCase().includes(term)))
        .sort((a, b) => Number(a.done) - Number(b.done) || b.created - a.created);
      const rows = shown.map((task) => {
        const done = h("button", {
          class: "icon-btn small tt-option-action", type: "button",
          title: task.done ? "Back to in progress" : "Mark as done", "aria-label": task.done ? "Back to in progress" : "Mark as done",
          onclick: (e: Event) => {
            e.stopPropagation();
            void timeApi.editTask(task.id, { done: !task.done }).then((t) => (this.local.set(t.id, t), draw()), () => undefined);
          },
        }, icon(task.done ? "undo" : "checkSquare", 14));
        const row = h("div", {
          class: `tt-option${task.id === this.value ? " selected" : ""}${task.done ? " done" : ""}`, role: "option",
          "aria-selected": task.id === this.value ? "true" : "false",
          onclick: () => (this.choose(task), this.pop?.close(), this.el.focus()),
        },
        h("span", { class: "tt-option-text" }, h("span", { class: "tt-task-title" }, task.title), task.project ? h("span", { class: "tt-task-project" }, task.project) : null),
        task.id === this.value ? icon("check", 14) : null, done);
        return row;
      });
      const empty = kind === "meeting" ? "No tasks available" : "No in-progress tasks";
      list.replaceChildren(...(rows.length ? rows : [h("div", { class: "tt-options-empty" }, terms.length ? "No tasks match" : empty)]));
      const doneCount = ofKind.filter((t) => t.done).length;
      doneToggle.hidden = !doneCount;
      doneToggle.textContent = showDone ? "Hide done tasks" : `Show done tasks (${doneCount})`;
      addButton.replaceChildren(icon("plus", 14), search.value.trim() ? `New task “${search.value.trim()}”` : "New task");
      highlight(Math.min(active, rows.length - 1));
    };

    const doneToggle = h("button", { class: "text-btn", type: "button", onclick: () => ((showDone = !showDone), draw()) });
    const addButton = h("button", { class: "text-btn tt-add-task", type: "button", onclick: () => showForm() });
    const foot = h("div", { class: "tt-task-foot" }, addButton, h("span", { class: "spacer" }), doneToggle);

    const showForm = () => {
      const title = textInput({ placeholder: "Task name", "aria-label": "Task name", value: search.value.trim() });
      const projects = [...new Set(this.all().map((t) => t.project).filter(Boolean))].sort();
      const listId = `tt-projects-${Math.random().toString(36).slice(2)}`;
      const project = textInput({ placeholder: "Project (optional)", "aria-label": "Project", list: listId });
      const datalist = h("datalist", { id: listId }, ...projects.map((p) => h("option", { value: p })));
      const problem = h("p", { class: "tt-error" });
      const kindOf: TaskKind = kind ?? "development";
      const add = async () => {
        try {
          const task = await timeApi.addTask(title.value, project.value, kindOf);
          this.local.set(task.id, task);
          this.choose(task);
          this.pop?.close();
          this.el.focus();
        } catch (err) {
          problem.textContent = errorText(err);
        }
      };
      const form = h("div", { class: "tt-task-form" },
        h("div", { class: "tt-task-form-title" }, kindOf === "meeting" ? "New meeting task" : "New task"),
        title, project, datalist, problem,
        h("div", { class: "tt-task-form-foot" },
          h("span", { class: "spacer" }),
          h("button", { class: "btn small", type: "button", onclick: () => (panel.replaceChildren(searchRow, list, foot), search.focus()) }, "Back"),
          h("button", { class: "btn small primary", type: "button", onclick: () => void add() }, "Add Task")));
      form.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          void add();
        }
      });
      panel.replaceChildren(form);
      title.focus();
    };

    search.addEventListener("input", () => ((active = 0), draw()));
    search.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        highlight(active + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const item = options()[active];
        if (item) item.click();
        else showForm();
      }
    });
    const searchRow = h("label", { class: "search tt-task-search" }, icon("search", 14), search);
    panel.append(searchRow, list, foot);
    draw();
    requestAnimationFrame(() => search.focus());
    return panel;
  }
}
