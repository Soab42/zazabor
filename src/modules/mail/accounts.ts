import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { confirmSheet } from "../files/ops/sheets";
import { mailApi, type Account, type Server, type Setup } from "./api";

type Security = Server["security"];
const SECURITIES: [Security, string][] = [["ssl", "SSL/TLS"], ["starttls", "STARTTLS"], ["none", "None"]];

/** A labelled field. */
function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "ml-field" }, h("span", { class: "ml-label" }, label), control, hint ? h("span", { class: "ml-hint" }, hint) : null);
}

function serverRow(label: string, defaults: Server) {
  const host = h("input", { class: "ml-input", type: "text", spellcheck: "false", autocomplete: "off", placeholder: "mail.example.com", "aria-label": `${label} server` });
  const port = h("input", { class: "ml-input ml-port", type: "text", inputmode: "numeric", "aria-label": `${label} port` });
  const security = h("select", { class: "ml-input ml-security", "aria-label": `${label} security` }, ...SECURITIES.map(([value, text]) => h("option", { value }, text)));
  const set = (s: Server) => {
    host.value = s.host;
    port.value = String(s.port);
    security.value = s.security;
  };
  set(defaults);
  return {
    el: h("div", { class: "ml-field" }, h("span", { class: "ml-label" }, label), h("div", { class: "ml-server" }, host, port, security)),
    set,
    get: (): Server => ({ host: host.value.trim(), port: Number(port.value) || 0, security: security.value as Security }),
    filled: () => host.value.trim() !== "",
  };
}

/**
 * The account sheet. Adding one takes a name, an address and a password: the servers are worked
 * out from the address and only shown when they had to be guessed or signing in failed. Editing
 * one also has its colour, its signature and Remove. Resolves true when something changed.
 */
export function accountSheet(existing: Account | null, colors: string[], openUrl: (url: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let busy = false;
    let setup: Setup | null = null;
    /** The address the servers were worked out for. */
    let setupFor = "";
    let color = existing?.color ?? "";

    const name = h("input", { class: "ml-input", type: "text", placeholder: "Your name", autocomplete: "off", value: existing?.name ?? "" });
    const email = h("input", { class: "ml-input", type: "email", placeholder: "you@example.com", autocomplete: "off", spellcheck: "false", value: existing?.email ?? "" });
    const password = h("input", { class: "ml-input", type: "password", autocomplete: "off", placeholder: existing ? "Unchanged" : "Password or app password" });
    const show = h("button", { class: "icon-btn small ml-reveal", type: "button", title: "Show the password", "aria-label": "Show the password" }, icon("eye", 15));
    show.addEventListener("click", () => {
      const hidden = password.type === "password";
      password.type = hidden ? "text" : "password";
      show.replaceChildren(icon(hidden ? "eyeOff" : "eye", 15));
    });
    const username = h("input", { class: "ml-input", type: "text", spellcheck: "false", autocomplete: "off", placeholder: "Usually the email address", value: existing?.username ?? "" });
    const imap = serverRow("Incoming (IMAP)", existing?.imap ?? { host: "", port: 993, security: "ssl" });
    const smtp = serverRow("Outgoing (SMTP)", existing?.smtp ?? { host: "", port: 465, security: "ssl" });
    const servers = h("div", { class: "ml-servers", hidden: !existing }, imap.el, smtp.el, field("User name", username));
    const advanced = h("button", { class: "ml-link", type: "button", hidden: !!existing }, "Server settings");
    advanced.addEventListener("click", () => {
      servers.hidden = !servers.hidden;
      if (!servers.hidden && !imap.filled() && email.value.includes("@")) void discover();
    });
    const note = h("div", { class: "ml-note", hidden: true });
    const error = h("p", { class: "ml-error", role: "alert", hidden: true });

    const signature = h("textarea", { class: "ml-input ml-textarea", rows: 3, placeholder: "Goes under every new message" });
    signature.value = htmlToPlain(existing?.signature ?? "");
    const swatches = h("div", { class: "ml-swatches", role: "radiogroup", "aria-label": "Colour" },
      ...colors.map((c) => {
        const swatch = h("button", { class: `ml-swatch ml-c-${c}${c === color ? " active" : ""}`, type: "button", role: "radio", "aria-checked": String(c === color), title: c, "aria-label": c });
        swatch.addEventListener("click", () => {
          color = c;
          for (const other of swatches.children) {
            other.classList.toggle("active", other === swatch);
            other.setAttribute("aria-checked", String(other === swatch));
          }
        });
        return swatch;
      }));

    const cancel = h("button", { class: "btn ghost", type: "button", onclick: () => finish(false) }, "Cancel");
    const save = h("button", { class: "btn primary", type: "submit" }, existing ? "Save" : "Add Account");
    const remove = existing ? h("button", { class: "btn ghost ml-remove", type: "button" }, icon("trash", 14), "Remove Account…") : null;
    remove?.addEventListener("click", async () => {
      const ok = await confirmSheet({
        title: `Remove ${existing!.email}?`,
        message: "Its mail leaves this computer and stays on the server. Drafts written here for it are deleted.",
        confirmLabel: "Remove", destructive: true, icon: "trash",
      });
      if (!ok) return;
      try {
        await mailApi.removeAccount(existing!.id);
        finish(true);
      } catch (err) {
        fail(String(err));
      }
    });

    const form = h("form", { class: "ml-account-form", novalidate: true },
      field("Name", name, "Shown to the people you write to."),
      field("Email address", email),
      field("Password", h("div", { class: "ml-password" }, password, show)),
      note, advanced, servers,
      existing ? field("Colour", swatches) : null,
      existing ? field("Signature", signature) : null,
      error);
    const card = h("div", { class: "modal ml-account-sheet", role: "dialog", "aria-modal": "true", "aria-label": existing ? "Account settings" : "Add an email account" },
      h("div", { class: "modal-head" }, h("div", null, h("h2", null, existing ? existing.email : "Add an email account"), h("p", { class: "setup-summary" }, existing ? "Account settings" : "Gmail, iCloud, Yahoo, Fastmail, or any address with IMAP."))),
      h("div", { class: "modal-body" }, form),
      h("div", { class: "modal-foot" }, remove, h("span", { class: "ops-spacer" }), cancel, save));
    save.setAttribute("form", "ml-account-form");
    form.id = "ml-account-form";
    const overlay = h("div", { class: "modal-overlay ml-overlay" }, card);
    overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        finish(false);
      }
    });
    document.body.append(overlay);
    (existing ? name : name.value ? email : name).focus();

    function finish(changed: boolean) {
      if (busy) return;
      overlay.remove();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      resolve(changed);
    }

    function fail(message: string) {
      error.hidden = false;
      error.textContent = message;
    }

    function showNote(s: Setup) {
      note.hidden = !s.note && !s.provider;
      if (note.hidden) return;
      const link = s.helpUrl ? h("button", { class: "ml-link", type: "button", onclick: () => openUrl(s.helpUrl) }, s.note.includes("app") ? "Make an app password" : "Learn more", icon("external", 12)) : null;
      note.replaceChildren(icon("info", 15), h("div", null, h("strong", null, s.provider || "Your mail provider"), s.note ? h("p", null, s.note) : null, link));
    }

    /** Works the servers out from the address (once per address). */
    async function discover(): Promise<Setup | null> {
      const address = email.value.trim();
      if (!address.includes("@")) return null;
      if (setup && setupFor === address) return setup;
      try {
        const found = await mailApi.discover(address);
        if (email.value.trim() !== address) return null;
        setup = found;
        setupFor = address;
        imap.set(found.imap);
        smtp.set(found.smtp);
        if (!username.value.trim() || username.value.trim() === existing?.username) username.value = found.username;
        showNote(found);
        if (found.guessed) servers.hidden = false;
        return found;
      } catch {
        return null;
      }
    }

    if (!existing) {
      email.addEventListener("change", () => void discover());
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      error.hidden = true;
      const address = email.value.trim();
      if (!address.includes("@")) return fail("Enter your email address.");
      if (!existing && !password.value) return fail("Enter the password.");
      busy = true;
      overlay.classList.add("busy");
      save.disabled = true;
      cancel.disabled = true;
      save.replaceChildren(h("span", { class: "spinner ops-spin" }), existing ? "Checking…" : "Signing in…");
      try {
        if (!existing && (!imap.filled() || setupFor !== address) && servers.hidden) await discover();
        if (!imap.filled() || !smtp.filled()) {
          servers.hidden = false;
          throw new Error("Enter the mail servers for this address.");
        }
        await mailApi.saveAccount({
          id: existing?.id, email: address, name: name.value.trim(), color, username: username.value.trim() || address,
          imap: imap.get(), smtp: smtp.get(), signature: plainToHtml(signature.value), password: password.value,
        });
        busy = false;
        finish(true);
      } catch (err) {
        busy = false;
        overlay.classList.remove("busy");
        save.disabled = false;
        cancel.disabled = false;
        save.textContent = existing ? "Save" : "Add Account";
        servers.hidden = false;
        fail(String(err instanceof Error ? err.message : err));
      }
    });
  });
}

function plainToHtml(text: string): string {
  return text.trim().replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!).replace(/\r?\n/g, "<br>");
}

function htmlToPlain(html: string): string {
  // Parsed into a document of its own: nothing in it loads or runs.
  return new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, "\n"), "text/html").body.textContent ?? "";
}
