import { formatBytes, h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu } from "../../ui/menu";
import type { ShellContext } from "../../shell/module";
import { fsApi, type Place, type PlaceKind, type Volume } from "./api";
import { volumeIcon } from "./kinds";
import { folderName, samePath } from "./path";

const PLACE_ICONS: Record<PlaceKind, IconName> = {
  home: "home",
  desktop: "desktop",
  documents: "document",
  downloads: "download",
  pictures: "image",
  videos: "video",
  music: "music",
  trash: "trash",
};

export interface SidebarHooks {
  navigate(path: string): void;
  openInNewTab(path: string): void;
  /** The user removed a pinned folder. */
  unpin(path: string): void;
  /** Fresh volume list, for the status bar's free-space figure. */
  volumes(volumes: Volume[]): void;
}

/** The glass sidebar: Favourites (standard places and pinned folders) and Devices. */
export class Sidebar {
  readonly el = h("aside", { class: "fs-sidebar" });
  private places: Place[] = [];
  private volumes: Volume[] = [];
  private volumeKey = "";
  private current = "";
  private timer: number | undefined;
  private disposed = false;

  constructor(private readonly shell: ShellContext, private readonly hooks: SidebarHooks) {
    this.render();
    void this.loadPlaces();
  }

  private async loadPlaces() {
    try {
      this.places = await fsApi.places();
    } catch (err) {
      console.warn("Could not list places:", err);
    }
    if (!this.disposed) this.render();
  }

  /** Volumes are polled every 5 s while the module is on screen. */
  activate() {
    void this.refreshVolumes();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => void this.refreshVolumes(), 5000);
  }

  deactivate() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async refreshVolumes() {
    let volumes: Volume[];
    try {
      volumes = await fsApi.volumes();
    } catch (err) {
      console.warn("Could not list volumes:", err);
      return;
    }
    if (this.disposed) return;
    this.hooks.volumes(volumes);
    const key = JSON.stringify(volumes);
    if (key === this.volumeKey) return;
    this.volumeKey = key;
    this.volumes = volumes;
    this.render();
  }

  /** Highlights the item for the folder being shown. */
  setCurrent(path: string) {
    this.current = path;
    this.paint();
  }

  /** Rebuilds the list, e.g. after a folder was pinned. */
  render() {
    const pinned = this.shell.config.files.pinned.filter((p) => !this.places.some((place) => samePath(place.path, p)));
    const favourites = [
      ...this.places.map((p) => this.item(PLACE_ICONS[p.kind] ?? "folder", p.name, p.path, false)),
      ...pinned.map((p) => this.item("folder", folderName(p), p, true)),
    ];
    const children: Node[] = [this.section("Favourites", favourites)];
    if (this.volumes.length) children.push(this.section("Devices", this.volumes.map((v) => this.volumeItem(v))));
    this.el.replaceChildren(...children);
    this.paint();
  }

  private section(title: string, items: Node[]) {
    return h("div", { class: "sb-section" }, h("div", { class: "sb-label" }, title), ...items);
  }

  private item(name: IconName, label: string, path: string, pinned: boolean) {
    const button = h("button", { class: "sb-item", type: "button", "data-path": path, title: path },
      h("span", { class: "sb-icon" }, icon(name, 17)), h("span", { class: "sb-name" }, label));
    this.wire(button, path, pinned);
    return button;
  }

  private volumeItem(volume: Volume) {
    const used = volume.total > 0 ? Math.min(1, Math.max(0, (volume.total - volume.free) / volume.total)) : 0;
    const eject = volume.removable
      ? h("span", { class: "sb-eject", title: "Eject" }, icon("eject", 13))
      : null;
    const button = h("button", {
      class: "sb-item sb-volume", type: "button", "data-path": volume.path,
      title: `${volume.name}\n${formatBytes(volume.free)} free of ${formatBytes(volume.total)}`,
    },
    h("span", { class: "sb-icon" }, icon(volumeIcon(volume), 17)),
    h("span", { class: "sb-name" }, volume.name),
    eject,
    h("span", { class: used > 0.9 ? "sb-usage full" : "sb-usage", title: `${formatBytes(volume.free)} free of ${formatBytes(volume.total)}` },
      h("i", { style: { width: `${(used * 100).toFixed(1)}%` } })));
    this.wire(button, volume.path, false);
    return button;
  }

  private wire(button: HTMLElement, path: string, pinned: boolean) {
    button.addEventListener("click", () => this.hooks.navigate(path));
    button.addEventListener("auxclick", (e) => {
      if (e.button === 1) this.hooks.openInNewTab(path);
    });
    button.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        { label: "Open", icon: "folder", action: () => this.hooks.navigate(path) },
        { label: "Open in New Tab", icon: "plus", action: () => this.hooks.openInNewTab(path) },
        ...(pinned ? ["separator" as const, { label: "Remove from Sidebar", icon: "minus" as const, action: () => this.hooks.unpin(path) }] : []),
      ]);
    });
  }

  private paint() {
    // One item wins: the first whose path is exactly the current folder.
    let found = false;
    for (const item of Array.from(this.el.querySelectorAll<HTMLElement>(".sb-item"))) {
      const match = !found && this.current !== "" && samePath(item.dataset.path ?? "", this.current);
      if (match) found = true;
      item.classList.toggle("active", match);
    }
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
  }
}
