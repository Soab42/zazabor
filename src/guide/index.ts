import "./guide.css";
import type { Config } from "../config";
import type { ModuleId } from "../shell/module";
import { clear, h } from "../ui/dom";
import { icon } from "../ui/icons";
import { ARTICLES } from "./content";
import { GROUP_TITLES, type GuideArticle, type GuideGroup, type GuideTopic } from "./types";

/**
 * The user guide: how to use every part of Zazabor, as a page over the workspace (the ? on the
 * rail, F1, or Settings → General → Help & Guide). A searchable table of contents on the left,
 * the article on the right; F1 opens the article for what shows. Articles are data (`content/`).
 */

export interface GuideHost {
  readonly config: Config;
  saveConfig(): void;
  /** Closes the guide and shows that part of the app. */
  openTarget(module: ModuleId, target?: string): void;
  /** The section is turned on (Settings → Features). */
  enabled(module: ModuleId): boolean;
  close(): void;
}

const BY_ID = new Map(ARTICLES.map((a) => [a.id, a]));
const GROUP_ORDER: GuideGroup[] = ["start", "media", "productivity", "office", "studio", "system", "new"];
const FIRST = "getting-started";

/** The words of a line of guide markup, without the markup. */
function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\{([^}]+)\}/g, "$1").replace(/\[\[[a-z0-9-]+\|([^\]]+)\]\]/g, "$1");
}

function articleText(a: GuideArticle): string[] {
  const lines = [a.title, a.summary, a.needs ?? ""];
  for (const t of a.topics) lines.push(t.title, ...(t.steps ?? []), ...(t.tips ?? []), ...(t.keys ?? []).map(([k, what]) => `${k} ${what}`));
  return lines.map(plain);
}

const SEARCH_INDEX = ARTICLES.map((a) => ({ article: a, lines: articleText(a), all: articleText(a).join("\n").toLowerCase() }));

/** Text with the search terms marked. */
function marked(text: string, terms: string[]): Node[] {
  if (!terms.length) return [document.createTextNode(text)];
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).filter(Boolean).map((part) => (terms.some((t) => part.toLowerCase() === t) ? h("mark", null, part) : document.createTextNode(part)));
}

/** Keys as key caps: "Ctrl+Shift+S", alternatives with " or ". */
function keycaps(keys: string): HTMLElement {
  const el = h("span", { class: "gd-keys" });
  keys.split(" or ").forEach((combo, i) => {
    if (i) el.append(h("span", { class: "gd-or" }, "or"));
    const parts = combo.split(/\+(?=.)/);
    el.append(h("span", { class: "gd-combo" }, ...parts.map((k) => h("kbd", null, k))));
  });
  return el;
}

export class Guide {
  readonly el = h("section", { class: "guide", hidden: true, "aria-label": "User Guide" });
  private search = h("input", { class: "search-input", type: "search", placeholder: "Search the guide", spellcheck: "false", "aria-label": "Search the guide" });
  private nav = h("nav", { class: "gd-nav-list", "aria-label": "Guide contents" });
  private page = h("article", { class: "gd-page" });
  private backButton = h("button", { class: "icon-btn", type: "button", title: "Back (Alt+←)", "aria-label": "Back", hidden: true }, icon("back", 18));
  private navButtons = new Map<string, HTMLButtonElement>();
  private current = FIRST;
  private history: string[] = [];
  /** Search terms to mark in the article opened from the results. */
  private terms: string[] = [];

  constructor(private readonly host: GuideHost) {
    this.search.addEventListener("input", () => this.renderNav());
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = this.results()[0];
        if (first) this.show(first.id, true);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        (this.nav.querySelector(".gd-nav-item") as HTMLElement | null)?.focus();
      }
    });
    this.backButton.addEventListener("click", () => this.back());
    const aside = h("aside", { class: "gd-nav" },
      h("div", { class: "gd-nav-top" },
        h("div", { class: "gd-brand" }, icon("book", 18), h("span", null, "User Guide")),
        h("label", { class: "search" }, icon("search", 15), this.search)),
      this.nav);
    const head = h("header", { class: "gd-head" }, this.backButton, h("div", { class: "spacer" }),
      h("button", { class: "icon-btn", type: "button", title: "Close (Esc)", "aria-label": "Close the guide", onclick: () => host.close() }, icon("close")));
    this.el.append(aside, h("div", { class: "gd-main" }, head, this.page));
    this.renderNav();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  /** Shows the guide, on `id` when given (and known), otherwise where it was left. */
  open(id?: string | null) {
    const start = (id && BY_ID.has(id) ? id : null) ?? (this.host.config.guide.last && BY_ID.has(this.host.config.guide.last) ? this.host.config.guide.last : FIRST);
    this.el.hidden = false;
    this.search.value = "";
    this.history = [];
    this.show(start, false, false);
    requestAnimationFrame(() => this.search.focus({ preventScroll: true }));
  }

  close() {
    this.el.hidden = true;
  }

  /** Esc clears the search, then closes; Alt+← goes back; Ctrl+F searches. True when used. */
  handleKey(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      if (this.search.value) {
        this.search.value = "";
        this.renderNav();
        this.search.focus();
      } else this.host.close();
      return true;
    }
    if (e.altKey && e.key === "ArrowLeft") {
      this.back();
      return true;
    }
    if (mod && e.key.toLowerCase() === "f") {
      this.search.focus();
      this.search.select();
      return true;
    }
    return false;
  }

  // ---- navigation

  private show(id: string, fromSearch: boolean, remember = true) {
    const article = BY_ID.get(id);
    if (!article) return;
    if (remember && this.isOpen && id !== this.current && this.page.childElementCount) this.history.push(this.current);
    this.current = id;
    this.terms = fromSearch ? this.queryTerms() : [];
    this.host.config.guide.last = id;
    this.host.saveConfig();
    this.backButton.hidden = this.history.length === 0;
    this.renderNav();
    this.renderArticle(article);
  }

  private back() {
    const prev = this.history.pop();
    if (prev) this.show(prev, false, false);
  }

  private queryTerms(): string[] {
    return this.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }

  private results(): GuideArticle[] {
    const terms = this.queryTerms();
    if (!terms.length) return [];
    return SEARCH_INDEX
      .filter((entry) => terms.every((t) => entry.all.includes(t)))
      // Titles that match come first.
      .sort((a, b) => Number(terms.some((t) => b.article.title.toLowerCase().includes(t))) - Number(terms.some((t) => a.article.title.toLowerCase().includes(t))))
      .map((entry) => entry.article);
  }

  private renderNav() {
    clear(this.nav);
    this.navButtons.clear();
    const terms = this.queryTerms();
    if (terms.length) {
      const found = this.results();
      if (!found.length) {
        this.nav.append(h("p", { class: "gd-none" }, `Nothing in the guide matches “${this.search.value.trim()}”.`));
        return;
      }
      this.nav.append(h("div", { class: "gd-nav-head" }, `${found.length} ${found.length === 1 ? "article" : "articles"}`));
      for (const article of found) {
        const line = SEARCH_INDEX.find((e) => e.article === article)!.lines.find((l) => terms.some((t) => l.toLowerCase().includes(t))) ?? article.summary;
        const snippet = line.length > 120 ? `${line.slice(0, 117)}…` : line;
        const b = h("button", { class: "gd-nav-item result", type: "button", onclick: () => this.show(article.id, true) },
          icon(article.icon, 17),
          h("span", { class: "gd-nav-text" }, h("span", { class: "gd-nav-title" }, ...marked(article.title, terms)), h("span", { class: "gd-snippet" }, ...marked(snippet, terms))));
        this.addKeys(b);
        this.nav.append(b);
      }
      return;
    }
    for (const group of GROUP_ORDER) {
      const articles = ARTICLES.filter((a) => a.group === group);
      if (!articles.length) continue;
      this.nav.append(h("div", { class: "gd-nav-head" }, GROUP_TITLES[group]));
      for (const article of articles) {
        const b = h("button", { class: `gd-nav-item${article.id === this.current ? " active" : ""}`, type: "button", onclick: () => this.show(article.id, false) },
          icon(article.icon, 17), h("span", { class: "gd-nav-title" }, article.title));
        if (article.id === this.current) b.setAttribute("aria-current", "page");
        this.addKeys(b);
        this.navButtons.set(article.id, b);
        this.nav.append(b);
      }
    }
    this.navButtons.get(this.current)?.scrollIntoView({ block: "nearest" });
  }

  /** Arrow keys move between the contents' items. */
  private addKeys(b: HTMLButtonElement) {
    b.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = [...this.nav.querySelectorAll<HTMLElement>(".gd-nav-item")];
      const i = items.indexOf(b) + (e.key === "ArrowDown" ? 1 : -1);
      if (i < 0) this.search.focus();
      else items[Math.min(i, items.length - 1)]?.focus();
    });
  }

  // ---- the article

  /** A line of guide markup as nodes: **names**, {keys} and [[id|links]], with search terms marked. */
  private rich(text: string): Node[] {
    const out: Node[] = [];
    const re = /\*\*(.+?)\*\*|\{([^}]+)\}|\[\[([a-z0-9-]+)\|([^\]]+)\]\]/g;
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > last) out.push(...marked(text.slice(last, m.index), this.terms));
      if (m[1] !== undefined) out.push(h("strong", null, ...marked(m[1], this.terms)));
      else if (m[2] !== undefined) out.push(keycaps(m[2]));
      else {
        const id = m[3];
        out.push(BY_ID.has(id)
          ? h("button", { class: "gd-link", type: "button", onclick: () => this.show(id, false) }, ...marked(m[4], this.terms))
          : document.createTextNode(m[4]));
      }
      last = re.lastIndex;
    }
    if (last < text.length) out.push(...marked(text.slice(last), this.terms));
    return out;
  }

  private renderTopic(topic: GuideTopic): HTMLElement {
    const section = h("section", { class: "gd-topic" }, h("h2", null, ...marked(topic.title, this.terms)));
    if (topic.steps?.length) section.append(h("ol", { class: "gd-steps" }, ...topic.steps.map((s) => h("li", null, ...this.rich(s)))));
    if (topic.keys?.length) {
      section.append(h("div", { class: "gd-keytable" }, ...topic.keys.map(([keys, what]) =>
        h("div", { class: "gd-keyrow" }, keycaps(keys), h("span", null, ...this.rich(what))))));
    }
    if (topic.tips?.length) {
      section.append(h("ul", { class: "gd-tips" }, ...topic.tips.map((t) => h("li", null, icon("info", 14), h("span", null, ...this.rich(t))))));
    }
    return section;
  }

  private renderArticle(a: GuideArticle) {
    clear(this.page);
    const actions = h("div", { class: "gd-actions" });
    if (a.open) {
      if (this.host.enabled(a.open.module)) {
        actions.append(h("button", { class: "btn primary", type: "button", onclick: () => this.host.openTarget(a.open!.module, a.open!.target) }, icon("external", 15), a.open.label));
      } else {
        actions.append(h("span", { class: "gd-off" }, icon("eyeOff", 14), "This feature is turned off. Turn it on in ", h("strong", null, "Settings → Features"), "."));
      }
    }
    if (a.extra === "playerShortcuts") {
      actions.append(h("button", { class: "btn", type: "button", onclick: () => void this.playerShortcuts() }, icon("terminal", 15), "All Player Shortcuts"));
    }
    this.page.append(
      h("header", { class: "gd-title" },
        h("span", { class: "gd-chip" }, icon(a.icon, 26)),
        h("div", null, h("h1", null, ...marked(a.title, this.terms)), h("p", null, ...this.rich(a.summary)))),
      ...(actions.childElementCount ? [actions] : []),
      ...(a.needs ? [h("div", { class: "gd-needs" }, icon("sparkles", 16), h("span", null, ...this.rich(a.needs)))] : []),
      ...a.topics.map((t) => this.renderTopic(t)),
    );
    const related = (a.related ?? []).map((id) => BY_ID.get(id)).filter((r): r is GuideArticle => !!r);
    if (related.length) {
      this.page.append(h("section", { class: "gd-related" }, h("h2", null, "See also"),
        h("div", { class: "gd-related-list" }, ...related.map((r) => h("button", { class: "gd-card", type: "button", onclick: () => this.show(r.id, false) }, icon(r.icon, 16), h("span", null, r.title))))));
    }
    this.page.scrollTop = 0;
    this.page.querySelector("mark")?.scrollIntoView({ block: "center" });
  }

  /** The video player's own shortcuts sheet, with the skip and volume steps of its settings. */
  private async playerShortcuts() {
    const [{ openShortcuts }, { mediaSettings }] = await Promise.all([
      import("../modules/video/features/hotkeys"),
      import("../modules/video/features/profiles/settings"),
    ]);
    openShortcuts(mediaSettings({ config: this.host.config }));
  }
}

/** The article for what shows: a module's own choice (Office's Sheets), else the module's article. */
export function articleFor(module: ModuleId | null, topic: string | null | undefined, settingsOpen: boolean): string {
  if (settingsOpen) return "settings";
  if (topic && BY_ID.has(topic)) return topic;
  const byModule: Record<ModuleId, string> = {
    files: "files", gallery: "gallery", video: "video-player", terminal: "terminal", notes: "notes", time: "time",
    wallet: "wallet", office: "office", studio: "studio", clipboard: "clipboard",
  };
  return module ? byModule[module] ?? FIRST : FIRST;
}
