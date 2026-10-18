/** The paths on the app's clipboard that Cut marked; views dim them until pasted or replaced. */
const cut = new Set<string>();
const listeners = new Set<() => void>();

export const cutSet = {
  has: (path: string) => cut.has(path),
  /** Replaces the marked paths (empty clears) and tells the listeners when they differ. */
  set(paths: string[]) {
    if (paths.length === cut.size && paths.every((p) => cut.has(p))) return;
    cut.clear();
    for (const p of paths) cut.add(p);
    for (const fn of listeners) fn();
  },
  onChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};
