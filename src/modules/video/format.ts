const pad = (n: number) => String(n).padStart(2, "0");

/** Formats milliseconds as `m:ss`, or `h:mm:ss` from one hour up. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** "1×", "0.75×". */
export const formatRate = (rate: number) => `${Number(rate.toFixed(2))}×`;

/** The time left, e.g. "12:03 left". */
export const formatRemaining = (time: number, length: number) => `${formatTime(length - time)} left`;
