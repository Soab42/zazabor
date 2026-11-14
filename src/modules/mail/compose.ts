import { open as openFiles } from "../../shared/dialog";
import { basename, h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu } from "../../ui/menu";
import { confirmSheet } from "../files/ops/sheets";
import { displayName, escapeHtml, longDate, mailApi, parseAddresses, safeHtml, textToHtml, type Account, type Address, type Attach, type Body, type Draft, type Message } from "./api";

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const signatureBlock = (account: Account | undefined) => (account?.signature ? `<div><br></div><div class="zz-signature">${account.signature}</div>` : "");

export function blankDraft(account: Account | undefined, to: Address[] = []): Draft {
  return { id: newId(), accountId: account?.id ?? "", to, cc: [], bcc: [], subject: "", html: `<div><br></div>${signatureBlock(account)}`, attachments: [], replyTo: null };
}

/**
 * A message's content made safe to sit in the editor (which is part of the page, not a frame):
 * no style sheets, no classes or ids that could pick up the app's styles, nothing positioned out
 * of the flow, and no large inline pictures.
 */
function quotable(body: Body): string {
  if (!body.html) return textToHtml(body.text);
  const doc = new DOMParser().parseFromString(body.html, "text/html");
  doc.querySelectorAll("style, link, meta, title, script").forEach((el) => el.remove());
  doc.querySelectorAll<HTMLElement>("*").forEach((el) => {
    el.removeAttribute("class");
    el.removeAttribute("id");
    if (el.style.position) el.style.removeProperty("position");
    if (el instanceof HTMLImageElement && el.src.startsWith("data:") && el.src.length > 200_000) el.remove();
  });
  return doc.body.innerHTML;
}

const mine = (accounts: Account[], addr: string) => accounts.some((a) => a.email.toLowerCase() === addr.toLowerCase());

function unique(list: Address[]): Address[] {
  const seen = new Set<string>();
  return list.filter((a) => a.addr && !seen.has(a.addr.toLowerCase()) && seen.add(a.addr.toLowerCase()));
}

const prefixed = (prefix: string, subject: string) => (new RegExp(`^${prefix}:`, "i").test(subject.trim()) ? subject.trim() : `${prefix}: ${subject.trim()}`);

/** A draft answering (or forwarding) a message. */
export function responseDraft(mode: "reply" | "replyAll" | "forward", message: Message, body: Body, accounts: Account[]): Draft {
  const account = accounts.find((a) => a.id === message.accountId);
  const draft = blankDraft(account);
  const original = quotable(body);
  const who = message.from.name ? `${escapeHtml(message.from.name)} &lt;${escapeHtml(message.from.addr)}&gt;` : escapeHtml(message.from.addr);
  if (mode === "forward") {
    const lines = [`From: ${who}`, `Date: ${escapeHtml(longDate(message.date))}`, `Subject: ${escapeHtml(message.subject)}`, `To: ${escapeHtml(message.to.map(displayName).join(", "))}`];
    draft.subject = prefixed("Fwd", message.subject);
    draft.html = `<div><br></div>${signatureBlock(account)}<div><br></div><div>---------- Forwarded message ----------<br>${lines.join("<br>")}</div><div><br></div>${original}`;
    draft.attachments = body.attachments.map((a): Attach => ({ kind: "part", message: message.id, index: a.index, name: a.name }));
    return draft;
  }
  const sentByMe = mine(accounts, message.from.addr);
  const author: Address = message.replyTo ? { name: message.from.name, addr: message.replyTo } : message.from;
  draft.to = sentByMe ? message.to : [author];
  if (mode === "replyAll") {
    const others = (list: Address[]) => list.filter((a) => !mine(accounts, a.addr));
    if (!sentByMe) draft.to = unique([author, ...others(message.to)]);
    draft.cc = unique(others(message.cc)).filter((a) => !draft.to.some((t) => t.addr.toLowerCase() === a.addr.toLowerCase()));
  }
  draft.subject = prefixed("Re", message.subject);
  draft.replyTo = message.id;
  draft.html = `<div><br></div>${signatureBlock(account)}<div><br></div><div class="zz-quote">On ${escapeHtml(longDate(message.date))}, ${who} wrote:<blockquote type="cite" style="margin:0 0 0 0.8ex;border-left:2px solid #c8c8c8;padding-left:1ex">${original}</blockquote></div>`;
  return draft;
}

/** A row of address chips with a text field after them, suggesting people written to before. */
function addressField(label: string, initial: Address[], onChange: () => void) {
  const chips: Address[] = [...initial];
  const input = h("input", { class: "ml-to-input", type: "text", spellcheck: "false", autocomplete: "off", "aria-label": label });
  const row = h("div", { class: "ml-to-chips" });
  const suggestions = h("div", { class: "ml-suggest", role: "listbox", hidden: true });
  const el = h("div", { class: "ml-to-row" }, h("span", { class: "ml-to-label" }, label), row, suggestions);
  let found: Address[] = [];
  let picked = 0;
  let asked = 0;

  const draw = () => {
    row.replaceChildren(
      ...chips.map((a, i) => {
        const remove = h("button", { class: "ml-chip-x", type: "button", tabindex: -1, "aria-label": `Remove ${a.addr}` }, icon("close", 10));
        remove.addEventListener("click", () => {
          chips.splice(i, 1);
          draw();
          onChange();
          input.focus();
        });
        return h("span", { class: "ml-chip", title: a.addr }, displayName(a), remove);
      }),
      input);
  };

  const hide = () => {
    suggestions.hidden = true;
    found = [];
  };

  /** Turns what's typed into chips; what isn't an address stays in the field. */
  const commit = (): boolean => {
    const { good, bad } = parseAddresses(input.value);
    for (const a of good) if (!chips.some((c) => c.addr.toLowerCase() === a.addr.toLowerCase())) chips.push(a);
    input.value = bad.join(", ");
    if (good.length) {
      draw();
      onChange();
    }
    hide();
    return bad.length === 0;
  };

  const pick = (a: Address) => {
    input.value = "";
    if (!chips.some((c) => c.addr.toLowerCase() === a.addr.toLowerCase())) chips.push(a);
    draw();
    onChange();
    hide();
    input.focus();
  };

  const drawSuggestions = () => {
    suggestions.hidden = found.length === 0;
    suggestions.replaceChildren(...found.map((a, i) => {
      const option = h("div", { class: `ml-suggest-item${i === picked ? " active" : ""}`, role: "option" }, h("span", null, a.name || a.addr), a.name ? h("span", { class: "ml-suggest-addr" }, a.addr) : null);
      option.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        pick(a);
      });
      return option;
    }));
  };

  input.addEventListener("input", () => {
    const text = input.value.trim();
    if (/[,;]\s*$/.test(input.value)) return void commit();
    if (text.length < 2) return hide();
    const ticket = ++asked;
    mailApi.contacts(text).then((list) => {
      if (ticket !== asked || input.value.trim() !== text) return;
      found = list.filter((a) => !chips.some((c) => c.addr.toLowerCase() === a.addr.toLowerCase()));
      picked = 0;
      drawSuggestions();
    }, hide);
  });
  input.addEventListener("keydown", (e) => {
    if (found.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      picked = (picked + (e.key === "ArrowDown" ? 1 : found.length - 1)) % found.length;
      drawSuggestions();
    } else if ((e.key === "Enter" || e.key === "Tab") && found.length) {
      e.preventDefault();
      pick(found[picked]);
    } else if (e.key === "Enter" || (e.key === " " && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.value.trim()))) {
      if (input.value.trim()) {
        e.preventDefault();
        commit();
      }
    } else if (e.key === "Backspace" && !input.value && chips.length) {
      chips.pop();
      draw();
      onChange();
    } else if (e.key === "Escape" && found.length) {
      e.stopPropagation();
      hide();
    }
  });
  input.addEventListener("blur", () => commit());
  input.addEventListener("paste", () => setTimeout(commit));
  el.addEventListener("click", (e) => {
    if (e.target === el || e.target === row) input.focus();
  });
  draw();
  return { el, input, get: () => [...chips], commit, focus: () => input.focus() };
}

export interface ComposeHost {
  accounts: Account[];
  /** Sends it (the host shows "Sending… Undo" first). */
  send(draft: Draft, text: string): void;
  toast(message: string): void;
}

let openSheet: { close(): void } | null = null;

/** The compose sheet. One at a time: opening another saves the first as a draft. */
export function openCompose(start: Draft, host: ComposeHost) {
  openSheet?.close();
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const draft: Draft = structuredClone(start);
  if (!host.accounts.some((a) => a.id === draft.accountId)) draft.accountId = host.accounts[0]?.id ?? "";
  let dirty = false;
  let saveTimer = 0;
  let closed = false;

  const touch = () => {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void mailApi.saveDraft(current()).catch(() => undefined), 1200);
  };

  // From: a menu when there's more than one account.
  const from = h("button", { class: "ml-from", type: "button" });
  const drawFrom = () => {
    const account = host.accounts.find((a) => a.id === draft.accountId);
    from.replaceChildren(h("span", { class: `ml-dot ml-c-${account?.color ?? "blue"}` }), account ? (account.name ? `${account.name} <${account.email}>` : account.email) : "No account", host.accounts.length > 1 ? icon("chevronDown", 12) : "");
    from.disabled = host.accounts.length < 2;
  };
  from.addEventListener("click", () => {
    const r = from.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, host.accounts.map((a) => ({
      label: a.name ? `${a.name} <${a.email}>` : a.email, icon: a.id === draft.accountId ? ("check" as IconName) : undefined,
      action: () => {
        // The signature follows the account.
        const old = host.accounts.find((x) => x.id === draft.accountId);
        draft.accountId = a.id;
        const block = editor.querySelector(".zz-signature");
        if (block && old?.signature !== a.signature) {
          if (a.signature) block.innerHTML = safeHtml(a.signature);
          else block.remove();
        }
        drawFrom();
        touch();
      },
    })));
  });
  drawFrom();

  const to = addressField("To", draft.to, touch);
  const cc = addressField("Cc", draft.cc, touch);
  const bcc = addressField("Bcc", draft.bcc, touch);
  const more = h("button", { class: "ml-link ml-ccbcc", type: "button" }, "Cc Bcc");
  const showMore = () => {
    cc.el.hidden = false;
    bcc.el.hidden = false;
    more.hidden = true;
  };
  cc.el.hidden = bcc.el.hidden = draft.cc.length + draft.bcc.length === 0;
  more.hidden = !cc.el.hidden;
  more.addEventListener("click", () => {
    showMore();
    cc.focus();
  });
  to.el.append(more);

  const subject = h("input", { class: "ml-subject", type: "text", placeholder: "Subject", "aria-label": "Subject", value: draft.subject });
  subject.addEventListener("input", touch);

  const editor = h("div", { class: "ml-editor", contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": "Message", spellcheck: "true" });
  // This app's own text, or a message the backend cleaned and `quotable` flattened; made inert once more.
  editor.innerHTML = safeHtml(draft.html);
  editor.addEventListener("input", touch);

  const run = (command: string, value?: string) => {
    editor.focus();
    document.execCommand(command, false, value);
    touch();
  };
  const tool = (glyph: IconName, title: string, action: () => void) => {
    const button = h("button", { class: "icon-btn small", type: "button", title, "aria-label": title, tabindex: -1 }, icon(glyph, 15));
    button.addEventListener("pointerdown", (e) => e.preventDefault());
    button.addEventListener("click", action);
    return button;
  };
  const linkInput = h("input", { class: "ml-input ml-link-input", type: "url", placeholder: "https://", "aria-label": "Link address" });
  const linkBar = h("div", { class: "ml-linkbar", hidden: true }, linkInput, h("button", { class: "btn small primary", type: "button", onclick: () => applyLink() }, "Add Link"));
  let linkRange: Range | null = null;
  const applyLink = () => {
    const url = linkInput.value.trim();
    linkBar.hidden = true;
    if (!url || !linkRange) return;
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(linkRange);
    const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    if (linkRange.collapsed) run("insertHTML", `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>`);
    else run("createLink", href);
  };
  linkInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyLink();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      linkBar.hidden = true;
      editor.focus();
    }
  });
  const tools = h("div", { class: "ml-tools", role: "toolbar", "aria-label": "Formatting" });
  const letter = (text: string, cls: string, title: string, command: string) => {
    const button = h("button", { class: `icon-btn small ml-letter ${cls}`, type: "button", title, "aria-label": title, tabindex: -1 }, text);
    button.addEventListener("pointerdown", (e) => e.preventDefault());
    button.addEventListener("click", () => run(command));
    return button;
  };
  tools.replaceChildren(
    letter("B", "b", "Bold (Ctrl+B)", "bold"), letter("I", "i", "Italic (Ctrl+I)", "italic"), letter("U", "u", "Underline (Ctrl+U)", "underline"), letter("S", "s", "Strikethrough", "strikeThrough"),
    h("span", { class: "ml-tools-sep" }),
    tool("bullets", "Bulleted list", () => run("insertUnorderedList")), tool("numbers", "Numbered list", () => run("insertOrderedList")),
    tool("indent", "Quote", () => run("formatBlock", "blockquote")), tool("outdent", "Less indent", () => run("outdent")),
    h("span", { class: "ml-tools-sep" }),
    tool("link", "Link", () => {
      const selection = getSelection();
      linkRange = selection?.rangeCount && editor.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
      if (!linkRange) {
        editor.focus();
        linkRange = getSelection()?.getRangeAt(0).cloneRange() ?? null;
      }
      linkBar.hidden = false;
      linkInput.value = "";
      linkInput.focus();
    }),
    tool("eraser", "Clear formatting", () => run("removeFormat")));

  const files = h("div", { class: "ml-files" });
  const drawFiles = () => {
    files.hidden = draft.attachments.length === 0;
    files.replaceChildren(...draft.attachments.map((a, i) => {
      const remove = h("button", { class: "ml-chip-x", type: "button", "aria-label": `Remove ${a.name}` }, icon("close", 10));
      remove.addEventListener("click", () => {
        draft.attachments.splice(i, 1);
        drawFiles();
        touch();
      });
      return h("span", { class: "ml-file" }, icon("paperclip", 13), h("span", { class: "ml-file-name" }, a.name), remove);
    }));
  };
  drawFiles();

  const error = h("p", { class: "ml-error", role: "alert", hidden: true });
  const send = h("button", { class: "btn primary ml-send", type: "button", title: "Send (Ctrl+Enter)" }, icon("send", 14), "Send");
  const attach = h("button", { class: "icon-btn", type: "button", title: "Attach files", "aria-label": "Attach files" }, icon("paperclip", 17));
  const discard = h("button", { class: "icon-btn", type: "button", title: "Discard", "aria-label": "Discard" }, icon("trash", 17));
  const closeButton = h("button", { class: "icon-btn", type: "button", title: "Save and close (Esc)", "aria-label": "Close" }, icon("close", 16));
  const title = h("h2", null, draft.subject || "New Message");
  subject.addEventListener("input", () => (title.textContent = subject.value.trim() || "New Message"));

  const card = h("div", { class: "modal ml-compose", role: "dialog", "aria-modal": "true", "aria-label": "New message" },
    h("div", { class: "ml-compose-head" }, title, closeButton),
    h("div", { class: "ml-compose-fields" }, h("div", { class: "ml-to-row" }, h("span", { class: "ml-to-label" }, "From"), from), to.el, cc.el, bcc.el, subject),
    h("div", { class: "ml-compose-body" }, editor),
    files, linkBar, error,
    h("div", { class: "ml-compose-foot" }, send, tools, h("span", { class: "ops-spacer" }), attach, discard));
  const overlay = h("div", { class: "modal-overlay ml-overlay ml-compose-overlay" }, card);

  function current(): Draft {
    return { ...draft, to: to.get(), cc: cc.get(), bcc: bcc.get(), subject: subject.value, html: editor.innerHTML };
  }

  /** Nothing was written: only the empty lines and the signature are there. */
  function empty(): boolean {
    const copy = editor.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".zz-signature, .zz-quote").forEach((el) => el.remove());
    const d = current();
    return !copy.textContent?.trim() && !d.subject.trim() && d.to.length + d.cc.length + d.bcc.length === 0 && d.attachments.length === 0;
  }

  function shut() {
    if (closed) return;
    closed = true;
    clearTimeout(saveTimer);
    overlay.remove();
    if (openSheet === handle) openSheet = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }

  /** Closes, keeping what was written as a draft. */
  function close() {
    if (closed) return;
    [to, cc, bcc].forEach((f) => f.commit());
    if (empty()) void mailApi.deleteDraft(draft.id).catch(() => undefined);
    else if (dirty) {
      void mailApi.saveDraft(current()).catch(() => undefined);
      host.toast("Saved to Drafts");
    }
    shut();
  }
  const handle = { close };
  openSheet = handle;

  async function submit() {
    error.hidden = true;
    const clean = [to, cc, bcc].map((f) => f.commit());
    const d = current();
    const fail = (message: string) => {
      error.hidden = false;
      error.textContent = message;
    };
    if (!clean.every(Boolean)) return fail("One of the addresses doesn't look right. Fix it or remove it.");
    if (!d.accountId) return fail("Add an email account first.");
    if (d.to.length + d.cc.length + d.bcc.length === 0) {
      to.focus();
      return fail("Add someone to send it to.");
    }
    if (!d.subject.trim() && !(await confirmSheet({ title: "Send without a subject?", message: "This message has no subject.", confirmLabel: "Send Anyway", icon: "send" }))) return void subject.focus();
    host.send(d, editor.innerText.replace(/\n{3,}/g, "\n\n").trim());
    shut();
  }

  send.addEventListener("click", () => void submit());
  closeButton.addEventListener("click", close);
  discard.addEventListener("click", () => {
    void mailApi.deleteDraft(draft.id).catch(() => undefined);
    shut();
  });
  attach.addEventListener("click", async () => {
    const paths = await openFiles({ title: "Attach Files", multiple: true });
    if (!paths?.length) return;
    for (const path of paths) if (!draft.attachments.some((a) => a.kind === "file" && a.path === path)) draft.attachments.push({ kind: "file", path, name: basename(path) });
    drawFiles();
    touch();
  });
  overlay.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      showMore();
      cc.focus();
    }
  });
  document.body.append(overlay);
  if (draft.to.length === 0) to.focus();
  else if (!draft.subject) subject.focus();
  else {
    editor.focus();
    const range = document.createRange();
    range.setStart(editor, 0);
    range.collapse(true);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  }
}
