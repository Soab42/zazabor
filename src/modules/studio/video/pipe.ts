/**
 * Export's frames on their way to the encoder: read back from the GPU, then sent, in order and a
 * few at a time, so drawing the next frame, reading this one back and sending the one before
 * overlap. Each send carries its frame's number (the backend puts any that overtake each other
 * back in order), and a buffer is filled again only once its send has answered.
 */

export interface PipeIo<R> {
  /** Copies a started read into `out`. */
  collect(read: R, out: Uint8Array): Promise<void>;
  /** Sends frame number `seq`; resolves once the backend has it. */
  send(seq: number, frame: Uint8Array): Promise<unknown>;
}

export interface PipeDepth {
  /** Frames whose read has started but isn't collected yet. */
  reads: number;
  /** Sends waiting for an answer. */
  sends: number;
}

export class FramePipe<R> {
  private reads: R[] = [];
  private sends: { done: Promise<unknown>; buffer: Uint8Array }[] = [];
  private free: Uint8Array[] = [];
  private seq = 0;
  private io: PipeIo<R>;
  private bytes: number;
  private depth: PipeDepth;

  constructor(io: PipeIo<R>, bytes: number, depth: PipeDepth = { reads: 2, sends: 2 }) {
    this.io = io;
    this.bytes = bytes;
    this.depth = depth;
  }

  /** Frames handed to `send` so far. */
  get sent(): number {
    return this.seq;
  }

  /** The next frame (in order), its read started; waits while too many are on their way. */
  async push(read: R): Promise<void> {
    this.reads.push(read);
    while (this.reads.length > this.depth.reads) await this.advance();
  }

  /** Lets go of the reads not collected yet (a stopped export), through `drop`. */
  discard(drop: (read: R) => void) {
    for (const read of this.reads.splice(0)) drop(read);
  }

  /** Sends what's left and waits for every answer. */
  async flush(): Promise<void> {
    while (this.reads.length) await this.advance();
    while (this.sends.length) await this.retire();
  }

  private async advance() {
    const read = this.reads.shift()!;
    while (this.sends.length >= Math.max(1, this.depth.sends)) await this.retire();
    const buffer = this.free.pop() ?? new Uint8Array(this.bytes);
    await this.io.collect(read, buffer);
    const done = this.io.send(this.seq++, buffer);
    // A failed send throws where it's waited for (retire); the ones after it are let go.
    done.catch(() => undefined);
    this.sends.push({ done, buffer });
  }

  private async retire() {
    const s = this.sends.shift()!;
    await s.done;
    this.free.push(s.buffer);
  }
}
