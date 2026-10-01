import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DRAFT_KEEPALIVE_MS,
  DraftStream,
  type DraftSink,
} from '../bridge/src/brain/draftStream.js';

function recorder(failFirst = false) {
  const sent: Array<{ threadId: number | undefined; draftId: number; text: string }> = [];
  let calls = 0;
  const sink: DraftSink = {
    sendDraft: async (_chatId, threadId, draftId, text) => {
      calls++;
      if (failFirst && calls === 1) throw new Error('Bad Request: text must be non-empty');
      sent.push({ threadId, draftId, text });
    },
  };
  return { sink, sent };
}

describe('DraftStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the placeholder at once, in the right topic', async () => {
    const { sink, sent } = recorder();
    const d = new DraftStream({ sink, chatId: '1', threadId: 7, draftId: 5 });
    d.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ threadId: 7, draftId: 5, text: '' }]);
    d.stop();
  });

  it('sends at most one update per second, with the latest text', async () => {
    const { sink, sent } = recorder();
    const d = new DraftStream({ sink, chatId: '1', draftId: 1 });
    d.start();
    await vi.advanceTimersByTimeAsync(0);
    sent.length = 0;
    d.setText('a');
    d.setText('ab');
    d.setText('abc');
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('abc');
    d.stop();
  });

  it('keeps the last three tool lines', async () => {
    const { sink, sent } = recorder();
    const d = new DraftStream({ sink, chatId: '1', draftId: 1 });
    d.start();
    for (const n of ['one', 'two', 'three', 'four']) d.tool('recall', n);
    await vi.advanceTimersByTimeAsync(1000);
    const text = sent[sent.length - 1]?.text ?? '';
    expect(text).not.toContain('recall: one');
    expect(text).toContain('🔎 recall: four');
    d.stop();
  });

  it('shows only the tail of a long answer', () => {
    const { sink } = recorder();
    const d = new DraftStream({ sink, chatId: '1', draftId: 1 });
    d.setText(`${'a'.repeat(4000)}END`);
    const text = d.render();
    expect(text).toContain('…');
    expect(text).toContain('END');
    expect(text.length).toBeLessThan(3600);
  });

  it('refreshes every 15 s while nothing happens', async () => {
    const { sink, sent } = recorder();
    const d = new DraftStream({ sink, chatId: '1', draftId: 1 });
    d.start();
    await vi.advanceTimersByTimeAsync(0);
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(DRAFT_KEEPALIVE_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('⏱ 15s');
    d.stop();
  });

  it('sends nothing after stop()', async () => {
    const { sink, sent } = recorder();
    const d = new DraftStream({ sink, chatId: '1', draftId: 1 });
    d.start();
    await vi.advanceTimersByTimeAsync(0);
    d.stop();
    // flush() goes quiet once stopped, so only the timer count catches a leaked keep-alive.
    expect(vi.getTimerCount()).toBe(0);
    d.setText('late');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
  });

  it('falls back to rendered text when the placeholder is refused, and reports the error', async () => {
    const { sink, sent } = recorder(true);
    const errors: unknown[] = [];
    const d = new DraftStream({ sink, chatId: '1', draftId: 1, onError: (e) => errors.push(e) });
    d.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    expect(sent[0]?.text).toContain('⏱ 0s');
    d.stop();
  });
});
