import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { errorText, timeApi, type Report, type Task } from "./api";
import { confirmDialog, openDialog, textArea } from "./dialog";
import type { TimeHost } from "./dialogs";
import { dayFromKey, dayKey, endOfDay, hm, longDay, minutes, reportText, startOfDay, summarize, timeOfDay, type DaySummary } from "./model";

/**
 * The daily report: generated from the day's entries, edited here, then saved as a draft or
 * submitted. One per day; opening it again brings back what was saved. ‹ › steps through days.
 */
export function reportDialog(host: TimeHost, day = Date.now()) {
  let date = dayKey(day);
  let saved: Report | null = null;
  let summary: DaySummary | null = null;
  /** The text as last generated, to tell whether the user changed it. */
  let generated = "";
  let editing = false;
  let tasks = new Map<string, Task>();
  let entries: Awaited<ReturnType<typeof timeApi.data>>["entries"] = [];

  const dayLabel = h("span", { class: "tt-report-day" });
  const prev = h("button", { class: "icon-btn small", type: "button", title: "Previous day", "aria-label": "Previous day", onclick: () => void load(dayFromKey(date) - 12 * 3_600_000) }, icon("chevronLeft", 14));
  const next = h("button", { class: "icon-btn small", type: "button", title: "Next day", "aria-label": "Next day", onclick: () => void load(endOfDay(dayFromKey(date)) + 12 * 3_600_000) }, icon("chevronRight", 14));
  const loading = h("div", { class: "tt-report-loading", "aria-live": "polite" }, h("span", { class: "spinner large" }), h("p", null, "Generating your report…"));
  const times = h("div", { class: "tt-report-times" });
  const stats = h("div", { class: "tt-report-stats" });
  const text = textArea({ class: "tt-input tt-textarea tt-report-text", rows: 9, "aria-label": "Report", spellcheck: "true" });
  const regenerate = h("button", { class: "tt-link", type: "button", onclick: () => void rebuild() }, icon("refresh", 13), "Regenerate");
  const content = h("div", { class: "tt-report-content" },
    times, stats,
    h("div", { class: "tt-label-row" }, h("span", { class: "tt-label" }, "Report"), regenerate),
    text);
  const state = h("span", { class: "tt-report-state" });
  const copy = h("button", { class: "btn ghost", type: "button", title: "Copy the report", onclick: () => void copyText() }, icon("copy", 14), "Copy");
  const draft = h("button", { class: "btn", type: "button", onclick: () => void save("draft") }, "Save as Draft");
  const submit = h("button", { class: "btn primary", type: "button", onclick: () => void save("submitted") }, "Submit Report");
  const reopen = h("button", { class: "btn", type: "button", onclick: () => ((editing = true), draw()) }, icon("pencil", 14), "Edit Again");

  const dialog = openDialog({
    title: "Daily Report",
    subtitle: "Review, edit, then save a draft or submit",
    icon: "document",
    tone: "total",
    class: "tt-report",
    body: [h("div", { class: "tt-report-nav" }, prev, dayLabel, next), loading, content],
    foot: [state, h("span", { class: "spacer" }), copy, reopen, draft, submit],
  });

  async function load(at: number) {
    date = dayKey(at);
    const from = startOfDay(at);
    dayLabel.textContent = date === dayKey(Date.now()) ? `Today · ${longDay(from)}` : longDay(from);
    next.disabled = date === dayKey(Date.now());
    loading.hidden = false;
    content.hidden = true;
    dialog.error("");
    try {
      const [data, report] = await Promise.all([timeApi.data(from, endOfDay(from)), timeApi.report(date)]);
      if (date !== dayKey(at)) return;
      tasks = new Map(data.tasks.map((t) => [t.id, t]));
      entries = data.entries;
      summary = summarize(data.sessions, data.entries, from, data.now);
      generated = reportText(summary, entries, tasks, from, data.now);
      saved = report;
      editing = !report || report.status === "draft";
      text.value = report?.content ?? generated;
    } catch (err) {
      dialog.error(errorText(err));
    }
    // A short beat on the spinner reads as "made for you", not a flash.
    await new Promise((resolve) => setTimeout(resolve, 250));
    loading.hidden = true;
    content.hidden = false;
    draw();
    if (editing) text.focus();
  }

  function draw() {
    if (!summary) return;
    times.replaceChildren(
      h("span", null, icon("logIn", 14), "Checked in ", h("strong", null, summary.checkedIn != null ? timeOfDay(summary.checkedIn) : "—")),
      h("span", { class: "tt-dot-sep" }, "·"),
      h("span", null, icon("logOut", 14), "Checked out ", h("strong", null, summary.checkedOut != null ? timeOfDay(summary.checkedOut) : "—")));
    const stat = (label: string, ms: number, tone: string) => h("div", { class: `tt-report-stat tone-${tone}` }, h("span", { class: "tt-stat-label" }, label), h("span", { class: "tt-report-value" }, hm(ms)));
    stats.replaceChildren(stat("Worked", summary.totals.work, "work"), stat("Break", summary.breaks, "break"), stat("Idle", summary.totals.idle, "idle"));
    const submitted = saved?.status === "submitted" && !editing;
    text.readOnly = submitted;
    text.classList.toggle("readonly", submitted);
    regenerate.hidden = submitted;
    reopen.hidden = !submitted;
    draft.hidden = submitted;
    submit.hidden = submitted;
    submit.textContent = saved?.status === "submitted" ? "Resubmit" : "Submit Report";
    state.replaceChildren(...(saved
      ? [h("span", { class: `tt-report-pill ${saved.status}` }, saved.status === "submitted" ? "Submitted" : "Draft"),
        saved.status === "submitted" && saved.submitted ? `at ${timeOfDay(saved.submitted)}` : `saved ${timeOfDay(saved.updated)}`]
      : [h("span", { class: "tt-report-pill" }, "Not saved")]));
  }

  async function rebuild() {
    if (text.value.trim() !== generated.trim() && text.value.trim()) {
      const yes = await confirmDialog({ title: "Replace your edits?", text: "Regenerating rebuilds the report from today's entries.", confirm: "Regenerate" });
      if (!yes) return;
    }
    await load(dayFromKey(date));
    text.value = generated;
  }

  async function save(status: Report["status"]) {
    if (!summary) return;
    if (!text.value.trim()) return dialog.error("The report is empty.");
    dialog.busy(true);
    try {
      saved = await timeApi.saveReport({
        date, content: text.value.trim(), status,
        workedMin: minutes(summary.totals.work), breakMin: minutes(summary.breaks), idleMin: minutes(summary.totals.idle),
        updated: 0, submitted: null,
      });
      editing = status === "draft";
      host.toast(status === "submitted" ? "Report submitted" : "Draft saved");
      dialog.error("");
      draw();
    } catch (err) {
      dialog.error(errorText(err));
    } finally {
      dialog.busy(false);
    }
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text.value);
      host.toast("Report copied");
    } catch {
      host.toast("Could not copy the report");
    }
  }

  void load(day);
}
