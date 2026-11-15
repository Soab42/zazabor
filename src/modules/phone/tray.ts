import type { ShellContext } from "../../shell/module";
import { dirname, formatBytes, h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { showToast } from "../files/ops/toast";
import { errorText, phoneApi, type Transfer } from "./api";
import { clearFinishedTransfers, getTransfers, subscribe } from "./store";

/**
 * The transfers tray: files going to and coming from the phone, with progress and Cancel. A
 * button at the bottom of the sidebar shows how many are running and opens it.
 */
export function createTray(shell: ShellContext) {
  let open = false;
  const known = new Map<number, Transfer["state"]>();

  const badge = h("span", { class: "pl-tray-count" });
  const ring = h("span", { class: "pl-tray-ring" });
  const button = h("button", { class: "pl-nav-item pl-tray-button", type: "button", hidden: true }, icon("transfer", 16), h("span", { class: "pl-nav-label" }, "Transfers"), ring, badge);
  button.addEventListener("click", () => toggle());

  const clear = h("button", { class: "btn small ghost", type: "button" }, "Clear Finished");
  clear.addEventListener("click", () => clearFinishedTransfers());
  const close = h("button", { class: "icon-btn small", type: "button", title: "Close", "aria-label": "Close" }, icon("close", 14));
  close.addEventListener("click", () => toggle(false));
  const list = h("div", { class: "pl-tray-list" });
  const panel = h("section", { class: "pl-tray glass-strong", hidden: true, "aria-label": "Transfers" },
    h("header", { class: "pl-tray-head" }, h("strong", null, "Transfers"), h("span", { class: "spacer" }), clear, close),
    list);

  function row(t: Transfer): HTMLElement {
    const pct = t.size ? Math.min(100, Math.round((t.done / t.size) * 100)) : t.state === "done" ? 100 : 0;
    const running = t.state === "running" || t.state === "queued";
    const what = t.state === "done" ? (t.dir === "in" ? "Saved" : "Sent") : t.state === "failed" ? t.error || "Failed" : t.state === "cancelled" ? "Cancelled" : t.state === "queued" ? "Waiting…" : `${formatBytes(t.done)} of ${formatBytes(t.size)}`;
    const actions: Node[] = [];
    if (running) {
      const cancel = h("button", { class: "icon-btn small", type: "button", title: "Cancel", "aria-label": "Cancel" }, icon("close", 13));
      cancel.addEventListener("click", () => void phoneApi.transferCancel(t.id).catch((err) => showToast(errorText(err))));
      actions.push(cancel);
    } else if (t.state === "done" && t.dir === "in" && t.path) {
      const show = h("button", { class: "icon-btn small", type: "button", title: "Show in Files", "aria-label": "Show in Files" }, icon("folder", 14));
      show.addEventListener("click", () => shell.open({ kind: "folder", path: dirname(t.path!) }));
      actions.push(show);
    }
    return h("div", { class: `pl-xfer ${t.state}` },
      h("span", { class: `pl-xfer-dir ${t.dir}`, title: t.dir === "in" ? "From the phone" : "To the phone" }, icon(t.dir === "in" ? "download" : "upload", 15)),
      h("div", { class: "pl-xfer-main" },
        h("span", { class: "pl-xfer-name", title: t.path ?? t.name }, t.name),
        running ? h("span", { class: "pl-progress" }, h("span", { style: { width: `${pct}%` } })) : null,
        h("span", { class: "pl-xfer-what" }, what)),
      ...actions);
  }

  function draw() {
    const all = getTransfers();
    const running = all.filter((t) => t.state === "running" || t.state === "queued");
    button.hidden = all.length === 0;
    badge.textContent = running.length ? String(running.length) : "";
    const size = running.reduce((s, t) => s + t.size, 0);
    const done = running.reduce((s, t) => s + t.done, 0);
    ring.hidden = !running.length;
    ring.style.setProperty("--p", `${size ? Math.round((done / size) * 100) : 0}%`);
    clear.disabled = all.length === running.length;
    list.replaceChildren(...(all.length ? all.map(row) : [h("p", { class: "pl-none" }, "Nothing is being sent.")]));
    panel.hidden = !open;
    button.classList.toggle("active", open);
    // Tell about each transfer once, when it ends.
    for (const t of all) {
      const before = known.get(t.id);
      known.set(t.id, t.state);
      if (before && before !== t.state && t.state === "done" && t.dir === "in" && t.path && !open) {
        const path = t.path;
        showToast(`Saved “${t.name}”`, { label: "Show", run: () => shell.open({ kind: "folder", path: dirname(path) }) }, 4000);
      } else if (before && before !== t.state && t.state === "failed") {
        showToast(`“${t.name}” didn't go through: ${t.error ?? "the connection dropped"}`);
      }
    }
  }

  function toggle(to = !open) {
    open = to;
    draw();
  }

  subscribe("transfers", draw);
  draw();
  return { button, panel, show: () => toggle(true) };
}
