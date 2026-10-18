/** One clickable step of a path bar. */
export interface Crumb {
  name: string;
  path: string;
}

const driveLetter = /^[A-Za-z]:/;

/** Splits an absolute path into crumbs from the root down; "/" (or "C:\") comes first. */
export function crumbs(path: string): Crumb[] {
  if (driveLetter.test(path)) {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    const out: Crumb[] = [{ name: parts[0], path: `${parts[0]}\\` }];
    let acc = `${parts[0]}\\`;
    for (const part of parts.slice(1)) {
      acc += acc.endsWith("\\") ? part : `\\${part}`;
      out.push({ name: part, path: acc });
    }
    return out;
  }
  const out: Crumb[] = [{ name: "/", path: "/" }];
  let acc = "";
  for (const part of path.split("/").filter(Boolean)) {
    acc += `/${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

/** The containing folder; a root is its own parent. */
export function parentOf(path: string): string {
  const list = crumbs(path);
  return list.length > 1 ? list[list.length - 2].path : list[0].path;
}

const sepOf = (dir: string) => (dir.includes("\\") && !dir.includes("/") ? "\\" : "/");

export function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir);
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** Drops trailing separators, except on a root. */
export function normalizePath(path: string): string {
  const list = crumbs(path.trim());
  return list[list.length - 1].path;
}

export const samePath = (a: string, b: string) => normalizePath(a) === normalizePath(b);

/** True when `path` is `folder` itself or lies inside it. */
export function isInside(path: string, folder: string): boolean {
  const f = normalizePath(folder);
  const p = normalizePath(path);
  if (p === f) return true;
  const sep = sepOf(f);
  return p.startsWith(f.endsWith(sep) ? f : f + sep);
}

/** Turns what the user typed into a path: `~` becomes the home folder. */
export function expandPath(input: string, home: string): string {
  const text = input.trim();
  if (text === "~") return home;
  if (text.startsWith("~/") || text.startsWith("~\\")) return joinPath(home, text.slice(2));
  return normalizePath(text);
}

/** The last crumb's name; "/" for the root. */
export function folderName(path: string): string {
  const list = crumbs(path);
  return list[list.length - 1].name;
}
