// bridge/src/brain/brainMain.ts
//
// Wires the brain profile: the brain bot's channel, the subject store, the SDK
// and its session helpers, Google Speech for voice notes, and BrainApp.
// index.ts calls startBrain when TELEGRAM_BRIDGE_PROFILE=brain; the general
// bridge never gets here.

import { mkdirSync, promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { deleteSession, getSessionInfo, query } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../../../src/logger/logger.js';
import { parseAllowlist } from '../allowlist.js';
import { BotApiChannel } from '../channels/botApiChannel.js';
import type { SupportedLanguage } from '../replyRouter.js';
import { createSpeechClient, transcribeOgg, type SpeechClient } from '../stt/google.js';
import { createTtsClient, synthesize } from '../tts/google.js';
import type { VoiceBridgeConfig } from '../voiceBridgeConfig.js';
import { BrainApp, type BrainLog } from './brainApp.js';
import { BRAIN_COMMANDS } from './commands.js';
import { buildBrainOptions, loadBrainProfile } from './profile.js';
import { SubjectStore } from './subjects.js';

const UPDATES = ['message', 'callback_query', 'stopped_message_generation'] as const;
/** How long a shutdown waits for the replies of the turns it cancels. */
export const RESTART_REPLY_WAIT_MS = 3000;
/** How long a shutdown waits for the channel to stop. */
export const CHANNEL_STOP_WAIT_MS = 5000;

/** Whether `p` settles within `ms`; a rejection rejects. The timer never outlives the wait. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The SIGINT and SIGTERM handler: polling stops, running turns tell the owner the bot is
 * restarting, and the process exits 0, all within about 8 s, well inside systemd's 90 s
 * before SIGKILL. A second signal joins the shutdown already under way.
 */
export function brainShutdown(o: {
  app: Pick<BrainApp, 'cancelAll'>;
  channel: Pick<BotApiChannel, 'stop'>;
  log: BrainLog;
  closeClients: () => void;
  exit: (code: number) => void;
}): () => Promise<void> {
  let shutdown: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    o.log.info({}, 'shutdown signal received');
    try {
      // Polling stops first, so nothing new is fetched and confirmed while turns wind down:
      // Telegram redelivers what arrives meanwhile after the restart. bot.stop() confirms
      // the last update with one more getUpdates, which fails or hangs with the network
      // down; a stop must still exit 0, or the unit ends failed and alerts.
      try {
        if (!(await settlesWithin(o.channel.stop(), CHANNEL_STOP_WAIT_MS))) {
          o.log.warn({}, 'channel stop timed out; going on');
        }
      } catch (err) {
        o.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'channel stop failed',
        );
      }
      // Sending still works once polling has stopped: "Restarting; please ask again."
      if (!(await settlesWithin(o.app.cancelAll(), RESTART_REPLY_WAIT_MS))) {
        o.log.warn({}, 'restart replies still pending; exiting anyway');
      }
    } finally {
      o.closeClients();
      o.exit(0);
    }
  };
  return () => (shutdown ??= run());
}

export async function startBrain(o: {
  logger: Logger;
  voiceCfg: VoiceBridgeConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = o.env ?? process.env;
  const profile = loadBrainProfile(env);
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required for the brain profile');
  const allowed = parseAllowlist(env.TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS);
  mkdirSync(dirname(profile.statePath), { recursive: true, mode: 0o700 });
  // The SDK spawns the CLI here without checking: a missing directory fails every turn as a launch error.
  mkdirSync(profile.cwd, { recursive: true, mode: 0o700 });

  const log: BrainLog = {
    info: (obj, msg) => o.logger.info({ component: 'brain', ...obj }, msg),
    warn: (obj, msg) => o.logger.warn({ component: 'brain', ...obj }, msg),
    error: (obj, msg) => o.logger.error({ component: 'brain', ...obj }, msg),
  };
  const stt = createSpeechClient(o.voiceCfg.projectId, o.voiceCfg.keyFilename);
  const tts = createTtsClient(o.voiceCfg.projectId, o.voiceCfg.keyFilename);
  const channel = new BotApiChannel({
    token,
    tmpDir: env.TELEGRAM_BRIDGE_BOT_TMPDIR ?? `${dirname(profile.statePath)}/inbox`,
    logger: o.logger,
    allowedUpdates: UPDATES,
    // A bot that stops polling but stays up is never restarted: exit, and the unit restarts it.
    onPollingStopped: (err) => {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'polling stopped; exiting so systemd restarts the bot',
      );
      process.exit(1);
    },
  });
  const app = new BrainApp({
    out: channel,
    store: new SubjectStore(profile.statePath),
    turn: {
      query,
      sessionExists: async (id) => (await getSessionInfo(id, { dir: profile.cwd })) !== undefined,
      buildOptions: (plan, abort) => buildBrainOptions(profile, plan, abort, env),
      warn: (message, data) => log.warn(data ?? {}, message),
    },
    deleteSession: (id) => deleteSession(id, { dir: profile.cwd }),
    discard: (path) => fs.unlink(path).catch(() => undefined),
    transcribe: (path) => transcribeNote(path, o.voiceCfg, stt),
    synthesize: (text, language) => synthesize(text, language, o.voiceCfg.voiceConfig, tts),
    maxAudioSeconds: o.voiceCfg.maxAudioSeconds,
    allowed,
    model: profile.model,
    log,
  });

  const guard =
    (what: string) =>
    (err: unknown): void =>
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        `unhandled error in ${what}`,
      );
  channel.onText((m) => void app.onText(m).catch(guard('text')));
  channel.onVoice((m) => void app.onVoice(m).catch(guard('voice')));
  channel.onOtherMessage((m) => void app.onOther(m).catch(guard('other message')));
  channel.onCallback((cb) => void app.onCallback(cb).catch(guard('button')));
  channel.onStop((s) => {
    try {
      app.onStop(s);
    } catch (err) {
      guard('stop')(err);
    }
  });
  await channel.start();
  await channel.setCommands(BRAIN_COMMANDS).catch(guard('setMyCommands'));
  log.info(
    { statePath: profile.statePath, mcp: profile.brainMcpUrl, model: profile.model },
    'brain bot listening',
  );

  const shutdown = brainShutdown({
    app,
    channel,
    log,
    closeClients: () => {
      stt.close();
      tts.close();
    },
    exit: (code) => process.exit(code),
  });
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function transcribeNote(
  path: string,
  cfg: VoiceBridgeConfig,
  stt: SpeechClient,
): Promise<{ text: string; language: SupportedLanguage }> {
  try {
    const { size } = await fs.stat(path);
    // About 3,000 bytes a second at Telegram's 24 kbps Opus; the 4x margin matches the general bridge.
    if (size > cfg.rejectInboundAboveSeconds * 3000 * 4) {
      throw new Error(`voice notes are capped at ${cfg.rejectInboundAboveSeconds} s; split it`);
    }
    const heard = await transcribeOgg(path, stt, cfg.projectId);
    return {
      text: heard.text.trim(),
      language: heard.languageCode.toLowerCase().startsWith('el') ? 'el-GR' : 'en-US',
    };
  } finally {
    if (!cfg.keepAudioFiles) await fs.unlink(path).catch(() => undefined);
  }
}
