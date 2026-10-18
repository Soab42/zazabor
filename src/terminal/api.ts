import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** The terminal backend (src-tauri/src/term.rs): the user's shell in a pseudo-terminal. */
export const termApi = {
  spawn: (cwd: string | null, cols: number, rows: number) => invoke<number>("term_spawn", { cwd, cols, rows }),
  write: (id: number, data: string) => invoke<void>("term_write", { id, data }),
  resize: (id: number, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows }),
  kill: (id: number) => invoke<void>("term_kill", { id }),
  /** The program in front (e.g. "vim", or the shell) and the shell's folder. */
  info: (id: number) => invoke<{ program: string; cwd: string }>("term_info", { id }),
};

type DataFn = (data: string) => void;
type ExitFn = (code: number | null) => void;

const dataFns = new Map<number, DataFn>();
const exitFns = new Map<number, ExitFn>();
/** Output that arrived before its terminal started following it (the first prompt). */
const early = new Map<number, string[]>();
let listening: Promise<UnlistenFn[]> | null = null;

/** Routes the backend's output and exit events to the terminal they belong to (one listener for all). */
export function ensureListening() {
  listening ??= Promise.all([
    listen<{ id: number; data: string }>("term-data", (e) => {
      const fn = dataFns.get(e.payload.id);
      if (fn) fn(e.payload.data);
      else early.set(e.payload.id, [...(early.get(e.payload.id) ?? []), e.payload.data]);
    }),
    listen<{ id: number; code: number | null }>("term-exit", (e) => {
      exitFns.get(e.payload.id)?.(e.payload.code);
      dataFns.delete(e.payload.id);
      exitFns.delete(e.payload.id);
    }),
  ]);
  return listening;
}

/** Follows one terminal's output and exit; returns a function that stops following. */
export async function follow(id: number, onData: DataFn, onExit: ExitFn): Promise<() => void> {
  await ensureListening();
  for (const chunk of early.get(id) ?? []) onData(chunk);
  early.delete(id);
  dataFns.set(id, onData);
  exitFns.set(id, onExit);
  return () => {
    dataFns.delete(id);
    exitFns.delete(id);
  };
}
