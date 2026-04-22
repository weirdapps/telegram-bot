// src/client/buildClient.ts
//
// Internal helper — constructs a GramJS TelegramClient with the project's
// standard options and wires the pino-backed logger bridge (Coder B's
// PinoBridgeLogger). Not part of the public surface.

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import type { Logger as GramJsLogger } from 'telegram/extensions/Logger.js';
import { PinoBridgeLogger } from './PinoBridgeLogger.js';
import type { Logger } from '../logger/logger.js';

export interface BuildClientOptions {
  readonly apiId: number;
  readonly apiHash: string;
  readonly sessionString: string;
  readonly logger: Logger;
  /** See ADR-008 — default 5 s. */
  readonly floodSleepThreshold?: number;
  /** GramJS initial-connection retry budget. Default 10. */
  readonly connectionRetries?: number;
}

/**
 * Builds a configured TelegramClient. Does NOT connect; caller invokes
 * `.connect()` / `.start()` as appropriate.
 */
export function buildTelegramClient(opts: BuildClientOptions): TelegramClient {
  const session = new StringSession(opts.sessionString);

  const bridge = new PinoBridgeLogger(opts.logger);

  const client = new TelegramClient(session, opts.apiId, opts.apiHash, {
    connectionRetries: opts.connectionRetries ?? 10,
    reconnectRetries: Infinity,
    retryDelay: 2000,
    autoReconnect: true,
    floodSleepThreshold: opts.floodSleepThreshold ?? 5,
    requestRetries: 3,
    useWSS: false,
    baseLogger: bridge as unknown as GramJsLogger,
  });

  return client;
}
