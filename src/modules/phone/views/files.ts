import { open as openDialog } from "../../../shared/dialog";
import { formatBytes, h } from "../../../ui/dom";
import { icon, type IconName } from "../../../ui/icons";
import { openMenu } from "../../../ui/menu";
import { confirmSheet } from "../../files/ops/sheets";
import { showToast } from "../../files/ops/toast";
import { errorText, hasCap, phoneApi, shortTime, type Entry } from "../api";
import type { PhoneCtx, PhoneView } from "../ctx";
import { emptyState, loadingState } from "../ui";

function glyphFor(e: Entry): IconName {
  if (e.dir) return e.path.startsWith("/storage/") && e.path.split("/").length <= 4 && /storage|card|usb/i.test(e.name) ? "drive" : "folder";
  const mime = e.mime ?? "";
  const ext = e.name.slice(e.name.lastIndexOf(".") + 1).toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "music";
  if (mime === "application/pdf" || ext === "pdf") return "pdfFile";
  if (/sheet|excel|csv/.test(mime) || ["xlsx", "xls", "csv", "ods"].includes(ext)) return "sheetFile";
  if (/word|document/.test(mime) || ["docx", "doc", "odt"].includes(ext)) return "docFile";
  if (/zip|archive|compressed|android\.package/.test(mime) || ["zip", "apk", "7z", "rar", "tar", "gz"].includes(ext)) return "fileArchive";
  return "file";
}

/**
 * Files: the phone's storage, with breadcrumbs. Download, upload (or drop files from the desktop
 * onto the list), and delete. Transfers show in the tray.
 */
export function filesView(ctx: PhoneCtx): PhoneView & { dropDir(): string | null; upload(paths: string[]): void } {
  let path = "";
  /** Names of the storage roots, to show in the breadcrumbs instead of "/storage/emulated/0". */
  const rootNames = new Map<string, string>();
  let entries: Entry[] = [];
  let loading = false;
  let failed: string | null = null;
  const selected = new Set<string>();
  let anchor = -1;
  let ticket = 0;

  const up = h("button", { class: "icon-btn", type: "button", title: "Up (Alt+↑)", "aria-label": "Up" }, icon("arrowUp", 16));
  up.addEventListener("click", () => goUp());
  const crumbs = h("nav", { class: "pl-crumbs", "aria-label": "Folder" });
  const refresh = h("button", { class: "icon-btn", type: "button", title: "Refresh (F5)", "aria-label": "Refresh" }, icon("refresh", 16));
  refresh.addEventListener("click", () => void load());
  const uploadButton = h("button", { class: "btn small", type: "button", title: "Send files from this PC to this folder" }, icon("upload", 14), "Upload");
  uploadButton.addEventListener("click", () => void pickUpload());
  const downloadButton = h("button", { class: "btn small", type: "button" }, icon("download", 14), "Download");
  downloadButton.addEventListener("click", () => void download([...selected]));
  const deleteButton = h("button", { class: "icon-btn", type: "button", title: "Delete", "aria-label": "Delete" }, icon("trash", 16));
  deleteButton.addEventListener("click", () => void remove([...selected]));
  const list = h("div", { class: "pl-file-list", role: "listbox", "aria-multiselectable": "true", tabindex: 0 });
  const dropHint = h("div", { class: "pl-file-drop" }, icon("upload", 15), h("span", null, "Drop files here to send them to this folder"));
  const el = h("div", { class: "pl-pane pl-files" },
    h("header", { class: "pl-bar" },
      h("div", { class: "pl-bar-row" }, up, crumbs, h("span", { class: "spacer" }), deleteButton, downloadButton, uploadButton, refresh)),
    h("div", { class: "pl-file-head" }, h("span", null, "Name"), h("span", null, "Size"), h("span", null, "Modified")),
    list, dropHint);

  const phoneId = () => ctx.phone()?.phoneId ?? "";
  const parentOf = (p: string) => {
    if (!p || rootNames.has(p)) return "";
    const cut = p.lastIndexOf("/");
    return cut > 0 ? p.slice(0, cut) : "";
  };

  async function load(to = path) {
    const id = phoneId();
    if (!id) return;
    const mine = ++ticket;
    loading = true;
    failed = null;
    if (to !== path) {
      path = to;
      entries = [];
      selected.clear();
    }
    draw();
    try {
      const next = await phoneApi.files(id, to);
      if (mine !== ticket) return;
      entries = next.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1));
      if (!to) for (const e of next) rootNames.set(e.path, e.name);
      for (const p of [...selected]) if (!entries.some((e) => e.path === p)) selected.delete(p);
    } catch (err) {
      if (mine !== ticket) return;
      failed = errorText(err);
      entries = [];
    }
    loading = false;
    draw();
  }

  function goUp() {
    if (path) void load(parentOf(path));
  }

  function drawCrumbs() {
    const parts: { label: string; to: string }[] = [{ label: ctx.phone()?.name ?? "Phone", to: "" }];
    if (path) {
      const root = [...rootNames.keys()].find((r) => path === r || path.startsWith(`${r}/`));
      if (root) {
        parts.push({ label: rootNames.get(root)!, to: root });
        let at = root;
        for (const seg of path.slice(root.length).split("/").filter(Boolean)) {
          at = `${at}/${seg}`;
          parts.push({ label: seg, to: at });
        }
      } else {
        let at = "";
        for (const seg of path.split("/").filter(Boolean)) {
          at = `${at}/${seg}`;
          parts.push({ label: seg, to: at });
        }
      }
    }
    crumbs.replaceChildren(...parts.flatMap((p, i) => {
      const last = i === parts.length - 1;
      const b = h("button", { class: `pl-crumb${last ? " current" : ""}`, type: "button" }, i === 0 ? icon("phone", 14) : null, p.label);
      if (!last) b.addEventListener("click", () => void load(p.to));
      return i ? [h("span", { class: "pl-crumb-sep" }, icon("chevronRight", 12)), b] : [b];
    }));
  }

  function draw() {
    drawCrumbs();
    const phone = ctx.phone();
    const canWrite = !!phone?.connected && hasCap(phone, "files") && !!path;
    up.disabled = !path;
    uploadButton.disabled = !canWrite;
    downloadButton.disabled = !phone?.connected || ![...selected].some((p) => entries.find((e) => e.path === p && !e.dir));
    deleteButton.disabled = !phone?.connected || !selected.size || !path;
    el.classList.toggle("can-drop", canWrite);
    if (loading && !entries.length) return list.replaceChildren(loadingState("Loading the folder…"));
    if (!hasCap(phone, "files")) return list.replaceChildren(emptyState("folder", "Files aren't shared", "Give Zazabor Link “All files access” on the phone to browse its storage here."));
    if (!phone?.connected) return list.replaceChildren(emptyState("folder", "The phone isn't connected", "The phone's files show while it's linked to this PC."));
    if (failed) return list.replaceChildren(emptyState("folder", "Couldn't open this folder", failed));
    if (!entries.length) return list.replaceChildren(emptyState("folder", "This folder is empty", path ? "Drop files here, or press Upload, to send some from this PC." : "No storage found on the phone."));
    list.replaceChildren(...entries.map((e, index) => {
      const row = h("div", { class: `pl-file${selected.has(e.path) ? " selected" : ""}`, role: "option", "aria-selected": String(selected.has(e.path)), "data-path": e.path },
        h("span", { class: `pl-file-icon${e.dir ? " dir" : ""}` }, icon(glyphFor(e), 18)),
        h("span", { class: "pl-file-name" }, e.name),
        h("span", { class: "pl-file-size" }, e.dir ? "—" : formatBytes(e.size)),
        h("span", { class: "pl-file-date" }, e.at ? shortTime(e.at) : ""));
      row.addEventListener("click", (ev) => clickRow(e, index, ev));
      row.addEventListener("dblclick", () => activate(e));
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        if (!selected.has(e.path)) {
          selected.clear();
          selected.add(e.path);
          draw();
        }
        const paths = [...selected];
        const files = paths.filter((p) => entries.find((x) => x.path === p && !x.dir));
        openMenu(ev.clientX, ev.clientY, [
          ...(e.dir ? [{ label: "Open", icon: "folder" as IconName, action: () => activate(e) }] : []),
          { label: files.length > 1 ? `Download ${files.length} Files` : "Download", icon: "download", disabled: !files.length, action: () => void download(paths) },
          { label: "Download To…", icon: "folder", disabled: !files.length, action: () => void download(paths, true) },
          "separator",
          { label: "Delete…", icon: "trash", danger: true, disabled: !path, action: () => void remove(paths) },
        ]);
      });
      return row;
    }));
  }

  function clickRow(e: Entry, index: number, ev: MouseEvent) {
    if (ev.ctrlKey || ev.metaKey) {
      if (selected.has(e.path)) selected.delete(e.path);
      else selected.add(e.path);
      anchor = index;
    } else if (ev.shiftKey && anchor >= 0) {
      selected.clear();
      const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
      for (let k = a; k <= b; k++) selected.add(entries[k].path);
    } else {
      selected.clear();
      selected.add(e.path);
      anchor = index;
    }
    draw();
  }

  function activate(e: Entry) {
    if (e.dir) void load(e.path);
    else void download([e.path]);
  }

  async function download(paths: string[], ask = false) {
    const files = paths.filter((p) => entries.find((e) => e.path === p && !e.dir));
    if (!files.length) return;
    let dest = ctx.downloadDir();
    if (ask) {
      const chosen = await openDialog({ title: "Download to", directory: true, defaultPath: dest || undefined });
      if (!chosen) return;
      dest = chosen;
    }
    try {
      await phoneApi.download(phoneId(), files, dest);
      ctx.showTransfers();
    } catch (err) {
      showToast(`Couldn't download: ${errorText(err)}`);
    }
  }

  async function remove(paths: string[]) {
    if (!paths.length || !path) return;
    const names = paths.map((p) => entries.find((e) => e.path === p)?.name ?? p);
    const ok = await confirmSheet({
      title: names.length === 1 ? `Delete “${names[0]}”?` : `Delete ${names.length} items?`,
      message: "They're deleted from the phone for good; Android has no Trash for them.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const failures: string[] = [];
    for (const p of paths) {
      try {
        await phoneApi.fileDelete(phoneId(), p);
      } catch (err) {
        failures.push(errorText(err));
      }
    }
    if (failures.length) showToast(`Couldn't delete: ${failures[0]}`);
    selected.clear();
    void load();
  }

  async function pickUpload() {
    const paths = await openDialog({ title: "Send to the phone", multiple: true });
    if (paths?.length) upload(paths);
  }

  function upload(paths: string[]) {
    if (!path) return;
    void phoneApi.upload(phoneId(), paths, path).then(() => {
      ctx.showTransfers();
      // The new files appear once they're there; look again shortly.
      window.setTimeout(() => void load(), 1500);
    }, (err) => showToast(`Couldn't send: ${errorText(err)}`));
  }

  list.addEventListener("keydown", (e) => {
    const i = entries.findIndex((x) => selected.has(x.path));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(entries.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
      if (entries[next]) {
        selected.clear();
        selected.add(entries[next].path);
        anchor = next;
        draw();
        list.querySelector(".pl-file.selected")?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Enter" && i >= 0) {
      e.preventDefault();
      activate(entries[i]);
    } else if (e.key === "Delete" && selected.size) {
      e.preventDefault();
      void remove([...selected]);
    }
  });

  let shownFor = "";
  return {
    el,
    show(phoneChanged) {
      const id = phoneId();
      if (id !== shownFor) {
        shownFor = id;
        path = "";
        entries = [];
        void load("");
      } else if (phoneChanged) void load();
      else draw();
    },
    handleKey(e) {
      if (e.key === "F5") {
        void load();
        return true;
      }
      if ((e.altKey && e.key === "ArrowUp") || (e.key === "Backspace" && path)) {
        goUp();
        return true;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && entries.length) {
        for (const x of entries) selected.add(x.path);
        draw();
        return true;
      }
      return false;
    },
    dropDir: () => (path && ctx.phone()?.connected ? path : null),
    upload,
  };
}
