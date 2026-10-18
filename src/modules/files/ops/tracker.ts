import type { UnlistenFn } from "@tauri-apps/api/event";
import { isFinal, onJob, type JobEvent } from "../ops-api";

/**
 * Listens to `fs-job` for the whole session. A job's events can arrive before the command that
 * started it has returned its id, so final events are kept until someone asks for them.
 */
export class JobTracker {
  private finals = new Map<number, JobEvent>();
  private waiters = new Map<number, (event: JobEvent) => void>();
  private watchers = new Set<(event: JobEvent) => void>();
  private unlisten: UnlistenFn | null = null;
  private disposed = false;

  constructor() {
    onJob((event) => this.handle(event)).then((fn) => {
      if (this.disposed) fn();
      else this.unlisten = fn;
    }, () => {});
  }

  /** Every event of every job, in order. Returns an unsubscribe function. */
  watch(handler: (event: JobEvent) => void): () => void {
    this.watchers.add(handler);
    return () => this.watchers.delete(handler);
  }

  /** Resolves with the job's final event (immediately if it already ended). */
  whenDone(id: number): Promise<JobEvent> {
    const done = this.finals.get(id);
    if (done) {
      this.finals.delete(id);
      return Promise.resolve(done);
    }
    return new Promise((resolve) => this.waiters.set(id, resolve));
  }

  private handle(event: JobEvent) {
    for (const watcher of this.watchers) watcher(event);
    if (!isFinal(event)) return;
    const waiter = this.waiters.get(event.id);
    if (waiter) {
      this.waiters.delete(event.id);
      waiter(event);
    } else {
      this.finals.set(event.id, event);
    }
  }

  dispose() {
    this.disposed = true;
    this.unlisten?.();
    this.watchers.clear();
  }
}
