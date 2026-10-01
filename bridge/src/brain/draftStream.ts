// bridge/src/brain/draftStream.ts
//
// The live preview under a question: Telegram's sendMessageDraft, refreshed at
// most once a second and kept alive every 15 s (a draft vanishes 30 s after its
// last update). It never breaks the turn: a failed update is reported and
// dropped. The final answer always goes out as a normal message.

export interface DraftSink {
  sendDraft(
    chatId: string,
    threadId: number | undefined,
    draftId: number,
    text: string,
  ): Promise<void>;
}

export const DRAFT_MIN_INTERVAL_MS = 1000;
export const DRAFT_KEEPALIVE_MS = 15_000;
const TEXT_TAIL = 3500;
const TOOL_LINES = 3;

export interface DraftStreamOptions {
  sink: DraftSink;
  chatId: string;
  threadId?: number;
  draftId: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export class DraftStream {
  private readonly tools: string[] = [];
  private readonly startedAt: number;
  private text = '';
  private lastSent = 0;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private settled: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly o: DraftStreamOptions) {
    this.startedAt = this.now();
  }

  /** Telegram's "Thinking…" placeholder now, then keep the draft alive until stop(). */
  start(): void {
    void this.push('').then((ok) => {
      if (!ok && !this.stopped) void this.push(this.render());
    });
    this.keepAlive = setInterval(() => this.schedule(), DRAFT_KEEPALIVE_MS);
  }

  tool(name: string, detail: string): void {
    this.tools.push(detail ? `🔎 ${name}: ${detail}` : `🔎 ${name}`);
    this.schedule();
  }

  setText(text: string): void {
    this.text = text;
    this.schedule();
  }

  /**
   * Clears both timers at once, then resolves when every update already sent has settled, so
   * a late preview cannot land after the final answer. Never rejects.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pending) clearTimeout(this.pending);
    if (this.keepAlive) clearInterval(this.keepAlive);
    await this.settled;
  }

  render(): string {
    const body = this.text.length > TEXT_TAIL ? `…${tailOf(this.text)}` : this.text;
    const seconds = Math.round((this.now() - this.startedAt) / 1000);
    return [...this.tools.slice(-TOOL_LINES), ...(body ? ['', body] : []), '', `⏱ ${seconds}s`]
      .join('\n')
      .trim();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private schedule(): void {
    if (this.stopped || this.pending) return;
    const wait = Math.max(0, this.lastSent + DRAFT_MIN_INTERVAL_MS - this.now());
    if (wait === 0) {
      // Nothing sent in the last second: send now rather than through a 0 ms timer.
      this.flush();
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (!this.stopped) void this.push(this.render());
  }

  private push(text: string): Promise<boolean> {
    const sent = this.send(text);
    // Chained, so stop() waits for every send still in flight, not only the latest.
    this.settled = Promise.allSettled([this.settled, sent]);
    return sent;
  }

  private async send(text: string): Promise<boolean> {
    this.lastSent = this.now();
    try {
      await this.o.sink.sendDraft(this.o.chatId, this.o.threadId, this.o.draftId, text);
      return true;
    } catch (err) {
      this.o.onError?.(err);
      return false;
    }
  }
}

// The last TEXT_TAIL code units of `text`. A cut through an emoji would start on the low half
// of its surrogate pair, which is invalid UTF-16 and can make Telegram reject the draft.
function tailOf(text: string): string {
  const tail = text.slice(-TEXT_TAIL);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}
