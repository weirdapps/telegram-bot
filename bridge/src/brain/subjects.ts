// bridge/src/brain/subjects.ts
//
// A subject is one Claude session plus what the bot needs to manage it: a
// title, timestamps, a question count, and a short log of the exchanges, which
// rebuilds the context when the session itself cannot be resumed. Keyed by
// chat and topic, persisted atomically, owner-only.

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { VoiceMode } from '../replyRouter.js';

export const LOG_EXCHANGES = 10;
export const LOG_ANSWER_CHARS = 2000;
export const TITLE_CHARS = 60;

export interface Exchange {
  q: string;
  a: string;
}

export interface Subject {
  sessionId: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  questions: number;
  contextTokens: number;
  log: Exchange[];
}

interface SubjectFile {
  voiceMode: VoiceMode;
  subjects: Record<string, Subject>;
}

const VOICE_MODES: ReadonlySet<string> = new Set(['mirror', 'always', 'off']);

export function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  // Never keep only the high half of a surrogate pair (an emoji): that is invalid UTF-16.
  // codePointAt reads a whole pair there above 0xFFFF, and a lone high half as itself.
  const cp = s.codePointAt(max - 2) ?? 0;
  const end = cp > 0xffff || (cp >= 0xd800 && cp <= 0xdbff) ? max - 2 : max - 1;
  return `${s.slice(0, end)}…`;
}

export function subjectKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? 0}`;
}

export function titleFrom(question: string): string {
  return cut(question.replace(/\s+/g, ' ').trim(), TITLE_CHARS);
}

export function recordExchange(
  prev: Subject | undefined,
  x: { question: string; answer: string; sessionId: string; contextTokens: number; now: Date },
): Subject {
  const iso = x.now.toISOString();
  return {
    sessionId: x.sessionId,
    title: prev?.title ?? titleFrom(x.question),
    createdAt: prev?.createdAt ?? iso,
    lastActiveAt: iso,
    questions: (prev?.questions ?? 0) + 1,
    contextTokens: x.contextTokens,
    log: [...(prev?.log ?? []), { q: x.question, a: cut(x.answer, LOG_ANSWER_CHARS) }].slice(
      -LOG_EXCHANGES,
    ),
  };
}

export function idleHours(s: Subject, now: Date): number {
  return (now.getTime() - Date.parse(s.lastActiveAt)) / 3_600_000;
}

/** The subject log as a preamble for a fresh session, when the old one cannot be resumed. */
export function rebuildSeed(s: Subject): string {
  return [
    `[Earlier in this subject («${s.title}»), rebuilt from the chat log because the session could not be resumed:`,
    ...s.log.map((x, i) => `Q${i + 1}: ${x.q}\nA${i + 1}: ${x.a}`),
    ']',
  ].join('\n');
}

export class SubjectStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(key: string): Promise<Subject | undefined> {
    return (await this.read()).subjects[key];
  }

  async put(key: string, subject: Subject): Promise<void> {
    await this.mutate((f) => {
      f.subjects[key] = subject;
    });
  }

  async remove(key: string): Promise<Subject | undefined> {
    let removed: Subject | undefined = undefined;
    await this.mutate((f) => {
      removed = f.subjects[key];
      delete f.subjects[key];
    });
    return removed;
  }

  async voiceMode(): Promise<VoiceMode> {
    return (await this.read()).voiceMode;
  }

  async setVoiceMode(mode: VoiceMode): Promise<void> {
    await this.mutate((f) => {
      f.voiceMode = mode;
    });
  }

  private async read(): Promise<SubjectFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.path, 'utf8')) as Partial<SubjectFile>;
      return {
        voiceMode:
          parsed.voiceMode !== undefined && VOICE_MODES.has(parsed.voiceMode)
            ? parsed.voiceMode
            : 'mirror',
        subjects: parsed.subjects ?? {},
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        return { voiceMode: 'mirror', subjects: {} };
      throw err;
    }
  }

  /** Read, change, write atomically; writes queue one behind another so none is lost. */
  private mutate(change: (f: SubjectFile) => void): Promise<void> {
    const next = this.chain.then(async () => {
      const f = await this.read();
      change(f);
      await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.path);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}
