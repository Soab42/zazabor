import { invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { h } from "../ui/dom";
import { openMenu } from "../ui/menu";
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

function theme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const dark = document.documentElement.dataset.theme !== "light";
  const accent = style.getPropertyValue("--accent").trim() || "#3fb87a";
  return {
    ...PALETTES[dark ? "dark" : "light"],
    background: "#00000000",
    foreground: dark ? "#e6e8ee" : "#1d1f24",
    cursor: accent,
    cursorAccent: dark ? "#16171b" : "#ffffff",
    selectionBackground: dark ? "#ffffff30" : "#00000024",
  };
}

export interface TerminalViewOptions {
  /** The folder the shell starts in (home when missing). */
  cwd?: string | null;
  /** The title changed (program or folder). */
  onTitle?(title: string): void;
  /** The shell ended. */
  onExit?(code: number | null): void;
}

/**
 * One terminal: xterm.js drawing the user's shell, which runs in a pseudo-terminal in the backend.
 * Fits its box, keeps the theme, copies and pastes with Ctrl+Shift+C / V, opens links.
 */
export class TerminalView {
  readonly el = h("div", { class: "tv" });
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private id: number | null = null;
  private unfollow: (() => void) | null = null;
  private infoTimer = 0;
  private exited = false;
  private disposed = false;
  title = "Terminal";
  cwd = "";
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly opts: TerminalViewOptions = {}) {
    const style = getComputedStyle(document.documentElement);
    this.term = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: style.getPropertyValue("--mono").trim() || "monospace",
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10_000,
      macOptionIsMeta: true,
      theme: theme(),
    });
    this.term.loadAddon(this.fit);
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
    this.el.addEventListener("contextmenu", (e) => this.menu(e));
    this.resizeObserver = new ResizeObserver(() => this.fitNow());
  }

  /** Puts the terminal on screen (in an attached element) and starts the shell the first time. */
  async mount() {
    if (this.term.element) {
      this.fitNow();
      return;
    }
    this.term.open(this.el);
    this.resizeObserver.observe(this.el);
    this.fitNow();
    await this.start();
  }

  private async start() {
    this.exited = false;
    await ensureListening();
    try {
      this.id = await termApi.spawn(this.opts.cwd ?? null, this.term.cols, this.term.rows);
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
    this.term.reset();
    await this.start();
  }

  private async refreshInfo() {
    if (this.id === null) return;
    const info = await termApi.info(this.id).catch(() => null);
    if (!info) return;
    this.cwd = info.cwd;
    const folder = info.cwd.split("/").filter(Boolean).pop() ?? "/";
    const shell = /^(bash|zsh|fish|sh|dash|nu|elvish)$/.test(info.program);
    const title = !info.program || shell ? folder : info.program;
    if (title !== this.title) {
      this.title = title;
      this.opts.onTitle?.(title);
    }
  }

  fitNow() {
    if (!this.term.element || this.el.clientWidth === 0 || this.el.clientHeight === 0) return;
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

  themeChanged() {
    this.term.options.theme = theme();
  }

  private onKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
      const text = this.term.getSelection();
      if (text) void navigator.clipboard?.writeText(text);
      return false;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "v") {
      void this.paste();
      return false;
    }
    return true;
  }

  private async paste() {
    const text = await navigator.clipboard?.readText().catch(() => "");
    if (text) this.term.paste(text);
  }

  private menu(e: MouseEvent) {
    e.preventDefault();
    const selection = this.term.getSelection();
    openMenu(e.clientX, e.clientY, [
      { label: "Copy", icon: "copy", shortcut: "Ctrl+Shift+C", disabled: !selection, action: () => void navigator.clipboard?.writeText(selection) },
      { label: "Paste", icon: "paste", shortcut: "Ctrl+Shift+V", action: () => void this.paste() },
      "separator",
      { label: "Select All", action: () => this.term.selectAll() },
      { label: "Clear", icon: "trash", action: () => this.clear() },
    ]);
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.infoTimer);
    this.resizeObserver.disconnect();
    this.unfollow?.();
    if (this.id !== null) termApi.kill(this.id).catch(() => undefined);
    this.term.dispose();
    this.el.remove();
  }
}

export { isTerminalTarget } from "./target";
