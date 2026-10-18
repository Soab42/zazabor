import { invoke } from "@tauri-apps/api/core";

/** One changed file (src-tauri/src/git.rs): letters as in `git status` ('.' = no change, '?' = untracked). */
export interface GitFile {
  /** Relative to the repository root. */
  path: string;
  index: string;
  work: string;
  from?: string;
}

export interface GitStatus {
  root: string;
  branch: string;
  commit: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  truncated: boolean;
}

export const gitApi = {
  /** The repository a folder is in and what changed; null outside a repository. */
  status: (folder: string) => invoke<GitStatus | null>("git_status", { folder }),
  /** A file's text at `HEAD:path` or staged (`:path`); null when it isn't there. */
  show: (root: string, spec: string) => invoke<string | null>("git_show", { root, spec }),
  stage: (root: string, paths: string[]) => invoke<void>("git_stage", { root, paths }),
  unstage: (root: string, paths: string[]) => invoke<void>("git_unstage", { root, paths }),
  discard: (root: string, tracked: string[], untracked: string[]) => invoke<void>("git_discard", { root, tracked, untracked }),
  commit: (root: string, message: string, amend = false) => invoke<void>("git_commit", { root, message, amend }),
  push: (root: string) => invoke<string>("git_push", { root }),
  pull: (root: string) => invoke<string>("git_pull", { root }),
  branches: (root: string) => invoke<string[]>("git_branches", { root }),
  checkout: (root: string, branch: string, create = false) => invoke<void>("git_checkout", { root, branch, create }),
  init: (folder: string) => invoke<void>("git_init", { folder }),
};

/** A file has staged changes. */
export const isStaged = (f: GitFile) => f.index !== "." && f.index !== "?" && f.index !== "U";
/** A file has changes in the working tree (untracked and conflicts included). */
export const isUnstaged = (f: GitFile) => f.work !== "." || f.index === "?" || f.index === "U";

/** The letter VS Code shows for a change, and its kind for colouring. */
export function changeMark(letter: string): { mark: string; kind: "modified" | "added" | "deleted" | "renamed" | "conflict" | "untracked" } {
  switch (letter) {
    case "A": return { mark: "A", kind: "added" };
    case "D": return { mark: "D", kind: "deleted" };
    case "R": case "C": return { mark: "R", kind: "renamed" };
    case "U": return { mark: "!", kind: "conflict" };
    case "?": return { mark: "U", kind: "untracked" };
    default: return { mark: "M", kind: "modified" };
  }
}
