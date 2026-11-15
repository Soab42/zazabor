import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { appsApi, formatSize, onProgress, type Leftover, type Outcome, type Plan, type Program } from "./api";

const HOME_KINDS: Record<Leftover["kind"], string> = { settings: "Settings", data: "Data", cache: "Cache", state: "State" };

/** "~/.config/vlc" for paths in the home folder. */
function tilde(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function appIcon(program: Program, size: number): HTMLElement {
  return program.icon
    ? h("img", { class: "ap-icon", src: program.icon, alt: "", width: size, height: size, draggable: false })
    : h("span", { class: "ap-icon ap-icon-blank" }, icon("package", Math.round(size * 0.6)));
}

/**
 * The uninstall sheet: works out what will happen (an apt simulation can take a moment), shows it
 * with the choices it offers, and runs it with its progress. Resolves with the outcome, or null
 * when cancelled.
 */
export function uninstallSheet(program: Program, home: string): Promise<Outcome | null> {
  return new Promise((resolve) => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let running = false;
    let plan: Plan | null = null;

    const title = h("h2", null, `Uninstall ${program.name}?`);
    const body = h("div", { class: "ap-sheet-content" }, h("div", { class: "ap-sheet-wait" }, h("span", { class: "spinner" }), "Checking what will be removed…"));
    const error = h("p", { class: "ap-sheet-error", role: "alert", hidden: true });
    const log = h("pre", { class: "ap-log", hidden: true });
    const status = h("p", { class: "ap-status", hidden: true });
    const cancel = h("button", { class: "btn ghost", type: "button", onclick: () => finish(null) }, "Cancel");
    const confirm = h("button", { class: "btn danger", type: "button", disabled: true, onclick: () => void go() }, "Uninstall");
    const card = h("div", { class: "modal ops-sheet ap-sheet", role: "dialog", "aria-modal": "true", "aria-label": title.textContent },
      h("div", { class: "ap-sheet-head" }, appIcon(program, 40), h("div", { class: "ap-sheet-title" }, title, h("p", { class: "ap-sheet-sub" }, [program.version, program.publisher].filter(Boolean).join(" · ")))),
      h("div", { class: "ap-sheet-body" }, body, status, log, error),
      h("div", { class: "modal-foot ops-sheet-foot" }, h("span", { class: "ops-spacer" }), cancel, confirm));
    const overlay = h("div", { class: "modal-overlay ops-overlay ap-overlay" }, card);
    overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" && !running) {
        e.preventDefault();
        finish(null);
      }
    });
    document.body.append(overlay);
    cancel.focus();

    const unlisten = onProgress((id, line) => {
      if (id !== program.id) return;
      log.hidden = false;
      log.textContent = `${log.textContent ? `${log.textContent}\n` : ""}${line}`;
      log.scrollTop = log.scrollHeight;
      if (!line.startsWith("$ ")) status.textContent = line;
    });

    function finish(value: Outcome | null) {
      if (running) return;
      overlay.remove();
      void unlisten.then((fn) => fn());
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      resolve(value);
    }

    const choices = { extras: true, purge: false, leftovers: new Set<string>() };

    function check(label: string, hint: string | null, on: boolean, set: (on: boolean) => void, extra?: HTMLElement): HTMLElement {
      const input = h("input", { type: "checkbox", class: "ap-check" });
      input.checked = on;
      input.addEventListener("change", () => set(input.checked));
      return h("label", { class: "ap-option" }, input, h("span", { class: "ap-option-text" }, h("span", null, label), hint ? h("span", { class: "ap-option-hint" }, hint) : null, extra ?? null));
    }

    function show(p: Plan) {
      plan = p;
      title.textContent = p.blocked ? `${program.name} can’t be uninstalled here` : p.action === "Uninstall" ? `Uninstall ${program.name}?` : `${p.action}: ${program.name}?`;
      const parts: HTMLElement[] = [];
      if (p.blocked) {
        const [first, ...details] = p.blocked.split("\n");
        parts.push(h("div", { class: "ap-blocked" }, icon("info", 16), h("p", null, first, ...details.flatMap((line): Node[] => [h("br"), h("span", { class: "ap-mono" }, line)]))));
      } else {
        parts.push(h("ul", { class: "ap-steps" }, ...p.steps.map((s) => h("li", null, s))));
        for (const w of p.warnings) parts.push(h("div", { class: "ap-warning" }, icon("info", 16), h("p", null, w)));
        const options: HTMLElement[] = [];
        if (p.extras.length) {
          const SHOWN = 6;
          const names = h("span", { class: "ap-option-list" }, p.extras.slice(0, SHOWN).join(", "));
          if (p.extras.length > SHOWN) {
            const more = h("button", { class: "ap-more-link", type: "button" }, `and ${p.extras.length - SHOWN} more`);
            more.addEventListener("click", (e) => {
              e.preventDefault();
              names.textContent = p.extras.join(", ");
            });
            names.append(", ", more);
          }
          options.push(check(`Also remove ${p.extras.length} package${p.extras.length === 1 ? "" : "s"} that came with it`, "Nothing else uses them once it’s gone.", true, (on) => (choices.extras = on), names));
        }
        if (p.canPurge && p.source === "deb") options.push(check("Also remove its system-wide settings", "Its configuration files in /etc.", false, (on) => (choices.purge = on)));
        if (p.canPurge && p.source === "snap") options.push(check("Don’t keep a snapshot of its data", "Snap otherwise saves one for 31 days.", false, (on) => (choices.purge = on)));
        if (options.length) parts.push(h("div", { class: "ap-options" }, ...options));
        if (p.leftovers.length) {
          const total = p.leftovers.reduce((n, l) => n + l.size, 0);
          parts.push(h("div", { class: "ap-leftovers" },
            h("p", { class: "ap-section-title" }, `Its files in your home folder (${formatSize(total)})`),
            h("p", { class: "ap-section-hint" }, "Ticked ones go to the Trash too. They look like its settings and data by their names; leave anything you’re not sure about."),
            ...p.leftovers.map((l) => check(tilde(l.path, home), `${HOME_KINDS[l.kind]} · ${formatSize(l.size)}`, false, (on) => (on ? choices.leftovers.add(l.path) : choices.leftovers.delete(l.path))))));
        }
        if (p.admin) parts.push(h("p", { class: "ap-admin" }, icon("lock", 14), "You’ll be asked for your password."));
        else if (p.undoable) parts.push(h("p", { class: "ap-admin" }, icon("trash", 14), "Everything goes to the Trash, so it can be put back."));
      }
      body.replaceChildren(...parts);
      confirm.hidden = !!p.blocked;
      confirm.disabled = !!p.blocked;
      confirm.textContent = p.action;
      cancel.textContent = p.blocked ? "Close" : "Cancel";
      (p.blocked ? cancel : confirm).focus();
    }

    async function go() {
      if (!plan || running) return;
      running = true;
      overlay.classList.add("busy");
      confirm.disabled = true;
      cancel.disabled = true;
      error.hidden = true;
      status.hidden = false;
      status.textContent = plan.admin ? "Asking for your password…" : "Uninstalling…";
      confirm.replaceChildren(h("span", { class: "spinner ops-spin" }), "Uninstalling…");
      try {
        const outcome = await appsApi.uninstall(program.id, { purge: choices.purge, extras: choices.extras, leftovers: [...choices.leftovers] });
        running = false;
        finish(outcome);
      } catch (err) {
        running = false;
        overlay.classList.remove("busy");
        status.hidden = true;
        error.hidden = false;
        error.textContent = String(err);
        confirm.textContent = "Try Again";
        confirm.disabled = false;
        cancel.disabled = false;
      }
    }

    appsApi.plan(program.id).then(show, (err) => {
      body.replaceChildren();
      error.hidden = false;
      error.textContent = String(err);
      cancel.textContent = "Close";
    });
  });
}
