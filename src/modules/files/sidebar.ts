import { formatBytes, h } from "../../ui/dom";
import { icon, type IconName } from "../../ui/icons";
import { openMenu, type MenuItem } from "../../ui/menu";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { ShellContext } from "../../shell/module";
import { fsApi, type Place, type PlaceKind, type Volume } from "./api";
import { volumeIcon } from "./kinds";
import { addressOnMount, subPath } from "./network/address";
import { openServerSheet, saveServer, tryMount } from "./network/connect";
import { networkApi, onMountsChanged, type Mount } from "./network-api";
import { showToast } from "./ops/toast";
import { folderName, joinPath, samePath } from "./path";
import "./network/network.css";

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

const PHONE_HINT = "Unlock your phone and choose File transfer";

export interface SidebarHooks {
  navigate(path: string): void;
  openInNewTab(path: string): void;
  /** The user removed a pinned folder. */
  unpin(path: string): void;
  /** Fresh volume list, for the status bar's free-space figure. */
  volumes(volumes: Volume[]): void;
}

/** One sidebar row, before it becomes a button. */
interface Row {
  icon: IconName;
  label: string;
  /** Highlight/navigation path; "" when the row is not browsable yet. */
  path: string;
  /** Tooltip. */
  title?: string;
  /** A second line under the name (phone hints). */
  hint?: string;
  offline?: boolean;
  usage?: { total: number; free: number };
  /** Stable id for the busy state. */
  key: string;
  /** Click, when it is not simply navigating to `path`. */
  open?: () => void;
  /** Shows an eject button. */
  leave?: { label: string; run: () => void };
  menu: () => MenuItem[];
}

/**
 * The glass sidebar: Favourites, Devices (disks, USB, phones), Cloud and Network (shares and
 * saved servers), kept fresh by the GIO volume monitor.
 */
export class Sidebar {
  readonly el = h("aside", { class: "fs-sidebar" });
  private places: Place[] = [];
  private volumes: Volume[] = [];
  private mounts: Mount[] = [];
  private volumeKey = "";
  private mountKey = "";
  private current = "";
  private timer: number | undefined;
  private debounce: number | undefined;
  private unlisten: UnlistenFn | null = null;
  private readonly busy = new Set<string>();
  private disposed = false;

  constructor(private readonly shell: ShellContext, private readonly hooks: SidebarHooks) {
    this.render();
    void this.loadPlaces();
    void onMountsChanged(() => this.mountsChanged()).then((un) => {
      if (this.disposed) un();
      else this.unlisten = un;
    });
  }

  private async loadPlaces() {
    try {
      this.places = await fsApi.places();
    } catch (err) {
      console.warn("Could not list places:", err);
    }
    if (!this.disposed) this.render();
  }

  /** Volumes are polled every 5 s while the module is on screen; mounts follow events. */
  activate() {
    void this.refreshVolumes();
    void this.refreshMounts();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => void this.refreshVolumes(), 5000);
  }

  deactivate() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private mountsChanged() {
    clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => {
      void this.refreshVolumes();
      void this.refreshMounts();
    }, 120);
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

  private async refreshMounts() {
    let mounts: Mount[];
    try {
      mounts = await networkApi.mounts();
    } catch (err) {
      console.warn("Could not list mounts:", err);
      return;
    }
    if (this.disposed) return;
    const key = JSON.stringify(mounts);
    if (key === this.mountKey) return;
    this.mountKey = key;
    this.mounts = mounts;
    this.render();
  }

  /** Highlights the item for the folder being shown. */
  setCurrent(path: string) {
    this.current = path;
    this.paint();
  }

  /** Opens Connect to Server (Ctrl+K). */
  connectToServer() {
    openServerSheet(this.shell, { connected: (mount, address) => this.connected(mount, address) });
  }

  /** Rebuilds the list, e.g. after a folder was pinned. */
  render() {
    const pinned = this.shell.config.files.pinned.filter((p) => !this.places.some((place) => samePath(place.path, p)));
    const favourites = [
      ...this.places.map((p) => this.pathRow(PLACE_ICONS[p.kind] ?? "folder", p.name, p.path, false)),
      ...pinned.map((p) => this.pathRow("folder", folderName(p), p, true)),
    ];
    const children: Node[] = [this.section("Favourites", favourites)];
    const devices = this.deviceRows();
    if (devices.length) children.push(this.section("Devices", devices.map((r) => this.row(r))));
    const cloud = this.mounts.filter((m) => m.kind === "cloud");
    if (cloud.length) children.push(this.section("Cloud", cloud.map((m) => this.row(this.mountRow(m)))));
    const network = this.networkRows();
    const add = h("button", {
      class: "sb-add", type: "button", title: "Connect to Server… (Ctrl+K)", "aria-label": "Connect to Server",
      onclick: () => this.connectToServer(),
    }, icon("plus", 13));
    children.push(this.section("Network", network.map((r) => this.row(r)), add,
      network.length ? null : h("p", { class: "sb-empty" }, "No servers yet")));
    this.el.replaceChildren(...children);
    this.paint();
  }

  private section(title: string, items: Node[], action?: Node | null, footer?: Node | null) {
    return h("div", { class: "sb-section" },
      h("div", { class: "sb-label" }, h("span", null, title), action), ...items, footer);
  }

  // ---- rows ---------------------------------------------------------------------------------

  private pathRow(name: IconName, label: string, path: string, pinned: boolean) {
    return this.row({
      icon: name, label, path, title: path, key: path,
      menu: () => [
        ...this.openItems(path),
        ...(pinned ? ["separator" as const, { label: "Remove from Sidebar", icon: "minus" as const, action: () => this.hooks.unpin(path) }] : []),
      ],
    });
  }

  private deviceRows(): Row[] {
    const rows: Row[] = [];
    const byPath = (path: string) => this.mounts.find((m) => m.path !== "" && samePath(m.path, path));
    for (const volume of this.volumes) {
      if (volume.path.includes("/gvfs/")) continue;
      const mount = byPath(volume.path);
      const ejectable = !!mount && (mount.canEject || mount.canUnmount);
      const label = ejectable && mount.canEject ? "Eject" : "Unmount";
      rows.push({
        icon: volumeIcon(volume), label: volume.name, path: volume.path, key: volume.path,
        title: `${volume.name}\n${formatBytes(volume.free)} free of ${formatBytes(volume.total)}`,
        usage: volume.total > 0 ? { total: volume.total, free: volume.free } : undefined,
        leave: ejectable || volume.removable
          ? { label, run: () => this.leave(volume.path, volume.name, volume.path, mount?.canEject !== false) }
          : undefined,
        menu: () => [
          ...this.openItems(volume.path),
          ...(ejectable || volume.removable
            ? ["separator" as const, { label, icon: "eject" as const, action: () => this.leave(volume.path, volume.name, volume.path, mount?.canEject !== false) }]
            : []),
        ],
      });
    }
    for (const mount of this.mounts.filter((m) => m.kind === "phone")) rows.push(this.mountRow(mount));
    return rows;
  }

  private networkRows(): Row[] {
    const rows: Row[] = [];
    const mounted = this.mounts.filter((m) => m.kind === "network");
    const saved = this.shell.config.files.servers;
    for (const mount of mounted) {
      const server = saved.find((s) => addressOnMount(s.url, mount.uri));
      rows.push(this.mountRow(mount, server?.url));
    }
    for (const server of saved) {
      if (mounted.some((m) => addressOnMount(server.url, m.uri))) continue;
      rows.push({
        icon: "network", label: server.name, path: "", title: server.url, offline: true, key: server.url,
        hint: undefined,
        open: () => void this.connect(server.url, server.url, "network"),
        menu: () => [
          { label: "Connect", icon: "network", action: () => void this.connect(server.url, server.url, "network") },
          "separator",
          { label: "Copy Address", icon: "copy", action: () => this.copy(server.url) },
          { label: "Remove from Sidebar", icon: "minus", action: () => this.forget(server.url) },
        ],
      });
    }
    return rows;
  }

  private mountRow(mount: Mount, savedUrl?: string): Row {
    const phone = mount.kind === "phone";
    const where = mount.mounted && mount.path && !mount.locked;
    const kindIcon: IconName = phone ? "phone" : mount.kind === "cloud" ? "server" : "network";
    const leaveLabel = mount.canEject ? "Eject" : phone || mount.kind === "network" || mount.kind === "cloud" ? "Disconnect" : "Unmount";
    const canLeave = mount.mounted && (mount.canEject || mount.canUnmount);
    const target = mount.path || mount.uri;
    return {
      icon: kindIcon, label: mount.name, path: mount.path, key: mount.uri,
      title: mount.uri, offline: !mount.mounted,
      hint: phone && !where ? PHONE_HINT : undefined,
      open: where ? undefined : () => void this.openPhone(mount),
      leave: canLeave ? { label: leaveLabel, run: () => this.leave(mount.uri, mount.name, target, mount.canEject) } : undefined,
      menu: () => [
        ...(where ? this.openItems(mount.path) : [{ label: mount.mounted ? "Open" : "Connect", icon: "folder" as const, action: () => void this.openPhone(mount) }]),
        ...(canLeave ? ["separator" as const, { label: leaveLabel, icon: "eject" as const, action: () => this.leave(mount.uri, mount.name, target, mount.canEject) }] : []),
        "separator" as const,
        { label: "Copy Address", icon: "copy" as const, action: () => this.copy(mount.uri) },
        ...(savedUrl ? [{ label: "Remove from Sidebar", icon: "minus" as const, action: () => this.forget(savedUrl) }] : []),
      ],
    };
  }

  private openItems(path: string): MenuItem[] {
    return [
      { label: "Open", icon: "folder", action: () => this.hooks.navigate(path) },
      { label: "Open in New Tab", icon: "plus", action: () => this.hooks.openInNewTab(path) },
    ];
  }

  private row(row: Row): HTMLElement {
    const busy = this.busy.has(row.key);
    const full = row.usage && row.usage.total > 0 ? (row.usage.total - row.usage.free) / row.usage.total > 0.9 : false;
    const used = row.usage && row.usage.total > 0 ? Math.min(1, Math.max(0, (row.usage.total - row.usage.free) / row.usage.total)) : 0;
    const eject = row.leave
      ? h("span", {
        class: "sb-eject", role: "button", title: busy ? "Working…" : row.leave.label, "aria-label": row.leave.label,
      }, busy ? h("span", { class: "spinner sb-spin" }) : icon("eject", 13))
      : busy ? h("span", { class: "sb-eject" }, h("span", { class: "spinner sb-spin" })) : null;
    const button = h("button", {
      class: `sb-item${row.usage || row.hint ? " sb-volume" : ""}${row.offline ? " offline" : ""}${busy ? " busy" : ""}`,
      type: "button", "data-path": row.path || null, title: row.title ?? row.label,
    },
    h("span", { class: "sb-icon" }, icon(row.icon, 17)),
    h("span", { class: "sb-name" }, row.label),
    eject,
    row.usage
      ? h("span", { class: full ? "sb-usage full" : "sb-usage", title: `${formatBytes(row.usage.free)} free of ${formatBytes(row.usage.total)}` },
        h("i", { style: { width: `${(used * 100).toFixed(1)}%` } }))
      : null,
    row.hint ? h("span", { class: "sb-hint" }, row.hint) : null);
    if (row.path) button.dataset.dropPath = row.path;
    if (row.leave) {
      eject?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!busy) row.leave?.run();
      });
    }
    button.addEventListener("click", () => {
      if (busy) return;
      if (row.open) row.open();
      else if (row.path) this.hooks.navigate(row.path);
    });
    button.addEventListener("auxclick", (e) => {
      if (e.button === 1 && row.path && !row.open) this.hooks.openInNewTab(row.path);
    });
    button.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, row.menu());
    });
    return button;
  }

  // ---- actions ------------------------------------------------------------------------------

  private setBusy(key: string, on: boolean) {
    if (on) this.busy.add(key);
    else this.busy.delete(key);
    if (!this.disposed) this.render();
  }

  private async leave(key: string, name: string, target: string, eject: boolean) {
    this.setBusy(key, true);
    try {
      if (eject) await networkApi.eject(target);
      else await networkApi.unmount(target);
    } catch (err) {
      showToast(`Could not ${eject ? "eject" : "disconnect"} “${name}”: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.setBusy(key, false);
      void this.refreshVolumes();
      void this.refreshMounts();
    }
  }

  private async openPhone(mount: Mount) {
    if (mount.mounted && mount.path && !mount.locked) {
      this.hooks.navigate(mount.path);
      return;
    }
    if (mount.mounted) {
      // Mounted but nothing to read: the phone is locked or in charge-only mode.
      showToast(mount.kind === "phone" ? PHONE_HINT : "This location has no folder on this computer");
      void this.refreshMounts();
      return;
    }
    await this.connect(mount.uri, mount.uri, mount.kind);
  }

  /** Mounts an address from the sidebar; asks for a login only if the server wants one. */
  private async connect(key: string, address: string, kind: Mount["kind"]) {
    this.setBusy(key, true);
    const outcome = await tryMount(address);
    this.setBusy(key, false);
    if ("mount" in outcome) {
      saveServer(this.shell, outcome.mount, address);
      this.connected(outcome.mount, address);
    } else if ("auth" in outcome) {
      openServerSheet(this.shell, { address, credentials: true, connected: (mount, a) => this.connected(mount, a) });
    } else {
      showToast(kind === "phone" ? `${PHONE_HINT}. ${outcome.error}` : outcome.error);
    }
  }

  /** A share or device is mounted: refresh and open it. */
  private connected(mount: Mount, address: string) {
    void this.refreshMounts();
    if (mount.path) this.hooks.navigate(joinSub(mount.path, subPath(address, mount.uri)));
    this.render();
  }

  private forget(url: string) {
    const files = this.shell.config.files;
    files.servers = files.servers.filter((s) => s.url !== url);
    this.shell.saveConfig();
    this.render();
  }

  private copy(text: string) {
    void navigator.clipboard.writeText(text).then(() => showToast("Address copied"), () => showToast("Could not copy the address"));
  }

  private paint() {
    // One item wins: the first whose path is exactly the current folder.
    let found = false;
    for (const item of Array.from(this.el.querySelectorAll<HTMLElement>(".sb-item"))) {
      const match = !found && this.current !== "" && !!item.dataset.path && samePath(item.dataset.path, this.current);
      if (match) found = true;
      item.classList.toggle("active", match);
    }
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    this.unlisten?.();
  }
}

function joinSub(root: string, sub: string): string {
  return sub ? joinPath(root, sub.replace(/^\/+/, "")) : root;
}
