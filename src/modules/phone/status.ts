import type { RailStatus } from "../../shell/module";
import { getBt, getState, startStore, subscribe } from "./store";

/**
 * The Phone button's rail dot: pulsing during a call, on while there are unread texts. Loaded with
 * the shell, so it stays small (no UI).
 */
export function watchPhoneStatus(show: (status: RailStatus | null) => void): () => void {
  const update = () => {
    const live = getBt()?.calls.some((c) => c.state !== "incoming" && c.state !== "waiting");
    if (live) return show({ tone: "live", title: "On a call" });
    const unread = getState()?.phones.reduce((sum, p) => sum + (p.unreadSms || 0), 0) ?? 0;
    show(unread > 0 ? { tone: "on", title: `${unread} unread ${unread === 1 ? "text" : "texts"}` } : null);
  };
  const stops = [subscribe("state", update), subscribe("bt", update)];
  void startStore().then(update, () => undefined);
  return () => stops.forEach((stop) => stop());
}
