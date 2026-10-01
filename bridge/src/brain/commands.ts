// bridge/src/brain/commands.ts
//
// Slash commands of the brain bot and the texts it answers them with. Pure:
// no I/O, so every reply is testable on its own.

import { idleHours, type Subject } from './subjects.js';

export type BrainCommand =
  | { kind: 'new' }
  | { kind: 'context' }
  | { kind: 'help' }
  | { kind: 'voice' }
  | { kind: 'unknown'; name: string };

/** The Telegram command menu (setMyCommands). */
export const BRAIN_COMMANDS = [
  { command: 'new', description: 'Close this subject and start fresh' },
  { command: 'context', description: 'What the current subject holds' },
  { command: 'voice', description: 'Voice replies: mirror, always or off' },
  { command: 'help', description: 'List the commands' },
] as const;

/** The command in `text`, or null when it is a question. `/new@SomeBot` works too. */
export function parseBrainCommand(text: string): BrainCommand | null {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text.trim());
  if (!m) return null;
  const name = (m[1] ?? '').toLowerCase();
  switch (name) {
    case 'new':
    case 'clear':
      return { kind: 'new' };
    case 'context':
      return { kind: 'context' };
    case 'help':
    case 'start':
      return { kind: 'help' };
    case 'voice':
      return { kind: 'voice' };
    default:
      return { kind: 'unknown', name };
  }
}

export function helpText(): string {
  return [
    'Ask anything your second brain holds: mail, attachments, calendar, Teams, WhatsApp, past sessions, news.',
    'Follow-up questions keep the context of the subject.',
    '',
    '/new: close this subject and start fresh (or tap 🆕 under an answer)',
    '/context: what the current subject holds',
    '/voice [mirror|always|off]: voice replies',
    '/help: this list',
  ].join('\n');
}

export function closedText(s: Pick<Subject, 'title' | 'questions'> | undefined): string {
  if (!s) return 'Nothing to close: no open subject here.';
  return `Closed: «${s.title}», ${s.questions} ${s.questions === 1 ? 'question' : 'questions'}.`;
}

export function formatHours(h: number): string {
  if (h < 1) return `${Math.max(0, Math.round(h * 60))} min`;
  return `${Math.round(h)} h`;
}

export function contextText(s: Subject | undefined, now: Date, model: string): string {
  if (!s) return 'No open subject here. Your next question starts one.';
  return [
    `Subject: «${s.title}»`,
    `Questions: ${s.questions}`,
    `Opened: ${s.createdAt.slice(0, 16).replace('T', ' ')} UTC`,
    `Idle: ${formatHours(idleHours(s, now))}`,
    `Context: ~${Math.round(s.contextTokens / 1000)}k tokens`,
    `Model: ${model}`,
  ].join('\n');
}

/** A one-line reminder that an old subject is being continued; null within the threshold. */
export function idleNotice(s: Subject, now: Date, thresholdHours = 6): string | null {
  const h = idleHours(s, now);
  if (h <= thresholdHours) return null;
  return `(continuing «${s.title}», idle ${formatHours(h)} · /new to start fresh)`;
}
