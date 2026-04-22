// src/client/events.ts
//
// Public event / payload types consumed by TelegramUserClient.

import type { Api } from 'telegram';
import type { IncomingKind } from './media.js';
import type { PeerInput } from './peer.js';

/** Callbacks used by TelegramUserClient.login for interactive prompts. */
export interface LoginCallbacks {
  /**
   * Resolves to the phone number in international format. Typically returns
   * the value of TELEGRAM_PHONE_NUMBER from AppConfig.
   */
  readonly phoneNumber: () => Promise<string>;

  /** Resolves to the SMS/Telegram login code entered by the user on stdin. */
  readonly phoneCode: () => Promise<string>;

  /**
   * Resolves to the 2FA password when Telegram responds SESSION_PASSWORD_NEEDED.
   * If omitted and 2FA is enabled, the login rejects with LoginRequiredError.
   */
  readonly password?: () => Promise<string>;

  /** Called on any non-terminal error during the login flow. */
  readonly onError?: (e: Error) => void;
}

/** Structured payload for a sent message, returned from sendText/sendImage/sendDocument. */
export interface SentMessageInfo {
  /** The message ID assigned by Telegram. */
  readonly messageId: number;
  /** Server-reported timestamp of the delivered message. */
  readonly date: Date;
  /** The original PeerInput supplied by the caller (round-trip aid). */
  readonly peer: PeerInput;
  /** Resolved Telegram chat ID for the recipient. */
  readonly chatId: bigint;
}

/**
 * Structured payload emitted to message handlers. `chatId`/`senderId` are
 * `bigint` because Telegram IDs can exceed Number.MAX_SAFE_INTEGER for
 * channel/megagroup peers (ADR-005). In v1 the listener is filtered to
 * private chats, but the type does not bake that in.
 */
export interface IncomingMessage {
  readonly kind: IncomingKind;
  readonly messageId: number;
  readonly chatId: bigint;
  readonly senderId: bigint | null;
  readonly date: Date;
  /** Body text for kind="text" (or caption for media). Null when absent. */
  readonly text: string | null;
  /**
   * Absolute file path when the media was auto-downloaded (photo/voice/audio).
   * Null for kind="text"/"document"/"other".
   */
  readonly mediaPath: string | null;
  /** Escape hatch for callers who need the raw GramJS message. */
  readonly rawMessage: Api.Message;
}

/** Options for startListening(). */
export interface ListenOptions {
  /**
   * If true (default), only messages where NewMessageEvent.isPrivate is true
   * are dispatched. Set false to receive events from groups/channels too (v1
   * does NOT guarantee correct classification for non-DM peers — see OOS-02).
   */
  readonly privateChatsOnly?: boolean;

  /**
   * If true (default), incoming photo/voice/audio are auto-downloaded and
   * their absolute path is placed on IncomingMessage.mediaPath. Set false to
   * skip all downloads; mediaPath will be null.
   */
  readonly autoDownload?: boolean;
}

/** The set of event names a handler can subscribe to. */
export type EventName = IncomingKind | 'any';

/** Signature of a message-event handler. May be sync or async. */
export type MessageHandler = (m: IncomingMessage) => void | Promise<void>;
