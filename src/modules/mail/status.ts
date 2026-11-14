import type { RailStatus } from "../../shell/module";
import { mailApi, onMailChanged } from "./api";

/**
 * The Mail button's rail dot: on while there's unread mail in an inbox, with the count in the
 * tooltip. Loaded with the shell (small: no UI); it also starts the accounts' syncing, so new
 * mail arrives before the section is ever opened.
 */
export function watchMailStatus(show: (status: RailStatus | null) => void): () => void {
  let stopped = false;
  let timer = 0;
  const update = async () => {
    try {
      const unread = await mailApi.unread();
      if (!stopped) show(unread > 0 ? { tone: "on", title: `${unread} unread` } : null);
    } catch {
      // Locked: keep the dot as it was.
    }
  };
  const unlisten = onMailChanged(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void update(), 600);
  });
  void mailApi.start().then(update, () => undefined);
  return () => {
    stopped = true;
    clearTimeout(timer);
    void unlisten.then((fn) => fn());
  };
}
