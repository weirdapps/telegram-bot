// src/index.ts
//
// Library barrel — public re-exports.

export { TelegramUserClient } from './client/TelegramUserClient.js';
export type { TelegramUserClientOptions } from './client/TelegramUserClient.js';

export { resolvePeer } from './client/peer.js';
export type { PeerInput } from './client/peer.js';

export { classifyIncoming, downloadIncomingMedia } from './client/media.js';
export type { IncomingKind, IncomingMedia } from './client/media.js';

export { withFloodRetry } from './client/flood.js';
export type { WithFloodRetryOptions } from './client/flood.js';

export { installGracefulShutdown } from './client/shutdown.js';

export { loadConfig } from './config/config.js';
export type { AppConfig } from './config/config.js';

export { createLogger } from './logger/logger.js';
export type { Logger, LogLevel } from './logger/logger.js';

export type {
  IncomingMessage,
  SentMessageInfo,
  LoginCallbacks,
  ListenOptions,
} from './client/events.js';

// Typed error surface.
export {
  ConfigError,
  PeerNotFoundError,
  UnsupportedMediaError,
  LoginRequiredError,
} from './errors.js';

// Re-export GramJS's FloodWaitError so library consumers don't have to
// depend on 'telegram/errors' themselves.
export { FloodWaitError } from 'telegram/errors/index.js';
