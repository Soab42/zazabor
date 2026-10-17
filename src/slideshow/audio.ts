/**
 * Plays one looping soundtrack through Web Audio. Compared to an <audio> element this loops
 * without a gap, fades with sample accuracy, and exposes an exact playback position for
 * cutting on the beat.
 */
export class MusicPlayer {
  private ctx: AudioContext;
  private gain: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  /** Context time at which the track's position 0 would have played. */
  private origin = 0;
  private disposed = false;

  /** Create during a user gesture so the browser lets the context start. */
  constructor() {
    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(this.ctx.destination);
  }

  async load(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const data = await response.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(data);
  }

  get loaded() {
    return !!this.buffer;
  }

  get playing() {
    return !!this.source && this.ctx.state === "running";
  }

  /** Seconds into the (looping) track. */
  get position() {
    if (!this.buffer) return 0;
    return (((this.ctx.currentTime - this.origin) % this.buffer.duration) + this.buffer.duration) % this.buffer.duration;
  }

  start() {
    if (!this.buffer || this.source || this.disposed) return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.loop = true;
    source.connect(this.gain);
    const when = this.ctx.currentTime + 0.05;
    source.start(when);
    this.origin = when;
    this.source = source;
    void this.ctx.resume();
  }

  /** Ramps the volume to `level` over `seconds`. */
  fadeTo(level: number, seconds: number) {
    const now = this.ctx.currentTime;
    const param = this.gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(Math.max(0, level), now + Math.max(0.01, seconds));
  }

  /** Fades out, then freezes playback (and the clock) until resume(). */
  async pause(fadeSeconds = 0.4) {
    this.fadeTo(0, fadeSeconds);
    await sleep(fadeSeconds * 1000);
    if (!this.disposed && this.ctx.state === "running") await this.ctx.suspend();
  }

  async resume(level: number, fadeSeconds = 0.8) {
    if (this.disposed) return;
    await this.ctx.resume();
    this.fadeTo(level, fadeSeconds);
  }

  async dispose(fadeSeconds = 0.6) {
    if (this.disposed) return;
    this.disposed = true;
    this.fadeTo(0, fadeSeconds);
    await sleep(fadeSeconds * 1000);
    try {
      this.source?.stop();
    } catch {
      // Already stopped.
    }
    await this.ctx.close().catch(() => {});
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
