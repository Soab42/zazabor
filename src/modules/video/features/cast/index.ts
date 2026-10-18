import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { VideoContext } from "../../extensions";
import { mediaApi, type CastState, type Renderer } from "../../media-api";
import { openDialog } from "../open/dialog";
import { reopenAt } from "../open/playback";
import { emptyState, hint, listButton, sectionLabel } from "../open/ui";

const POLL_MS = 1200;

export interface CastFeature {
  /** Opens the Stream to Device dialog. */
  open(): void;
  /** Goes back to playing on this computer. */
  stop(): Promise<void>;
  /** The app locked or the module closed: forget the device without touching the (already stopped) player. */
  reset(): void;
  readonly active: boolean;
  dispose(): void;
}

const kindLabel = (device: Renderer) => {
  const kind = device.kind === "chromecast" ? "Chromecast" : device.kind || "Device";
  return device.video ? kind : `${kind} · audio only`;
};

/** Streaming to Chromecast and other renderers libVLC can find on the network. */
export function createCast(ctx: VideoContext): CastFeature {
  let target: { id: number; name: string } | null = null;
  const chipName = h("span", { class: "mt-chip-name" });
  const stopButton = h("button", { class: "mt-chip-stop", type: "button", title: "Stop casting", "aria-label": "Stop casting" }, icon("close", 13));
  const chip = h("div", { class: "mt-chip", role: "status" }, icon("desktop", 15), chipName, stopButton);
  chip.hidden = true;
  ctx.stageLayer.append(chip);
  stopButton.addEventListener("click", () => void stop());

  const showChip = () => {
    chip.hidden = target === null;
    chipName.textContent = target ? `Casting to ${target.name}` : "";
  };

  /** Casting only starts with a fresh playback, so the current media is opened again at the same spot. */
  const restart = async () => {
    const { current, state, queue } = ctx.player;
    if (current) await reopenAt(ctx, current, queue, state.time);
  };

  /** Picks the device for the next playback; false when it vanished. */
  async function select(device: Renderer | null): Promise<boolean> {
    try {
      await mediaApi.castTo(device?.id ?? null);
    } catch (err) {
      console.warn("Could not choose the device:", err);
      ctx.showOsd("That device is no longer available");
      return false;
    }
    target = device ? { id: device.id, name: device.name } : null;
    showChip();
    ctx.showOsd(device ? `Casting to ${device.name}` : "Playing on this computer");
    return true;
  }

  async function stop() {
    if (target && (await select(null))) await restart();
  }

  function open() {
    let timer = 0;
    let state: CastState | null = null;
    const dialog = openDialog({
      title: "Stream to Device",
      subtitle: "Send what you're watching to a TV or speaker on your network.",
      icon: "desktop",
      onClose: () => {
        clearInterval(timer);
        // Keep searching only while it can still be useful: a chosen device stays selected on its own.
        void mediaApi.castStopDiscovery().catch(() => undefined);
      },
    });
    const stopCasting = h("button", { class: "btn", type: "button" }, "Play on This Computer");
    stopCasting.addEventListener("click", () => {
      dialog.close();
      void stop();
    });
    dialog.foot.append(h("div", { class: "spacer" }), stopCasting);

    const render = () => {
      stopCasting.hidden = target === null;
      if (!state) {
        dialog.body.replaceChildren(h("div", { class: "mt-loading" }, h("span", { class: "spinner" }), "Looking for devices…"));
        return;
      }
      if (!state.searching.length) {
        dialog.body.replaceChildren(emptyState("desktop", "Casting isn't available",
          "This copy of VLC has no device search installed. Chromecast needs VLC's \"microdns\" discovery plugin; install a VLC build that includes it and try again."));
        return;
      }
      const note = ctx.player.current ? "" : "Nothing is playing yet. Pick a device, then open a video and it plays there.";
      const list = state.devices.length
        ? h("div", { class: "mt-list" }, ...state.devices.map((device) => listButton({
          icon: "desktop",
          title: device.name,
          meta: kindLabel(device),
          active: target?.id === device.id,
          end: target?.id === device.id ? icon("check", 16) : null,
          action: async () => {
            // Select before closing: closing stops the search and forgets the device list.
            const ok = await select(device);
            dialog.close();
            if (ok) await restart();
          },
        })))
        : h("div", { class: "mt-loading" }, h("span", { class: "spinner" }), "Looking for TVs and speakers on your network…");
      dialog.body.replaceChildren(sectionLabel("Devices"), list, hint(note || `Searching with ${state.searching.join(", ")}.`));
    };

    const poll = async () => {
      try {
        state = await mediaApi.castState();
        render();
      } catch (err) {
        console.warn("Could not read cast devices:", err);
      }
    };
    render();
    mediaApi.castDiscover()
      .then((s) => {
        state = s;
        render();
        timer = window.setInterval(() => void poll(), POLL_MS);
      })
      .catch((err) => {
        console.warn("Device search failed:", err);
        state = { searching: [], devices: [], selected: null };
        render();
      });
  }

  return {
    open,
    stop,
    reset() {
      target = null;
      showChip();
    },
    get active() {
      return target !== null;
    },
    dispose() {
      chip.remove();
      if (target) void mediaApi.castTo(null).catch(() => undefined);
    },
  };
}
