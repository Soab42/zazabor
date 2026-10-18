import { clear, h } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import type { JobEvent, JobKind } from "../ops-api";
import { kindTitle, progressDetail, progressOf } from "./format";

const KIND_ICON: Record<JobKind, IconName> = { copy: "copy", move: "folder", trash: "trash", delete: "trash", compress: "fileArchive", extract: "fileArchive" };
/** A job only appears in the panel once it has run this long (or needs attention). */
const REVEAL_MS = 250;
/** How long a finished job lingers before it fades out. */
const LINGER_MS = 2200;

interface Row {
  id: number;
  title: string;
  event: JobEvent;
  started: number;
  el: HTMLElement;
  /** Shown in the panel; quick jobs finish before this and never appear. */
  revealed: boolean;
  fade?: number;
}

/**
 * The jobs panel: a glass card docked at the bottom-right of the Files area, one row per running
 * operation (icon, title, progress bar, bytes / speed / time left, cancel). It collapses to a
 * small pill, lets finished jobs fade away and keeps failures until dismissed.
 */
export class JobsPanel {
  readonly el = h("section", { class: "ops-jobs", hidden: true, "aria-label": "File operations" });
  private rows = new Map<number, Row>();
  private titles = new Map<number, string>();
  private collapsed = false;
  private readonly list = h("div", { class: "ops-jobs-list" });
  private readonly head = h("div", { class: "ops-jobs-head" });
  private timer: number | undefined;

  constructor(private readonly cancel: (id: number) => void) {
    this.el.append(this.head, this.list);
  }

  /** The readable name of a job ("Copying 12 items to Pictures"). */
  setTitle(id: number, title: string) {
    this.titles.set(id, title);
    const row = this.rows.get(id);
    if (row) {
      row.title = title;
      this.paint(row);
    }
  }

  /** Feeds one `fs-job` event. */
  update(event: JobEvent) {
    let row = this.rows.get(event.id);
    if (!row) {
      row = {
        id: event.id, title: this.titles.get(event.id) ?? kindTitle(event.kind), event, started: Date.now(),
        el: h("div", { class: "ops-job" }), revealed: false,
      };
      row.el.hidden = true;
      this.rows.set(event.id, row);
      this.list.append(row.el);
      this.timer ??= window.setInterval(() => this.tickAll(), 1000);
      const created = row;
      window.setTimeout(() => this.reveal(created), REVEAL_MS);
    }
    row.event = event;
    const quick = !row.revealed && (event.state === "done" || event.state === "cancelled");
    if (quick) return this.remove(event.id);
    if (event.state === "failed" || event.state === "waiting") this.reveal(row);
    this.paint(row);
    this.afterChange();
    if (event.state === "done" || event.state === "cancelled") this.fadeLater(row, event.state === "done" ? LINGER_MS : 400);
  }

  private reveal(row: Row) {
    if (row.revealed || this.rows.get(row.id) !== row) return;
    row.revealed = true;
    row.el.hidden = false;
    this.afterChange();
  }

  private fadeLater(row: Row, ms: number) {
    window.clearTimeout(row.fade);
    row.fade = window.setTimeout(() => {
      row.el.classList.add("leaving");
      window.setTimeout(() => this.remove(row.id), 220);
    }, ms);
  }

  private remove(id: number) {
    const row = this.rows.get(id);
    if (!row) return;
    window.clearTimeout(row.fade);
    row.el.remove();
    this.rows.delete(id);
    this.titles.delete(id);
    this.afterChange();
  }

  private tickAll() {
    for (const row of this.rows.values()) if (row.event.state === "running") this.paint(row);
  }

  private active() {
    return [...this.rows.values()].filter((r) => r.event.state === "running" || r.event.state === "waiting");
  }

  private afterChange() {
    this.el.hidden = ![...this.rows.values()].some((r) => r.revealed);
    if (this.rows.size === 0 && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.el.classList.toggle("collapsed", this.collapsed);
    this.paintHead();
  }

  private paintHead() {
    clear(this.head);
    const active = this.active().filter((r) => r.revealed);
    const failed = [...this.rows.values()].filter((r) => r.event.state === "failed").length;
    let summary: string;
    if (active.length) {
      const total = active.reduce((s, r) => s + progressOf(r.event), 0) / active.length;
      summary = active.length === 1 ? `${active[0].title}  ·  ${Math.round(total * 100)}%` : `${active.length} operations  ·  ${Math.round(total * 100)}%`;
    } else {
      summary = failed ? "Something went wrong" : "Finished";
    }
    const toggle = h("button", {
      class: "ops-jobs-toggle", type: "button", "aria-expanded": String(!this.collapsed),
      title: this.collapsed ? "Show file operations" : "Hide details",
      onclick: () => {
        this.collapsed = !this.collapsed;
        this.afterChange();
      },
    }, active.length ? h("span", { class: "spinner ops-spin" }) : icon(failed ? "info" : "check", 14),
    h("span", { class: "ops-jobs-summary" }, summary),
    h("span", { class: "ops-jobs-chevron" }, icon(this.collapsed ? "chevronLeft" : "chevronRight", 12)));
    this.head.append(toggle);
  }

  private paint(row: Row) {
    const { event } = row;
    const failed = event.state === "failed";
    row.el.className = `ops-job ${event.state}${row.el.classList.contains("leaving") ? " leaving" : ""}`;
    const fraction = event.state === "done" ? 1 : progressOf(event);
    let detail: string;
    if (failed) detail = event.error ?? "The operation failed.";
    else if (event.state === "waiting") detail = "Waiting for your answer…";
    else if (event.state === "done") detail = "Done";
    else if (event.state === "cancelled") detail = "Cancelled";
    else detail = progressDetail(event, row.started);

    const bar = h("div", { class: "ops-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(fraction * 100)) },
      h("span", { style: { transform: `scaleX(${fraction})` } }));
    const stop = failed || event.state === "done" || event.state === "cancelled"
      ? h("button", { class: "icon-btn small", type: "button", title: "Dismiss", "aria-label": "Dismiss", onclick: () => this.remove(row.id) }, icon("close", 13))
      : h("button", { class: "icon-btn small", type: "button", title: "Cancel", "aria-label": "Cancel", onclick: () => this.cancel(row.id) }, icon("close", 13));
    clear(row.el);
    row.el.append(
      h("div", { class: "ops-job-icon" }, icon(failed ? "info" : KIND_ICON[event.kind], 16)),
      h("div", { class: "ops-job-main" },
        h("div", { class: "ops-job-title", title: row.title }, row.title),
        failed ? null : bar,
        h("div", { class: "ops-job-detail", title: detail }, detail)),
      stop);
  }

  dispose() {
    if (this.timer !== undefined) clearInterval(this.timer);
    for (const row of this.rows.values()) window.clearTimeout(row.fade);
    this.el.remove();
  }
}
