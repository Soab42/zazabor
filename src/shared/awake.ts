import { invoke } from "@tauri-apps/api/core";

/**
 * Keeps the screen from dimming, blanking or locking while `on` (see `awake.rs`). Reasons count
 * per window; a playing video does this from the backend by itself.
 */
export function keepAwake(reason: string, on: boolean) {
  invoke("awake_set", { reason, on }).catch(() => undefined);
}

/** Whether something in any window (a playing video, a slideshow) keeps the screen awake now. */
export function isKeptAwake(): Promise<boolean> {
  return invoke<boolean>("awake_active").catch(() => false);
}
