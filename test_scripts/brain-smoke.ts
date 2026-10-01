// Live smoke for the brain profile: the real SDK and the real second-brain HTTP
// MCP, no Telegram. Run on the host, with the brain env and the Vertex env loaded
// (Task B11 has the exact command). Prints each answer with its timings.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteSession, getSessionInfo, query } from '@anthropic-ai/claude-agent-sdk';
import { BrainApp, type BrainOutput } from '../bridge/src/brain/brainApp.js';
import { buildBrainOptions, loadBrainProfile } from '../bridge/src/brain/profile.js';
import { SubjectStore } from '../bridge/src/brain/subjects.js';

const profile = loadBrainProfile();
let started = 0;
let firstDraftMs = 0;
const seconds = (): string => ((Date.now() - started) / 1000).toFixed(1);

const out: BrainOutput = {
  sendDraft: async () => {
    if (firstDraftMs === 0) firstDraftMs = Date.now() - started;
  },
  sendRich: async (_chatId, _html, plain) => {
    console.log(`\n--- answer after ${seconds()} s (first draft at ${firstDraftMs} ms)\n${plain}`);
    return 1;
  },
  sendPlain: async (_chatId, text) => {
    console.log(`\n--- note after ${seconds()} s\n${text}`);
    return 1;
  },
  sendVoiceTo: async () => undefined,
  answerCallback: async () => undefined,
};

const app = new BrainApp({
  out,
  store: new SubjectStore(join(mkdtempSync(join(tmpdir(), 'brain-smoke-')), 'subjects.json')),
  turn: {
    query,
    sessionExists: async (id) => (await getSessionInfo(id, { dir: profile.cwd })) !== undefined,
    buildOptions: (plan, abort) => buildBrainOptions(profile, plan, abort),
    warn: (message, data) => console.warn('[warn]', message, data ?? ''),
  },
  deleteSession: (id) => deleteSession(id, { dir: profile.cwd }),
  transcribe: async () => ({ text: '', language: 'en-US' }),
  synthesize: async () => {
    throw new Error('no voice in the smoke run');
  },
  maxAudioSeconds: 60,
  allowed: new Set(['1']),
  model: profile.model,
  log: {
    info: () => undefined,
    warn: (obj, msg) => console.warn('[warn]', msg, obj),
    error: (obj, msg) => console.error('[error]', msg, obj),
  },
});

async function say(text: string): Promise<void> {
  console.log(`\n>>> ${text}`);
  started = Date.now();
  firstDraftMs = 0;
  await app.onText({ channel: 'smoke', chatId: '1', senderId: '1', chatType: 'private', text });
}

await say('Ποια είναι τα τρία πιο πρόσφατα email που έλαβα; Μόνο αποστολέας, ημερομηνία και θέμα.');
await say('Who sent the second one, and what did they want?');
await say('How many emails did I receive per month in 2026? Use SQL.');
await say('What were the main subjects in my mail last week?');
await say('/new');
await say('What did we just talk about?');
