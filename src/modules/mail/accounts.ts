import { h } from "../../ui/dom";
import { icon } from "../../ui/icons";
import { confirmSheet } from "../files/ops/sheets";
import { mailApi, type Account, type OAuthState, type Server, type Setup, type SignInProvider } from "./api";

type Security = Server["security"];
const SECURITIES: [Security, string][] = [["ssl", "SSL/TLS"], ["starttls", "STARTTLS"], ["none", "None"]];

/** What a provider's own sign-in is called, and how its client ID is made (once, by whoever sets Zazabor up). */
const SIGN_IN: Record<SignInProvider, { name: string; mark: string; console: string; consoleLabel: string; steps: string[]; note: string }> = {
  google: {
    name: "Google",
    mark: "G",
    console: "https://console.cloud.google.com/apis/credentials",
    consoleLabel: "Open Google Cloud Console",
    steps: [
      "Make a project, and under APIs & Services → Library turn on the Gmail API.",
      "Under OAuth consent screen choose External, and add your own address as a test user.",
      "Under Credentials choose Create credentials → OAuth client ID → Desktop app.",
      "Copy its client ID and client secret here.",
    ],
    note: "While the project is in Testing, Google asks you to sign in again every 7 days. Publishing it stops that; Google reviews apps that read mail before it lets strangers use them.",
  },
  microsoft: {
    name: "Microsoft",
    mark: "M",
    console: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    consoleLabel: "Open Azure App Registrations",
    steps: [
      "Choose New registration and give it a name (Zazabor).",
      "For who can use it, pick accounts in any organisation and personal Microsoft accounts.",
      "For the redirect URI pick Public client/native (mobile & desktop) and enter http://localhost.",
      "Register, then copy the Application (client) ID here.",
    ],
    note: "A work or school account may also need its administrator to allow IMAP, and sending by mail apps (SMTP AUTH).",
  },
};

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
 * The account sheet. Adding one is a sign-in with Google or Microsoft (in the browser, on their
 * own page), or a name, an address and a password: the servers are worked out from the address
 * and only shown when they had to be guessed or signing in failed. Editing one also has its
 * colour, its signature and Remove. Resolves true when something changed; `notify` says what
 * the user should know afterwards.
 */
export function accountSheet(existing: Account | null, colors: string[], openUrl: (url: string) => void, notify: (message: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let busy = false;
    let setup: Setup | null = null;
    /** The address the servers were worked out for. */
    let setupFor = "";
    let color = existing?.color ?? "";
    let oauth: OAuthState | null = null;
    const signedInWith = existing && existing.auth !== "password" ? existing.auth : null;
    void mailApi.oauthState().then((state) => (oauth = state), () => undefined);

    const name = h("input", { class: "ml-input", type: "text", placeholder: "Your name", autocomplete: "off", value: existing?.name ?? "" });
    const email = h("input", { class: "ml-input", type: "email", placeholder: "you@example.com", autocomplete: "off", spellcheck: "false", value: existing?.email ?? "", disabled: !!signedInWith });
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
    const servers = h("div", { class: "ml-servers", hidden: !existing || !!signedInWith }, imap.el, smtp.el, field("User name", username));
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

    // Signing in on the provider's own page.
    const providerButton = (provider: SignInProvider, label: string) => {
      const button = h("button", { class: `btn ml-signin ml-signin-${provider}`, type: "button" }, h("span", { class: "ml-signin-mark" }, SIGN_IN[provider].mark), label);
      button.addEventListener("click", () => void signIn(provider));
      return button;
    };
    const providers = existing ? null : h("div", { class: "ml-signins" },
      h("div", { class: "ml-signin-row" }, providerButton("google", "Sign in with Google"), providerButton("microsoft", "Sign in with Microsoft")),
      h("div", { class: "ml-or" }, h("span", null, "or with a password")));
    const signedIn = signedInWith ? h("div", { class: "ml-signed" },
      h("span", { class: "ml-signin-mark" }, SIGN_IN[signedInWith].mark),
      h("span", { class: "ml-signed-text" }, `Signed in with ${SIGN_IN[signedInWith].name}`),
      (() => {
        const again = h("button", { class: "btn small", type: "button" }, "Sign In Again");
        again.addEventListener("click", () => void signIn(signedInWith));
        return again;
      })()) : null;

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
      providers,
      field("Name", name, "Shown to the people you write to."),
      field("Email address", email),
      signedIn ?? field("Password", h("div", { class: "ml-password" }, password, show)),
      note, advanced, servers,
      existing ? field("Colour", swatches) : null,
      existing ? field("Signature", signature) : null,
      error);
    const foot = h("div", { class: "modal-foot" }, remove, h("span", { class: "ops-spacer" }), cancel, save);
    const body = h("div", { class: "modal-body" }, form);
    const card = h("div", { class: "modal ml-account-sheet", role: "dialog", "aria-modal": "true", "aria-label": existing ? "Account settings" : "Add an email account" },
      h("div", { class: "modal-head" }, h("div", null, h("h2", null, existing ? existing.email : "Add an email account"), h("p", { class: "setup-summary" }, existing ? "Account settings" : "Gmail, Outlook, iCloud, Yahoo, Fastmail, or any address with IMAP."))),
      body, foot);
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
    name.focus();

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

    /** Back to the form from the sign-in's own panels. */
    function showForm() {
      body.replaceChildren(form);
      foot.hidden = false;
    }

    /** The one-time setup of a provider's client ID; resolves true once one is kept. */
    function clientSetup(provider: SignInProvider): Promise<boolean> {
      return new Promise((done) => {
        const info = SIGN_IN[provider];
        const id = h("input", { class: "ml-input", type: "text", spellcheck: "false", autocomplete: "off", placeholder: provider === "google" ? "…apps.googleusercontent.com" : "00000000-0000-0000-0000-000000000000", value: provider === "google" ? oauth?.googleId ?? "" : oauth?.microsoftId ?? "" });
        const secret = h("input", { class: "ml-input", type: "password", spellcheck: "false", autocomplete: "off", placeholder: oauth?.googleSecret ? "Unchanged" : "GOCSPX-…" });
        const problem = h("p", { class: "ml-error", role: "alert", hidden: true });
        const open = h("button", { class: "ml-link", type: "button" }, info.consoleLabel, icon("external", 12));
        open.addEventListener("click", () => openUrl(info.console));
        const back = h("button", { class: "btn ghost", type: "button" }, "Back");
        const keep = h("button", { class: "btn primary", type: "submit" }, "Save and Sign In");
        const panel = h("form", { class: "ml-account-form ml-client", novalidate: true },
          h("div", { class: "ml-note" }, icon("info", 15), h("div", null,
            h("strong", null, `Set up ${info.name} sign-in (once)`),
            h("p", null, `${info.name} only signs people in to an app it knows. Register Zazabor with your own ${info.name} account and enter what it gives you:`))),
          h("ol", { class: "ml-steps" }, ...info.steps.map((step) => h("li", null, step))),
          open,
          field("Client ID", id),
          provider === "google" ? field("Client secret", secret, "For a desktop app this only names the app; it is kept on this computer.") : null,
          h("p", { class: "ml-hint" }, info.note),
          problem,
          h("div", { class: "ml-client-foot" }, h("span", { class: "ops-spacer" }), back, keep));
        back.addEventListener("click", () => {
          showForm();
          done(false);
        });
        panel.addEventListener("submit", async (e) => {
          e.preventDefault();
          problem.hidden = true;
          if (!id.value.trim()) {
            problem.hidden = false;
            problem.textContent = "Enter the client ID.";
            return;
          }
          try {
            oauth = await mailApi.oauthClient(provider, id.value.trim(), secret.value.trim());
            done(true);
          } catch (err) {
            problem.hidden = false;
            problem.textContent = String(err);
          }
        });
        foot.hidden = true;
        body.replaceChildren(panel);
        id.focus();
      });
    }

    /** Signs in on the provider's page, in the browser, and adds (or signs in again) the account. */
    async function signIn(provider: SignInProvider) {
      if (busy) return;
      error.hidden = true;
      const info = SIGN_IN[provider];
      try {
        oauth = oauth ?? (await mailApi.oauthState());
      } catch (err) {
        return fail(String(err));
      }
      if (!oauth[provider] && !(await clientSetup(provider))) return;
      busy = true;
      const stop = h("button", { class: "btn", type: "button" }, "Cancel");
      stop.addEventListener("click", () => void mailApi.oauthCancel());
      foot.hidden = true;
      body.replaceChildren(h("div", { class: "ml-waiting" },
        h("span", { class: "spinner large" }),
        h("h3", null, `Finish signing in with ${info.name} in your browser`),
        h("p", null, `Your browser opened ${info.name}'s sign-in page. Zazabor never sees your password; it is only allowed to read and send your mail.`),
        stop));
      stop.focus();
      try {
        const done = await mailApi.oauthSignIn(provider, name.value.trim(), existing?.id);
        busy = false;
        notify(done.warning ?? `${done.account.email} is signed in`);
        finish(true);
      } catch (err) {
        busy = false;
        showForm();
        const message = String(err);
        if (!/cancelled/i.test(message)) fail(message);
        // A client ID the provider turned down can be corrected.
        if (/client ID/i.test(message)) void clientSetup(provider).then((kept) => {
          if (kept) void signIn(provider);
        });
      }
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
      if (!existing && !password.value) {
        // Microsoft takes no password at all: its sign-in is the way in.
        const found = await discover();
        if (found?.signIn === "microsoft") return void signIn("microsoft");
        return fail(found?.signIn === "google" ? "Enter an app password, or use Sign in with Google above." : "Enter the password.");
      }
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
        if (!signedInWith) servers.hidden = false;
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
