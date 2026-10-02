// bridge/src/brain/keyedQueue.ts
//
// One task at a time per key, at most `maxConcurrent` across keys. A follow-up
// in a subject waits for the answer still being written in that subject, so two
// turns never resume the same session at once; different topics overlap.

export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) throw new Error('KeyedQueue: maxConcurrent must be >= 1');
  }

  /** Queue `task` behind earlier tasks for `key`. A failing task never blocks the ones after it. */
  run(key: string, task: () => Promise<void>): Promise<void> {
    const next = (this.tails.get(key) ?? Promise.resolve()).then(() => this.withSlot(task));
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  /** True while a task for `key` is queued or running. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }

  private async withSlot(task: () => Promise<void>): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
    } else {
      // The finishing task hands its slot straight over, so `active` stays put.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}
