import { api, type FolderScan } from "../api";
import { basename, dirname } from "../ui/dom";

export interface Photo {
  path: string;
  name: string;
  size: number;
  mtime: number;
  folder: Folder;
}

export interface Folder {
  path: string;
  name: string;
  /** The name to show: the folder name, plus its parent when another album shares the name. */
  label: string;
  /** DISCOVERED, or the extra folder this was found under. */
  source: string;
  photos: Photo[];
  /** Newest photo modification time, used for date sorting and as the cover. */
  latest: number;
  earliest: number;
}

export type SortMode = "date" | "name";

/** A folder and the photos in it that pass the current search filter. */
export interface Group {
  folder: Folder;
  photos: Photo[];
}

/** Source key for folders found by automatic discovery. */
export const DISCOVERED = "\u0000discovered";

export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function makeFolder(scan: FolderScan, source: string, sort: SortMode = "name"): Folder {
  const folder: Folder = { path: scan.path, name: scan.name, label: scan.name, source, photos: [], latest: 0, earliest: 0 };
  folder.photos = scan.photos
    .map((p) => ({ ...p, folder }))
    .sort(sort === "date" ? (a, b) => b.mtime - a.mtime || collator.compare(a.name, b.name) : (a, b) => collator.compare(a.name, b.name));
  let latest = 0;
  let earliest = Infinity;
  for (const photo of folder.photos) {
    latest = Math.max(latest, photo.mtime);
    earliest = Math.min(earliest, photo.mtime);
  }
  folder.latest = latest;
  folder.earliest = Number.isFinite(earliest) ? earliest : 0;
  return folder;
}

/**
 * Every photo folder on this computer, found automatically like a phone gallery, plus any
 * extra folders the user added by hand.
 */
export class Library {
  /** Extra folders added by hand. */
  roots: string[] = [];
  folders: Folder[] = [];
  readonly hidden = new Set<string>();
  showHidden = false;
  readonly scanning = new Set<string>();
  sort: SortMode = "date";
  private sources = new Map<string, FolderScan[]>();
  private listeners = new Set<() => void>();

  onChange(fn: () => void) {
    this.listeners.add(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  get photoCount() {
    return this.folders.reduce((sum, f) => sum + (this.hidden.has(f.path) ? 0 : f.photos.length), 0);
  }

  get discovering() {
    return this.scanning.has(DISCOVERED);
  }

  /** Shows the previous discovery immediately, then refreshes everything in the background. */
  async load(roots: string[], hidden: string[]) {
    this.roots = [...roots];
    for (const path of hidden) this.hidden.add(path);
    const cached = await api.cachedPhotos().catch(() => null);
    if (cached) {
      this.sources.set(DISCOVERED, cached);
      this.rebuild();
    }
    this.emit();
    await this.rescan();
  }

  async rescan() {
    await Promise.all([this.discover(), ...this.roots.map((root) => this.scanRoot(root))]);
  }

  /** Adds an extra folder; returns false when it was already there. */
  async addRoot(path: string): Promise<boolean> {
    const root = path.replace(/[\\/]+$/, "") || path;
    if (this.roots.includes(root)) {
      await this.scanRoot(root);
      return false;
    }
    this.roots.push(root);
    this.emit();
    await this.scanRoot(root);
    return true;
  }

  removeRoot(root: string) {
    this.roots = this.roots.filter((r) => r !== root);
    this.sources.delete(root);
    this.rebuild();
    this.emit();
  }

  setHidden(path: string, hidden: boolean) {
    if (hidden) this.hidden.add(path);
    else this.hidden.delete(path);
    this.emit();
  }

  setShowHidden(show: boolean) {
    this.showHidden = show;
    this.emit();
  }

  setSort(mode: SortMode) {
    this.sort = mode;
    this.rebuild();
    this.emit();
  }

  groups(filter: string): Group[] {
    const needle = filter.trim().toLowerCase();
    const groups: Group[] = [];
    for (const folder of this.folders) {
      if (this.hidden.has(folder.path) && !this.showHidden) continue;
      if (!needle) {
        groups.push({ folder, photos: folder.photos });
        continue;
      }
      const folderMatches = folder.label.toLowerCase().includes(needle);
      const photos = folderMatches ? folder.photos : folder.photos.filter((p) => p.name.toLowerCase().includes(needle));
      if (photos.length) groups.push({ folder, photos });
    }
    return groups;
  }

  private async discover() {
    await this.track(DISCOVERED, async () => this.sources.set(DISCOVERED, await api.discoverPhotos()));
  }

  private async scanRoot(root: string) {
    await this.track(root, async () => {
      const scans = await api.scanFolder(root);
      if (this.roots.includes(root)) this.sources.set(root, scans);
    });
  }

  private async track(key: string, work: () => Promise<unknown>) {
    this.scanning.add(key);
    this.emit();
    try {
      await work();
    } catch (err) {
      console.error(`Scanning ${key === DISCOVERED ? "this computer" : key} failed:`, err);
    } finally {
      this.scanning.delete(key);
      this.rebuild();
      this.emit();
    }
  }

  private rebuild() {
    const byPath = new Map<string, Folder>();
    // Hand-added folders win over discovery, which skips small images.
    for (const source of [...this.roots, DISCOVERED]) {
      for (const scan of this.sources.get(source) ?? []) {
        if (!byPath.has(scan.path)) byPath.set(scan.path, makeFolder(scan, source, this.sort));
      }
    }
    const folders = [...byPath.values()];
    const nameCount = new Map<string, number>();
    for (const f of folders) nameCount.set(f.name.toLowerCase(), (nameCount.get(f.name.toLowerCase()) ?? 0) + 1);
    for (const f of folders) {
      if ((nameCount.get(f.name.toLowerCase()) ?? 0) > 1) f.label = `${f.name} · ${basename(dirname(f.path))}`;
    }
    const byName = (a: Folder, b: Folder) => collator.compare(a.label, b.label) || collator.compare(a.path, b.path);
    this.folders = folders.sort(this.sort === "date" ? (a, b) => b.latest - a.latest || byName(a, b) : byName);
  }
}
