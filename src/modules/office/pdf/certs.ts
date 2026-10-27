import { invoke } from "@tauri-apps/api/core";
import { open } from "../../../shared/dialog";
import { basename, h } from "../../../ui/dom";
import { icon } from "../../../ui/icons";
import { field, openDialog, textInput } from "../../time/dialog";

/**
 * Certificate signatures (docs/plans/pdf.md §4.7): signing with a .p12/.pfx file, and the
 * Signatures panel that checks the ones a file has. The work is in Rust
 * (src-tauri/src/office/pdf_tools/sign.rs); the signed file must be saved exactly as it comes back.
 */

export interface SigInfo {
  field: string;
  signer: string;
  issuer: string;
  email: string;
  /** The claimed signing time, as the file writes it (D:…). */
  signedAt: string;
  reason: string;
  location: string;
  subFilter: string;
  intact: boolean;
  trusted: boolean;
  whole: boolean;
  page: number | null;
  rect: [number, number, number, number] | null;
  problem: string | null;
}

export interface CertInfo {
  name: string;
  issuer: string;
  email: string;
  validFrom: string;
  validTo: string;
  expired: boolean;
  selfSigned: boolean;
}

export interface SignChoice {
  certPath: string;
  certPassword: string;
  reason: string;
  location: string;
  visible: boolean;
  /** A saved signature picture to show beside the words (a PNG data URL). */
  picture: string | null;
}

function bytesOf(result: unknown): Uint8Array {
  return result instanceof ArrayBuffer ? new Uint8Array(result) : result instanceof Uint8Array ? result : new Uint8Array(result as number[]);
}

/** The body `pdf_edit` and `pdf_sign` take: the job, then the file and pictures. */
function body(job: unknown, parts: Uint8Array[]): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(job));
  const size = 8 + json.length + parts.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  view.setUint32(at, json.length, true);
  out.set(json, (at += 4));
  at += json.length;
  view.setUint32(at, parts.length, true);
  at += 4;
  for (const p of parts) {
    view.setUint32(at, p.length, true);
    out.set(p, (at += 4));
    at += p.length;
  }
  return out;
}

export const certApi = {
  info: (path: string, password: string) => invoke<CertInfo>("pdf_cert_info", { path, password }),
  verify: (pdf: Uint8Array) => invoke<SigInfo[]>("pdf_verify_signatures", pdf),
  /** Signs `pdf`; `page`/`rect` place a visible signature (page from 1, rect in its own space). */
  async sign(pdf: Uint8Array, c: SignChoice, page: number, rect: [number, number, number, number] | null, picture: Uint8Array | null): Promise<Uint8Array> {
    const job = {
      sign: {
        certPath: c.certPath, certPassword: c.certPassword, reason: c.reason, location: c.location,
        page: rect ? page : 0, rect, image: picture ? 1 : null,
      },
    };
    return bytesOf(await invoke("pdf_sign", body(job, picture ? [pdf, picture] : [pdf])));
  },
};

/** The certificate last signed with (the path only; never the password). */
const LAST_CERT = "zazabor.pdf.certificate";

export function lastCertificate(): string {
  try {
    return localStorage.getItem(LAST_CERT) ?? "";
  } catch {
    return "";
  }
}

function rememberCertificate(path: string) {
  try {
    localStorage.setItem(LAST_CERT, path);
  } catch {
    // Remembering is a convenience.
  }
}

export function forgetCertificate() {
  try {
    localStorage.removeItem(LAST_CERT);
  } catch {
    // Nothing to forget.
  }
}

const REASONS = ["I am the author of this document", "I approve this document", "I have reviewed this document", "I agree to the terms of this document"];

/** Asks for the certificate, its password and what the signature says. */
export function signDialog(savedPicture: string | null): Promise<SignChoice | null> {
  return new Promise((resolve) => {
    let answer: SignChoice | null = null;
    let certPath = lastCertificate();
    const certName = h("span", { class: "pf-cert-file" }, certPath ? basename(certPath) : "No certificate chosen");
    const choose = h("button", {
      class: "btn small", type: "button",
      onclick: async () => {
        const picked = await open({ title: "Choose Your Certificate", multiple: false, filters: [{ name: "Certificates", extensions: ["p12", "pfx"] }] }).catch(() => null);
        if (!picked) return;
        certPath = picked;
        certName.textContent = basename(picked);
        details.replaceChildren();
        password.focus();
      },
    }, "Choose…");
    const password = textInput({ type: "password", autocomplete: "off", "aria-label": "Certificate password" });
    const details = h("div", { class: "pf-cert-details" });
    const reason = h("select", { class: "tt-input pf-select", "aria-label": "Reason" },
      h("option", { value: "" }, "No reason"), ...REASONS.map((r) => h("option", { value: r }, r)));
    reason.value = REASONS[1];
    const location = textInput({ placeholder: "Dhaka", "aria-label": "Location" });
    const visible = h("input", { type: "checkbox", checked: true });
    const withPicture = h("input", { type: "checkbox", checked: !!savedPicture, disabled: !savedPicture });
    const sync = () => (withPicture.disabled = !savedPicture || !visible.checked);
    visible.addEventListener("change", sync);
    sync();

    const check = async (): Promise<CertInfo | null> => {
      if (!certPath) {
        dialog.error("Choose your certificate file (.p12 or .pfx).");
        return null;
      }
      try {
        const info = await certApi.info(certPath, password.value);
        details.replaceChildren(
          h("div", { class: "pf-cert-line" }, icon("pfCertificate", 14), h("b", null, info.name), info.email ? h("span", null, info.email) : null),
          h("div", { class: "pf-cert-line pf-note" }, `Issued by ${info.issuer}${info.selfSigned ? " (self-signed: other people's apps will say the signer is unknown)" : ""} · valid until ${info.validTo}`));
        if (info.expired) {
          dialog.error("This certificate has expired, so it can't sign.");
          return null;
        }
        return info;
      } catch (err) {
        dialog.error(String(err));
        return null;
      }
    };
    password.addEventListener("change", () => void check());

    const ok = async () => {
      if (!(await check())) return;
      rememberCertificate(certPath);
      answer = {
        certPath,
        certPassword: password.value,
        reason: reason.value,
        location: location.value.trim(),
        visible: visible.checked,
        picture: visible.checked && withPicture.checked ? savedPicture : null,
      };
      dialog.close();
    };
    const dialog = openDialog({
      title: "Sign with a Certificate",
      subtitle: "A digital signature proves who signed and that nothing changed since. Zazabor saves the signed file right away.",
      icon: "pfCertificate",
      tone: "work",
      class: "pf-wide",
      body: [
        field("Certificate (.p12 or .pfx)", h("div", { class: "pf-row pf-cert-row" }, certName, choose)),
        field("Password", password),
        details,
        h("div", { class: "pf-row" }, field("Reason", reason), field("Location", location)),
        h("label", { class: "pf-check" }, visible, "Show the signature on the page (drag a box where it goes)"),
        h("div", { class: "pf-indent" }, h("label", { class: "pf-check" }, withPicture, savedPicture ? "With my saved handwritten signature" : "With my handwritten signature (save one with Fill & Sign → Sign first)")),
        h("p", { class: "tt-dialog-text pf-note" }, "Once signed, changing the pages (Edit, Protect, Organize) makes the signature invalid. Comments and form values added later are kept beside it, as Acrobat does."),
      ],
      foot: [
        h("span", { class: "spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: () => void ok() }, "Sign"),
      ],
      submit: () => void ok(),
      onClose: () => resolve(answer),
    });
    if (certPath) password.focus();
  });
}

/** A signature's state in words, and how it shows (good, caution or bad). */
export function sigStatus(s: SigInfo): { tone: "good" | "caution" | "bad"; title: string; text: string } {
  if (s.problem) return { tone: "bad", title: "Can't be checked", text: s.problem };
  if (!s.intact) return { tone: "bad", title: "Invalid", text: "The document was changed after it was signed, or the signature is damaged." };
  const later = s.whole ? "" : " Changes were made after it (comments, form values or another signature).";
  if (!s.trusted) return { tone: "caution", title: "Signer not verified", text: `The signed part hasn't changed, but the certificate isn't from an authority this computer trusts.${later}` };
  return { tone: s.whole ? "good" : "caution", title: "Valid", text: `The signed part hasn't changed and the signer's certificate is trusted.${later}` };
}

/** The Signatures panel's list. `when` formats a PDF date; `go` shows a page. */
export function signaturesPanel(list: SigInfo[] | null, when: (date: string) => string, go: (page: number) => void): HTMLElement {
  if (!list) return h("div", { class: "pf-empty" }, "Checking signatures…");
  if (!list.length) return h("div", { class: "pf-empty" }, "This document has no digital signatures. Fill & Sign → Certificate signs it with yours.");
  return h("div", { class: "pf-sigs" }, ...list.map((s) => {
    const status = sigStatus(s);
    return h("button", { class: `pf-sig ${status.tone}`, type: "button", disabled: !s.page, onclick: () => s.page && go(s.page) },
      h("span", { class: "pf-sig-icon" }, icon(status.tone === "bad" ? "close" : status.tone === "good" ? "check" : "info", 14)),
      h("span", { class: "pf-sig-main" },
        h("span", { class: "pf-sig-head" }, h("b", null, s.signer || s.field), h("span", null, status.title)),
        h("span", { class: "pf-sig-text" }, status.text),
        h("span", { class: "pf-sig-meta" }, [s.signedAt ? when(s.signedAt) : "", s.reason, s.location, s.issuer ? `Issued by ${s.issuer}` : ""].filter(Boolean).join(" · "))));
  }));
}
