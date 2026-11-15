import { save as saveDialog } from "../../shared/dialog";
import { formatBytes, h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu, type MenuItem } from "../../ui/menu";
import { displayName, hueOf, inertDocument, initials, longDate, mailApi, shortDate, textToHtml, type Account, type Address, type Attachment, type Body, type Message } from "./api";

export type ThreadAction = "archive" | "trash" | "junk" | "inbox" | "unread" | "star" | "move";

export interface ReaderHost {
  accounts(): Account[];
  /** Whether pictures from the web load without asking. */
  alwaysImages(): boolean;
  setAlwaysImages(): void;
  openUrl(url: string): void;
  openPath(path: string): void;
  respond(mode: "reply" | "replyAll" | "forward", message: Message, body: Body): void;
  writeTo(address: string): void;
  /** An action on the whole conversation (the toolbar's buttons). */
  act(action: ThreadAction, anchor: HTMLElement): void;
  starMessage(message: Message, on: boolean): void;
  toast(message: string): void;
  back(): void;
}

export function avatar(a: Address, size = 32): HTMLElement {
  const el = h("span", { class: "ml-avatar", style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px` } }, initials(a));
  el.style.setProperty("--hue", String(hueOf(a)));
  return el;
}

/**
 * The style of an HTML message. It sits in a shadow root, so its own style sheets reach nothing
 * else and the app's reach nothing in it. A message with no colours of its own takes the app's
 * (`themed`); the rest stay on white paper, as their senders designed them.
 */
const MESSAGE_STYLE = `
:host { display: block; contain: layout paint; isolation: isolate; overflow-x: auto; }
.zz-body { padding: 18px 20px; font: 14px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1d1d1f; background: #ffffff; overflow-wrap: anywhere; cursor: auto; -webkit-user-select: text; user-select: text; }
.zz-body * { -webkit-user-select: text; user-select: text; }
.zz-body img { max-width: 100%; height: auto; }
.zz-body img:not([src]) { visibility: hidden; }
.zz-body table { max-width: 100%; }
.zz-body pre { white-space: pre-wrap; }
.zz-body blockquote { margin: 0 0 0 0.8ex; padding-left: 1ex; border-left: 2px solid #c8c8c8; }
.zz-body [data-href] { cursor: pointer; }
.zz-body a[data-href] { color: #0b62d6; text-decoration: underline; }
.zz-body [data-href]:focus-visible { outline: 2px solid #0b62d6; outline-offset: 1px; }
.zz-body.themed { padding: 2px 0 6px; background: transparent; color: var(--text); font: inherit; font-size: 13.5px; line-height: 1.6; }
.zz-body.themed a[data-href] { color: var(--accent); }
.zz-body.themed blockquote { border-left-color: var(--line-strong); color: var(--text-2); }
.zz-body.themed hr { border: 0; border-top: 1px solid var(--line-strong); }
.zz-hidden { display: none !important; }`;

function fileIcon(mime: string): IconName {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "music";
  if (mime === "application/pdf") return "pdfFile";
  if (/zip|compressed|tar|rar|7z/.test(mime)) return "fileArchive";
  if (/word|document/.test(mime)) return "docFile";
  if (/sheet|excel|csv/.test(mime)) return "sheetFile";
  return "file";
}

/** The reading pane: a conversation as a stack of messages, the newest (and unread ones) open. */
export function createReader(host: ReaderHost) {
  let messages: Message[] = [];
  const cards = new Map<number, ReturnType<typeof card>>();
  const bodies = new Map<string, Promise<Body>>();

  const subject = h("h1", { class: "ml-subject-title" });
  const count = h("span", { class: "ml-thread-count" });
  const list = h("div", { class: "ml-messages" });
  const scroll = h("div", { class: "ml-reader-scroll" }, h("div", { class: "ml-reader-inner" }, h("div", { class: "ml-reader-head" }, subject, count), list));

  const button = (glyph: IconName, title: string, action: ThreadAction | (() => void)) => {
    const el = h("button", { class: "icon-btn", type: "button", title, "aria-label": title }, icon(glyph, 17));
    el.addEventListener("click", () => (typeof action === "function" ? action() : host.act(action, el)));
    return el;
  };
  const back = h("button", { class: "icon-btn ml-back", type: "button", title: "Back to the list", "aria-label": "Back" }, icon("back", 17));
  back.addEventListener("click", () => host.back());
  const junk = button("junk", "Junk (!)", "junk");
  const notJunk = button("inbox", "Not junk: move to the inbox", "inbox");
  const star = button("star", "Star (S)", "star");
  const last = () => messages[messages.length - 1];
  const respond = (mode: "reply" | "replyAll" | "forward", message = last()) => {
    if (!message) return;
    body(message.id, false).then((b) => host.respond(mode, message, b), (err) => host.toast(String(err)));
  };
  const bar = h("header", { class: "ml-reader-bar" },
    back,
    button("archive", "Archive (E)", "archive"), button("trash", "Delete (Delete)", "trash"), junk, notJunk,
    h("span", { class: "ml-bar-sep" }),
    button("mail", "Mark as unread (U)", "unread"), star, button("folder", "Move to… (V)", "move"),
    h("span", { class: "spacer" }),
    button("reply", "Reply (R)", () => respond("reply")), button("replyAll", "Reply to all (A)", () => respond("replyAll")), button("forward", "Forward (F)", () => respond("forward")));
  const empty = h("div", { class: "ml-reader-empty" }, h("div", { class: "cp-empty-tile glass" }, icon("mail", 30)), h("p", null, "Pick a conversation to read it here."));
  const el = h("section", { class: "ml-reader empty" }, bar, scroll, empty);

  function body(id: number, images: boolean): Promise<Body> {
    const key = `${id}:${images}`;
    let found = bodies.get(key);
    if (!found) {
      if (bodies.size > 80) bodies.clear();
      found = mailApi.body(id, images);
      bodies.set(key, found);
      found.catch(() => bodies.delete(key));
    }
    return found;
  }

  function card(first: Message, open: boolean) {
    let m = first;
    let loaded = false;
    let expanded = false;
    let images = host.alwaysImages();

    const unread = h("span", { class: "ml-unread-dot", hidden: true });
    const name = h("span", { class: "ml-msg-name" });
    const address = h("span", { class: "ml-msg-addr" });
    const preview = h("span", { class: "ml-msg-preview" });
    const date = h("span", { class: "ml-msg-date" });
    const recipients = h("div", { class: "ml-msg-to" });
    const starButton = h("button", { class: "icon-btn small ml-msg-star", type: "button" });
    starButton.addEventListener("click", (e) => {
      e.stopPropagation();
      host.starMessage(m, !m.flagged);
    });
    const replyButton = h("button", { class: "icon-btn small", type: "button", title: "Reply", "aria-label": "Reply" }, icon("reply", 15));
    replyButton.addEventListener("click", (e) => {
      e.stopPropagation();
      respond("reply", m);
    });
    const moreButton = h("button", { class: "icon-btn small", type: "button", title: "More", "aria-label": "More" }, icon("more", 15));
    moreButton.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = moreButton.getBoundingClientRect();
      const items: MenuItem[] = [
        { label: "Reply", icon: "reply", action: () => respond("reply", m) },
        { label: "Reply to All", icon: "replyAll", action: () => respond("replyAll", m) },
        { label: "Forward", icon: "forward", action: () => respond("forward", m) },
        "separator",
        { label: "Write to the Sender", icon: "pencil", action: () => host.writeTo(m.from.addr) },
        { label: "Copy the Sender’s Address", icon: "copy", action: () => void navigator.clipboard.writeText(m.from.addr).then(() => host.toast("Copied")) },
      ];
      openMenu(r.right - 200, r.bottom + 4, items);
    });
    const tools = h("div", { class: "ml-msg-tools" }, starButton, replyButton, moreButton);
    const head = h("div", { class: "ml-msg-head", tabindex: 0, role: "button" },
      avatar(m.from, 34),
      h("div", { class: "ml-msg-who" }, h("div", { class: "ml-msg-line" }, unread, name, address, preview), recipients),
      date, tools);
    const content = h("div", { class: "ml-msg-content", hidden: true });
    const el = h("article", { class: "ml-msg" }, head, content);
    head.addEventListener("click", () => toggle(!expanded));
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle(!expanded);
      }
    });

    function update(next: Message) {
      m = next;
      unread.hidden = m.seen;
      name.textContent = displayName(m.from);
      address.textContent = m.from.name ? `<${m.from.addr}>` : "";
      preview.textContent = m.snippet;
      date.textContent = expanded ? longDate(m.date) : shortDate(m.date);
      date.title = longDate(m.date);
      const all = [...m.to, ...m.cc];
      recipients.textContent = all.length ? `to ${all.map((a) => (host.accounts().some((x) => x.email.toLowerCase() === a.addr.toLowerCase()) ? "me" : displayName(a))).join(", ")}` : "";
      recipients.title = all.map((a) => (a.name ? `${a.name} <${a.addr}>` : a.addr)).join(", ");
      starButton.replaceChildren(icon(m.flagged ? "starFilled" : "star", 15));
      starButton.classList.toggle("on", m.flagged);
      starButton.title = m.flagged ? "Remove the star" : "Star";
      starButton.setAttribute("aria-label", starButton.title);
    }

    function toggle(on: boolean) {
      expanded = on;
      el.classList.toggle("open", on);
      content.hidden = !on;
      date.textContent = on ? longDate(m.date) : shortDate(m.date);
      if (on && !loaded) load();
    }

    function load() {
      loaded = true;
      content.replaceChildren(h("div", { class: "ml-msg-loading" }, h("span", { class: "spinner" }), m.body ? "" : "Fetching the message…"));
      body(m.id, images).then(show, (err) => {
        loaded = false;
        const retry = h("button", { class: "btn small", type: "button", onclick: () => load() }, "Try Again");
        content.replaceChildren(h("div", { class: "ml-msg-failed" }, icon("info", 16), h("p", null, String(err)), retry));
      });
    }

    function show(b: Body) {
      const parts: HTMLElement[] = [];
      if (b.blockedImages) {
        const showOnce = h("button", { class: "btn small", type: "button" }, "Show Pictures");
        showOnce.addEventListener("click", () => {
          images = true;
          load();
        });
        const always = h("button", { class: "btn small ghost", type: "button" }, "Always Show");
        always.addEventListener("click", () => {
          host.setAlwaysImages();
          images = true;
          load();
        });
        parts.push(h("div", { class: "ml-images-bar" }, icon("eyeOff", 15), h("span", null, "Pictures from the web are hidden: loading them tells the sender you opened this."), showOnce, always));
      }
      if (b.unsubscribe) {
        const link = h("button", { class: "ml-link ml-unsubscribe", type: "button" }, "Unsubscribe");
        link.addEventListener("click", () => (b.unsubscribe!.startsWith("mailto:") ? host.writeTo(b.unsubscribe!.slice(7).split("?")[0]) : host.openUrl(b.unsubscribe!)));
        recipients.append(" · ", link);
      }
      parts.push(b.html ? htmlView(b.html) : textView(b.text));
      if (b.attachments.length) parts.push(h("div", { class: "ml-attachments" }, ...b.attachments.map((a) => attachment(m, a))));
      content.replaceChildren(...parts);
    }

    update(m);
    toggle(open);
    return { el, update, id: m.id };
  }

  /** Clicks (and Enter) on what was a link open the browser, or a new message for a mail address. */
  function followLinks(el: HTMLElement) {
    const follow = (target: EventTarget | null) => {
      const href = (target as Element | null)?.closest?.("[data-href]")?.getAttribute("data-href") ?? "";
      if (/^mailto:/i.test(href)) host.writeTo(decodeURIComponent(href.slice(7).split("?")[0]));
      else if (/^https?:\/\//i.test(href)) host.openUrl(href);
    };
    el.addEventListener("click", (e) => {
      // Dragging across a link to select its text isn't a click on it.
      if (getSelection()?.isCollapsed === false) return;
      follow(e.target);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") follow(e.target);
    });
  }

  /** A plain message: its text, with the web addresses in it made links. */
  function textView(text: string): HTMLElement {
    const view = h("div", { class: "ml-msg-text" });
    // `textToHtml` escapes everything and adds only line breaks and links, which `inertDocument` disarms.
    view.append(...inertDocument(textToHtml(text.trimEnd())).body.childNodes);
    followLinks(view);
    return view;
  }

  /**
   * An HTML message, inside a shadow root. The backend already cleaned it (no scripts, forms or
   * frames) and the app's content policy runs none; here it is parsed apart from the page, and
   * its links lose their addresses to a data attribute, so a click can only do what this code
   * does with it: open the browser.
   */
  function htmlView(html: string): HTMLElement {
    const doc = inertDocument(html);
    const view = h("div", { class: "ml-html" });
    const root = view.attachShadow({ mode: "closed" });
    const content = document.createElement("div");
    const style = document.createElement("style");
    style.textContent = MESSAGE_STYLE;
    root.append(style);
    // The message's own style sheets apply inside the root only; "body" in them means this box.
    doc.querySelectorAll("style").forEach((sheet) => {
      const own = document.createElement("style");
      own.textContent = (sheet.textContent ?? "").replace(/(^|[\s,}])(?:html\s+)?body(?=[\s,{.:#[>+~])/gi, "$1.zz-body").replace(/(^|[\s,}])html(?=[\s,{])/gi, "$1:host");
      root.append(own);
      sheet.remove();
    });
    // A message that sets no colours of its own reads in the app's colours.
    const themed = !root.querySelector("style:not(:first-child)") && !doc.querySelector("[bgcolor], [color], [background], [style*='color'], [style*='background'], table[border], font");
    content.className = `zz-body${themed ? " themed" : ""}`;
    view.classList.toggle("paper", !themed);
    content.append(...doc.body.childNodes);
    root.append(content);

    followLinks(content);

    // The messages quoted under an answer fold away behind a "…" button.
    const quote = content.querySelector<HTMLElement>(".gmail_quote, .zz-quote, .moz-cite-prefix, blockquote[type='cite'], #divRplyFwdMsg, #appendonsend");
    if (!quote || (content.textContent ?? "").trim().length <= (quote.textContent ?? "").trim().length) return view;
    const fold: HTMLElement[] = [quote];
    if (!quote.matches(".gmail_quote, .zz-quote, blockquote")) for (let next = quote.nextElementSibling; next; next = next.nextElementSibling) fold.push(next as HTMLElement);
    fold.forEach((node) => node.classList.add("zz-hidden"));
    const toggle = h("button", { class: "ml-quoted-toggle", type: "button", title: "Show the earlier messages", "aria-label": "Show the earlier messages", "aria-expanded": "false" }, icon("more", 16));
    toggle.addEventListener("click", () => {
      const hide = !fold[0].classList.contains("zz-hidden");
      fold.forEach((node) => node.classList.toggle("zz-hidden", hide));
      toggle.setAttribute("aria-expanded", String(!hide));
    });
    return h("div", { class: "ml-html-wrap" }, view, toggle);
  }

  function attachment(m: Message, a: Attachment): HTMLElement {
    const open = () => {
      host.toast(`Opening ${a.name}…`);
      mailApi.attachment(m.id, a.index).then((path) => host.openPath(path), (err) => host.toast(String(err)));
    };
    const saveAs = async () => {
      const path = await saveDialog({ title: "Save Attachment", defaultPath: a.name });
      if (!path) return;
      mailApi.attachment(m.id, a.index, path).then(() => host.toast(`Saved ${a.name}`), (err) => host.toast(String(err)));
    };
    const save = h("button", { class: "icon-btn small ml-attachment-save", type: "button", title: "Save as…", "aria-label": `Save ${a.name}` }, icon("download", 15));
    save.addEventListener("click", (e) => {
      e.stopPropagation();
      void saveAs();
    });
    const el = h("div", { class: "ml-attachment", tabindex: 0, role: "button", title: `Open ${a.name}` },
      h("span", { class: "ml-attachment-icon" }, icon(fileIcon(a.mime), 18)),
      h("span", { class: "ml-attachment-text" }, h("span", { class: "ml-attachment-name" }, a.name), h("span", { class: "ml-attachment-size" }, formatBytes(a.size))),
      save);
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") open();
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [{ label: "Open", icon: "external", action: open }, { label: "Save As…", icon: "download", action: () => void saveAs() }]);
    });
    return el;
  }

  return {
    el,
    /** Shows a conversation; the same one again only refreshes what changed (stars, read marks, new answers). */
    show(next: Message[], inJunk: boolean) {
      const same = messages.length > 0 && next.length >= messages.length && messages.every((m, i) => next[i]?.id === m.id);
      messages = next;
      el.classList.toggle("empty", next.length === 0);
      if (!next.length) {
        cards.clear();
        list.replaceChildren();
        return;
      }
      subject.textContent = next[next.length - 1].subject || next[0].subject || "(no subject)";
      count.textContent = next.length > 1 ? String(next.length) : "";
      junk.hidden = inJunk;
      notJunk.hidden = !inJunk;
      const starred = next.some((m) => m.flagged);
      star.replaceChildren(icon(starred ? "starFilled" : "star", 17));
      star.classList.toggle("active", starred);
      if (same) {
        for (const m of next) {
          const existing = cards.get(m.id);
          if (existing) existing.update(m);
          else {
            const made = card(m, true);
            cards.set(m.id, made);
            list.append(made.el);
          }
        }
        return;
      }
      cards.clear();
      const firstUnread = next.findIndex((m) => !m.seen);
      const made = next.map((m, i) => card(m, i === next.length - 1 || (firstUnread >= 0 && i >= firstUnread)));
      made.forEach((c) => cards.set(c.id, c));
      list.replaceChildren(...made.map((c) => c.el));
      scroll.scrollTop = 0;
      // A long conversation opens at its first unread message.
      const target = made[firstUnread > 0 ? firstUnread : made.length > 1 && firstUnread < 0 ? made.length - 1 : 0];
      if (target && target !== made[0]) requestAnimationFrame(() => target.el.scrollIntoView({ block: "start" }));
    },
    messages: () => messages,
    respond,
    scrollBy(pages: number) {
      scroll.scrollBy({ top: pages * scroll.clientHeight * 0.85, behavior: "smooth" });
    },
  };
}
