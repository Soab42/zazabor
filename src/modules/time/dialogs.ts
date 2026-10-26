import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { ACTIVITY_KINDS, errorText, timeApi, type ActivityKind, type Entry, type Session, type Task, type TaskKind } from "./api";
import { confirmDialog, field, openDialog, textArea, type Dialog } from "./dialog";
import { HOUR, KIND_CATEGORY, KIND_ICON, KIND_LABEL, timeOfDay } from "./model";
import { DateTimeField, popover, TaskPicker, type Popover } from "./pickers";

/** What the dialogs need from the section. */
export interface TimeHost {
  tasks(): Task[];
  /** The open check-in. */
  session(): Session | null;
  toast(text: string): void;
  /** A change went through; refetch now rather than waiting for the event. */
  changed(): void;
}

/** Runs a request with the dialog's buttons off; a refusal shows in the dialog. */
async function attempt<T>(dialog: Dialog, run: () => Promise<T>): Promise<T | null> {
  dialog.busy(true);
  dialog.error("");
  try {
    return await run();
  } catch (err) {
    dialog.error(errorText(err));
    return null;
  } finally {
    dialog.busy(false);
  }
}

function footer(dialog: () => Dialog, primary: HTMLButtonElement, extra: Node | null = null): (Node | null)[] {
  return [extra, h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => dialog().close() }, "Cancel"), primary];
}

/** Checks that `start..end` is a span in the past; the backend checks overlaps. */
function spanProblem(start: number | null, end: number | null): string | null {
  if (start == null || end == null) return "Pick a start and an end.";
  if (end <= start) return "The end must be after the start.";
  if (end > Date.now() + 60_000) return "The end can't be later than now.";
  return null;
}

// ---- check in

/** Asks to check in first; resolves true once checked in. */
export async function ensureCheckedIn(host: TimeHost, what: string): Promise<boolean> {
  if (host.session()) return true;
  const yes = await confirmDialog({
    title: "Check in first",
    text: `Time is tracked inside a check-in. Check in now to ${what}.`,
    confirm: "Check In",
    icon: "logIn",
    tone: "work",
  });
  if (!yes) return false;
  try {
    await timeApi.checkIn();
    host.toast("Checked in");
    host.changed();
    return true;
  } catch (err) {
    host.toast(errorText(err));
    return false;
  }
}

/** Check In at… / Check Out at…: for a forgotten check-in or check-out earlier today. */
export function checkTimeDialog(host: TimeHost, mode: "in" | "out") {
  const session = host.session();
  const at = new DateTimeField({ value: Date.now(), placeholder: "Pick a time", label: mode === "in" ? "Check-in time" : "Check-out time", host: () => dialog.overlay });
  const go = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, mode === "in" ? "Check In" : "Check Out");
  const dialog = openDialog({
    title: mode === "in" ? "Check in at…" : "Check out at…",
    subtitle: mode === "in" ? "For a day that started before you checked in." : `Checked in at ${session ? timeOfDay(session.start) : "—"}. Whatever runs stops then.`,
    icon: mode === "in" ? "logIn" : "logOut",
    tone: mode === "in" ? "work" : "idle",
    body: [field("Time", at.el)],
    foot: footer(() => dialog, go),
    submit: () => void submit(),
  });
  async function submit() {
    const when = at.get() ?? Date.now();
    const done = await attempt(dialog, () => (mode === "in" ? timeApi.checkIn(when) : timeApi.checkOut(when)));
    if (!done) return;
    host.toast(mode === "in" ? `Checked in at ${timeOfDay(when)}` : `Checked out at ${timeOfDay(when)}`);
    host.changed();
    dialog.close();
  }
}

// ---- start a task timer

export function startTimerDialog(host: TimeHost) {
  let kind: TaskKind = "development";
  let custom = false;
  const kinds: [TaskKind, string, "briefcase" | "calendar"][] = [["development", "Development", "briefcase"], ["meeting", "Meeting", "calendar"]];
  const kindButtons = kinds.map(([id, label, glyph]) => h("button", { type: "button", "aria-pressed": "false", onclick: () => setKind(id) }, icon(glyph, 14), label));
  const kindRow = h("div", { class: "segmented tt-kind" }, ...kindButtons);
  const hint = h("span", { class: "tt-hint" });
  const picker = new TaskPicker({ tasks: host.tasks, kind: () => kind, value: null, host: () => dialog.overlay, onChange: () => update() });
  const note = textArea({ "aria-label": "Note" });
  const startAt = new DateTimeField({ value: Date.now(), placeholder: "Pick start time", label: "Start time", host: () => dialog.overlay });
  const customField = field("Start time", startAt.el, { class: "tt-custom-start" });
  const customLink = h("button", { class: "tt-link", type: "button", onclick: () => ((custom = !custom), update()) });
  const start = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, icon("play", 13), "Start");

  const dialog = openDialog({
    title: "Start Task Timer",
    subtitle: "Select a task to begin tracking",
    icon: "stopwatch",
    tone: "work",
    body: [field("Type", kindRow), field("Task", picker.el, { note: hint }), field("Note", note, { optional: true }), customLink, customField],
    foot: footer(() => dialog, start),
    submit: () => void submit(),
  });

  function setKind(next: TaskKind) {
    kind = next;
    picker.refresh();
    update();
  }

  function update() {
    kindButtons.forEach((b, i) => {
      const on = kinds[i][0] === kind;
      b.classList.toggle("active", on);
      b.classList.toggle("tone-meeting", on && kind === "meeting");
      b.setAttribute("aria-pressed", String(on));
    });
    note.placeholder = kind === "meeting" ? "Meeting agenda or notes…" : "What will you work on?";
    const any = host.tasks().some((t) => t.kind === kind && !t.done);
    hint.textContent = kind === "meeting" && !any ? "(no in-progress meeting tasks)" : "";
    customLink.replaceChildren(icon("clock", 13), custom ? "Starting at a custom time" : "Start at a custom time instead of now");
    customLink.classList.toggle("on", custom);
    customField.hidden = !custom;
    start.disabled = !picker.get();
  }
  update();
  // The task list opens first: picking the task is the point of the dialog.
  requestAnimationFrame(() => picker.el.focus());

  async function submit() {
    const task = picker.get();
    if (!task) return dialog.error("Pick a task.");
    let at: number | undefined;
    if (custom) {
      at = startAt.get() ?? Date.now();
      const session = host.session();
      if (at > Date.now() + 60_000) return dialog.error("The start can't be later than now.");
      if (session && at < session.start) return dialog.error(`The start can't be before you checked in (${timeOfDay(session.start)}).`);
    }
    const entry = await attempt(dialog, () => timeApi.start(task.id, note.value, at));
    if (!entry) return;
    host.toast(`Timer started: ${task.title}`);
    host.changed();
    dialog.close();
  }
}

// ---- other activity

export function otherActivityDialog(host: TimeHost) {
  const text = textArea({ placeholder: "e.g. Client sync, doctor's appointment…", "aria-label": "Description", "data-autofocus": "", "data-enter-submits": "", rows: 2 });
  const start = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, icon("play", 13), "Start");
  const dialog = openDialog({
    title: "Start other activity",
    subtitle: "Give this activity a short label, then start tracking.",
    icon: "more",
    tone: "others",
    body: [field("Description (what was it?)", text)],
    foot: footer(() => dialog, start),
    submit: () => void submit(),
  });
  const update = () => (start.disabled = !text.value.trim());
  text.addEventListener("input", update);
  update();
  async function submit() {
    if (!text.value.trim()) return dialog.error("Say what the activity is.");
    const entry = await attempt(dialog, () => timeApi.begin("other", text.value));
    if (!entry) return;
    host.toast(`Started: ${entry.text}`);
    host.changed();
    dialog.close();
  }
}

// ---- activity type menu

/** A button that opens the activity types, with ✓ on the one picked. */
class KindSelect {
  readonly el: HTMLButtonElement;
  private pop: Popover | null = null;

  constructor(private value: ActivityKind, private readonly host: () => HTMLElement) {
    this.el = h("button", { class: "tt-select", type: "button", "aria-haspopup": "listbox", onclick: () => this.toggle() });
    this.render();
  }

  get(): ActivityKind {
    return this.value;
  }

  private render() {
    this.el.replaceChildren(h("span", { class: `tt-kind-icon tone-${KIND_CATEGORY[this.value]}` }, icon(KIND_ICON[this.value], 14)), h("span", null, KIND_LABEL[this.value]), icon("chevronDown", 13));
  }

  private toggle() {
    if (this.pop) return this.pop.close();
    const list = h("div", { class: "tt-options tt-kind-options", role: "listbox" }, ...ACTIVITY_KINDS.map((kind) =>
      h("button", {
        class: `tt-option${kind === this.value ? " selected" : ""}`, type: "button", role: "option", "aria-selected": String(kind === this.value),
        onclick: () => {
          this.value = kind;
          this.render();
          this.pop?.close();
          this.el.focus();
        },
      },
      h("span", { class: `tt-kind-icon tone-${KIND_CATEGORY[kind]}` }, icon(KIND_ICON[kind], 14)),
      h("span", { class: "tt-option-text" }, KIND_LABEL[kind]),
      kind === this.value ? icon("check", 14) : null)));
    list.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = [...list.querySelectorAll<HTMLElement>(".tt-option")];
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    });
    this.pop = popover(this.el, list, this.host(), () => (this.pop = null), true);
    requestAnimationFrame(() => list.querySelector<HTMLElement>(".selected")?.focus());
  }
}

// ---- log past

export function logPastWorkDialog(host: TimeHost) {
  const picker = new TaskPicker({ tasks: host.tasks, kind: () => null, value: null, host: () => dialog.overlay, onChange: () => update() });
  const now = Date.now();
  const start = new DateTimeField({ value: now - HOUR, placeholder: "Pick start time", label: "Start", host: () => dialog.overlay });
  const end = new DateTimeField({ value: now, placeholder: "Pick end time", label: "End", host: () => dialog.overlay });
  const note = textArea({ placeholder: "What was worked on?", "aria-label": "Note" });
  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, "Log session");
  const dialog = openDialog({
    title: "Log past session",
    subtitle: "Record a work session that already happened.",
    icon: "briefcase",
    tone: "work",
    body: [field("Task", picker.el), h("div", { class: "tt-pair" }, field("Start", start.el), field("End", end.el)), field("Note", note, { optional: true })],
    foot: footer(() => dialog, save),
    submit: () => void submit(),
  });
  const update = () => (save.disabled = !picker.get());
  update();
  requestAnimationFrame(() => picker.el.focus());
  async function submit() {
    const task = picker.get();
    if (!task) return dialog.error("Pick a task.");
    const problem = spanProblem(start.get(), end.get());
    if (problem) return dialog.error(problem);
    const entry = await attempt(dialog, () => timeApi.add({ kind: "work", task: task.id, text: note.value, start: start.get()!, end: end.get()! }));
    if (!entry) return;
    host.toast(`Logged a session on ${task.title}`);
    host.changed();
    dialog.close();
  }
}

export function logPastActivityDialog(host: TimeHost) {
  const kind = new KindSelect("short_break", () => dialog.overlay);
  const text = textArea({ placeholder: "What was it?", "aria-label": "Description", rows: 2 });
  const now = Date.now();
  const start = new DateTimeField({ value: now - HOUR, placeholder: "Pick start time", label: "Start", host: () => dialog.overlay });
  const end = new DateTimeField({ value: now, placeholder: "Pick end time", label: "End", host: () => dialog.overlay });
  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, "Log activity");
  const dialog = openDialog({
    title: "Log past activity",
    subtitle: "Record an activity that already happened.",
    icon: "coffee",
    tone: "break",
    body: [field("Type", kind.el), field("Description", text, { optional: true }), h("div", { class: "tt-pair" }, field("Start", start.el), field("End", end.el))],
    foot: footer(() => dialog, save),
    submit: () => void submit(),
  });
  async function submit() {
    const problem = spanProblem(start.get(), end.get());
    if (problem) return dialog.error(problem);
    const entry = await attempt(dialog, () => timeApi.add({ kind: kind.get(), task: null, text: text.value, start: start.get()!, end: end.get()! }));
    if (!entry) return;
    host.toast(`Logged ${KIND_LABEL[entry.kind].toLowerCase()}`);
    host.changed();
    dialog.close();
  }
}

// ---- edit

/** Edit activity (or a work log: its task and note instead of type and description); Delete asks first. */
export function editDialog(host: TimeHost, entry: Entry) {
  const work = entry.kind === "work";
  const picker = work ? new TaskPicker({ tasks: host.tasks, kind: () => null, value: entry.task, host: () => dialog.overlay }) : null;
  const kind = work ? null : new KindSelect(entry.kind as ActivityKind, () => dialog.overlay);
  const text = textArea({ placeholder: work ? "What was worked on?" : "What was it?", "aria-label": work ? "Note" : "Description", rows: 2 });
  text.value = entry.text;
  const start = new DateTimeField({ value: entry.start, placeholder: "Pick start time", label: "Start", host: () => dialog.overlay });
  const end = new DateTimeField({ value: entry.end, placeholder: "Still running", label: "End", clearable: true, host: () => dialog.overlay });
  const save = h("button", { class: "btn primary", type: "button", onclick: () => void submit() }, "Save");
  const remove = h("button", { class: "btn tt-danger", type: "button", onclick: () => void del() }, icon("trash", 14), "Delete");
  const dialog = openDialog({
    title: work ? "Edit work session" : "Edit activity",
    subtitle: work ? "Adjust the task, note, or times for this session." : "Adjust the type, label, or times for this activity.",
    icon: "pencil",
    tone: KIND_CATEGORY[entry.kind],
    body: [
      work ? field("Task", picker!.el) : field("Type", kind!.el),
      field(work ? "Note" : "Description", text, { optional: true }),
      h("div", { class: "tt-pair" }, field("Start", start.el), field("End", end.el, { optional: true })),
      h("p", { class: "tt-hint tt-end-hint" }, "Clear the end to keep it running."),
    ],
    foot: footer(() => dialog, save, remove),
    submit: () => void submit(),
  });

  async function submit() {
    const from = start.get();
    const to = end.get();
    if (from == null) return dialog.error("Pick a start.");
    if (to != null) {
      const problem = spanProblem(from, to);
      if (problem) return dialog.error(problem);
    }
    const task = picker?.get() ?? null;
    if (work && !task) return dialog.error("Pick a task.");
    const saved = await attempt(dialog, () => timeApi.edit(entry.id, { kind: work ? "work" : kind!.get(), task: task?.id ?? null, text: text.value, start: from, end: to }));
    if (!saved) return;
    host.toast("Saved");
    host.changed();
    dialog.close();
  }

  async function del() {
    const yes = await confirmDialog({ title: "Delete this entry?", text: "It's removed from your time for good.", confirm: "Delete", danger: true, icon: "trash", tone: "idle" });
    if (!yes) return;
    const done = await attempt(dialog, () => timeApi.remove(entry.id).then(() => true));
    if (!done) return;
    host.toast("Deleted");
    host.changed();
    dialog.close();
  }
}
