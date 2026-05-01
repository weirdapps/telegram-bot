# Bot API Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Telegram Bot API channel (grammy) to the existing bridge daemon so DMs to `@plessas_claude_bot` are handled by the same Agent SDK + plugin pipeline that already serves Saved Messages, then retire the standalone `telegram` plugin.

**Architecture:** Introduce a small `Channel` interface in `bridge/src/channels/`. Wrap the existing `TelegramUserClient` as `MtProtoChannel` (no behavior change). Add `BotApiChannel` using grammy. `bridge/src/index.ts` instantiates both channels, attaches the same text/voice handlers to each, and routes everything through the existing FIFO queue → `runClaudeTurn` → `askClaude` → loaded plugins. Per-channel state isolation deferred to v2 — both channels share `BridgeState.sessionId` (single user, single Claude conversation).

**Tech Stack:** TypeScript (ESM, NodeNext), `@anthropic-ai/claude-agent-sdk`, `grammy` (new), `telegram` (existing GramJS), vitest, launchd.

---

## File Structure

**Created:**
- `bridge/src/channels/channel.ts` — interface + types only
- `bridge/src/channels/mtprotoChannel.ts` — wrapper around existing `TelegramUserClient`
- `bridge/src/channels/botApiChannel.ts` — new grammy-based implementation
- `test_scripts/test-channel-types.ts` — interface conformance smoke test
- `test_scripts/test-botApiChannel.ts` — unit tests for the bot wrapper

**Modified:**
- `package.json` — add grammy
- `bridge/src/index.ts` — instantiate both channels, attach shared handler
- `.env.example` — document `TELEGRAM_BOT_TOKEN` + (optional) `TELEGRAM_BRIDGE_BOT_ALLOWED_USER_IDS`
- `~/SourceCode/telegram-bot/.env` — add `TELEGRAM_BOT_TOKEN` (real value)
- `~/.claude/settings.json` — disable `telegram@claude-plugins-official`

**Deleted (post-verification):** none. The plugin install dir (`~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6`) and state dir (`~/.claude/channels/telegram/`) are left in place; disabling in `enabledPlugins` is sufficient and reversible.

---

### Task 1: Add `grammy` dependency

**Files:**
- Modify: `package.json` (dependencies block)

- [ ] **Step 1: Install grammy**

Run:
```bash
cd ~/SourceCode/telegram-bot && npm install grammy@^1.21.0
```
Expected: `package.json` shows `"grammy": "^1.21.0"` under dependencies; `package-lock.json` updated; `node_modules/grammy/` exists.

- [ ] **Step 2: Verify the import resolves**

Run:
```bash
cd ~/SourceCode/telegram-bot && node --input-type=module -e "import('grammy').then(m => console.log('ok', typeof m.Bot))"
```
Expected: `ok function`

- [ ] **Step 3: Typecheck still passes**

Run:
```bash
cd ~/SourceCode/telegram-bot && npm run typecheck
```
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
cd ~/SourceCode/telegram-bot && git add package.json package-lock.json && git commit -m "deps: add grammy for bot api channel"
```

---

### Task 2: Define the `Channel` interface

**Files:**
- Create: `bridge/src/channels/channel.ts`
- Create: `test_scripts/test-channel-types.ts`

- [ ] **Step 1: Write the failing test**

Create `test_scripts/test-channel-types.ts`:
```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type { Channel, ChannelMessage, ChannelTextHandler, ChannelVoiceHandler } from '../bridge/src/channels/channel.js';

describe('Channel interface shape', () => {
  it('ChannelMessage has the documented fields', () => {
    expectTypeOf<ChannelMessage>().toMatchTypeOf<{
      channel: string;
      chatId: string;
      senderId: string;
    }>();
  });

  it('Channel exposes start/stop and the four handlers/senders', () => {
    expectTypeOf<Channel['start']>().toBeFunction();
    expectTypeOf<Channel['stop']>().toBeFunction();
    expectTypeOf<Channel['onText']>().parameter(0).toEqualTypeOf<ChannelTextHandler>();
    expectTypeOf<Channel['onVoice']>().parameter(0).toEqualTypeOf<ChannelVoiceHandler>();
    expectTypeOf<Channel['sendText']>().toBeFunction();
    expectTypeOf<Channel['sendVoice']>().toBeFunction();
  });
});
```

- [ ] **Step 2: Verify the test compiles RED (type contract not yet satisfied)**

`expectTypeOf` is a vitest type-only API and `import type` erases at runtime, so vitest itself can't see the missing module. Use `tsc` for TDD red/green on type contracts.

Run:
```bash
cd ~/SourceCode/telegram-bot && npm run typecheck
```
Expected: FAIL with `error TS2307: Cannot find module '../bridge/src/channels/channel.js'`.

- [ ] **Step 3: Create the interface**

Create `bridge/src/channels/channel.ts`:
```typescript
/**
 * Channel — minimal abstraction over a Telegram input/output source.
 *
 * Two implementations:
 *   - MtProtoChannel: wraps TelegramUserClient (Saved Messages via user account)
 *   - BotApiChannel:  wraps grammy Bot (DMs to @plessas_claude_bot)
 *
 * Both feed the same handler in bridge/src/index.ts so plugin loading,
 * permission policy, voice synthesis, and reply routing stay shared.
 */

export interface ChannelMessage {
  /** Channel name — useful for logs and per-channel routing later. */
  channel: string;
  /** Chat to reply to. Stringified bigint for safe JSON logging. */
  chatId: string;
  /** Sender's user id. Stringified bigint. */
  senderId: string;
  /** Optional message id (for threading replies if the channel supports it). */
  messageId?: string;
  /** Plain text body (for text messages); caption for media. */
  text?: string;
  /** Local filesystem path to the downloaded voice file (.ogg). */
  mediaPath?: string;
}

export type ChannelTextHandler = (msg: ChannelMessage) => void;
export type ChannelVoiceHandler = (msg: ChannelMessage) => void;

export interface Channel {
  /** Stable name — `"saved-messages"`, `"bot"`. Used in logs. */
  readonly name: string;

  /** Begin listening for incoming messages. Idempotent. */
  start(): Promise<void>;

  /** Stop listening and release resources. Idempotent. */
  stop(): Promise<void>;

  onText(handler: ChannelTextHandler): void;
  onVoice(handler: ChannelVoiceHandler): void;

  sendText(chatId: string, text: string): Promise<void>;
  sendVoice(chatId: string, audio: Buffer, durationSeconds: number): Promise<void>;
}
```

- [ ] **Step 4: Verify typecheck now passes (GREEN)**

Run:
```bash
cd ~/SourceCode/telegram-bot && npm run typecheck
```
Expected: exit 0.

- [ ] **Step 5: Runtime sanity check — vitest discovers and "runs" the test**

Run:
```bash
cd ~/SourceCode/telegram-bot && npx vitest run test_scripts/test-channel-types.ts
```
Expected: 2/2 PASS. The assertions are type-only and run as no-ops at runtime; this only proves the file parses and vitest discovers it.

- [ ] **Step 6: Commit**

```bash
cd ~/SourceCode/telegram-bot && git add bridge/src/channels/channel.ts test_scripts/test-channel-types.ts && git commit -m "feat: introduce Channel interface for input source abstraction"
```

---

### Task 3: Wrap existing MTProto client as `MtProtoChannel`

**Files:**
- Create: `bridge/src/channels/mtprotoChannel.ts`

This task is a behavior-preserving wrapper — no test needed beyond typecheck + later integration via Task 4.

- [ ] **Step 1: Create the wrapper**

Create `bridge/src/channels/mtprotoChannel.ts`:
```typescript
import type { TelegramUserClient } from '../../../src/index.js';
import type { Channel, ChannelTextHandler, ChannelVoiceHandler } from './channel.js';

/**
 * Saved-Messages channel — wraps the existing GramJS user client.
 * Emits text + voice events with the same shape as BotApiChannel so the
 * bridge handler can stay channel-agnostic.
 */
export class MtProtoChannel implements Channel {
  readonly name = 'saved-messages';
  private started = false;

  constructor(private readonly client: TelegramUserClient) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.client.startListening();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.client.disconnect();
    this.started = false;
  }

  onText(handler: ChannelTextHandler): void {
    this.client.on('text', (msg) => {
      handler({
        channel: this.name,
        chatId: msg.chatId.toString(),
        senderId: msg.senderId?.toString() ?? '',
        text: msg.text ?? '',
      });
    });
  }

  onVoice(handler: ChannelVoiceHandler): void {
    this.client.on('voice', (msg) => {
      const out: { channel: string; chatId: string; senderId: string; mediaPath?: string } = {
        channel: this.name,
        chatId: msg.chatId.toString(),
        senderId: msg.senderId?.toString() ?? '',
      };
      if (msg.mediaPath !== undefined) out.mediaPath = msg.mediaPath;
      handler(out);
    });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.client.sendText(BigInt(chatId), text);
  }

  async sendVoice(chatId: string, audio: Buffer, durationSeconds: number): Promise<void> {
    await this.client.sendVoice(BigInt(chatId), audio, durationSeconds);
  }
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
cd ~/SourceCode/telegram-bot && npm run typecheck
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd ~/SourceCode/telegram-bot && git add bridge/src/channels/mtprotoChannel.ts && git commit -m "feat: MtProtoChannel wraps TelegramUserClient as a Channel"
```

---

### Task 4: Refactor `bridge/src/index.ts` to use `MtProtoChannel` (no behavior change)

**Files:**
- Modify: `bridge/src/index.ts:69-181` (client creation, event handlers, listener startup)

This is a pure refactor. Existing test scripts (test-bridge-split-message, test-claudeRetry, test-replyRouter, etc.) MUST continue to pass.

- [ ] **Step 1: Extract handler functions to take ChannelMessage**

Replace the `handleTextMessage` and `handleVoiceMessage` signatures in `bridge/src/index.ts`. They currently take `(text, chatId, rt)` and `(filePath, chatId, rt)` — change to `(msg, rt)`.

In `bridge/src/index.ts`, find:
```typescript
async function handleTextMessage(
  text: string,
  chatId: bigint,
  rt: BridgeRuntime,
): Promise<void> {
```
Replace with:
```typescript
async function handleTextMessage(
  msg: ChannelMessage,
  rt: BridgeRuntime,
): Promise<void> {
  const text = msg.text ?? '';
  const chatId = msg.chatId;
```

Find:
```typescript
async function handleVoiceMessage(
  filePath: string,
  chatId: bigint,
  rt: BridgeRuntime,
): Promise<void> {
```
Replace with:
```typescript
async function handleVoiceMessage(
  msg: ChannelMessage,
  rt: BridgeRuntime,
): Promise<void> {
  if (!msg.mediaPath) {
    rt.logger.warn({ component: 'bridge', chatId: msg.chatId, channel: msg.channel }, 'voice without mediaPath — drop');
    return;
  }
  const filePath = msg.mediaPath;
  const chatId = msg.chatId;
```

Inside both functions, `rt.client.sendText(chatId, ...)` calls now need `chatId: string`. Update the helper section. Search the file for `sendText(chatId,` and `sendVoice(chatId,` — there should be ~5 sites. The new `chatId` is already `string`; pass it through the channel adapter, not the raw client.

- [ ] **Step 2: Replace `rt.client` with `rt.channel`**

In `BridgeRuntime` interface (currently lines ~38-47), replace:
```typescript
  client: TelegramUserClient;
```
with:
```typescript
  channels: Channel[];
  /** First channel is the "primary" used for replies — replaced in Task 6 with per-message routing. */
  channel: Channel;
```

Update all `rt.client.sendText` → `rt.channel.sendText` and `rt.client.sendVoice` → `rt.channel.sendVoice`. The client itself remains owned by MtProtoChannel.

Then in `runClaudeTurn`, `await rt.client.sendText(chatId, chunk)` becomes `await rt.channel.sendText(chatId, chunk)` — note the `chatId` is now string.

- [ ] **Step 3: Wire MtProtoChannel in `main()`**

Replace lines 69-77 (the `new TelegramUserClient(...)` and `await client.connect()`) with:
```typescript
  const userClient = new TelegramUserClient({
    apiId: cfg.apiId,
    apiHash: cfg.apiHash,
    sessionString,
    logger,
    downloadDir: cfg.downloadDir,
    sessionPath: cfg.sessionPath,
  });
  await userClient.connect();
  const savedMessages = new MtProtoChannel(userClient);
```

Then replace lines ~113-167 (the `client.on('text', ...)` and `client.on('voice', ...)` blocks plus `client.startListening()`) with:
```typescript
  // Single shared handler per channel — same FIFO queue serialises across all channels
  const attachHandlers = (ch: Channel): void => {
    ch.onText((m) => {
      if (!isAllowed(m.senderId, allowed)) {
        logger.warn({ component: 'bridge', channel: m.channel, senderId: m.senderId, chatId: m.chatId }, 'rejected: sender not allowlisted');
        return;
      }
      const text = (m.text ?? '').trim();
      if (text === '') return;
      queue = queue.then(() =>
        handleTextMessage({ ...m, text }, rt).catch((err) => {
          logger.error({ component: 'bridge', channel: m.channel, err: err instanceof Error ? err.message : String(err) }, 'unhandled error in text handler');
        }),
      );
    });
    ch.onVoice((m) => {
      if (!isAllowed(m.senderId, allowed)) {
        logger.warn({ component: 'bridge', channel: m.channel, senderId: m.senderId, chatId: m.chatId }, 'rejected: voice sender not allowlisted');
        return;
      }
      queue = queue.then(() =>
        handleVoiceMessage(m, rt).catch((err) => {
          logger.error({ component: 'bridge', channel: m.channel, err: err instanceof Error ? err.message : String(err) }, 'unhandled error in voice handler');
        }),
      );
    });
  };

  const channels: Channel[] = [savedMessages];
  for (const ch of channels) attachHandlers(ch);
  for (const ch of channels) await ch.start();
```

Update `BridgeRuntime` literal initialization (~line 99-108) to set `channels` and `channel: savedMessages`.

Update shutdown block (~line 183-192):
```typescript
  const shutdown = async (): Promise<void> => {
    logger.info({ component: 'bridge' }, 'shutdown signal received');
    await queue.catch(() => undefined);
    stt.close();
    tts.close();
    for (const ch of channels) await ch.stop();
    process.exit(0);
  };
```

- [ ] **Step 4: Add the new imports at the top of `bridge/src/index.ts`**

Insert near the existing imports:
```typescript
import type { Channel, ChannelMessage } from './channels/channel.js';
import { MtProtoChannel } from './channels/mtprotoChannel.js';
```

Remove the now-unused `client` field from BridgeRuntime if any references remain.

- [ ] **Step 5: Typecheck**

Run:
```bash
cd ~/SourceCode/telegram-bot && npm run typecheck
```
Expected: exit 0. Fix any leftover `rt.client` references or type mismatches.

- [ ] **Step 6: Run all existing tests**

Run:
```bash
cd ~/SourceCode/telegram-bot && npx vitest run
```
Expected: PASS. No regressions in test-bridge-split-message, test-replyRouter, test-claudeRetry, test-pluginLoader, test-session-store, test-voiceMode, test-markdownStrip, test-channel-types.

- [ ] **Step 7: Commit**

```bash
cd ~/SourceCode/telegram-bot && git add bridge/src/index.ts && git commit -m "refactor: bridge dispatches via Channel abstraction (saved messages still sole source)"
```

---

### Task 5: Implement `BotApiChannel`

**Files:**
- Create: `bridge/src/channels/botApiChannel.ts`
- Create: `test_scripts/test-botApiChannel.ts`

- [ ] **Step 1: Write the failing test**

Create `test_scripts/test-botApiChannel.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BotApiChannel } from '../bridge/src/channels/botApiChannel.js';

describe('BotApiChannel', () => {
  let sendMessageMock: ReturnType<typeof vi.fn>;
  let sendVoiceMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendMessageMock = vi.fn().mockResolvedValue({});
    sendVoiceMock = vi.fn().mockResolvedValue({});
  });

  it('exposes name "bot"', () => {
    const ch = new BotApiChannel({
      token: 'fake-token',
      tmpDir: '/tmp/test-bot-channel',
      botFactory: () => ({ api: { sendMessage: sendMessageMock, sendVoice: sendVoiceMock }, on: vi.fn(), start: vi.fn(), stop: vi.fn(), botInfo: undefined } as never),
    });
    expect(ch.name).toBe('bot');
  });

  it('sendText calls grammy api.sendMessage with chat_id + text', async () => {
    const ch = new BotApiChannel({
      token: 'fake-token',
      tmpDir: '/tmp/test-bot-channel',
      botFactory: () => ({ api: { sendMessage: sendMessageMock, sendVoice: sendVoiceMock }, on: vi.fn(), start: vi.fn(), stop: vi.fn(), botInfo: undefined } as never),
    });
    await ch.sendText('5988833079', 'hello world');
    expect(sendMessageMock).toHaveBeenCalledWith('5988833079', 'hello world');
  });

  it('sendVoice posts an InputFile via api.sendVoice with duration', async () => {
    const ch = new BotApiChannel({
      token: 'fake-token',
      tmpDir: '/tmp/test-bot-channel',
      botFactory: () => ({ api: { sendMessage: sendMessageMock, sendVoice: sendVoiceMock }, on: vi.fn(), start: vi.fn(), stop: vi.fn(), botInfo: undefined } as never),
    });
    const audio = Buffer.from('opusbytes');
    await ch.sendVoice('5988833079', audio, 7);
    expect(sendVoiceMock).toHaveBeenCalledTimes(1);
    const [chatId, _file, opts] = sendVoiceMock.mock.calls[0];
    expect(chatId).toBe('5988833079');
    expect(opts).toEqual({ duration: 7 });
  });

  it('onText forwards text messages with channel="bot"', () => {
    const handlers: Record<string, (ctx: unknown) => void> = {};
    const onMock = vi.fn((event: string, handler: (ctx: unknown) => void) => { handlers[event] = handler; });
    const ch = new BotApiChannel({
      token: 'fake-token',
      tmpDir: '/tmp/test-bot-channel',
      botFactory: () => ({ api: { sendMessage: sendMessageMock, sendVoice: sendVoiceMock }, on: onMock, start: vi.fn(), stop: vi.fn(), botInfo: undefined } as never),
    });
    const received: unknown[] = [];
    ch.onText((m) => received.push(m));
    handlers['message:text']?.({
      message: { text: 'hi', message_id: 42 },
      chat: { id: 5988833079 },
      from: { id: 5988833079 },
    });
    expect(received).toEqual([{
      channel: 'bot',
      chatId: '5988833079',
      senderId: '5988833079',
      messageId: '42',
      text: 'hi',
    }]);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

Run:
```bash
cd ~/SourceCode/telegram-bot && npx vitest run test_scripts/test-botApiChannel.ts
```
Expected: FAIL — `Cannot find module '../bridge/src/channels/botApiChannel.js'`.

- [ ] **Step 3: Implement BotApiChannel**

Create `bridge/src/channels/botApiChannel.ts`:
```typescript
import { Bot, InputFile, type Context } from 'grammy';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../../src/logger/logger.js';
import type {
  Channel,
  ChannelTextHandler,
  ChannelVoiceHandler,
  ChannelMessage,
} from './channel.js';

/** Test seam — production passes the real `Bot` constructor. */
export type BotFactory = (token: string) => Pick<Bot, 'api' | 'on' | 'start' | 'stop' | 'botInfo'>;

export interface BotApiChannelOpts {
  token: string;
  /** Where to drop downloaded voice .ogg files. */
  tmpDir: string;
  logger?: Logger;
  /** Override for tests. Defaults to the real `Bot` constructor. */
  botFactory?: BotFactory;
}

/**
 * Bot API channel — DMs to @plessas_claude_bot via grammy long-polling.
 *
 * Inbound flow:
 *   - on('message:text')   → emit ChannelMessage with text
 *   - on('message:voice')  → download to tmpDir, emit ChannelMessage with mediaPath
 *
 * Outbound flow uses bot.api.sendMessage / sendVoice. Bot DMs use the bot's
 * identity, not the user's account, so replies appear to come from
 * @plessas_claude_bot.
 */
export class BotApiChannel implements Channel {
  readonly name = 'bot';
  private readonly bot: ReturnType<BotFactory>;
  private readonly token: string;
  private readonly tmpDir: string;
  private readonly logger?: Logger;
  private textHandler?: ChannelTextHandler;
  private voiceHandler?: ChannelVoiceHandler;
  private started = false;

  constructor(opts: BotApiChannelOpts) {
    const factory: BotFactory = opts.botFactory ?? ((t) => new Bot(t));
    this.bot = factory(opts.token);
    this.token = opts.token;
    this.tmpDir = opts.tmpDir;
    this.logger = opts.logger;
    mkdirSync(this.tmpDir, { recursive: true });

    this.bot.on('message:text', (ctx: Context) => {
      if (!this.textHandler) return;
      const text = ctx.message?.text ?? '';
      const chatId = String(ctx.chat?.id ?? '');
      const senderId = String(ctx.from?.id ?? '');
      const messageId = ctx.message?.message_id !== undefined ? String(ctx.message.message_id) : undefined;
      const msg: ChannelMessage = { channel: this.name, chatId, senderId, text };
      if (messageId !== undefined) msg.messageId = messageId;
      this.textHandler(msg);
    });

    this.bot.on('message:voice', async (ctx: Context) => {
      if (!this.voiceHandler) return;
      const voice = ctx.message?.voice;
      if (!voice) return;
      const chatId = String(ctx.chat?.id ?? '');
      const senderId = String(ctx.from?.id ?? '');
      const messageId = ctx.message?.message_id !== undefined ? String(ctx.message.message_id) : undefined;
      let mediaPath: string | undefined;
      try {
        const file = await ctx.api.getFile(voice.file_id);
        if (file.file_path) {
          const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
          const res = await fetch(url);
          const buf = Buffer.from(await res.arrayBuffer());
          mediaPath = join(this.tmpDir, `${Date.now()}-${voice.file_unique_id}.ogg`);
          writeFileSync(mediaPath, buf, { mode: 0o600 });
        }
      } catch (err) {
        this.logger?.warn({ component: 'botApiChannel', err: err instanceof Error ? err.message : String(err) }, 'voice download failed');
      }
      const msg: ChannelMessage = { channel: this.name, chatId, senderId };
      if (messageId !== undefined) msg.messageId = messageId;
      if (mediaPath !== undefined) msg.mediaPath = mediaPath;
      this.voiceHandler(msg);
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // bot.start() blocks until stop() — fire-and-forget with error logging.
    void this.bot.start({
      onStart: (info) => {
        this.logger?.info({ component: 'botApiChannel', username: info.username }, `polling as @${info.username}`);
      },
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.bot.stop();
    this.started = false;
  }

  onText(handler: ChannelTextHandler): void {
    this.textHandler = handler;
  }

  onVoice(handler: ChannelVoiceHandler): void {
    this.voiceHandler = handler;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(chatId, text);
  }

  async sendVoice(chatId: string, audio: Buffer, durationSeconds: number): Promise<void> {
    await this.bot.api.sendVoice(chatId, new InputFile(audio), { duration: durationSeconds });
  }
}
```

- [ ] **Step 4: Run test, expect pass**

Run:
```bash
cd ~/SourceCode/telegram-bot && npx vitest run test_scripts/test-botApiChannel.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck**

Run:
```bash
cd ~/SourceCode/telegram-bot && npm run typecheck
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
cd ~/SourceCode/telegram-bot && git add bridge/src/channels/botApiChannel.ts test_scripts/test-botApiChannel.ts && git commit -m "feat: BotApiChannel — grammy-based bot dm input/output"
```

---

### Task 6: Wire `BotApiChannel` into the bridge

**Files:**
- Modify: `bridge/src/index.ts` (just the channel-construction block in `main()`)

- [ ] **Step 1: Read the bot token + opt-in env**

In `main()`, after the existing `loadConfig()` call, add:
```typescript
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
```

- [ ] **Step 2: Build the channels list conditionally**

Replace:
```typescript
  const channels: Channel[] = [savedMessages];
```
with:
```typescript
  const channels: Channel[] = [savedMessages];
  if (botToken) {
    const botTmpDir = process.env.TELEGRAM_BRIDGE_BOT_TMPDIR ?? `${process.env.HOME ?? ''}/.telegram/bot-inbox`;
    channels.push(new BotApiChannel({ token: botToken, tmpDir: botTmpDir, logger }));
    logger.info({ component: 'bridge', botTmpDir }, 'bot api channel enabled (TELEGRAM_BOT_TOKEN set)');
  } else {
    logger.info({ component: 'bridge' }, 'bot api channel disabled (TELEGRAM_BOT_TOKEN not set)');
  }
```

- [ ] **Step 3: Update reply routing — reply on the channel that sourced the message**

`runClaudeTurn` currently uses `rt.channel.sendText/sendVoice`. We need to route replies back to the SAME channel the request came in on. Change `BridgeRuntime`:
```typescript
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
```

Build it:
```typescript
  const channelByName: Record<string, Channel> = {};
  for (const ch of channels) channelByName[ch.name] = ch;
  const rt: BridgeRuntime = {
    state, channels, channelByName, logger, cwd, voiceCfg, stt, tts, plugins: pluginLoad.plugins,
  };
```

Change `runClaudeTurn` signature to take a channel name:
```typescript
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
  // ... existing body, but every rt.channel.sendX → out.sendX
```

Update `handleTextMessage` and `handleVoiceMessage` to pass `msg.channel` into `runClaudeTurn`.

- [ ] **Step 4: Typecheck + run all tests**

Run:
```bash
cd ~/SourceCode/telegram-bot && npm run typecheck && npx vitest run
```
Expected: exit 0; all tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/SourceCode/telegram-bot && git add bridge/src/index.ts && git commit -m "feat: bridge wires both channels and routes replies back to source"
```

---

### Task 7: Update `.env` and `.env.example`

**Files:**
- Modify: `~/SourceCode/telegram-bot/.env` (real value)
- Modify: `~/SourceCode/telegram-bot/.env.example` (documentation)

- [ ] **Step 1: Add token to live `.env`**

Run:
```bash
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' ~/.claude/channels/telegram/.env | cut -d= -f2-)
test -n "$TOKEN" || { echo "no token found in plugin .env"; exit 1; }
grep -q '^TELEGRAM_BOT_TOKEN=' ~/SourceCode/telegram-bot/.env && \
  sed -i '' "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=${TOKEN}|" ~/SourceCode/telegram-bot/.env || \
  printf '\n# Bot API token for @plessas_claude_bot (added 2026-05-01)\nTELEGRAM_BOT_TOKEN=%s\n' "$TOKEN" >> ~/SourceCode/telegram-bot/.env
chmod 600 ~/SourceCode/telegram-bot/.env
grep '^TELEGRAM_BOT_TOKEN=' ~/SourceCode/telegram-bot/.env | sed 's/=\([0-9]*\):.*/=\1:.../'
```
Expected: prints `TELEGRAM_BOT_TOKEN=8636866491:...`

- [ ] **Step 2: Document in `.env.example`**

Append to `~/SourceCode/telegram-bot/.env.example`:
```bash
cat >> ~/SourceCode/telegram-bot/.env.example <<'EOF'

# --- Bot API channel (optional) ---
# When set, the bridge ALSO listens for DMs to your bot. Get the token from
# BotFather (@BotFather on Telegram → /newbot or /token).
# TELEGRAM_BOT_TOKEN=123456789:AAH...
# Override the default voice download dir ($HOME/.telegram/bot-inbox)
# TELEGRAM_BRIDGE_BOT_TMPDIR=/tmp/bot-inbox
EOF
```

- [ ] **Step 3: Clear `BRIDGE_PLUGIN_ALLOWLIST` (load all 40 plugins per user choice)**

Run:
```bash
sed -i '' 's/^BRIDGE_PLUGIN_ALLOWLIST=.*/BRIDGE_PLUGIN_ALLOWLIST=/' ~/SourceCode/telegram-bot/.env
grep '^BRIDGE_PLUGIN_ALLOWLIST=' ~/SourceCode/telegram-bot/.env
```
Expected: `BRIDGE_PLUGIN_ALLOWLIST=` (empty value). Empty allowlist = load every enabled plugin from `~/.claude/settings.json`.

- [ ] **Step 4: Commit `.env.example` only — never the live `.env`**

```bash
cd ~/SourceCode/telegram-bot && git add .env.example && git commit -m "docs: document TELEGRAM_BOT_TOKEN env in example"
```
Expected: `.env` is gitignored so `git status` should show only `.env.example` modified before the commit.

---

### Task 8: Disable the `telegram` plugin in Claude Code

The plugin's bot poller will fight the bridge for the same getUpdates slot if both run. Disabling stops the plugin from spawning on next session start; `kill` removes the running process now.

**Files:**
- Modify: `~/.claude/settings.json` (`enabledPlugins` map)

- [ ] **Step 1: Read current setting**

Run:
```bash
python3 -c "import json; d=json.load(open('$HOME/.claude/settings.json')); print('telegram@claude-plugins-official:', d.get('enabledPlugins', {}).get('telegram@claude-plugins-official'))"
```
Expected: `telegram@claude-plugins-official: True`

- [ ] **Step 2: Set to false (preserves all other settings)**

Run:
```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / '.claude' / 'settings.json'
d = json.loads(p.read_text())
d.setdefault('enabledPlugins', {})['telegram@claude-plugins-official'] = False
p.write_text(json.dumps(d, indent=2) + '\n')
print('disabled')
PY
```
Expected: `disabled`

- [ ] **Step 3: Kill the currently running plugin bot process**

Run:
```bash
PID=$(cat ~/.claude/channels/telegram/bot.pid 2>/dev/null)
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID" && echo "killed pid $PID"
else
  echo "no live bot.pid (already gone)"
fi
```
Expected: either `killed pid 70678` or `no live bot.pid`.

- [ ] **Step 4: Verify the polling slot is free**

Run:
```bash
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' ~/.claude/channels/telegram/.env | cut -d= -f2-)
curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=2&limit=1" | python3 -m json.tool
```
Expected: `"ok": true` (NOT 409 Conflict). Updates list may be empty — that's fine.

---

### Task 9: Reload the bridge daemon

**Files:**
- Touched indirectly: `~/Library/LaunchAgents/com.weirdapps.telegram-claude-bridge.plist` (no edits, just reload)

- [ ] **Step 1: Build (if the bridge runs from `dist/`) or skip (if `tsx`)**

Run:
```bash
cd ~/SourceCode/telegram-bot && npm run build
```
Expected: exit 0. Confirms TS compiles end-to-end.

- [ ] **Step 2: Restart the launchd job**

Run:
```bash
launchctl unload ~/Library/LaunchAgents/com.weirdapps.telegram-claude-bridge.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.weirdapps.telegram-claude-bridge.plist
sleep 3
launchctl list | grep telegram-claude-bridge
```
Expected: a non-zero PID and exit-status `0`.

- [ ] **Step 3: Tail logs for the bot-channel boot line**

Run:
```bash
tail -50 ~/Library/Logs/telegram-claude-bridge.out.log | grep -E 'bot api channel|polling as @|bridge listening'
```
Expected: lines like `bot api channel enabled`, `polling as @plessas_claude_bot`, `bridge listening`.

- [ ] **Step 4: Confirm no 409 in err.log**

Run:
```bash
tail -50 ~/Library/Logs/telegram-claude-bridge.err.log | grep -E '409|Conflict' || echo "clean"
```
Expected: `clean`.

---

### Task 10: End-to-end verification from Telegram

- [ ] **Step 1: From your phone, DM `@plessas_claude_bot`**

Send: `test from bot channel — what plugins are loaded?`

- [ ] **Step 2: Watch the live log**

Run (in a terminal, leave it running):
```bash
tail -f ~/Library/Logs/telegram-claude-bridge.out.log | grep -E 'channel|bot|claude turn'
```

Expected sequence within 10s:
- `event: message_received` (from grammy via BotApiChannel)
- `claude turn completed` line with `costUsd > 0`, `isError: false`
- `event: message_sent` (the reply)

- [ ] **Step 3: Verify the reply lands in Telegram**

Check your phone: `@plessas_claude_bot` should reply with a list of plugins.

- [ ] **Step 4: Repeat with Saved Messages**

From your own Saved Messages, send the same prompt. Confirm the reply arrives there too — proving both channels still work simultaneously.

- [ ] **Step 5: Optional — voice test**

Send a voice note to `@plessas_claude_bot`. Expected: STT transcribes, Claude responds, TTS replies (if voiceMode=mirror|always).

---

### Task 11: Final commit + status check

- [ ] **Step 1: Confirm clean tree**

Run:
```bash
cd ~/SourceCode/telegram-bot && git status
```
Expected: `nothing to commit, working tree clean` (all earlier task commits already in).

- [ ] **Step 2: Note the disabled plugin in CLAUDE.md (optional)**

If the bridge's CLAUDE.md mentions the `telegram` plugin, update the line to say it was retired in favor of the in-bridge BotApiChannel. Otherwise skip.

- [ ] **Step 3: Tag the release**

Run:
```bash
cd ~/SourceCode/telegram-bot && git tag -a v0.2.0-bot-channel -m "add Bot API channel; retire standalone telegram plugin"
```

---

## Self-Review

**Spec coverage:**
- Channel abstraction (Task 2) ✓
- MTProto wrapped (Task 3) ✓
- Refactor index.ts (Task 4) ✓
- Bot API channel (Task 5) ✓
- Bridge wires both (Task 6) ✓
- Token in env (Task 7) ✓
- Plugin disabled (Task 8) ✓
- Daemon reload (Task 9) ✓
- E2E test (Task 10) ✓
- All 40 plugins loaded — already handled by existing pluginLoader (no allowlist override needed). If `BRIDGE_PLUGIN_ALLOWLIST` is set in `.env` it should be either cleared or expanded to include all 40 keys; flagged for user confirmation pre-Task 9.

**Placeholder scan:** All steps include exact code or commands. No "TBD" / "implement later" / "similar to Task N" found.

**Type consistency:** `Channel.sendText(chatId: string, ...)` everywhere. `ChannelMessage.chatId: string` everywhere. `runClaudeTurn` updated to take string `chatId` (Task 6 step 3) — confirmed consistent with handler updates in Task 4.

**Known caveats noted in plan:**
- Both channels share `BridgeState.sessionId` (single Claude conversation across them). Acceptable for single-user setup; per-channel state is a v2 concern.
- `BRIDGE_PLUGIN_ALLOWLIST` in current `.env` may be set to a curated subset (e.g. `trading-hub`-only). User chose "all 40 plugins" — clear or expand the env var before Task 9 reload.
