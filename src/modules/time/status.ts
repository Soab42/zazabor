import type { RailStatus } from "../../shell/module";
import { onTimeChanged, timeApi } from "./api";
import { endOfDay, hm, KIND_LABEL, startOfDay, totals } from "./model";

/**
 * The Time button's rail dot: pulsing while a task timer runs, amber during an activity, a ring
 * while checked in with nothing running. The tooltip says what runs and the time worked today.
 * Loaded with the shell (small: no UI), so the dot shows before the section is ever opened.
 */
export function watchTimeStatus(show: (status: RailStatus | null) => void): () => void {
  let stopped = false;
  let busy = false;
  let again = false;
  const update = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      const now = Date.now();
      const data = await timeApi.data(startOfDay(now), endOfDay(now));
      if (stopped) return;
      const worked = `${hm(totals(data.sessions, data.entries, startOfDay(now), endOfDay(now), now).work)} worked today`;
      const running = data.running;
      if (running?.kind === "work") {
        const task = data.tasks.find((t) => t.id === running.task);
        show({ tone: "live", title: `Timing “${task?.title ?? "a task"}” · ${worked}` });
      } else if (running) {
        show({ tone: "paused", title: `${KIND_LABEL[running.kind]}${running.text ? `: ${running.text}` : ""} · ${worked}` });
      } else if (data.session) {
        show({ tone: "on", title: `Checked in · ${worked}` });
      } else {
        show(null);
      }
    } catch {
      // Locked, or the backend is busy: keep the dot as it was.
    } finally {
      busy = false;
      if (again && !stopped) {
        again = false;
        void update();
      }
    }
  };
  const unlisten = onTimeChanged(() => void update());
  // The worked total ages, and a new day starts.
  const timer = window.setInterval(() => void update(), 60_000);
  void update();
  return () => {
    stopped = true;
    clearInterval(timer);
    void unlisten.then((fn) => fn());
  };
}
