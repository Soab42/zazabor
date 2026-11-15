import { h } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { MenuItem } from "../../../../ui/menu";
import type { VideoContext, VideoFeature } from "../../extensions";
import { openReceiverDialog } from "./dialog";
import { castTitle, currentCast, endCast, onCastChange, type PlayRequest } from "./service";

/** A cast that plays this long without a single picture is sending sound only. */
const NO_PICTURE_MS = 4000;

/**
 * Cast to Zazabor inside the player: a "From Pixel 7 · YouTube" chip over the video while a cast
 * plays (its × stops it and tells the phone), and "Cast to This PC…" in the menus. A cast without
 * a picture (VLC's "Audio only" casting, VLC for Android playing a video as audio, a song over
 * DLNA) shows its title and why there is no picture instead of a black stage.
 */
export function receiverFeature(ctx: VideoContext): VideoFeature {
  const name = h("span", { class: "mt-chip-name" });
  const stop = h("button", { class: "mt-chip-stop", type: "button", title: "Stop casting", "aria-label": "Stop casting" }, icon("close", 13));
  const chip = h("div", { class: "mt-chip rc-chip", role: "status" }, icon("cast", 15), name, stop);
  chip.hidden = true;
  const sound = h("div", { class: "rc-sound", hidden: true });
  ctx.stageLayer.append(sound, chip);
  let soundKey = "";
  stop.addEventListener("click", () => {
    endCast();
    void ctx.player.stop();
  });

  const render = () => {
    const cast = currentCast();
    const showing = !!cast && ctx.player.current === cast.url;
    chip.hidden = !showing;
    if (showing && cast) name.replaceChildren(`From ${cast.sender}`, h("small", null, cast.sourceLabel));
    const { playing, time, videoWidth } = ctx.player.state;
    const noPicture = showing && !!cast && videoWidth <= 0 && (cast.audioOnly || (playing && time >= NO_PICTURE_MS));
    const key = noPicture && cast ? `${cast.session}|${cast.audioOnly}` : "";
    if (key === soundKey) return;
    soundKey = key;
    sound.hidden = !noPicture;
    sound.replaceChildren(...(noPicture && cast ? soundOnly(cast) : []));
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
      sound.remove();
    },
  };
}

/** The stage for a cast without a picture: its art and title, and what to change on the phone. */
function soundOnly(cast: PlayRequest): HTMLElement[] {
  const art = h("div", { class: "rc-sound-art" }, icon(cast.source === "dlna" ? "music" : "cast", 56));
  if (cast.artwork) {
    const img = h("img", { alt: "", draggable: false, referrerPolicy: "no-referrer", src: cast.artwork });
    img.addEventListener("load", () => img.classList.add("loaded"));
    img.addEventListener("error", () => img.remove());
    art.append(img);
  }
  // VLC says what it sends; "audio/…" means the phone left the picture out on purpose.
  const why = cast.source === "cast"
    ? cast.audioOnly
      ? "VLC on the phone is sending only the sound. To see the picture, turn off Settings → Casting → Audio only in VLC, then play the video again from VLC's video player."
      : "VLC on the phone isn't sending a picture. Play the video again from VLC's video player, and check that Settings → Casting → Audio only is off."
    : cast.audioOnly ? null : `${cast.sender} isn't sending a picture, only the sound.`;
  return [
    art,
    h("div", { class: "rc-sound-text" },
      h("div", { class: "rc-sound-title" }, castTitle(cast)),
      h("div", { class: "rc-sound-from" }, cast.subtitle || `Sound from ${cast.sender}`),
      why ? h("p", { class: "rc-sound-why" }, why) : null),
  ];
}
