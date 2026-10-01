import { describe, it, expect } from 'vitest';
import {
  BRAIN_COMMANDS,
  closedText,
  contextText,
  formatHours,
  helpText,
  idleNotice,
  parseBrainCommand,
} from '../bridge/src/brain/commands.js';
import { recordExchange } from '../bridge/src/brain/subjects.js';

const T0 = new Date('2026-10-01T10:00:00.000Z');
const subject = recordExchange(undefined, {
  question: 'Budget owner?',
  answer: 'Alice.',
  sessionId: 's1',
  contextTokens: 45_600,
  now: T0,
});

describe('parseBrainCommand', () => {
  it.each([
    ['/new', 'new'],
    ['/clear', 'new'],
    ['/NEW', 'new'],
    ['/new@SomeBot', 'new'],
    ['  /new  ', 'new'],
    ['/context', 'context'],
    ['/help', 'help'],
    ['/start', 'help'],
    ['/voice always', 'voice'],
  ])('%s is %s', (text, kind) => {
    expect(parseBrainCommand(text)?.kind).toBe(kind);
  });

  it('names an unknown command', () => {
    expect(parseBrainCommand('/frobnicate now')).toEqual({ kind: 'unknown', name: 'frobnicate' });
  });

  it('treats anything else as a question', () => {
    expect(parseBrainCommand('what about /new?')).toBeNull();
    expect(parseBrainCommand('Τι έγινε σήμερα;')).toBeNull();
  });

  it('reads a command only at the start, as a whole word', () => {
    expect(parseBrainCommand('what does /new do')).toBeNull();
    expect(parseBrainCommand('/usr/local/bin: what lives there?')).toBeNull();
  });
});

describe('replies', () => {
  it('lists the commands for the Telegram menu', () => {
    expect(BRAIN_COMMANDS.map((c) => c.command)).toEqual(['new', 'context', 'voice', 'help']);
    expect(helpText()).toContain('/new');
  });

  it('says what a close closed', () => {
    expect(closedText(subject)).toBe('Closed: «Budget owner?», 1 question.');
    expect(closedText(undefined)).toBe('Nothing to close: no open subject here.');
  });

  it('counts two or more questions in the plural', () => {
    expect(closedText({ ...subject, questions: 2 })).toBe('Closed: «Budget owner?», 2 questions.');
  });

  it('describes the current subject: its age, not a wall time, and how long it has been idle', () => {
    const followed = recordExchange(subject, {
      question: 'And the forecast?',
      answer: 'Bob.',
      sessionId: 's1',
      contextTokens: 45_600,
      now: new Date(T0.getTime() + 3_600_000),
    });
    const text = contextText(followed, new Date(T0.getTime() + 3 * 3_600_000), 'model-x');
    expect(text).toContain('Subject: «Budget owner?»');
    expect(text).toContain('Questions: 2');
    expect(text).toContain('Opened: 3 h ago');
    expect(text).not.toContain('UTC');
    expect(text).toContain('Idle: 2 h');
    expect(text).toContain('Context: ~46k tokens');
    expect(text).toContain('Model: model-x');
    expect(contextText(undefined, T0, 'm')).toContain('No open subject');
  });

  it('adds an idle notice only past six hours', () => {
    expect(idleNotice(subject, new Date(T0.getTime() + 5 * 3_600_000))).toBeNull();
    expect(idleNotice(subject, new Date(T0.getTime() + 14 * 3_600_000))).toBe(
      '(continuing «Budget owner?», idle 14 h · /new to start fresh)',
    );
  });

  it('formats short and long idle times', () => {
    expect(formatHours(0.25)).toBe('15 min');
    expect(formatHours(3.4)).toBe('3 h');
  });
});
