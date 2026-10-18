import { basename, dirname, h, stripExtension } from "../../../../ui/dom";
import { icon } from "../../../../ui/icons";
import type { VideoContext } from "../../extensions";
import { isLocation, looksLikePlaylist, mediaApi, playlistHook, type CaptureDevice } from "../../media-api";
import { mediaSettings } from "../profiles/settings";
import { focusFirst, openDialog } from "./dialog";
import { emptyState, errorLine, hint, hostOf, listButton, sectionLabel, textInput } from "./ui";

const MAX_URLS = 12;

/** "www.example.com/a.mp4" becomes "https://www.example.com/a.mp4"; anything else is kept. */
export function normalizeAddress(raw: string): string {
  const text = raw.trim().replace(/^["']|["']$/g, "");
  if (!text || isLocation(text) || text.startsWith("/")) return text;
  return /^(www\.|[\w-]+(\.[\w-]+)+(:\d+)?\/)/i.test(text) ? `https://${text}` : text;
}

/**
 * Plays a web address or device address. A playlist address (M3U, PLS…) is listed first: when
 * the media library's hook takes it, it becomes a playlist; otherwise its entries become the
 * queue and the first one plays. Resolves to an error message, or null when playback started.
 */
export async function playAddress(ctx: VideoContext, raw: string): Promise<string | null> {
  const address = normalizeAddress(raw);
  if (!isLocation(address)) return "That doesn't look like a web address. It should start with http://, https:// or rtsp://.";
  const settings = mediaSettings(ctx.shell);
  if (settings.rememberUrls) {
    settings.recentUrls = [address, ...settings.recentUrls.filter((u) => u !== address)].slice(0, MAX_URLS);
    ctx.shell.saveConfig();
  }
  if (settings.detectPlaylists && looksLikePlaylist(address)) {
    let entries;
    try {
      entries = await mediaApi.resolvePlaylist(address);
    } catch (err) {
      console.warn("Could not read the playlist:", err);
      return "That playlist could not be read. Check the address and your connection.";
    }
    if (entries.length > 1 && playlistHook.importPlaylist) {
      try {
        if (await playlistHook.importPlaylist(address, entries)) {
          ctx.showOsd(`Playlist added · ${entries.length} entries`);
          return null;
        }
      } catch (err) {
        console.warn("Playlist import failed:", err);
      }
    }
    const mrls = entries.map((e) => e.mrl);
    await ctx.play(mrls[0], mrls.length > 1 ? mrls : undefined);
    return null;
  }
  await ctx.play(address);
  return null;
}

// ---- Network Stream ---------------------------------------------------------------------------------

export function openNetworkStream(ctx: VideoContext) {
  const dialog = openDialog({ title: "Network Stream", subtitle: "Play a video, a live stream or a playlist from a web address.", icon: "network" });
  const input = textInput("https://example.com/video.mp4");
  const error = errorLine();
  const play = h("button", { class: "btn primary", type: "button" }, icon("play", 15), "Play");
  const cancel = h("button", { class: "btn ghost", type: "button" }, "Cancel");
  cancel.addEventListener("click", () => dialog.close());

  const submit = async (value: string) => {
    error.set("");
    play.disabled = true;
    play.replaceChildren(h("span", { class: "spinner" }), "Opening…");
    const problem = await playAddress(ctx, value);
    if (problem) {
      error.set(problem);
      play.disabled = false;
      play.replaceChildren(icon("play", 15), "Play");
    } else {
      dialog.close();
    }
  };
  play.addEventListener("click", () => void submit(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit(input.value);
    }
  });
  dialog.body.append(
    sectionLabel("Address"), input, error.el,
    hint("HTTP, HTTPS, RTSP, MMS and UDP addresses work. A playlist address (M3U, PLS) opens as a list of channels."));

  const recent = mediaSettings(ctx.shell).recentUrls;
  if (recent.length) {
    const clear = h("button", { class: "text-btn", type: "button" }, "Clear");
    clear.addEventListener("click", () => {
      mediaSettings(ctx.shell).recentUrls = [];
      ctx.shell.saveConfig();
      list.remove();
      heading.remove();
    });
    const heading = sectionLabel("Recent addresses", clear);
    const list = h("div", { class: "mt-list" },
      ...recent.map((url) => listButton({ icon: "network", title: hostOf(url), meta: url, action: () => void submit(url) })));
    dialog.body.append(heading, list);
  }
  dialog.foot.append(h("div", { class: "spacer" }), cancel, play);
  input.focus();
}

// ---- Capture Device ---------------------------------------------------------------------------------

export function openCaptureDevice(ctx: VideoContext) {
  const dialog = openDialog({ title: "Capture Device", subtitle: "Watch a webcam, capture card or TV tuner.", icon: "video" });
  const render = (devices: CaptureDevice[] | null, failed = false) => {
    if (devices === null) {
      dialog.body.replaceChildren(h("div", { class: "mt-loading" }, h("span", { class: "spinner" }), "Looking for devices…"));
      return;
    }
    if (!devices.length) {
      dialog.body.replaceChildren(emptyState("video", failed ? "Couldn't look for devices" : "No cameras found",
        "Plug in a webcam or capture card. If it is already connected, make sure your user may use video devices.",
        { label: "Look again", run: () => void load() }));
      return;
    }
    dialog.body.replaceChildren(
      sectionLabel("Available devices"),
      h("div", { class: "mt-list" }, ...devices.map((d) => listButton({
        icon: "video", title: d.name, meta: d.path,
        action: () => {
          dialog.close();
          void ctx.play(d.mrl);
        },
      }))));
    focusFirst(dialog);
  };
  const load = async () => {
    render(null);
    try {
      render(await mediaApi.captureDevices());
    } catch (err) {
      console.warn("Could not list capture devices:", err);
      render([], true);
    }
  };
  const refresh = h("button", { class: "btn ghost", type: "button" }, icon("refresh", 15), "Refresh");
  refresh.addEventListener("click", () => void load());
  dialog.foot.append(refresh);
  void load();
}

// ---- From Clipboard ---------------------------------------------------------------------------------

export function openFromClipboard(ctx: VideoContext) {
  const dialog = openDialog({ title: "From Clipboard", subtitle: "Play a file path or web address you copied.", icon: "paste" });
  const input = textInput("Paste a path or address");
  const error = errorLine();
  const play = h("button", { class: "btn primary", type: "button" }, icon("play", 15), "Play");
  const cancel = h("button", { class: "btn ghost", type: "button" }, "Cancel");
  cancel.addEventListener("click", () => dialog.close());

  const submit = async () => {
    const text = input.value.trim().replace(/^["']|["']$/g, "");
    if (!text) {
      error.set("Nothing to play yet. Copy a path or address, then paste it here.");
      return;
    }
    error.set("");
    if (isLocation(text) || /^(www\.|[\w-]+(\.[\w-]+)+\/)/i.test(text)) {
      play.disabled = true;
      const problem = await playAddress(ctx, text);
      play.disabled = false;
      if (problem) error.set(problem);
      else dialog.close();
    } else {
      dialog.close();
      await ctx.play(text);
    }
  };
  play.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  });
  dialog.body.append(sectionLabel("On the clipboard"), input, error.el, hint("A full path such as /home/you/Videos/film.mkv, or a web address."));
  dialog.foot.append(h("div", { class: "spacer" }), cancel, play);
  input.focus();
  // The webview may refuse to read the clipboard; the field still takes a normal paste.
  navigator.clipboard
    ?.readText()
    .then((text) => {
      if (text.trim() && !input.value) {
        input.value = text.trim().split("\n")[0];
        input.select();
      }
    })
    .catch(() => undefined);
}

// ---- Recent Media -----------------------------------------------------------------------------------

export function openRecent(ctx: VideoContext) {
  const dialog = openDialog({ title: "Recent Media", subtitle: "Pick up where you were.", icon: "clock" });
  const clear = h("button", { class: "btn ghost", type: "button" }, "Clear list");
  const render = () => {
    const recent = ctx.shell.config.video.recent;
    clear.hidden = recent.length === 0;
    if (!recent.length) {
      dialog.body.replaceChildren(emptyState("clock", "Nothing here yet", "Files and streams you play will show up here so you can open them again."));
      return;
    }
    dialog.body.replaceChildren(h("div", { class: "mt-list" }, ...recent.map((path) => {
      const web = isLocation(path);
      return listButton({
        icon: web ? "network" : "film",
        title: web ? hostOf(path) : stripExtension(basename(path)),
        meta: web ? path : dirname(path),
        action: () => {
          dialog.close();
          void ctx.play(path);
        },
      });
    })));
    focusFirst(dialog);
  };
  clear.addEventListener("click", () => {
    ctx.shell.config.video.recent = [];
    ctx.shell.saveConfig();
    render();
  });
  dialog.foot.append(clear);
  render();
}
