import { invoke } from "@tauri-apps/api/core";
import { h } from "./ui/dom";
import { icon } from "./ui/icons";

export type LockMode = "off" | "system" | "custom";

export interface LockStatus {
  mode: LockMode;
  locked: boolean;
  systemAvailable: boolean;
}

export const lockApi = {
  status: () => invoke<LockStatus>("lock_status"),
  lockNow: () => invoke<void>("lock_now"),
  /** Custom password, or the system dialog when `password` is omitted. */
  unlock: (password?: string) => invoke<boolean>("unlock", { password: password ?? null }),
  confirm: (password?: string) => invoke<boolean>("confirm_identity", { password: password ?? null }),
  set: (mode: LockMode, newPassword?: string, currentPassword?: string) =>
    invoke<void>("set_lock", { mode, newPassword: newPassword ?? null, currentPassword: currentPassword ?? null }),
};

/**
 * Asks for the lock's credentials. "unlock" covers the whole app; "confirm" is a dialog that
 * re-checks identity (for private albums) and can be cancelled.
 */
export function askForAccess(mode: LockMode, purpose: "unlock" | "confirm", reason = ""): Promise<boolean> {
  return new Promise((resolve) => {
    const unlocking = purpose === "unlock";
    const error = h("p", { class: "lock-error" });
    const busy = (on: boolean) => card.classList.toggle("busy", on);
    const finish = (ok: boolean) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.classList.add("leaving");
      setTimeout(() => overlay.remove(), 220);
      resolve(ok);
    };
    const attempt = async (password?: string) => {
      busy(true);
      error.textContent = "";
      const ok = await (unlocking ? lockApi.unlock(password) : lockApi.confirm(password)).catch(() => false);
      busy(false);
      if (ok) return finish(true);
      error.textContent = mode === "custom" ? "That password isn't right." : "Authentication didn't succeed.";
      card.classList.remove("shake");
      void card.offsetWidth;
      card.classList.add("shake");
      input?.select();
    };

    let input: HTMLInputElement | null = null;
    const controls: HTMLElement[] = [];
    if (mode === "custom") {
      input = h("input", { type: "password", class: "lock-input", placeholder: "Password", autocomplete: "current-password" });
      const form = h("form", { class: "lock-form" }, input, h("button", { class: "btn primary", type: "submit" }, unlocking ? "Unlock" : "Continue"));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (input!.value) void attempt(input!.value);
      });
      controls.push(form);
    } else {
      const button = h("button", { class: "btn primary large" }, icon("lock", 17), unlocking ? "Unlock with system password" : "Confirm with system password");
      button.addEventListener("click", () => void attempt());
      controls.push(button, h("p", { class: "muted small" }, "Uses this computer's administrator authentication."));
    }
    if (!unlocking) controls.push(h("button", { class: "btn ghost", onclick: () => finish(false) }, "Cancel"));

    const card = h(
      "div",
      { class: "lock-card" },
      h("div", { class: "lock-badge" }, icon("lock", 30)),
      h("h1", null, unlocking ? "CorePro is locked" : "Confirm it's you"),
      h("p", { class: "lock-sub" }, reason || (unlocking ? "Your files and photos are private." : "")),
      ...controls,
      error,
    );
    const overlay = h("div", { class: `lock-screen${unlocking ? "" : " confirm"}` }, card);
    const onKey = (e: KeyboardEvent) => {
      // Nothing behind the lock may react to the keyboard.
      e.stopPropagation();
      if (e.key === "Escape" && !unlocking) finish(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    (input ?? card.querySelector<HTMLButtonElement>("button"))?.focus();
  });
}

const AUTO_LOCK_CHOICES: [number, string][] = [[0, "Never"], [1, "After 1 minute"], [5, "After 5 minutes"], [15, "After 15 minutes"], [30, "After 30 minutes"]];

/** Settings for the lock; resolves with the new status when saved, or null when cancelled. */
export function openLockSettings(status: LockStatus, autoLockMinutes: number): Promise<{ status: LockStatus; autoLockMinutes: number } | null> {
  return new Promise((resolve) => {
    let mode: LockMode = status.mode;
    const radios = new Map<LockMode, HTMLInputElement>();
    const option = (value: LockMode, title: string, detail: string, disabled = false) => {
      const input = h("input", { type: "radio", name: "lock-mode", checked: value === mode, disabled });
      input.addEventListener("change", () => {
        mode = value;
        update();
      });
      radios.set(value, input);
      return h("label", { class: `scope lock-option${disabled ? " disabled" : ""}` }, input,
        h("span", { class: "lock-option-text" }, h("span", { class: "scope-label" }, title), h("span", { class: "muted small" }, detail)));
    };
    const newPassword = h("input", { type: "password", class: "lock-input", placeholder: "New password", autocomplete: "new-password" });
    const repeat = h("input", { type: "password", class: "lock-input", placeholder: "Repeat new password", autocomplete: "new-password" });
    const currentPassword = h("input", { type: "password", class: "lock-input", placeholder: "Current password", autocomplete: "current-password" });
    const custom = h("div", { class: "lock-fields" }, newPassword, repeat);
    const current = h("div", { class: "lock-fields" }, h("span", { class: "muted small" }, "To change the lock, enter your current password."), currentPassword);
    const autoLock = h("select", null, ...AUTO_LOCK_CHOICES.map(([v, label]) => h("option", { value: String(v) }, label)));
    autoLock.value = String(AUTO_LOCK_CHOICES.some(([v]) => v === autoLockMinutes) ? autoLockMinutes : 5);
    const error = h("p", { class: "lock-error" });
    const save = h("button", { class: "btn primary" }, "Save");

    const update = () => {
      custom.hidden = mode !== "custom";
      current.hidden = status.mode !== "custom";
      autoLock.disabled = mode === "off";
    };
    update();

    const finish = (result: { status: LockStatus; autoLockMinutes: number } | null) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    };
    save.addEventListener("click", async () => {
      error.textContent = "";
      if (mode === "custom" && newPassword.value !== repeat.value) {
        error.textContent = "The new passwords don't match.";
        return;
      }
      save.disabled = true;
      try {
        await lockApi.set(mode, mode === "custom" ? newPassword.value : undefined, status.mode === "custom" ? currentPassword.value : undefined);
        finish({ status: { ...status, mode }, autoLockMinutes: Number(autoLock.value) });
      } catch (err) {
        error.textContent = String(err);
      } finally {
        save.disabled = false;
      }
    });
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") finish(null);
    };
    document.addEventListener("keydown", onKey, true);

    const dialog = h(
      "div",
      { class: "modal lock-settings", role: "dialog", "aria-label": "Privacy lock" },
      h("header", { class: "modal-head" },
        h("div", null, h("h2", null, "Privacy lock"), h("p", { class: "setup-summary" }, "Keep people who use this computer from browsing your photos.")),
        h("button", { class: "icon-btn", title: "Cancel (Esc)", onclick: () => finish(null) }, icon("close"))),
      h(
        "div",
        { class: "modal-body" },
        h("div", { class: "scope-list" },
          option("off", "Off", "Anyone using this computer can open CorePro."),
          option("system", "System password", status.systemAvailable ? "Unlock with this computer's administrator password." : "Not available on this computer.", !status.systemAvailable),
          option("custom", "Custom password", "Unlock with a password just for CorePro.")),
        custom,
        current,
        h("label", { class: "sf-row" }, h("span", { class: "sf-label" }, "Lock automatically"), autoLock),
        h("p", { class: "muted small lock-note" }, "While locked, CorePro hides your photos and refuses to load them, and hidden albums become private. Files on disk are not encrypted."),
        error,
      ),
      h("footer", { class: "modal-foot" }, h("div", { class: "spacer" }), h("button", { class: "btn", onclick: () => finish(null) }, "Cancel"), save),
    );
    const overlay = h("div", { class: "modal-overlay" }, dialog);
    document.body.append(overlay);
  });
}
