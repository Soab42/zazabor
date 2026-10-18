import { previewThumb } from "../../../shared/quicklook/bodies";
import { formatBytes, formatDateTime, h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import type { FsEntry } from "../api";
import { infoApi, TAG_COLORS, watchFolderSize, type FsInfo } from "../info-api";
import { kindLabel } from "../kinds";
import { loadTags, tagDot, toggleTag } from "./tags";

interface Row {
  el: HTMLElement;
  value: HTMLElement;
}

/** A labelled row of a section. */
function row(label: string, value: Node | string, extra?: Node): Row {
  const cell = h("div", { class: "gi-value" }, value);
  return { el: h("div", { class: "gi-row" }, h("div", { class: "gi-label" }, label), cell, extra), value: cell };
}

const section = (title: string, ...rows: Node[]) =>
  h("section", { class: "gi-section" }, h("h3", { class: "gi-title" }, title), h("div", { class: "card gi-card" }, ...rows));

/**
 * The Get Info inspector: a glass sheet at the right side of its host with a preview, general
 * facts (folders measure their size live), colour tags and permissions for one item.
 */
export class InfoPanel {
  private el: HTMLElement | null = null;
  private entry: FsEntry | null = null;
  private token = 0;
  private stopSize: (() => void) | null = null;
  private closeTimer: number | undefined;

  constructor(private readonly host: HTMLElement, private readonly onClose?: () => void) {}

  get isOpen() {
    return this.el !== null;
  }

  /** The path on show, if any. */
  get path() {
    return this.entry?.path ?? null;
  }

  /** Shows the inspector for an entry (replacing what it showed before). */
  show(entry: FsEntry) {
    window.clearTimeout(this.closeTimer);
    this.token++;
    this.stopSize?.();
    this.stopSize = null;
    this.entry = entry;
    const fresh = this.build(entry, this.token);
    if (this.el) {
      this.el.querySelector(".gi-scroll")?.replaceWith(fresh.querySelector(".gi-scroll")!);
    } else {
      this.el = fresh;
      this.host.append(fresh);
    }
  }

  close() {
    const el = this.el;
    if (!el) return;
    this.el = null;
    this.entry = null;
    this.token++;
    this.stopSize?.();
    this.stopSize = null;
    el.classList.add("closing");
    this.closeTimer = window.setTimeout(() => el.remove(), 140);
    this.onClose?.();
  }

  dispose() {
    window.clearTimeout(this.closeTimer);
    this.stopSize?.();
    this.el?.remove();
    this.el = null;
  }

  private build(entry: FsEntry, token: number): HTMLElement {
    const current = () => token === this.token;
    const closeButton = h("button", { class: "icon-btn gi-close", title: "Close (Esc)", "aria-label": "Close", onclick: () => this.close() }, icon("close", 16));

    // General: what is already known shows at once; the rest fills in when the backend answers.
    const kind = row("Kind", kindLabel(entry));
    const size = row("Size", entry.dir ? "Calculating…" : this.sizeText(entry.size));
    const copy = h("button", { class: "icon-btn small gi-copy", title: "Copy path", "aria-label": "Copy path" }, icon("copy", 13));
    const where = row("Where", entry.path, copy);
    where.value.title = entry.path;
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(entry.path).then(() => {
        copy.replaceChildren(icon("check", 13));
        window.setTimeout(() => copy.replaceChildren(icon("copy", 13)), 1200);
      }).catch(() => {});
    });
    const created = row("Created", "…");
    const modified = row("Modified", entry.mtime ? formatDateTime(entry.mtime) : "…");
    const accessed = row("Accessed", "…");
    const general = [kind.el, size.el, where.el, created.el, modified.el, accessed.el];

    const owner = row("Owner", "…");
    const group = row("Group", "…");
    const mode = row("Mode", "…");
    const access = row("Access", "…");

    const tagError = h("div", { class: "gi-error", hidden: true });
    const chips = TAG_COLORS.map(({ name }) => {
      const chip = h("button", { class: "gi-chip", "aria-pressed": "false", title: `Toggle ${name}` }, tagDot(name, 10), name);
      chip.addEventListener("click", () => {
        tagError.hidden = true;
        toggleTag([entry.path], name, tags).then((next) => {
          tags = next;
          paintChips();
        }).catch((e) => {
          tagError.hidden = false;
          tagError.textContent = String(e).replace(/^Error: /, "");
        });
      });
      return { name, chip };
    });
    let tags: Record<string, string[]> = {};
    const paintChips = () => {
      for (const { name, chip } of chips) chip.setAttribute("aria-pressed", String(tags[entry.path]?.includes(name) ?? false));
    };
    loadTags([entry.path]).then((loaded) => {
      if (!current()) return;
      tags = loaded;
      paintChips();
    }).catch(() => {});

    infoApi.info(entry.path).then((info) => {
      if (!current()) return;
      this.fill(info, { kind, size, created, modified, accessed, owner, group, mode, access });
      if (info.kind === "folder" || entry.dir) this.measure(entry, size.value, token);
    }).catch((e) => {
      if (!current()) return;
      size.value.textContent = entry.dir ? "Unavailable" : size.value.textContent;
      where.el.after(h("div", { class: "gi-error" }, String(e).replace(/^Error: /, "")));
    });

    const preview = h("div", { class: "gi-preview" }, previewThumb(entry, 512));
    const scroll = h("div", { class: "gi-scroll" },
      preview,
      h("div", { class: "gi-name", title: entry.name }, entry.name),
      h("div", { class: "gi-kind" }, kindLabel(entry)),
      section("General", ...general),
      section("Tags", h("div", { class: "gi-chips" }, ...chips.map((c) => c.chip)), tagError),
      section("Permissions", owner.el, group.el, mode.el, access.el));

    const panel = h("aside", { class: "gi glass-strong", role: "complementary", "aria-label": "Get Info" }, closeButton, scroll);
    return panel;
  }

  private sizeText(bytes: number) {
    return bytes < 1024 ? `${bytes} bytes` : `${formatBytes(bytes)} (${bytes.toLocaleString()} bytes)`;
  }

  private fill(info: FsInfo, rows: Record<"kind" | "size" | "created" | "modified" | "accessed" | "owner" | "group" | "mode" | "access", Row>) {
    const date = (s: number | null) => (s ? formatDateTime(s) : "Not recorded");
    rows.created.value.textContent = date(info.created);
    rows.modified.value.textContent = date(info.modified);
    rows.accessed.value.textContent = date(info.accessed);
    if (info.kind === "file") rows.size.value.textContent = this.sizeText(info.size);
    if (info.kind === "link" && info.linkTarget) {
      const target = row("Target", info.linkTarget);
      target.value.title = info.linkTarget;
      rows.kind.el.after(target.el);
    }
    rows.owner.value.textContent = info.owner;
    rows.group.value.textContent = info.group;
    rows.mode.value.replaceChildren(h("span", { class: "gi-mono" }, info.permissions), ` (${info.mode})`);
    rows.access.value.replaceChildren(h("span", { class: `gi-badge${info.readOnly ? " ro" : ""}` }, info.readOnly ? "Read-only" : "Read & write"));
  }

  /** Folders: counts items and streams the total size into the Size row. */
  private measure(entry: FsEntry, target: HTMLElement, token: number) {
    this.stopSize = watchFolderSize(entry.path, (size) => {
      if (token !== this.token) return;
      const files = `${size.files.toLocaleString()} ${size.files === 1 ? "file" : "files"}`;
      target.textContent = size.done ? `${this.sizeText(size.bytes)}, ${files}` : `${formatBytes(size.bytes)} so far…`;
      target.classList.toggle("pending", !size.done);
    }, () => {
      target.textContent = "Unavailable";
    });
  }
}
