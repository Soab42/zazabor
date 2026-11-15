import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { MenuItem } from "../../../../ui/menu";
import type { VideoContext, VideoFeature } from "../../extensions";
import { openReceiverDialog } from "./dialog";
import { currentCast, endCast, onCastChange } from "./service";

/**
 * Cast to Zazabor inside the player: a "From Pixel 7 · YouTube" chip over the video while a cast
 * plays (its × stops it and tells the phone), and "Cast to This PC…" in the menus.
 */
export function receiverFeature(ctx: VideoContext): VideoFeature {
  const name = h("span", { class: "mt-chip-name" });
  const stop = h("button", { class: "mt-chip-stop", type: "button", title: "Stop casting", "aria-label": "Stop casting" }, icon("close", 13));
  const chip = h("div", { class: "mt-chip rc-chip", role: "status" }, icon("cast", 15), name, stop);
  chip.hidden = true;
  ctx.stageLayer.append(chip);
  stop.addEventListener("click", () => {
    endCast();
    void ctx.player.stop();
  });

  const render = () => {
    const cast = currentCast();
    const showing = !!cast && ctx.player.current === cast.url;
    chip.hidden = !showing;
    if (showing && cast) name.replaceChildren(`From ${cast.sender}`, h("small", null, cast.sourceLabel));
  };
  const unsubscribeCast = onCastChange(render);
  const unsubscribePlayer = ctx.player.subscribe(render);

  const item: MenuItem = { label: "Cast to This PC…", icon: "cast", action: () => openReceiverDialog(ctx.shell) };
  return {
    menuItems: (place) => (place === "open" || place === "top" ? [item] : []),
    dispose() {
      unsubscribeCast();
      unsubscribePlayer();
      chip.remove();
    },
  };
}
