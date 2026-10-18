import { h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import type { ShellContext } from "../../../shell/module";
import { authMessage, errorText, isAuthError, networkApi, type Credentials, type Mount } from "../network-api";
import { normalizeAddress, schemeOf } from "./address";

export type MountOutcome = { mount: Mount } | { auth: string } | { error: string };

/** Mounts an address; credentials-needed and failures come back as values, not exceptions. */
export async function tryMount(address: string, creds?: Credentials): Promise<MountOutcome> {
  try {
    return { mount: await networkApi.mount(address, creds) };
  } catch (err) {
    return isAuthError(err) ? { auth: authMessage(err) } : { error: errorText(err) };
  }
}

/** Remembers a connected share under Network (most recent first, no duplicates). */
export function saveServer(shell: ShellContext, mount: Mount, address: string) {
  if (mount.kind !== "network") return;
  const files = shell.config.files;
  files.servers = [{ name: mount.name, url: address }, ...files.servers.filter((s) => s.url !== address)].slice(0, 20);
  shell.saveConfig();
}

export interface SheetOptions {
  /** Pre-filled address. */
  address?: string;
  /** Open straight on the credentials step (the address is fixed). */
  credentials?: boolean;
  /** Shown above the credentials fields, e.g. "Wrong user name or password". */
  notice?: string;
  connected(mount: Mount, address: string): void;
}

const SCHEME_HINTS = "smb · sftp · ftp · dav · davs · afp";

/**
 * Connect to Server: a glass sheet with an address field and recent servers, which turns into
 * a credentials form when the server asks for a login.
 */
export function openServerSheet(shell: ShellContext, options: SheetOptions): void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let address = options.address ?? "";
  let step: "address" | "credentials" = options.credentials ? "credentials" : "address";
  let notice = options.notice ?? "";
  let busy = false;
  let closed = false;
  const typed = { user: "", domain: "" };

  const card = h("div", { class: "modal nw-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Connect to Server" });
  const overlay = h("div", { class: "modal-overlay nw-overlay" }, card);
  overlay.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });

  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }

  async function submit(creds?: Credentials) {
    if (busy) return;
    const parsed = normalizeAddress(address);
    if ("error" in parsed) {
      notice = parsed.error;
      render();
      return;
    }
    busy = true;
    notice = "";
    render();
    const outcome = await tryMount(parsed.uri, creds);
    busy = false;
    if (closed) return;
    if ("mount" in outcome) {
      saveServer(shell, outcome.mount, parsed.uri);
      close();
      options.connected(outcome.mount, parsed.uri);
      return;
    }
    if ("auth" in outcome) {
      step = "credentials";
      notice = creds ? outcome.auth : "";
    } else {
      notice = outcome.error;
    }
    render();
  }

  function field(label: string, input: HTMLInputElement) {
    return h("label", { class: "nw-field" }, h("span", { class: "nw-field-label" }, label), input);
  }

  function addressStep(): Node[] {
    const input = h("input", {
      class: "nw-input", type: "text", value: address, placeholder: "smb://server/share", spellcheck: false,
      autocomplete: "off", "aria-label": "Server address", disabled: busy,
    });
    input.addEventListener("input", () => (address = input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void submit();
    });
    const recent = shell.config.files.servers;
    const list = recent.length
      ? h("div", { class: "nw-recent" },
        h("div", { class: "nw-label" }, "Recent servers"),
        ...recent.map((server) => {
          const row = h("button", { class: "nw-server", type: "button", title: server.url },
            h("span", { class: "nw-server-icon" }, icon("network", 16)),
            h("span", { class: "nw-server-text" },
              h("span", { class: "nw-server-name" }, server.name),
              h("span", { class: "nw-server-url" }, server.url)),
            h("span", {
              class: "nw-server-x", title: "Remove from Recent Servers", role: "button",
              onclick: (e: Event) => {
                e.stopPropagation();
                shell.config.files.servers = shell.config.files.servers.filter((s) => s.url !== server.url);
                shell.saveConfig();
                render();
              },
            }, icon("close", 12)));
          row.addEventListener("click", () => {
            address = server.url;
            input.value = address;
            input.focus();
          });
          row.addEventListener("dblclick", () => void submit());
          return row;
        }))
      : h("p", { class: "nw-empty" }, "Servers you connect to appear here.");
    queueMicrotask(() => {
      if (!closed && !busy) {
        input.focus();
        input.select();
      }
    });
    return [
      h("div", { class: "nw-field" }, h("span", { class: "nw-field-label" }, "Server address"), input,
        h("span", { class: "nw-hint" }, SCHEME_HINTS)),
      list,
    ];
  }

  function credentialsStep(): (Node | null)[] {
    const user = h("input", { class: "nw-input", type: "text", autocomplete: "username", spellcheck: false, value: typed.user, disabled: busy });
    const domain = h("input", { class: "nw-input", type: "text", spellcheck: false, placeholder: "WORKGROUP", value: typed.domain, disabled: busy });
    const password = h("input", { class: "nw-input", type: "password", autocomplete: "current-password", disabled: busy });
    const remember = h("input", { class: "switch", type: "checkbox", id: "nw-remember", disabled: busy });
    const go = () => {
      typed.user = user.value;
      typed.domain = domain.value;
      void submit({ username: user.value.trim(), domain: domain.value.trim(), password: password.value, remember: remember.checked });
    };
    for (const input of [user, domain, password]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") go();
      });
    }
    credentialsSubmit = go;
    queueMicrotask(() => {
      if (!closed && !busy) user.focus();
    });
    return [
      h("p", { class: "nw-where" }, icon("network", 15), h("span", null, address)),
      field("User name", user),
      schemeOf(address) === "smb" ? field("Domain", domain) : null,
      field("Password", password),
      h("label", { class: "nw-remember", for: "nw-remember" }, remember, h("span", null, "Remember this password")),
    ];
  }

  let credentialsSubmit: (() => void) | null = null;

  function render() {
    credentialsSubmit = null;
    const credentials = step === "credentials";
    const title = credentials ? "Sign in" : "Connect to Server";
    const body = credentials ? credentialsStep() : addressStep();
    const primary = h("button", { class: "btn primary", type: "button", disabled: busy, onclick: () => (credentials ? credentialsSubmit?.() : void submit()) },
      busy ? h("span", { class: "spinner nw-spin" }) : null, busy ? "Connecting…" : credentials ? "Sign In" : "Connect");
    const back = credentials && !options.credentials
      ? h("button", { class: "btn ghost", type: "button", disabled: busy, onclick: () => { step = "address"; notice = ""; render(); } }, "Back")
      : null;
    card.replaceChildren(
      h("div", { class: "modal-head nw-head" },
        h("div", { class: "nw-head-text" }, h("h2", null, title),
          h("p", { class: "setup-summary" }, credentials ? "This server needs a user name and password." : "Reach a NAS, another computer or a cloud folder.")),
        h("button", { class: "icon-btn small", type: "button", title: "Close", "aria-label": "Close", onclick: close }, icon("close", 14))),
      h("div", { class: "modal-body nw-body" }, ...body,
        notice ? h("p", { class: "nw-error", role: "alert" }, notice) : null),
      h("div", { class: "modal-foot nw-foot" }, h("span", { class: "nw-spacer" }), back,
        h("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel"), primary));
  }

  render();
  document.body.append(overlay);
}
