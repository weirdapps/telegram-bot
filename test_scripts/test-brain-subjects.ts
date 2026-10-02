import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOG_ANSWER_CHARS,
  LOG_EXCHANGES,
  SubjectStore,
  TITLE_CHARS,
  idleHours,
  rebuildSeed,
  recordExchange,
  subjectKey,
  titleFrom,
  type Subject,
} from '../bridge/src/brain/subjects.js';

const T0 = new Date('2026-10-01T10:00:00.000Z');
const later = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);
const first = (sessionId: string, question = 'Q1'): Subject =>
  recordExchange(undefined, { question, answer: 'A1', sessionId, contextTokens: 0, now: T0 });
// Half of a surrogate pair: invalid UTF-16, which Telegram and the API can reject.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('subject helpers', () => {
  it('keys by chat and topic', () => {
    expect(subjectKey('42')).toBe('42:0');
    expect(subjectKey('42', 7)).toBe('42:7');
  });

  it('titles from the first question, whitespace collapsed, cut at 60', () => {
    expect(titleFrom('  what   about\nthe budget?  ')).toBe('what about the budget?');
    const long = titleFrom('x'.repeat(100));
    expect(long).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
  });

  it('never cuts a title inside an emoji', () => {
    const title = titleFrom('x'.repeat(58) + '😀😀');
    expect(title).not.toMatch(LONE_SURROGATE);
    expect(title.length).toBeLessThanOrEqual(TITLE_CHARS);
    expect(title.endsWith('…')).toBe(true);
  });

  it('records the first exchange', () => {
    const s = recordExchange(undefined, {
      question: 'Q1',
      answer: 'A1',
      sessionId: 's1',
      contextTokens: 1200,
      now: T0,
    });
    expect(s).toEqual({
      sessionId: 's1',
      title: 'Q1',
      createdAt: T0.toISOString(),
      lastActiveAt: T0.toISOString(),
      questions: 1,
      contextTokens: 1200,
      log: [{ q: 'Q1', a: 'A1' }],
    });
  });

  it('keeps title and creation time on follow-ups and moves the session id', () => {
    const s2 = recordExchange(first('s1'), {
      question: 'Q2',
      answer: 'A2',
      sessionId: 's2',
      contextTokens: 2,
      now: later(1),
    });
    expect(s2.title).toBe('Q1');
    expect(s2.createdAt).toBe(T0.toISOString());
    expect(s2.lastActiveAt).toBe(later(1).toISOString());
    expect(s2.sessionId).toBe('s2');
    expect(s2.questions).toBe(2);
    expect(s2.log.map((x) => x.q)).toEqual(['Q1', 'Q2']);
  });

  it('keeps the last ten exchanges and cuts long answers', () => {
    let s: Subject | undefined;
    for (let i = 1; i <= 12; i++) {
      s = recordExchange(s, {
        question: `Q${i}`,
        answer: 'a'.repeat(5000),
        sessionId: 's',
        contextTokens: 0,
        now: T0,
      });
    }
    expect(s?.log).toHaveLength(LOG_EXCHANGES);
    expect(s?.log[0]?.q).toBe('Q3');
    expect(s?.log[0]?.a).toHaveLength(LOG_ANSWER_CHARS);
  });

  it('never cuts a log answer inside an emoji', () => {
    const s = recordExchange(undefined, {
      question: 'Q1',
      answer: 'a'.repeat(LOG_ANSWER_CHARS - 2) + '😀😀',
      sessionId: 's',
      contextTokens: 0,
      now: T0,
    });
    const answer = s.log[0]?.a ?? '';
    expect(answer).not.toMatch(LONE_SURROGATE);
    expect(answer.length).toBeLessThanOrEqual(LOG_ANSWER_CHARS);
    expect(answer.endsWith('…')).toBe(true);
  });

  it('measures idle time in hours', () => {
    expect(idleHours(first('s'), later(7.5))).toBeCloseTo(7.5);
  });

  it('builds a rebuild seed with the title and the exchanges in order', () => {
    const s = recordExchange(first('s'), {
      question: 'Q2',
      answer: 'A2',
      sessionId: 's',
      contextTokens: 0,
      now: T0,
    });
    const seed = rebuildSeed(s);
    expect(seed).toContain('«Q1»');
    expect(seed.indexOf('Q1: Q1')).toBeLessThan(seed.indexOf('Q2: Q2'));
    expect(seed).toContain('A2: A2');
  });
});

describe('SubjectStore', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'brain-subjects-'));
    path = join(dir, 'nested', 'subjects.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns undefined before anything is stored', async () => {
    expect(await new SubjectStore(path).get('1:0')).toBeUndefined();
  });

  it('round-trips a subject and survives a restart', async () => {
    await new SubjectStore(path).put('1:0', first('s1'));
    expect((await new SubjectStore(path).get('1:0'))?.sessionId).toBe('s1');
  });

  it('removes a subject and returns it', async () => {
    const store = new SubjectStore(path);
    await store.put('1:0', first('s1'));
    expect((await store.remove('1:0'))?.sessionId).toBe('s1');
    expect(await store.get('1:0')).toBeUndefined();
    expect(await store.remove('1:0')).toBeUndefined();
  });

  it('keeps both of two concurrent writes', async () => {
    const store = new SubjectStore(path);
    await Promise.all([store.put('1:0', first('a')), store.put('1:7', first('b'))]);
    expect((await store.get('1:0'))?.sessionId).toBe('a');
    expect((await store.get('1:7'))?.sessionId).toBe('b');
  });

  it('defaults the voice mode to mirror and persists a change', async () => {
    const store = new SubjectStore(path);
    expect(await store.voiceMode()).toBe('mirror');
    await store.setVoiceMode('off');
    expect(await new SubjectStore(path).voiceMode()).toBe('off');
  });

  it('writes the file owner-only', async () => {
    await new SubjectStore(path).put('1:0', first('s1'));
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });
});
