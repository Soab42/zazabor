import { getCurrentWindow, currentMonitor, LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { basename, h, stripExtension } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { MenuItem } from "../../../../ui/menu";
import { MAX_VOLUME } from "../../api";
import type { MenuPlace, VideoContext, VideoFeature } from "../../extensions";
import { formatTime } from "../../format";
import { Library } from "../library/store";
import "./mini.css";

/**
 * The mini player (docs/design/vlc/PLAYER.md, frame 970:3091): the window shrinks to a small
 * always-on-top player with the picture, title, previous / play / next, a thin seek bar, volume,
 * a queue list and a button back to the full player. Drag the picture to move the window;
 * double-click it (or press Escape / Ctrl+M) to return.
 */

/** Matches `minWidth` / `minHeight` in tauri.conf.json: the window API cannot read the minimum back. */
const NORMAL_MIN = { width: 860, height: 560 };
// A 16:9 picture (420×236) above the 86px control bar (`--mini-bar-h` in mini.css).
const MINI = { width: 420, height: 322 };
const MARGIN = 28;
const DRAG_THRESHOLD = 4;

interface Saved {
  size: PhysicalSize;
  position: PhysicalPosition;
  alwaysOnTop: boolean;
}

export function createMiniFeature(ctx: VideoContext): VideoFeature {
  const { player } = ctx;
  const root = ctx.stageLayer.closest<HTMLElement>(".vp");
  const lib = Library.of(ctx.shell, player);
  let active = false;
  let busy = false;
  let saved: Saved | null = null;
  let nativeDragBroken = false;
  let clickTimer = 0;
  let watchdog = 0;
  let queueOpen = false;

  // ---- the controls over the window -------------------------------------------------------------

  const titleEl = h("div", { class: "vp-mini-title" });
  const subtitleEl = h("div", { class: "vp-mini-sub" });
  const timeEl = h("div", { class: "vp-mini-time" });
  const seekFill = h("div", { class: "vp-mini-seek-fill" });
  const seekThumb = h("div", { class: "vp-mini-seek-thumb" });
  const seek = h("div", { class: "vp-mini-seek", role: "slider", "aria-label": "Seek", tabIndex: 0 }, seekFill, seekThumb);
  const iconButton = (name: Parameters<typeof icon>[0], label: string, onClick: () => void, extra = "") => {
    const b = h("button", { class: `vp-mini-btn${extra}`, type: "button", title: label, "aria-label": label }, icon(name, 18));
    b.addEventListener("click", onClick);
    return b;
  };
  const prev = iconButton("prev", "Previous", () => player.previous());
  const play = iconButton("play", "Play / Pause", () => player.togglePlay(), " primary");
  const next = iconButton("next", "Next", () => player.next());
  const volume = h("input", { class: "vp-mini-volume", type: "range", min: 0, max: MAX_VOLUME * 100, step: 1, "aria-label": "Volume" });
  volume.addEventListener("input", () => player.setVolume(Number(volume.value) / 100));
  const queueButton = iconButton("playlist", "Queue", () => toggleQueue());
  const returnButton = iconButton("fullscreen", "Back to the full player (double-click the picture)", () => void exit());
  const queuePanel = h("div", { class: "vp-mini-queue", hidden: true });
  const dragLayer = h("div", { class: "vp-mini-drag", title: "Drag to move · double-click to return" });
  const bar = h("div", { class: "vp-mini-bar" },
    seek,
    h("div", { class: "vp-mini-row" }, h("div", { class: "vp-mini-text" }, titleEl, subtitleEl), timeEl),
    h("div", { class: "vp-mini-row controls" },
      h("div", { class: "vp-mini-transport" }, prev, play, next),
      h("div", { class: "vp-mini-right" }, icon("volume", 15), volume, queueButton, returnButton)));
  const overlay = h("div", { class: "vp-mini", hidden: true }, dragLayer, queuePanel, bar);
  root?.append(overlay);

  // ---- seeking ----------------------------------------------------------------------------------

  const seekFrom = (e: PointerEvent) => {
    const r = seek.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (player.state.length > 0) player.seekTo(ratio * player.state.length);
  };
  seek.addEventListener("pointerdown", (e) => {
    seek.setPointerCapture(e.pointerId);
    seek.classList.add("dragging");
    seekFrom(e);
  });
  seek.addEventListener("pointermove", (e) => {
    if (seek.hasPointerCapture(e.pointerId)) seekFrom(e);
  });
  const endSeek = (e: PointerEvent) => {
    if (seek.hasPointerCapture(e.pointerId)) seek.releasePointerCapture(e.pointerId);
    seek.classList.remove("dragging");
  };
  seek.addEventListener("pointerup", endSeek);
  seek.addEventListener("pointercancel", endSeek);
  seek.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      player.seekBy((e.key === "ArrowLeft" ? -1 : 1) * 5000);
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // ---- the picture: click, double-click, drag ---------------------------------------------------

  dragLayer.addEventListener("click", () => {
    clearTimeout(clickTimer);
    clickTimer = window.setTimeout(() => player.togglePlay(), 230);
  });
  dragLayer.addEventListener("dblclick", () => {
    clearTimeout(clickTimer);
    void exit();
  });
  dragLayer.addEventListener("pointerdown", (down) => {
    if (down.button !== 0) return;
    const start = { x: down.screenX, y: down.screenY };
    let moved = false;
    let origin: PhysicalPosition | null = null;
    let frame = 0;
    const win = getCurrentWindow();
    const dpr = window.devicePixelRatio || 1;
    void win.outerPosition().then((p) => (origin = p)).catch(() => undefined);

    const move = (e: PointerEvent) => {
      const dx = e.screenX - start.x;
      const dy = e.screenY - start.y;
      if (!moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        moved = true;
        clearTimeout(clickTimer);
        if (!nativeDragBroken) {
          // The window manager takes over the pointer from here; if the permission is missing
          // (core:window:allow-start-dragging), fall back to moving the window ourselves.
          win.startDragging().then(() => cleanup(), () => (nativeDragBroken = true));
          return;
        }
      }
      if (!nativeDragBroken || !origin) return;
      const target = origin;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void win.setPosition(new PhysicalPosition(Math.round(target.x + dx * dpr), Math.round(target.y + dy * dpr))).catch(() => undefined);
      });
    };
    const up = () => {
      cleanup();
      if (moved) {
        // A drag must not count as a click.
        const swallow = (c: Event) => c.stopPropagation();
        dragLayer.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => dragLayer.removeEventListener("click", swallow, true), 0);
      }
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });

  // ---- queue list -------------------------------------------------------------------------------

  function renderQueue() {
    queuePanel.hidden = !queueOpen;
    queueButton.classList.toggle("active", queueOpen);
    if (!queueOpen) return;
    const items = player.queue.map((path) => {
      const playing = path === player.current;
      const row = h("button", { class: `vp-mini-qrow${playing ? " playing" : ""}`, type: "button", title: lib.label(path) },
        h("span", { class: "vp-mini-qname" }, lib.label(path)), h("span", { class: "vp-mini-qsub" }, lib.sublabel(path)));
      row.addEventListener("click", () => lib.playFn(path, player.queue));
      return row;
    });
    queuePanel.replaceChildren(
      h("div", { class: "vp-mini-qhead" }, "Queue"),
      h("div", { class: "vp-mini-qlist" }, ...(items.length ? items : [h("div", { class: "vp-mini-qempty" }, "Nothing queued")])));
    queuePanel.querySelector(".playing")?.scrollIntoView({ block: "nearest" });
  }

  function toggleQueue() {
    queueOpen = !queueOpen;
    renderQueue();
  }

  // ---- state ------------------------------------------------------------------------------------

  let shownKey = "";
  function update() {
    if (!active) return;
    if (!player.current) {
      void exit();
      return;
    }
    const { state } = player;
    const path = player.current;
    const key = `${path}|${player.queue.length}`;
    if (key !== shownKey) {
      shownKey = key;
      titleEl.textContent = lib.label(path) || stripExtension(basename(path));
      subtitleEl.textContent = lib.sublabel(path);
      if (queueOpen) renderQueue();
    }
    play.replaceChildren(icon(state.playing ? "pause" : "play", 18));
    prev.disabled = !player.hasPrevious;
    next.disabled = !player.hasNext;
    const ratio = state.length > 0 ? Math.min(1, state.time / state.length) : 0;
    seekFill.style.width = `${ratio * 100}%`;
    seekThumb.style.left = `${ratio * 100}%`;
    timeEl.textContent = state.length > 0 ? `${formatTime(state.time)} / ${formatTime(state.length)}` : formatTime(state.time);
    if (document.activeElement !== volume) volume.value = String(Math.round(state.volume * 100));
  }
  const unsubscribe = player.subscribe(update);
  const unsubscribeQueue = player.onQueueChange(() => {
    if (queueOpen && active) renderQueue();
  });

  // ---- entering and leaving ---------------------------------------------------------------------

  async function leaveFullscreen() {
    if (!ctx.fullscreen) return;
    // The module owns fullscreen; Escape is how it is left.
    ctx.stageLayer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    for (let i = 0; i < 20 && ctx.fullscreen; i++) await new Promise((r) => setTimeout(r, 50));
  }

  async function enter() {
    if (active || busy || !root) return;
    if (!player.current) {
      ctx.showOsd("Play something to use the mini player");
      return;
    }
    busy = true;
    try {
      await leaveFullscreen();
      if (ctx.fullscreen) {
        ctx.showOsd("Leave fullscreen first");
        return;
      }
      const win = getCurrentWindow();
      if (await win.isMaximized()) {
        try {
          await win.unmaximize();
        } catch {
          ctx.showOsd("Restore the window size to use the mini player");
          return;
        }
      }
      saved = { size: await win.innerSize(), position: await win.outerPosition(), alwaysOnTop: await win.isAlwaysOnTop() };
      ctx.closePanel();
      ctx.showPlayer();
      await win.setMinSize(new LogicalSize(MINI.width, MINI.height));
      await win.setSize(new LogicalSize(MINI.width, MINI.height));
      await win.setAlwaysOnTop(true);
      await moveToCorner(win);
      active = true;
      shownKey = "";
      queueOpen = false;
      root.classList.add("mini");
      overlay.hidden = false;
      renderQueue();
      update();
      watchdog = window.setInterval(() => {
        // The module was hidden (another app module took over): the mini window goes with it.
        if (active && root.getClientRects().length === 0) void exit();
      }, 600);
    } catch (err) {
      console.warn("Mini player failed:", err);
      await restoreWindow();
      ctx.showOsd("The mini player couldn't start");
    } finally {
      busy = false;
    }
  }

  async function moveToCorner(win: ReturnType<typeof getCurrentWindow>) {
    try {
      const monitor = await currentMonitor();
      if (!monitor) return;
      const scale = monitor.scaleFactor || 1;
      const x = monitor.position.x + monitor.size.width - Math.round((MINI.width + MARGIN) * scale);
      const y = monitor.position.y + monitor.size.height - Math.round((MINI.height + MARGIN * 2.5) * scale);
      await win.setPosition(new PhysicalPosition(Math.max(monitor.position.x, x), Math.max(monitor.position.y, y)));
    } catch (err) {
      console.warn("Could not place the mini player:", err);
    }
  }

  /** Puts the window back exactly as it was: always-on-top, minimum size, size and position. */
  async function restoreWindow() {
    const win = getCurrentWindow();
    const before = saved;
    saved = null;
    try {
      await win.setAlwaysOnTop(before?.alwaysOnTop ?? false);
      await win.setMinSize(new LogicalSize(NORMAL_MIN.width, NORMAL_MIN.height));
      if (before) {
        await win.setSize(before.size);
        await win.setPosition(before.position);
      }
    } catch (err) {
      console.warn("Could not restore the window:", err);
    }
  }

  async function exit() {
    if (!active || busy) return;
    busy = true;
    try {
      active = false;
      clearInterval(watchdog);
      clearTimeout(clickTimer);
      queueOpen = false;
      overlay.hidden = true;
      queuePanel.hidden = true;
      root?.classList.remove("mini");
      await restoreWindow();
    } finally {
      busy = false;
    }
  }

  const toggle = () => (active ? exit() : enter());

  return {
    menuItems(place: MenuPlace): MenuItem[] {
      if (place === "open") return [];
      return [{ label: active ? "Exit Mini Player" : "Mini Player", icon: "pip", action: () => void toggle() }];
    },
    handleKey(e: KeyboardEvent): boolean {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "m") {
        void toggle();
        return true;
      }
      if (active && e.key === "Escape" && !document.querySelector(".menu")) {
        void exit();
        return true;
      }
      return false;
    },
    dispose() {
      unsubscribe();
      unsubscribeQueue();
      clearInterval(watchdog);
      clearTimeout(clickTimer);
      if (active) {
        active = false;
        root?.classList.remove("mini");
        void restoreWindow();
      }
      overlay.remove();
    },
  };
}
