import { categoryOf, iconNameFor, iconNode } from "../modules/files/kinds";
import { compareNames } from "../modules/files/sort";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { openMenu, type MenuItem } from "../ui/menu";
import { changeMark, gitApi, isStaged, isUnstaged, type GitFile, type GitStatus } from "./git-api";

export interface ScmHost {
  /** The folder the editor shows; the repository is found from it. */
  readonly folder: string;
  /** Opens a changed file's diff: against the last commit, or what's staged against it. */
  openDiff(root: string, file: GitFile, staged: boolean): void;
  openFile(path: string): void;
  /** The status changed (status bar, Explorer colours, gutter bases). */
  statusChanged(status: GitStatus | null): void;
  note(text: string): void;
  ask(title: string, text: string, confirm: string): Promise<boolean>;
}

/**
 * The Source Control view, as in VS Code: a commit box, staged and unstaged changes with stage,
 * unstage and discard, pull and push, and Initialize Repository for a folder without one.
 */
export class SourceControl {
  readonly el: HTMLElement;
  private readonly body = h("div", { class: "scm-body" });
  /** The changes; re-rendered on every refresh, unlike the commit box (typing must survive refreshes). */
  private readonly groups = h("div", { class: "scm-groups" });
  private readonly commitBox: HTMLElement;
  private readonly message = h("textarea", { class: "scm-message", rows: 1, placeholder: "Message (Ctrl+Enter to commit)", spellcheck: true });
  private readonly commitButton = h("button", { class: "btn primary scm-commit", type: "button" }, icon("check", 14), "Commit");
  private readonly badgeTargets = new Set<(count: number) => void>();
  status: GitStatus | null = null;
  private busy = false;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly host: ScmHost) {
    const action = (name: Parameters<typeof icon>[0], title: string, fn: () => void) =>
      h("button", { class: "icon-btn small", type: "button", title, onclick: fn }, icon(name, 15));
    const head = h("div", { class: "ce-explorer-head" },
      h("span", { class: "ce-explorer-title" }, "Source Control"),
      action("check", "Commit (Ctrl+Enter)", () => void this.commit()),
      action("refresh", "Refresh", () => void this.refresh()),
      action("more", "More Actions", () => this.moreMenu()));
    this.message.addEventListener("input", () => this.growMessage());
    this.message.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void this.commit();
      }
    });
    this.commitButton.addEventListener("click", () => void this.commit());
    this.commitBox = h("div", { class: "scm-commit-box" }, this.message, this.commitButton);
    this.body.append(this.commitBox, this.groups);
    this.el = h("div", { class: "scm" }, head, this.body);
  }

  /** Called with the number of changes whenever it changes (the activity bar's badge). */
  onBadge(fn: (count: number) => void) {
    this.badgeTargets.add(fn);
  }

  /** Re-reads the repository's status (after a save, a git action, the window getting focus). */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        this.status = await gitApi.status(this.host.folder).catch(() => null);
      } finally {
        this.refreshing = null;
      }
      this.render();
      this.host.statusChanged(this.status);
      for (const fn of this.badgeTargets) fn(this.status?.files.length ?? 0);
    })();
    return this.refreshing;
  }

  private render() {
    const status = this.status;
    this.commitBox.hidden = !status;
    if (!status) {
      const init = h("button", { class: "btn primary", type: "button", onclick: () => void this.run(() => gitApi.init(this.host.folder), "Initialized a repository") }, "Initialize Repository");
      this.groups.replaceChildren(h("div", { class: "scm-empty" },
        h("p", null, "This folder isn’t a Git repository yet."), init));
      return;
    }
    const staged = status.files.filter(isStaged);
    const changes = status.files.filter(isUnstaged);
    this.commitButton.replaceChildren(icon("check", 14), staged.length || !changes.length ? "Commit" : "Commit All");
    this.groups.replaceChildren(
      ...(staged.length ? [this.group("Staged Changes", staged, true)] : []),
      this.group("Changes", changes, false),
      ...(status.truncated ? [h("p", { class: "scm-note" }, "Only the first 5,000 changes are listed.")] : []));
    this.growMessage();
  }

  private group(title: string, files: GitFile[], staged: boolean): HTMLElement {
    const root = this.status!.root;
    const sorted = [...files].sort((a, b) => compareNames(a.path, b.path));
    const paths = sorted.map((f) => f.path);
    const headActions = staged
      ? [this.miniButton("minus", "Unstage All", () => void this.run(() => gitApi.unstage(root, paths)))]
      : [
          this.miniButton("undo", "Discard All Changes", () => void this.discard(sorted)),
          this.miniButton("plus", "Stage All Changes", () => void this.run(() => gitApi.stage(root, paths))),
        ];
    const head = h("div", { class: "scm-group-head" },
      h("span", { class: "scm-group-title" }, title), h("span", { class: "spacer" }),
      h("span", { class: "scm-group-actions" }, ...(files.length ? headActions : [])),
      h("span", { class: "scm-count" }, String(files.length)));
    const rows = sorted.map((f) => this.row(root, f, staged));
    return h("section", { class: "scm-group" }, head,
      ...(rows.length ? rows : [h("p", { class: "scm-note" }, staged ? "" : "No changes.")]));
  }

  private row(root: string, file: GitFile, staged: boolean): HTMLElement {
    const letter = staged ? file.index : file.index === "?" || file.index === "U" ? file.index : file.work;
    const { mark, kind } = changeMark(letter);
    const name = file.path.split("/").pop() ?? file.path;
    const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
    const actions = staged
      ? [this.miniButton("minus", "Unstage", () => void this.run(() => gitApi.unstage(root, [file.path])))]
      : [
          this.miniButton("files", "Open File", () => this.host.openFile(`${root}/${file.path}`)),
          this.miniButton("undo", "Discard Changes", () => void this.discard([file])),
          this.miniButton("plus", "Stage", () => void this.run(() => gitApi.stage(root, [file.path]))),
        ];
    const row = h("div", { class: `scm-row ${kind}`, title: `${file.path}${file.from ? ` (from ${file.from})` : ""}` },
      iconNode(iconNameFor(categoryOf({ dir: false, ext })), 15),
      h("span", { class: "scm-name" }, name),
      h("span", { class: "scm-dir" }, dir),
      h("span", { class: "scm-actions" }, ...actions),
      h("span", { class: "scm-mark" }, mark));
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".scm-actions")) return;
      if (kind === "deleted" && !staged) return;
      this.host.openDiff(root, file, staged);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const items: MenuItem[] = [
        { label: "Open Changes", icon: "columns", action: () => this.host.openDiff(root, file, staged) },
        { label: "Open File", icon: "files", action: () => this.host.openFile(`${root}/${file.path}`) },
        "separator",
        staged
          ? { label: "Unstage Changes", icon: "minus", action: () => void this.run(() => gitApi.unstage(root, [file.path])) }
          : { label: "Stage Changes", icon: "plus", action: () => void this.run(() => gitApi.stage(root, [file.path])) },
        ...(staged ? [] : [{ label: "Discard Changes", icon: "undo" as const, action: () => void this.discard([file]) }]),
      ];
      openMenu(e.clientX, e.clientY, items);
    });
    return row;
  }

  private miniButton(name: Parameters<typeof icon>[0], title: string, fn: () => void) {
    return h("button", { class: "scm-mini", type: "button", title, onclick: (e: MouseEvent) => {
      e.stopPropagation();
      fn();
    } }, icon(name, 14));
  }

  /** Runs a git action, then refreshes; failures go to the status bar. */
  private async run(action: () => Promise<unknown>, done?: string) {
    if (this.busy) return;
    this.busy = true;
    this.el.classList.add("busy");
    try {
      await action();
      if (done) this.host.note(done);
    } catch (err) {
      this.host.note(String(err));
    } finally {
      this.busy = false;
      this.el.classList.remove("busy");
      await this.refresh();
    }
  }

  private async discard(files: GitFile[]) {
    const root = this.status?.root;
    if (!root || files.length === 0) return;
    const what = files.length === 1 ? `“${files[0].path.split("/").pop()}”` : `${files.length} files`;
    const untracked = files.filter((f) => f.index === "?").map((f) => f.path);
    const tracked = files.filter((f) => f.index !== "?").map((f) => f.path);
    const ok = await this.host.ask(`Discard the changes to ${what}?`,
      untracked.length ? "Changes are lost; new files move to the Trash." : "Your changes will be lost. This can’t be undone.", "Discard");
    if (ok) await this.run(() => gitApi.discard(root, tracked, untracked));
  }

  /** Commits what's staged; with nothing staged, offers to commit every change. */
  async commit() {
    const status = this.status;
    if (!status) return;
    const text = this.message.value.trim();
    if (!text) {
      this.host.note("Write a commit message first.");
      this.message.focus();
      return;
    }
    const staged = status.files.filter(isStaged);
    if (staged.length === 0) {
      const all = status.files.filter(isUnstaged).map((f) => f.path);
      if (all.length === 0) return this.host.note("There’s nothing to commit.");
      const ok = await this.host.ask("There are no staged changes. Stage all your changes and commit them?",
        "This is what VS Code does when you commit with nothing staged.", "Commit All");
      if (!ok) return;
      await this.run(async () => {
        await gitApi.stage(status.root, all);
        await gitApi.commit(status.root, text);
        this.message.value = "";
      }, "Committed");
      return;
    }
    await this.run(async () => {
      await gitApi.commit(status.root, text);
      this.message.value = "";
    }, "Committed");
  }

  async pull() {
    const root = this.status?.root;
    if (root) await this.run(() => gitApi.pull(root), "Pulled");
  }

  async push() {
    const root = this.status?.root;
    if (root) await this.run(() => gitApi.push(root), "Pushed");
  }

  /** Pull, then push, as the status bar's sync button does. */
  async sync() {
    const root = this.status?.root;
    if (!root) return;
    await this.run(async () => {
      if (this.status?.upstream) await gitApi.pull(root);
      await gitApi.push(root);
    }, "Synced");
  }

  /** The branch picker: switch to a branch or create one. */
  async branchMenu(x: number, y: number) {
    const status = this.status;
    if (!status) return;
    const branches = await gitApi.branches(status.root).catch(() => [] as string[]);
    const items: MenuItem[] = [
      { label: "Create New Branch…", icon: "plus", action: () => void this.createBranch() },
      "separator",
      ...branches.map((b) => ({
        label: b, icon: b === status.branch ? ("check" as const) : ("branch" as const),
        action: () => {
          if (b !== status.branch) void this.run(() => gitApi.checkout(status.root, b), `Switched to ${b}`);
        },
      })),
    ];
    openMenu(x, y, items);
  }

  private async createBranch() {
    const status = this.status;
    if (!status) return;
    const name = await promptText("New branch name", "feature/…");
    if (name) await this.run(() => gitApi.checkout(status.root, name, true), `Created ${name}`);
  }

  private moreMenu() {
    const r = this.el.querySelector(".ce-explorer-head")!.getBoundingClientRect();
    openMenu(r.right - 200, r.bottom, [
      { label: "Pull", icon: "download", action: () => void this.pull() },
      { label: "Push", icon: "arrowUp", action: () => void this.push() },
      { label: "Sync (Pull, then Push)", icon: "sync", action: () => void this.sync() },
      "separator",
      { label: "Checkout to…", icon: "branch", action: () => void this.branchMenu(r.right - 200, r.bottom) },
      { label: "Create Branch…", icon: "plus", action: () => void this.createBranch() },
      "separator",
      { label: "Commit (Amend)", icon: "check", action: () => void this.amend() },
    ]);
  }

  private async amend() {
    const status = this.status;
    if (!status) return;
    const text = this.message.value.trim();
    if (!text) return this.host.note("Write the new commit message first.");
    await this.run(async () => {
      await gitApi.commit(status.root, text, true);
      this.message.value = "";
    }, "Amended the last commit");
  }

  private growMessage() {
    this.message.style.height = "auto";
    this.message.style.height = `${Math.min(160, this.message.scrollHeight)}px`;
  }
}

/** A one-line text prompt as a glass sheet; resolves with the text, or null when cancelled. */
function promptText(title: string, placeholder: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h("input", { class: "ce-palette-input", type: "text", placeholder, spellcheck: false });
    const box = h("div", { class: "ce-palette", role: "dialog", "aria-label": title }, h("div", { class: "ce-prompt-title" }, title), input);
    const scrim = h("div", { class: "ce-scrim" }, box);
    const done = (value: string | null) => {
      scrim.remove();
      resolve(value);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        done(input.value.trim() || null);
      } else if (e.key === "Escape") {
        e.preventDefault();
        done(null);
      }
    });
    scrim.addEventListener("mousedown", (e) => {
      if (e.target === scrim) done(null);
    });
    document.body.append(scrim);
    input.focus();
  });
}
