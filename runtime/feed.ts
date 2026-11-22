import { randomUUID } from 'node:crypto';

/** A cursor is local to one host lifetime. Durable state comes from bootstrap + Pi history. */
export class WorkspaceFeed {
  readonly epoch = randomUUID();
  #sequence = 0;
  #bytes = 0;
  readonly #frames: { sequence: number; frame: string; bytes: number }[] = [];

  get cursor() { return { epoch: this.epoch, sequence: this.#sequence }; }

  append(event: object): string {
    const sequence = ++this.#sequence;
    const frame = `id: ${this.epoch}:${sequence}\ndata: ${JSON.stringify({ ...event, epoch: this.epoch, sequence })}\n\n`;
    const bytes = Buffer.byteLength(frame);
    this.#frames.push({ sequence, frame, bytes });
    this.#bytes += bytes;
    while (this.#frames.length > 512 || this.#bytes > 4 * 1024 * 1024) {
      const evicted = this.#frames.shift();
      if (evicted) this.#bytes -= evicted.bytes;
    }
    return frame;
  }

  replay(epoch: string | null, after: string | null): readonly string[] | null {
    if (epoch !== this.epoch || after === null || !/^\d+$/.test(after)) return null;
    const sequence = Number(after);
    const oldest = this.#frames[0]?.sequence ?? this.#sequence + 1;
    if (!Number.isSafeInteger(sequence) || sequence < oldest - 1 || sequence > this.#sequence) return null;
    return this.#frames.filter(item => item.sequence > sequence).map(item => item.frame);
  }
}
