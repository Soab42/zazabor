import { resumeTime } from "../../queue";
import type { VideoContext } from "../../extensions";
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
  player.open = async (path, siblings) => {
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
    // The continue-watching prompt (features/quick/resume.ts) offers the jump.
    if (hide && settings.resume === "ask" && resumeAt > 0) player.offerResume(path, resumeAt);
  };

  return () => {
    player.open = original;
  };
}
