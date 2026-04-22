// src/client/TelegramUserClient.ts
//
// Central facade over GramJS TelegramClient. One instance per process. Wraps
// every Telegram-touching call in `withFloodRetry` and dispatches incoming
// NewMessage events to handlers registered via `on(event, handler)`.

import { promises as fs } from 'node:fs';
import { Api, type TelegramClient } from 'telegram';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { FloodWaitError } from 'telegram/errors/index.js';

import type { Logger } from '../logger/logger.js';
import type {
  LoginCallbacks,
  SentMessageInfo,
  ListenOptions,
  MessageHandler,
  EventName,
  IncomingMessage,
} from './events.js';
import type { PeerInput } from './peer.js';
import { resolvePeer } from './peer.js';
import {
  classifyIncoming,
  downloadIncomingMedia,
  type IncomingKind,
} from './media.js';
import { withFloodRetry } from './flood.js';
import { buildTelegramClient } from './buildClient.js';
import { createSessionStore } from '../config/session-store.js';
import { LoginRequiredError } from '../errors.js';

/**
 * Construction-time options for TelegramUserClient.
 *
 * Defaults on floodSleepThreshold / connectionRetries are *library behaviour
 * knobs*, not user-facing configuration; the no-fallback rule applies strictly
 * to values derived from env (AppConfig).
 */
export interface TelegramUserClientOptions {
  /** MTProto application ID (positive integer). */
  readonly apiId: number;
  /** MTProto application hash. */
  readonly apiHash: string;
  /** Serialized StringSession, or "" for a fresh login. */
  readonly sessionString: string;
  /** pino logger used by the facade and passed to sub-modules. */
  readonly logger: Logger;
  /** Absolute directory for incoming media downloads. */
  readonly downloadDir: string;
  /** Absolute path at which to persist the serialized StringSession after login. */
  readonly sessionPath: string;
  /** GramJS floodSleepThreshold (seconds). Default 5. */
  readonly floodSleepThreshold?: number;
  /** GramJS connectionRetries (initial-connection attempts). Default 10. */
  readonly connectionRetries?: number;
}

/**
 * Singleton-per-process facade over GramJS TelegramClient.
 *
 * Lifecycle: construct → connect() (or login() for first run) → sendX /
 * startListening → stopListening → disconnect().
 *
 * Thread-safety: not thread-safe. One TelegramUserClient per process.
 */
export class TelegramUserClient {
  private readonly client: TelegramClient;
  private readonly logger: Logger;
  private readonly downloadDir: string;
  private readonly sessionPath: string;

  private readonly handlers: Map<EventName, Set<MessageHandler>> = new Map();
  private listening = false;
  private listenOptions: Required<ListenOptions> = {
    privateChatsOnly: true,
    autoDownload: true,
  };
  private boundHandler: ((event: NewMessageEvent) => Promise<void>) | null = null;
  private readonly inFlightDispatches: Set<Promise<unknown>> = new Set();

  private connected = false;

  constructor(options: TelegramUserClientOptions) {
    this.logger = options.logger;
    this.downloadDir = options.downloadDir;
    this.sessionPath = options.sessionPath;
    this.client = buildTelegramClient({
      apiId: options.apiId,
      apiHash: options.apiHash,
      sessionString: options.sessionString,
      logger: options.logger,
      ...(options.floodSleepThreshold !== undefined
        ? { floodSleepThreshold: options.floodSleepThreshold }
        : {}),
      ...(options.connectionRetries !== undefined
        ? { connectionRetries: options.connectionRetries }
        : {}),
    });
  }

  /**
   * Connects to Telegram using the provided sessionString. Throws
   * LoginRequiredError if Telegram rejects the session.
   */
  async connect(): Promise<void> {
    try {
      await this.client.connect();
      // Ensure the session is authorized — an empty session will connect but
      // subsequent calls will fail with AUTH_KEY_UNREGISTERED.
      const authorized = await this.client.checkAuthorization();
      if (!authorized) {
        throw new LoginRequiredError(
          'No valid Telegram session. Run the `login` subcommand.',
        );
      }
      this.connected = true;
      this.logger.info(
        { event: 'connection_state', component: 'client', state: 'connected' },
        'connected to Telegram',
      );
    } catch (err: unknown) {
      if (err instanceof LoginRequiredError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (
        /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_INVALID/i.test(
          msg,
        )
      ) {
        throw new LoginRequiredError(
          'Stored Telegram session is invalid. Run the `login` subcommand.',
          err,
        );
      }
      throw err;
    }
  }

  /**
   * Interactive login flow. Calls GramJS's client.start() with the provided
   * callbacks. On success, persists the new session string to `sessionPath`
   * (mode 0o600) and returns it.
   */
  async login(callbacks: LoginCallbacks): Promise<string> {
    const passwordFn = callbacks.password;
    try {
      await this.client.start({
        phoneNumber: callbacks.phoneNumber,
        phoneCode: callbacks.phoneCode,
        password: passwordFn !== undefined
          ? passwordFn
          : async () => {
              throw new LoginRequiredError(
                'Account has 2FA enabled but no password callback was supplied.',
              );
            },
        onError: (e: Error) => {
          if (callbacks.onError !== undefined) {
            try {
              callbacks.onError(e);
            } catch {
              // user callback errors must never break the login flow
            }
          } else {
            this.logger.error(
              { event: 'login_error', component: 'client', err: e.message },
              'login error',
            );
          }
        },
      });
    } catch (err: unknown) {
      if (err instanceof LoginRequiredError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new LoginRequiredError(`Login failed: ${msg}`, err);
    }

    this.connected = true;
    const sessionString = String(this.client.session.save());
    try {
      const store = createSessionStore();
      await store.write(this.sessionPath, sessionString);
      this.logger.info(
        {
          event: 'login_completed',
          component: 'client',
          sessionPath: this.sessionPath,
        },
        'login complete; session persisted',
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { component: 'client', err: msg },
        'failed to persist session file',
      );
      throw err;
    }
    return sessionString;
  }

  /**
   * Disconnects gracefully. Calls GramJS's `client.destroy()` (sets
   * `_destroyed=true` before disconnecting) and sleeps 500 ms to absorb the
   * known `_updateLoop` ping race (gramjs#243 / #615). Expected
   * "Cannot send requests while disconnected" / "TIMEOUT" errors are logged
   * at debug and swallowed.
   */
  async disconnect(): Promise<void> {
    try {
      await this.client.destroy();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('Cannot send requests while disconnected') ||
        msg.includes('TIMEOUT') ||
        msg.includes('disconnected')
      ) {
        this.logger.debug(
          { component: 'client', err: msg },
          'expected post-disconnect error (gramjs#243) — suppressed',
        );
      } else {
        this.logger.error(
          { component: 'client', err: msg },
          'unexpected error during disconnect',
        );
      }
    }

    // Settle window — lets any in-flight ping finish before the caller exits.
    await delay(500);

    this.connected = false;
    this.logger.info(
      { event: 'connection_state', component: 'client', state: 'disconnected' },
      'disconnected from Telegram',
    );
  }

  /** Returns the current serialized StringSession. */
  getSessionString(): string {
    return String(this.client.session.save());
  }

  /**
   * Invalidates the server-side session via MTProto `auth.LogOut`. Must be
   * called while connected. After success, the stored StringSession is no
   * longer usable and the caller should delete the local session file.
   */
  async logout(): Promise<void> {
    this.assertConnected();
    await this.client.invoke(new Api.auth.LogOut());
    this.logger.info(
      { event: 'logout', component: 'client' },
      'server-side session invalidated via auth.LogOut',
    );
  }

  /** Sends a plain-text DM. Wraps the GramJS call in withFloodRetry. */
  async sendText(peer: PeerInput, text: string): Promise<SentMessageInfo> {
    this.assertConnected();
    const resolved = await resolvePeer(this.client, peer, this.logger);
    const sent = await withFloodRetry(
      () => this.client.sendMessage(resolved, { message: text }),
      { logger: this.logger, maxAutoWaitSeconds: 60, operation: 'sendText' },
    );
    const info = buildSentInfo(sent, peer);
    this.logger.info(
      {
        event: 'message_sent',
        component: 'client',
        kind: 'text',
        messageId: info.messageId,
        chatId: info.chatId.toString(),
      },
      'message sent',
    );
    return info;
  }

  /**
   * Sends an image as a Telegram photo. `filePath` must be absolute. Raises
   * the standard Node ENOENT error if the file is missing.
   */
  async sendImage(
    peer: PeerInput,
    filePath: string,
    caption?: string,
  ): Promise<SentMessageInfo> {
    this.assertConnected();
    await fs.stat(filePath); // throws ENOENT on missing
    const resolved = await resolvePeer(this.client, peer, this.logger);
    const sent = await withFloodRetry(
      () =>
        this.client.sendFile(resolved, {
          file: filePath,
          forceDocument: false,
          ...(caption !== undefined ? { caption } : {}),
        }),
      { logger: this.logger, maxAutoWaitSeconds: 60, operation: 'sendImage' },
    );
    const info = buildSentInfo(sent, peer);
    this.logger.info(
      {
        event: 'message_sent',
        component: 'client',
        kind: 'photo',
        messageId: info.messageId,
        chatId: info.chatId.toString(),
      },
      'image sent',
    );
    return info;
  }

  /**
   * Sends a file as a Telegram Document (forceDocument: true). GramJS's
   * sendFile preserves the basename in DocumentAttributeFilename by default.
   */
  async sendDocument(
    peer: PeerInput,
    filePath: string,
    caption?: string,
  ): Promise<SentMessageInfo> {
    this.assertConnected();
    await fs.stat(filePath); // throws ENOENT on missing
    const resolved = await resolvePeer(this.client, peer, this.logger);
    const sent = await withFloodRetry(
      () =>
        this.client.sendFile(resolved, {
          file: filePath,
          forceDocument: true,
          ...(caption !== undefined ? { caption } : {}),
        }),
      { logger: this.logger, maxAutoWaitSeconds: 60, operation: 'sendDocument' },
    );
    const info = buildSentInfo(sent, peer);
    this.logger.info(
      {
        event: 'message_sent',
        component: 'client',
        kind: 'document',
        messageId: info.messageId,
        chatId: info.chatId.toString(),
      },
      'document sent',
    );
    return info;
  }

  /** Registers `handler` for incoming messages of `event` kind. */
  on(event: EventName, handler: MessageHandler): void {
    let bucket = this.handlers.get(event);
    if (bucket === undefined) {
      bucket = new Set();
      this.handlers.set(event, bucket);
    }
    bucket.add(handler);
  }

  /** Removes a previously-registered handler. No-op if not registered. */
  off(event: EventName, handler: MessageHandler): void {
    const bucket = this.handlers.get(event);
    if (bucket === undefined) return;
    bucket.delete(handler);
  }

  /**
   * Starts the NewMessage subscription. Idempotent: calling it a second time
   * without a stopListening() in between is a no-op other than updating opts.
   */
  startListening(opts?: ListenOptions): void {
    this.assertConnected();
    this.listenOptions = {
      privateChatsOnly: opts?.privateChatsOnly ?? true,
      autoDownload: opts?.autoDownload ?? true,
    };

    if (this.listening) {
      return;
    }

    const handler = async (event: NewMessageEvent): Promise<void> => {
      if (this.listenOptions.privateChatsOnly && !event.isPrivate) {
        return;
      }
      const dispatch = this.dispatchIncoming(event).finally(() => {
        this.inFlightDispatches.delete(dispatch);
      });
      this.inFlightDispatches.add(dispatch);
    };

    this.boundHandler = handler;
    this.client.addEventHandler(handler, new NewMessage({ incoming: true }));
    this.listening = true;
    this.logger.info(
      { component: 'client', event: 'listening_started' },
      'NewMessage subscription active',
    );
  }

  /**
   * Stops the NewMessage subscription and awaits all in-flight handler
   * dispatches (including any auto-downloads still running).
   */
  async stopListening(): Promise<void> {
    if (!this.listening) {
      return;
    }
    if (this.boundHandler !== null) {
      try {
        this.client.removeEventHandler(
          this.boundHandler,
          new NewMessage({ incoming: true }),
        );
      } catch {
        // GramJS throws if handler isn't registered; safe to ignore.
      }
      this.boundHandler = null;
    }
    this.listening = false;

    const pending = Array.from(this.inFlightDispatches);
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    this.logger.info(
      { component: 'client', event: 'listening_stopped' },
      'NewMessage subscription stopped',
    );
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private assertConnected(): void {
    if (!this.connected) {
      throw new LoginRequiredError(
        'TelegramUserClient not connected. Call connect() or login() first.',
      );
    }
  }

  private async dispatchIncoming(event: NewMessageEvent): Promise<void> {
    const msg = event.message;
    if (msg === undefined || msg === null) {
      return;
    }

    try {
      const media = classifyIncoming(msg);
      const kind: IncomingKind = media.kind;

      let mediaPath: string | null = null;
      if (this.listenOptions.autoDownload) {
        try {
          mediaPath = await downloadIncomingMedia(msg, this.downloadDir, this.client);
          if (mediaPath !== null) {
            this.logger.info(
              {
                event: 'media_downloaded',
                component: 'client',
                kind,
                path: mediaPath,
              },
              'media downloaded',
            );
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.error(
            { component: 'client', kind, err: errMsg },
            'media download failed',
          );
          mediaPath = null;
        }
      }

      const chatIdBig = toBigInt(msg.chatId);
      const senderIdBig = msg.senderId !== undefined && msg.senderId !== null
        ? toBigInt(msg.senderId)
        : null;

      const incoming: IncomingMessage = {
        kind,
        messageId: msg.id,
        chatId: chatIdBig,
        senderId: senderIdBig,
        date: new Date(msg.date * 1000),
        text: (msg.message !== undefined && msg.message !== '') ? msg.message : null,
        mediaPath,
        rawMessage: msg,
      };

      this.logger.info(
        {
          event: 'message_received',
          component: 'client',
          kind,
          messageId: incoming.messageId,
          chatId: incoming.chatId.toString(),
        },
        'message received',
      );

      await this.dispatchToHandlers(kind, incoming);
    } catch (err: unknown) {
      const msgText = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { component: 'client', err: msgText },
        'error while classifying / dispatching incoming message',
      );
    }
  }

  private async dispatchToHandlers(
    kind: IncomingKind,
    incoming: IncomingMessage,
  ): Promise<void> {
    const targets: MessageHandler[] = [];
    const kindBucket = this.handlers.get(kind);
    if (kindBucket !== undefined) targets.push(...kindBucket);
    const anyBucket = this.handlers.get('any');
    if (anyBucket !== undefined) targets.push(...anyBucket);

    for (let i = 0; i < targets.length; i++) {
      const handler = targets[i];
      if (handler === undefined) continue;
      try {
        const result = handler(incoming);
        if (result instanceof Promise) {
          await result;
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          {
            component: 'client',
            kind,
            handlerIndex: i,
            err: errMsg,
          },
          'handler threw — continuing with next handler',
        );
      }
    }
  }
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSentInfo(sent: Api.Message, peer: PeerInput): SentMessageInfo {
  const chatId = toBigInt(sent.chatId);
  return {
    messageId: sent.id,
    date: new Date(sent.date * 1000),
    peer,
    chatId,
  };
}

/**
 * Coerces a GramJS id (which may be `bigInt.BigIntegerImpl` / number / bigint /
 * string) into a native `bigint`. Tolerant of undefined/null (returns 0n).
 */
function toBigInt(v: unknown): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') {
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  }
  // GramJS big-integer library objects implement .toString()
  const asStr =
    typeof (v as { toString?: () => string }).toString === 'function'
      ? (v as { toString: () => string }).toString()
      : '';
  try {
    return BigInt(asStr);
  } catch {
    return 0n;
  }
}

// Silence FloodWaitError-not-used warning — kept imported for type surface
// symmetry with the rest of the facade (users re-export it from index.ts).
export type { FloodWaitError };
