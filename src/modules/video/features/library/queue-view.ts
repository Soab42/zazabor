import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import { openMenu } from "../../../../ui/menu";
import { formatTime } from "../../format";
import type { Player } from "../../player";
import { pathArt } from "./art";
import { draggable, dropList, type DragData } from "./dnd";
import { actionButton, formatSpan, row } from "./widgets";
import type { Library } from "./store";

/** The queue beside the video: what plays next, reorderable by dragging, with the usual actions. */

function durationOf(lib: Library, path: string): number {
  return lib.songAt(path)?.duration || lib.info(path)?.duration || lib.folders?.flatMap((f) => f.videos).find((v) => v.path === path)?.duration || 0;
}

function dragData(lib: Library, path: string, index: number): DragData {
  return { paths: [path], origin: { list: "queue", index }, label: lib.label(path) };
}

export class QueueView {
  readonly el = h("div", { class: "lib-queue" });
  private readonly head = h("div", { class: "lib-queue-head" });
  private readonly list = h("div", { class: "lib-list compact queue-list" });
  private key = "";
  private offs: (() => void)[] = [];

  constructor(private readonly lib: Library, private readonly player: Player) {
    this.el.append(this.head, this.list);
    this.offs.push(
      dropList(this.list, () => true, (data, at) => {
        if (data.origin?.list === "queue") this.player.moveInQueue(data.origin.index, at);
        else this.player.insertInQueue(data.paths, at);
      }),
      this.player.onQueueChange(() => this.render()),
      lib.onChange(() => this.render(true)),
    );
    this.render();
  }

  dispose() {
    for (const off of this.offs) off();
    this.offs = [];
  }

  /** Redraws when the queue or the playing item changed (cheap to call on every player update). */
  sync() {
    const key = `${this.player.current}|${this.player.queue.length}|${this.player.queue[0]}|${this.player.repeat}|${this.player.shuffle}`;
    if (key !== this.key) this.render();
  }

  render(soft = false) {
    if (soft && !this.el.isConnected) return;
    const { player, lib } = this;
    this.key = `${player.current}|${player.queue.length}|${player.queue[0]}|${player.repeat}|${player.shuffle}`;
    const queue = player.queue;
    const total = queue.reduce((sum, p) => sum + durationOf(lib, p), 0);

    const toggle = (iconName: "shuffle" | "refresh", label: string, on: boolean, run: () => void) => {
      const b = h("button", { class: `icon-btn small${on ? " active" : ""}`, type: "button", title: label, "aria-label": label, "aria-pressed": String(on) }, icon(iconName, 15));
      b.addEventListener("click", run);
      return b;
    };
    const repeat = toggle("refresh", `Repeat: ${player.repeat === "off" ? "off" : player.repeat === "all" ? "all" : "one"}`, player.repeat !== "off", () => player.cycleRepeat());
    if (player.repeat === "one") repeat.append(h("span", { class: "lib-badge-dot" }, "1"));
    const save = h("button", { class: "icon-btn small", type: "button", title: "Save as playlist", "aria-label": "Save queue as playlist", disabled: queue.length === 0 }, icon("plus", 15));
    save.addEventListener("click", () => void lib.newPlaylistWith(queue));
    const clear = h("button", { class: "icon-btn small", type: "button", title: "Clear queue", "aria-label": "Clear queue", disabled: queue.length <= 1 }, icon("trash", 15));
    clear.addEventListener("click", () => player.clearQueue());
    this.head.replaceChildren(
      h("div", { class: "lib-queue-title" }, h("strong", null, "Queue"), h("span", { class: "lib-count" }, queue.length === 0 ? "Empty" : [`${queue.length} ${queue.length === 1 ? "item" : "items"}`, total ? formatSpan(total) : ""].filter(Boolean).join(" · "))),
      toggle("shuffle", "Shuffle", player.shuffle, () => player.toggleShuffle()), repeat, save, clear);

    if (queue.length === 0) {
      this.list.replaceChildren(h("div", { class: "lib-queue-empty" },
        icon("playlist", 28),
        h("strong", null, "Nothing in the queue"),
        h("span", null, "Play something, or drag items here from the Library tab.")));
      return;
    }
    const scrollTop = this.list.scrollTop;
    this.list.replaceChildren(...queue.map((path, index) => this.rowFor(path, index)));
    this.list.scrollTop = scrollTop;
    if (!soft) this.list.querySelector(".playing")?.scrollIntoView({ block: "nearest" });
  }

  private rowFor(path: string, index: number): HTMLElement {
    const { lib, player } = this;
    const playing = path === player.current;
    const duration = durationOf(lib, path);
    const el = row({
      art: pathArt(lib, path, 96, { iconSize: 14 }),
      title: lib.label(path),
      subtitle: lib.sublabel(path),
      meta: duration ? formatTime(duration) : "",
      playing, listRow: true,
      onOpen: () => lib.playFn(path, player.queue),
      onMenu: (x, y) => openMenu(x, y, [
        { label: "Play", icon: "play", action: () => lib.playFn(path, player.queue) },
        { label: "Play Next", icon: "next", disabled: playing, action: () => player.insertInQueue([path], player.index + 1) },
        { label: "Remove from Queue", icon: "close", disabled: playing, action: () => player.removeFromQueue(index) },
        "separator",
        { label: "Add to Playlist…", icon: "plus", action: () => lib.addToPlaylist([path], x, y) },
        { label: "Clear Queue", icon: "trash", disabled: player.queue.length <= 1, action: () => player.clearQueue() },
      ]),
      actions: playing ? undefined : [actionButton("close", "Remove from queue", () => player.removeFromQueue(index))],
    });
    draggable(el, () => dragData(lib, path, index));
    return el;
  }
}

/**
 * A strip under the compact library that shows what plays next and accepts drops, so items can be
 * dragged into the queue while the library is open.
 */
export class QueueDock {
  readonly el = h("div", { class: "lib-dock" });
  private readonly title = h("button", { class: "lib-dock-title", type: "button", title: "Show the queue" });
  private offs: (() => void)[] = [];

  constructor(private readonly lib: Library, private readonly player: Player, showQueue: () => void) {
    this.title.addEventListener("click", showQueue);
    this.offs.push(
      dropList(this.el, () => true, (data, at) => {
        // Rows in the strip start after the playing item, so map the slot to the queue.
        const base = Math.max(0, this.player.index + 1);
        const slot = Math.min(at, this.visible().length);
        if (data.origin?.list === "queue") this.player.moveInQueue(data.origin.index, base + slot);
        else this.player.insertInQueue(data.paths, base + slot);
      }),
      player.onQueueChange(() => this.render()),
      lib.onChange(() => this.render()),
    );
    this.render();
  }

  dispose() {
    for (const off of this.offs) off();
    this.offs = [];
  }

  private visible(): string[] {
    const { player } = this;
    return player.queue.slice(Math.max(0, player.index + 1), Math.max(0, player.index + 1) + 3);
  }

  render() {
    const { player, lib } = this;
    const upNext = Math.max(0, player.queue.length - Math.max(0, player.index + 1));
    this.title.replaceChildren(icon("playlist", 15), h("span", null, "Up next"), h("span", { class: "lib-count" }, upNext ? String(upNext) : ""), icon("chevronRight", 13));
    const rows = this.visible().map((path) => h("div", { class: "lib-dock-row", "data-row": "", title: lib.label(path) }, h("span", null, lib.label(path))));
    // Rows are direct children of the drop element, which is what the insertion maths reads.
    this.el.replaceChildren(this.title, ...(rows.length ? rows : [h("div", { class: "lib-dock-hint" }, "Drag items here to queue them")]));
  }
}
