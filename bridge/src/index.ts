import 'dotenv/config';
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import { TelegramUserClient, loadConfig, createLogger } from '../../src/index.js';
import type { Logger } from '../../src/logger/logger.js';
import { askClaude } from './claude.js';
import { StateStore, type BridgeState } from './state.js';
import { parseAllowlist, isAllowed } from './allowlist.js';
import { splitMessage } from './splitMessage.js';
import { handleVoiceCommand } from './voiceMode.js';
import { loadVoiceBridgeConfig, type VoiceBridgeConfig } from './voiceBridgeConfig.js';
import {
  createSpeechClient,
  transcribeOgg,
  TranscriptionError,
  type SpeechClient,
} from './stt/google.js';
import { createTtsClient, synthesize, SynthesisError } from './tts/google.js';
import {
  routeReply,
  type SupportedLanguage,
  type InputModality,
  type ReplyRouterInput,
} from './replyRouter.js';
import { stripMarkdownForSpeech } from './markdownStrip.js';
import { loadEnabledPlugins } from './pluginLoader.js';
import { withRetryOnTimeout } from './claudeRetry.js';
import type { TextToSpeechClient } from '@google-cloud/text-to-speech';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Channel, ChannelMessage } from './channels/channel.js';
import { MtProtoChannel } from './channels/mtprotoChannel.js';
import { BotApiChannel } from './channels/botApiChannel.js';

interface BridgeRuntime {
  state: StateStore;
  channels: Channel[];
  channelByName: Record<string, Channel>;
  logger: Logger;
  cwd: string;
  voiceCfg: VoiceBridgeConfig;
  stt: SpeechClient;
  tts: TextToSpeechClient;
  plugins: SdkPluginConfig[];
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const voiceCfg = loadVoiceBridgeConfig();
  const logger = createLogger(cfg.logLevel);
  const allowed = parseAllowlist(process.env.TELEGRAM_BRIDGE_ALLOWED_SENDER_IDS);
  const statePath =
    process.env.TELEGRAM_BRIDGE_STATE_PATH ??
    `${process.env.HOME ?? ''}/.telegram/claude-bridge.state.json`;
  const cwd = process.env.TELEGRAM_BRIDGE_CWD ?? process.env.HOME ?? process.cwd();
  const state = new StateStore(statePath);

  const enableSavedMessages = process.env.TELEGRAM_BRIDGE_DISABLE_SAVED_MESSAGES !== 'true';

  const channels: Channel[] = [];

  if (enableSavedMessages) {
    const sessionString = existsSync(cfg.sessionPath)
      ? readFileSync(cfg.sessionPath, 'utf8').trim()
      : '';
    if (!sessionString) {
      throw new Error(
        `No Telegram session at ${cfg.sessionPath}. Run \`telegram-cli login\` first.`,
      );
    }

    const userClient = new TelegramUserClient({
      apiId: cfg.apiId,
      apiHash: cfg.apiHash,
      sessionString,
      logger,
      downloadDir: cfg.downloadDir,
      sessionPath: cfg.sessionPath,
    });
    await userClient.connect();
    channels.push(new MtProtoChannel(userClient));
    logger.info({ component: 'bridge' }, 'saved-messages channel enabled');
  } else {
    logger.info(
      { component: 'bridge' },
      'saved-messages channel disabled (TELEGRAM_BRIDGE_DISABLE_SAVED_MESSAGES=true)',
    );
  }

  const stt = createSpeechClient(voiceCfg.projectId, voiceCfg.keyFilename);
  const tts = createTtsClient(voiceCfg.projectId, voiceCfg.keyFilename);

  // Load enabled Claude Code plugins once at startup. With BRIDGE_PLUGIN_
  // ALLOWLIST set (plan-004) the bridge restricts itself to a curated subset
  // — much faster cold starts and far fewer flaky-MCP hangs than mirroring
  // the interactive CLI's full 34-plugin set. See pluginLoader.ts.
  const pluginLoad = loadEnabledPlugins({ logger });
  logger.info(
    {
      component: 'bridge',
      loadedPlugins: pluginLoad.loadedKeys.length,
      skippedPlugins: pluginLoad.skipped.length,
      deniedPlugins: pluginLoad.denied.length,
      keys: pluginLoad.loadedKeys,
      allowlistActive: !!(process.env.BRIDGE_PLUGIN_ALLOWLIST ?? '').trim(),
    },
    `loaded ${pluginLoad.loadedKeys.length} plugins from user settings`,
  );

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();

  if (botToken) {
    const botTmpDir =
      process.env.TELEGRAM_BRIDGE_BOT_TMPDIR ?? `${process.env.HOME ?? ''}/.telegram/bot-inbox`;
    channels.push(new BotApiChannel({ token: botToken, tmpDir: botTmpDir, logger }));
    logger.info(
      { component: 'bridge', botTmpDir },
      'bot api channel enabled (TELEGRAM_BOT_TOKEN set)',
    );
  } else {
    logger.info({ component: 'bridge' }, 'bot api channel disabled (TELEGRAM_BOT_TOKEN not set)');
  }

  if (channels.length === 0) {
    throw new Error(
      'no input channels enabled — set TELEGRAM_BOT_TOKEN and/or unset TELEGRAM_BRIDGE_DISABLE_SAVED_MESSAGES',
    );
  }

  const channelByName: Record<string, Channel> = {};
  for (const ch of channels) channelByName[ch.name] = ch;
  const rt: BridgeRuntime = {
    state,
    channels,
    channelByName,
    logger,
    cwd,
    voiceCfg,
    stt,
    tts,
    plugins: pluginLoad.plugins,
  };

  // FIFO queue: serialise Claude calls so concurrent DMs don't race.
  let queue: Promise<void> = Promise.resolve();

  // Single shared handler per channel — same FIFO queue serialises across all channels
  const attachHandlers = (ch: Channel): void => {
    ch.onText((m) => {
      if (!isAllowed(m.senderId, allowed)) {
        logger.warn(
          { component: 'bridge', channel: m.channel, senderId: m.senderId, chatId: m.chatId },
          'rejected: sender not allowlisted',
        );
        return;
      }
      const text = (m.text ?? '').trim();
      if (text === '') return;
      queue = queue.then(() =>
        handleTextMessage({ ...m, text }, rt).catch((err) => {
          logger.error(
            {
              component: 'bridge',
              channel: m.channel,
              err: err instanceof Error ? err.message : String(err),
            },
            'unhandled error in text handler',
          );
        }),
      );
    });
    ch.onVoice((m) => {
      if (!isAllowed(m.senderId, allowed)) {
        logger.warn(
          { component: 'bridge', channel: m.channel, senderId: m.senderId, chatId: m.chatId },
          'rejected: voice sender not allowlisted',
        );
        return;
      }
      queue = queue.then(() =>
        handleVoiceMessage(m, rt).catch((err) => {
          logger.error(
            {
              component: 'bridge',
              channel: m.channel,
              err: err instanceof Error ? err.message : String(err),
            },
            'unhandled error in voice handler',
          );
        }),
      );
    });
  };

  for (const ch of channels) attachHandlers(ch);
  for (const ch of channels) await ch.start();
  logger.info(
    {
      component: 'bridge',
      allowedCount: allowed.size,
      statePath,
      cwd,
      permissionMode: 'see permissions.ts',
      voiceMaxAudioSeconds: voiceCfg.maxAudioSeconds,
      voiceProjectId: voiceCfg.projectId,
    },
    'bridge listening (text + voice)',
  );

  const shutdown = async (): Promise<void> => {
    logger.info({ component: 'bridge' }, 'shutdown signal received');
    await queue.catch(() => undefined);
    stt.close();
    tts.close();
    for (const ch of channels) await ch.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Persist updated bridge state, preserving voiceMode.
 * Use after a successful Claude turn to update sessionId + lastMessageAt.
 */
async function persistTurn(state: StateStore, sessionId: string): Promise<void> {
  const current = await state.load();
  await state.save({
    ...current,
    sessionId,
    lastMessageAt: new Date().toISOString(),
  });
}

async function handleTextMessage(msg: ChannelMessage, rt: BridgeRuntime): Promise<void> {
  const text = msg.text ?? '';
  const chatId = msg.chatId;
  const out = rt.channelByName[msg.channel];
  if (!out) {
    rt.logger.error(
      { component: 'bridge', channel: msg.channel },
      'unknown channel in text message',
    );
    return;
  }

  // Slash commands handled inline.
  if (text === '/clear') {
    const current = await rt.state.load();
    await rt.state.save({ ...current, sessionId: null, lastMessageAt: null });
    await out.sendText(chatId, 'session cleared — next message starts fresh.');
    return;
  }
  if (text === '/status') {
    const s = await rt.state.load();
    await out.sendText(
      chatId,
      `session: ${s.sessionId ?? '(none)'}\nlast: ${s.lastMessageAt ?? '(never)'}\nvoice mode: ${s.voiceMode}`,
    );
    return;
  }
  if (text === '/help') {
    await out.sendText(
      chatId,
      [
        '/clear — reset session',
        '/status — show session state + voice mode',
        '/voice [mirror|always|off] — voice reply preferences',
        '/help — this list',
      ].join('\n'),
    );
    return;
  }
  // /voice family
  if (await handleVoiceCommand(text, chatId, rt.state, out)) return;

  await runClaudeTurn(text, chatId, msg.channel, 'text', undefined, rt);
}

async function handleVoiceMessage(msg: ChannelMessage, rt: BridgeRuntime): Promise<void> {
  if (!msg.mediaPath) {
    rt.logger.warn(
      { component: 'bridge', chatId: msg.chatId, channel: msg.channel },
      'voice without mediaPath — drop',
    );
    return;
  }
  const filePath = msg.mediaPath;
  const chatId = msg.chatId;
  const out = rt.channelByName[msg.channel];
  if (!out) {
    rt.logger.error(
      { component: 'bridge', channel: msg.channel },
      'unknown channel in voice message',
    );
    return;
  }

  // Reject inbound voice notes that are too long for the sync Speech API.
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    rt.logger.error(
      { component: 'bridge', err: err instanceof Error ? err.message : String(err), filePath },
      'voice file missing on disk',
    );
    await out.sendText(chatId, 'voice file missing — please re-record');
    return;
  }
  // Cheap upper-bound: at 24 kbps Opus, 1 s ≈ 3000 bytes; 300 s ≈ 900 kB.
  // We use bytes as a rough proxy and rely on Cloud Speech to enforce the
  // exact 60 s sync limit; this is a safety net against operators sending
  // megabytes of audio.
  const bytesCap = rt.voiceCfg.rejectInboundAboveSeconds * 3000;
  if (stat.size > bytesCap * 4) {
    await out.sendText(
      chatId,
      `voice notes capped at ${rt.voiceCfg.rejectInboundAboveSeconds}s — please split into shorter messages`,
    );
    if (!rt.voiceCfg.keepAudioFiles) await safeUnlink(filePath, rt.logger);
    return;
  }

  let transcript;
  try {
    transcript = await transcribeOgg(filePath, rt.stt, rt.voiceCfg.projectId);
  } catch (err) {
    if (err instanceof TranscriptionError) {
      rt.logger.error({ component: 'bridge', err: err.message }, 'STT failed');
      await out.sendText(chatId, `voice transcription failed: ${err.message}`);
    } else {
      throw err;
    }
    if (!rt.voiceCfg.keepAudioFiles) await safeUnlink(filePath, rt.logger);
    return;
  }

  if (transcript.text === '') {
    await out.sendText(chatId, "couldn't make out the voice note — try again or send text");
    if (!rt.voiceCfg.keepAudioFiles) await safeUnlink(filePath, rt.logger);
    return;
  }

  const detectedLanguage = normaliseLanguage(transcript.languageCode);
  rt.logger.info(
    {
      component: 'bridge',
      event: 'voice_transcribed',
      language: detectedLanguage,
      chars: transcript.text.length,
      durationSec: transcript.durationSeconds,
    },
    'voice transcribed',
  );

  await runClaudeTurn(transcript.text, chatId, msg.channel, 'voice', detectedLanguage, rt);
  if (!rt.voiceCfg.keepAudioFiles) await safeUnlink(filePath, rt.logger);
}

async function runClaudeTurn(
  prompt: string,
  chatId: string,
  channelName: string,
  inputModality: InputModality,
  detectedLanguage: SupportedLanguage | undefined,
  rt: BridgeRuntime,
): Promise<void> {
  const out = rt.channelByName[channelName];
  if (!out) throw new Error(`unknown channel: ${channelName}`);

  const s = await rt.state.load();
  // When the input is voice, hint Claude to write conversationally so the
  // spoken reply doesn't sound like a markdown document being read aloud.
  // The hint is a system-level prefix INSIDE the user-turn prompt — visible
  // to Claude but does not show on the user's screen as a reply.
  const willSpeak = inputModality === 'voice' && s.voiceMode !== 'off';
  const promptToSend = willSpeak
    ? `[BRIDGE-NOTE: this turn arrived as a Telegram voice note from ${detectedLanguage ?? 'unknown lang'}; the reply will be played aloud via TTS. Write conversationally — no markdown formatting (no asterisks, hashes, pipes, tables, code fences, bullet markers, links, "★ Insight" blocks). Keep the answer naturally short for spoken delivery, ideally under ~150 words. The text channel will mirror the same words, so no need for parallel "voice version" / "text version".]\n\n${prompt}`
    : prompt;
  let result;
  try {
    // plan-004: retry once on silence-watchdog timeout, with a fresh
    // (resume=null) subprocess. The first failure clears any stored
    // sessionId so the second attempt cannot inherit a corrupted resume.
    result = await withRetryOnTimeout(
      (resume) =>
        askClaude({
          prompt: promptToSend,
          resume,
          cwd: rt.cwd,
          plugins: rt.plugins,
        }),
      s.sessionId,
      {
        onRetry: async () => {
          if (s.sessionId !== null) {
            await rt.state.save({ ...s, sessionId: null });
          }
          rt.logger.warn(
            { component: 'bridge', priorSessionId: s.sessionId },
            'silence watchdog tripped — retrying once with fresh session',
          );
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Clear sessionId on terminal failure so a corrupted session (e.g. killed
    // mid-turn by SIGTERM, leaving --resume to hang silently) cannot trap
    // subsequent turns.
    if (s.sessionId !== null) {
      const cur = await rt.state.load();
      await rt.state.save({ ...cur, sessionId: null });
      rt.logger.warn(
        { component: 'bridge', priorSessionId: s.sessionId },
        'cleared sessionId after terminal error — next turn starts fresh',
      );
    }
    rt.logger.error({ component: 'bridge', err: message }, 'claude error');
    await out.sendText(chatId, `error: ${message}`);
    return;
  }
  await persistTurn(rt.state, result.sessionId);
  rt.logger.info(
    {
      component: 'bridge',
      sessionId: result.sessionId,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      isError: result.isError,
    },
    'claude turn completed',
  );

  const replyText = result.text || '(empty response)';
  const routerInput: ReplyRouterInput = {
    replyText,
    inputModality,
    voiceMode: s.voiceMode,
    maxAudioSeconds: rt.voiceCfg.maxAudioSeconds,
    ...(detectedLanguage !== undefined ? { detectedLanguage } : {}),
  };
  const plan = routeReply(routerInput);

  // Send text first if the plan includes it.
  if (plan.text !== undefined) {
    const chunks = splitMessage(plan.text);
    for (const chunk of chunks) await out.sendText(chatId, chunk);
  }

  // Then send voice if planned.
  if (plan.voice !== undefined) {
    // Strip markdown BEFORE TTS so asterisks/hashes/pipes don't get spelled
    // out as "αστερίσκος" / "δίεση" / etc. The text channel still got the
    // original markdown above; only the spoken version gets stripped.
    const speakable = stripMarkdownForSpeech(plan.voice.text);
    rt.logger.info(
      {
        component: 'bridge',
        event: 'tts_request',
        language: plan.voice.language,
        chars: speakable.length,
        rawChars: plan.voice.text.length,
        truncated: plan.voice.truncated,
      },
      'sending text to TTS (markdown stripped)',
    );
    if (speakable === '') {
      rt.logger.warn(
        { component: 'bridge' },
        'TTS skipped — speakable text is empty after markdown strip',
      );
    } else {
      try {
        const synth = await synthesize(
          speakable,
          plan.voice.language,
          rt.voiceCfg.voiceConfig,
          rt.tts,
        );
        await out.sendVoice(chatId, synth.audio, synth.durationSeconds);
        if (rt.voiceCfg.keepAudioFiles) {
          const out = `${rt.cwd}/voice-reply-${Date.now()}.ogg`;
          await fs.writeFile(out, synth.audio, { mode: 0o600 });
          rt.logger.info({ component: 'bridge', out }, 'voice reply kept on disk');
        }
      } catch (err) {
        if (err instanceof SynthesisError) {
          rt.logger.error(
            { component: 'bridge', err: err.message },
            'TTS failed — falling back to text',
          );
          // If we hadn't already sent text, send it now as a fallback.
          if (plan.text === undefined) {
            const chunks = splitMessage(replyText);
            for (const chunk of chunks) await out.sendText(chatId, chunk);
          }
        } else {
          throw err;
        }
      }
    }
  }
}

function normaliseLanguage(code: string): SupportedLanguage {
  if (code === 'el-GR' || code.toLowerCase().startsWith('el')) return 'el-GR';
  return 'en-US';
}

async function safeUnlink(path: string, logger: Logger): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (err) {
    logger.warn(
      { component: 'bridge', err: err instanceof Error ? err.message : String(err), path },
      'failed to unlink voice file',
    );
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('FATAL', err);
  process.exit(1);
});
