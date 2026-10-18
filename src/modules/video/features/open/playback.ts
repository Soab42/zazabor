import { resumeTime } from "../../queue";
import type { VideoContext } from "../../extensions";
import { formatTime } from "../../format";
import { h } from "../../../../ui/dom";
import { mediaSettings } from "../profiles/settings";

/** Set while a re-open (e.g. moving playback to a cast device) must not ask about resuming. */
let quiet = false;

/** Opens the current media again and returns to `time` (casting only takes effect on a fresh start). */
export async function reopenAt(ctx: VideoContext, path: string, queue: string[], time: number): Promise<void> {
  quiet = true;
  try {
    await ctx.play(path, queue.length ? queue : undefined);
  } finally {
    quiet = false;
  }
  if (time < 1500) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      off();
      clearTimeout(timer);
      resolve();
    };
    const off = ctx.player.subscribe(() => {
      const { state, current } = ctx.player;
      if (current !== path) return done();
      if (state.path === path && state.length > 0) {
        ctx.player.seekTo(time);
        done();
      }
    });
    const timer = window.setTimeout(done, 15_000);
  });
}

/**
 * Makes the player honour the playback settings without touching `player.ts`: resume behaviour
 * (always / ask / never), the default speed and keeping or skipping history. `Player.open` is
 * wrapped on the instance; every way of starting a video goes through it. Returns an undo.
 */
export function installPlaybackSettings(ctx: VideoContext): () => void {
  const { player, shell } = ctx;
  const original = player.open.bind(player);
  let prompt: HTMLElement | null = null;
  let promptTimer = 0;

  const hidePrompt = () => {
    clearTimeout(promptTimer);
    prompt?.classList.remove("show");
    const gone = prompt;
    prompt = null;
    if (gone) setTimeout(() => gone.remove(), 220);
  };

  const askToResume = (path: string, time: number) => {
    hidePrompt();
    const resume = h("button", { class: "btn small primary", type: "button" }, `Resume at ${formatTime(time)}`);
    const restart = h("button", { class: "btn small ghost", type: "button" }, "Start over");
    const el = h("div", { class: "mt-prompt", role: "group", "aria-label": "Continue watching" },
      h("span", { class: "mt-prompt-text" }, "Pick up where you left off?"), resume, restart);
    resume.addEventListener("click", () => {
      if (player.current === path) player.seekTo(time);
      hidePrompt();
    });
    restart.addEventListener("click", hidePrompt);
    ctx.stageLayer.append(el);
    prompt = el;
    requestAnimationFrame(() => el.classList.add("show"));
    promptTimer = window.setTimeout(hidePrompt, 9000);
  };

  player.open = async (path, siblings) => {
    hidePrompt();
    const settings = mediaSettings(shell);
    const positions = shell.config.video.positions;
    const saved = positions[path];
    const hide = settings.resume !== "always" && saved !== undefined && !quiet;
    // `Player.open` reads the saved position before its first await; hide it for just that moment.
    if (hide) delete positions[path];
    const started = original(path, siblings);
    if (hide) positions[path] = saved;
    await started;
    if (player.current !== path) return;
    if (settings.defaultSpeed !== 1) player.setRate(settings.defaultSpeed);
    if (!settings.keepHistory) {
      shell.config.video.recent = shell.config.video.recent.filter((p) => p !== path);
      shell.saveConfig();
    }
    const resumeAt = resumeTime(saved);
    if (hide && settings.resume === "ask" && resumeAt > 0) askToResume(path, resumeAt);
  };

  return () => {
    hidePrompt();
    player.open = original;
  };
}
