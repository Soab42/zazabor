import { invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type IDecoration, type IMarker, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalSettings } from "../config";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { openMenu, type MenuItem } from "../ui/menu";
import { ensureListening, follow, termApi } from "./api";
import "./terminal.css";

/** How often the tab title follows the program in front and the folder. */
const INFO_EVERY_MS = 1500;

/** ANSI colours that read well on CorePro's dark and light surfaces. */
const PALETTES: Record<"dark" | "light", Omit<ITheme, "background" | "foreground" | "cursor" | "selectionBackground">> = {
  dark: {
    black: "#1d1f24", red: "#ff6b6b", green: "#5fd39a", yellow: "#f5c451", blue: "#6aa8ff", magenta: "#c792ea", cyan: "#4fd6d6", white: "#d6d8de",
    brightBlack: "#6b707c", brightRed: "#ff8787", brightGreen: "#7ee3b0", brightYellow: "#ffd776", brightBlue: "#8cbcff", brightMagenta: "#dab0f5", brightCyan: "#7ae6e6", brightWhite: "#ffffff",
  },
  light: {
    black: "#2a2c33", red: "#d73a49", green: "#1f8a4c", yellow: "#a36b00", blue: "#1f63d6", magenta: "#8a3fbf", cyan: "#0f7f8a", white: "#6b6f7a",
    brightBlack: "#8a8e99", brightRed: "#e5534b", brightGreen: "#2da55e", brightYellow: "#c08400", brightBlue: "#3b7ae8", brightMagenta: "#a35ad6", brightCyan: "#1b97a3", brightWhite: "#1d1f24",
  },
};

const dark = () => document.documentElement.dataset.theme !== "light";

function theme(): ITheme {
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#3fb87a";
  return {
    ...PALETTES[dark() ? "dark" : "light"],
    background: "#00000000",
    foreground: dark() ? "#e6e8ee" : "#1d1f24",
    cursor: accent,
    cursorAccent: dark() ? "#16171b" : "#ffffff",
    selectionBackground: dark() ? "#ffffff30" : "#00000024",
  };
}

/** One command and its output, from the marks the shell integration prints. */
export interface Block {
  /** Prompt start, output start (C) and end (D). */
  prompt: IMarker;
  output?: IMarker;
  end?: IMarker;
  command: string;
  exit: number | null;
  started: number;
  finished: number;
  cwd: string;
  decoration?: IDecoration;
}

export interface TerminalViewOptions {
  /** The folder the shell starts in (home when missing). */
  cwd?: string | null;
  /** The shell to run; the user's own when missing. */
  shell?: string | null;
  settings(): TerminalSettings;
  /** The title changed (program or folder). */
  onTitle?(title: string): void;
  /** The shell ended. */
  onExit?(code: number | null): void;
  /** A command finished (from shell integration). */
  onCommandDone?(block: Block): void;
  /** Keys for the terminal app (split, new tab…), tried before the shell gets them. True = handled. */
  onAppKey?(e: KeyboardEvent): boolean;
  onFocus?(): void;
}

/** "1.2 s", "3 min 5 s". */
export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/**
 * One terminal: xterm.js drawing the user's shell, which runs in a pseudo-terminal in the backend.
 * With shell integration it knows each command: a coloured bar beside it (click for copy output,
 * rerun…), Ctrl+Up / Down between commands, and a sticky header naming the command you're in.
 * Also find (Ctrl+Shift+F), zoom, copy and paste with Ctrl+Shift+C / V, and links.
 */
export class TerminalView {
  readonly el = h("div", { class: "tv" });
  private readonly host = h("div", { class: "tv-term" });
  private readonly sticky = h("button", { class: "tv-sticky", type: "button", hidden: true });
  private readonly findBar: HTMLElement;
  private readonly findInput = h("input", { class: "tv-find-input", type: "text", placeholder: "Find", spellcheck: false });
  private readonly findCount = h("span", { class: "tv-find-count" });
  private readonly findCase = h("button", { class: "tv-find-btn", type: "button", title: "Match Case" }, "Aa");
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon();
  private readonly nonce = crypto.randomUUID().replace(/-/g, "");
  private id: number | null = null;
  private unfollow: (() => void) | null = null;
  private infoTimer = 0;
  private exited = false;
  private disposed = false;
  private stickyFrame = 0;
  readonly blocks: Block[] = [];
  private current: Block | null = null;
  title = "Terminal";
  cwd = "";
  /** The program in front, when it isn't the shell ("vim", "cargo"…). */
  program = "";
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly opts: TerminalViewOptions) {
    const style = getComputedStyle(document.documentElement);
    this.cwd = opts.cwd ?? "";
    this.term = new Terminal({
      allowTransparency: true,
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: style.getPropertyValue("--mono").trim() || "monospace",
      fontSize: opts.settings().fontSize,
      lineHeight: 1.2,
      scrollback: 10_000,
      macOptionIsMeta: true,
      overviewRuler: { width: 8 },
      theme: theme(),
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(new WebLinksAddon((_e, uri) => void invoke("fs_open_default", { path: uri }).catch(() => undefined)));
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    this.term.onData((data) => {
      if (this.exited) {
        // Enter after the shell ended starts a new one.
        if (data === "\r") void this.restart();
        return;
      }
      if (this.id !== null) void termApi.write(this.id, data).catch(() => undefined);
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.id !== null) void termApi.resize(this.id, cols, rows).catch(() => undefined);
    });
    this.term.onScroll(() => this.scheduleSticky());
    this.term.onWriteParsed(() => this.scheduleSticky());
    this.term.buffer.onBufferChange(() => this.scheduleSticky());
    this.term.parser.registerOscHandler(133, (data) => this.onMark(data));
    this.term.parser.registerOscHandler(633, (data) => this.onVsMark(data));
    this.term.parser.registerOscHandler(7, (data) => this.onCwd(data));
    this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      this.findCount.textContent = resultCount ? `${resultIndex + 1} of ${resultCount}` : this.findInput.value ? "No results" : "";
    });

    this.findBar = this.buildFindBar();
    // Click the header to go to its command; its ⋯ opens the command's menu (copy output, run again).
    this.sticky.addEventListener("click", (e) => {
      const block = this.stickyBlock();
      if (!block) return;
      if ((e.target as HTMLElement).closest(".tv-sticky-more")) this.blockMenu(block, e.clientX, e.clientY);
      else this.term.scrollToLine(block.prompt.line);
    });
    this.el.append(this.host, this.sticky, this.findBar);
    this.el.addEventListener("contextmenu", (e) => this.menu(e));
    this.el.addEventListener("focusin", () => this.opts.onFocus?.());
    this.resizeObserver = new ResizeObserver(() => this.fitNow());
  }

  /** Puts the terminal on screen (in an attached element) and starts the shell the first time. */
  async mount() {
    if (this.term.element) {
      this.fitNow();
      return;
    }
    this.term.open(this.host);
    this.resizeObserver.observe(this.host);
    this.fitNow();
    await this.start();
  }

  private async start() {
    this.exited = false;
    await ensureListening();
    const settings = this.opts.settings();
    try {
      this.id = await termApi.spawn(this.cwd || null, this.term.cols, this.term.rows, this.opts.shell || settings.shell || null, settings.integration, this.nonce);
    } catch (err) {
      this.term.writeln(`\x1b[31m${String(err)}\x1b[0m`);
      return;
    }
    const id = this.id;
    this.unfollow = await follow(id, (data) => this.term.write(data), (code) => this.ended(code));
    if (this.disposed) termApi.kill(id).catch(() => undefined);
    this.infoTimer = window.setInterval(() => void this.refreshInfo(), INFO_EVERY_MS);
    void this.refreshInfo();
  }

  private ended(code: number | null) {
    clearInterval(this.infoTimer);
    this.unfollow?.();
    this.unfollow = null;
    this.id = null;
    this.exited = true;
    this.term.writeln(`\r\n\x1b[2m[Process exited${code ? ` with code ${code}` : ""}. Press Enter to start a new shell.]\x1b[0m`);
    this.opts.onExit?.(code);
  }

  private async restart() {
    for (const b of this.blocks) b.decoration?.dispose();
    this.blocks.length = 0;
    this.current = null;
    this.term.reset();
    await this.start();
  }

  private async refreshInfo() {
    if (this.id === null) return;
    const info = await termApi.info(this.id).catch(() => null);
    if (!info) return;
    if (info.cwd) this.cwd = info.cwd;
    const folder = this.cwd.split("/").filter(Boolean).pop() ?? "/";
    const shell = /^(bash|zsh|fish|sh|dash|nu|elvish)$/.test(info.program);
    this.program = shell ? "" : info.program;
    const title = this.program || folder;
    if (title !== this.title) {
      this.title = title;
      this.opts.onTitle?.(title);
    }
  }

  // ---- command blocks ----------------------------------------------------------------------

  /** OSC 133: A prompt, B input, C output, D;exit finished. */
  private onMark(data: string): boolean {
    const [kind, arg] = data.split(";");
    if (kind === "A") {
      const marker = this.term.registerMarker(0);
      if (marker) this.current = { prompt: marker, command: "", exit: null, started: 0, finished: 0, cwd: this.cwd };
    } else if (kind === "C" && this.current) {
      this.current.output = this.term.registerMarker(0);
      this.current.started = Date.now();
    } else if (kind === "D" && this.current?.output && !this.current.end) {
      // A D without a C was an empty line; nothing ran.
      const block = this.current;
      block.end = this.term.registerMarker(0);
      block.exit = arg === undefined || arg === "" ? null : Number(arg);
      block.finished = Date.now();
      this.blocks.push(block);
      this.decorate(block);
      this.opts.onCommandDone?.(block);
    }
    return true;
  }

  /** OSC 633: E;command;nonce is the exact command line (from our own script when the nonce matches). */
  private onVsMark(data: string): boolean {
    if (!data.startsWith("E;") || !this.current) return true;
    const rest = data.slice(2);
    const cut = rest.lastIndexOf(";");
    if (cut < 0 || rest.slice(cut + 1) !== this.nonce) return true;
    this.current.command = rest.slice(0, cut).replace(/\\x3b/g, ";").replace(/\\x0a/g, "\n").replace(/\\\\/g, "\\");
    return true;
  }

  /** OSC 7: file://host/path, the shell's folder. */
  private onCwd(data: string): boolean {
    const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
    if (match) {
      try {
        this.cwd = decodeURIComponent(match[1]);
      } catch {
        this.cwd = match[1];
      }
    }
    return true;
  }

  /** The bar beside a finished command: green or red by exit code; click it for the block's menu. */
  private decorate(block: Block) {
    const end = block.end?.line ?? block.prompt.line;
    const failed = block.exit !== null && block.exit !== 0;
    const decoration = this.term.registerDecoration({
      marker: block.prompt,
      x: 0,
      width: 1,
      height: Math.max(1, end - block.prompt.line),
      layer: "top",
      overviewRulerOptions: failed ? { color: "#e5534b", position: "left" } : undefined,
    });
    if (!decoration) return;
    block.decoration = decoration;
    decoration.onRender((el) => {
      if (el.dataset.bound) return;
      el.dataset.bound = "1";
      el.classList.add("tv-block", failed ? "failed" : "ok");
      el.title = `${block.command || "Command"} · ${failed ? `exit ${block.exit}` : "succeeded"} · ${duration(block.finished - block.started)}`;
      el.addEventListener("mousedown", (e) => e.stopPropagation());
      el.addEventListener("click", (e) => this.blockMenu(block, e.clientX, e.clientY));
    });
  }

  /** The text a command printed (between its C and D marks), lines joined as they were wrapped. */
  outputOf(block: Block): string {
    const buffer = this.term.buffer.active;
    const from = block.output?.line ?? -1;
    const to = block.end?.line ?? -1;
    if (from < 0 || to < 0) return "";
    let text = "";
    for (let i = from; i < to; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      if (i > from && !line.isWrapped) text += "\n";
      text += line.translateToString(true);
    }
    return text.replace(/\s+$/, "");
  }

  private blockMenu(block: Block, x: number, y: number) {
    const failed = block.exit !== null && block.exit !== 0;
    const atPrompt = !!this.current?.end || !this.current?.output;
    const items: MenuItem[] = [
      { label: `${failed ? "Failed" : "Succeeded"} · ${duration(block.finished - block.started)}${block.cwd ? ` · ${block.cwd.split("/").pop()}` : ""}`, disabled: true, action: () => undefined },
      "separator",
      { label: "Copy Command", icon: "copy", disabled: !block.command, action: () => void navigator.clipboard?.writeText(block.command) },
      { label: "Copy Output", icon: "copy", action: () => void navigator.clipboard?.writeText(this.outputOf(block)) },
      { label: "Copy Command and Output", icon: "copy", action: () => void navigator.clipboard?.writeText(`$ ${block.command}\n${this.outputOf(block)}`) },
      "separator",
      { label: "Run Again", icon: "refresh", disabled: !block.command || !atPrompt, action: () => this.send(`${block.command}\r`) },
      { label: "Select Output", icon: "checkSquare", action: () => this.selectOutput(block) },
      { label: "Go to Command", icon: "arrowUp", action: () => this.term.scrollToLine(block.prompt.line) },
    ];
    openMenu(x, y, items);
  }

  private selectOutput(block: Block) {
    const from = block.output?.line;
    const to = block.end?.line;
    if (from === undefined || to === undefined || to <= from) return;
    this.term.selectLines(from, to - 1);
  }

  /** Scrolls to the previous or next command. */
  jump(direction: -1 | 1) {
    const top = this.term.buffer.active.viewportY;
    const lines = this.blocks.map((b) => b.prompt.line).filter((l) => l >= 0);
    const target = direction < 0 ? [...lines].reverse().find((l) => l < top) : lines.find((l) => l > top);
    if (target !== undefined) this.term.scrollToLine(target);
    else if (direction > 0) this.term.scrollToBottom();
  }

  /** The command whose output fills the top of the view, when scrolled into it. */
  private stickyBlock(): Block | null {
    const buffer = this.term.buffer.active;
    if (buffer.type === "alternate") return null;
    const top = buffer.viewportY;
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.prompt.line < 0 || b.prompt.line >= top) continue;
      return (b.end?.line ?? Infinity) > top + 1 && b.command ? b : null;
    }
    return null;
  }

  private scheduleSticky() {
    if (this.stickyFrame) return;
    this.stickyFrame = requestAnimationFrame(() => {
      this.stickyFrame = 0;
      const block = this.stickyBlock();
      this.sticky.hidden = !block;
      if (!block) return;
      const failed = block.exit !== null && block.exit !== 0;
      this.sticky.className = `tv-sticky ${failed ? "failed" : "ok"}`;
      this.sticky.replaceChildren(h("span", { class: "tv-sticky-mark" }, "❯"), h("span", { class: "tv-sticky-cmd" }, block.command),
        h("span", { class: "tv-sticky-meta" }, failed ? `exit ${block.exit}` : duration(block.finished - block.started)),
        h("span", { class: "tv-sticky-more", title: "Command actions" }, icon("more", 14)));
    });
  }

  // ---- find ----------------------------------------------------------------------------------

  private buildFindBar(): HTMLElement {
    let matchCase = false;
    const options = () => ({
      caseSensitive: matchCase,
      decorations: { matchBackground: "#d7a22a", matchOverviewRuler: "#d7a22a", activeMatchBackground: "#4f8fe0", activeMatchColorOverviewRuler: "#4f8fe0" },
    });
    const next = (back = false) => {
      const q = this.findInput.value;
      if (!q) {
        this.search.clearDecorations();
        this.findCount.textContent = "";
        return;
      }
      if (back) this.search.findPrevious(q, options());
      else this.search.findNext(q, options());
    };
    this.findInput.addEventListener("input", () => next());
    this.findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        next(e.shiftKey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeFind();
      }
    });
    this.findCase.addEventListener("click", () => {
      matchCase = !matchCase;
      this.findCase.classList.toggle("active", matchCase);
      next();
    });
    const button = (name: Parameters<typeof icon>[0], title: string, fn: () => void) =>
      h("button", { class: "tv-find-btn", type: "button", title, onclick: fn }, icon(name, 14));
    return h("div", { class: "tv-find", hidden: true },
      icon("search", 13), this.findInput, this.findCount, this.findCase,
      button("chevronUp", "Previous (Shift+Enter)", () => next(true)),
      button("chevronDown", "Next (Enter)", () => next()),
      button("close", "Close (Esc)", () => this.closeFind()));
  }

  openFind() {
    this.findBar.hidden = false;
    const selected = this.term.getSelection();
    if (selected && !selected.includes("\n")) this.findInput.value = selected;
    this.findInput.focus();
    this.findInput.select();
    if (this.findInput.value) this.search.findNext(this.findInput.value);
  }

  private closeFind() {
    this.findBar.hidden = true;
    this.search.clearDecorations();
    this.term.focus();
  }

  // ---- the rest ------------------------------------------------------------------------------

  fitNow() {
    if (!this.term.element || this.host.clientWidth === 0 || this.host.clientHeight === 0) return;
    try {
      this.fit.fit();
    } catch {
      // Measuring fails while hidden; the next resize fits it.
    }
  }

  focus() {
    this.term.focus();
  }

  /** Types text into the shell as if pasted (e.g. "cd folder\r"). */
  send(text: string) {
    if (this.id !== null) void termApi.write(this.id, text).catch(() => undefined);
  }

  clear() {
    this.term.clear();
  }

  /** The command line running right now, if the shell integration said so. */
  get running(): string {
    return this.current?.output && !this.current.end ? this.current.command : "";
  }

  setFontSize(size: number) {
    this.term.options.fontSize = size;
    this.fitNow();
  }

  themeChanged() {
    this.term.options.theme = theme();
  }

  private onKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    // The app's own keys first; when one is handled the shell never sees it.
    if (this.opts.onAppKey?.(e)) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
      const text = this.term.getSelection();
      if (text) void navigator.clipboard?.writeText(text);
      e.stopPropagation();
      return false;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "v") {
      void this.paste();
      e.stopPropagation();
      return false;
    }
    return true;
  }

  private async paste() {
    const text = await navigator.clipboard?.readText().catch(() => "");
    if (text) this.term.paste(text);
  }

  private menu(e: MouseEvent) {
    if ((e.target as HTMLElement).closest(".tv-block")) return;
    e.preventDefault();
    const selection = this.term.getSelection();
    const last = this.blocks[this.blocks.length - 1];
    openMenu(e.clientX, e.clientY, [
      { label: "Copy", icon: "copy", shortcut: "Ctrl+Shift+C", disabled: !selection, action: () => void navigator.clipboard?.writeText(selection) },
      { label: "Paste", icon: "paste", shortcut: "Ctrl+Shift+V", action: () => void this.paste() },
      "separator",
      { label: "Copy Last Output", icon: "copy", disabled: !last, action: () => last && void navigator.clipboard?.writeText(this.outputOf(last)) },
      { label: "Find…", icon: "search", shortcut: "Ctrl+Shift+F", action: () => this.openFind() },
      "separator",
      { label: "Select All", action: () => this.term.selectAll() },
      { label: "Clear", icon: "trash", action: () => this.clear() },
    ]);
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.infoTimer);
    cancelAnimationFrame(this.stickyFrame);
    this.resizeObserver.disconnect();
    this.unfollow?.();
    if (this.id !== null) termApi.kill(this.id).catch(() => undefined);
    this.term.dispose();
    this.el.remove();
  }
}

export { isTerminalTarget } from "./target";
