// src/client/shutdown.ts
//
// Graceful SIGINT/SIGTERM handling for TelegramUserClient. Uses the
// design-doc ADR-009 recipe: client.stopListening() → client.disconnect()
// (which internally calls GramJS client.destroy()) → 500 ms settle window →
// process.exit(0). Post-disconnect races from gramjs#243 / #615 are
// suppressed.

import type { Logger } from '../logger/logger.js';
import type { TelegramUserClient } from './TelegramUserClient.js';

const SETTLE_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExpectedPostDisconnectError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Cannot send requests while disconnected') ||
    msg.includes('TIMEOUT') ||
    msg.includes('disconnected')
  );
}

/**
 * Installs once-only SIGINT and SIGTERM handlers that gracefully shut down
 * the given TelegramUserClient.
 *
 * Returns an uninstaller that removes the signal handlers (useful for tests).
 */
export function installGracefulShutdown(client: TelegramUserClient, logger: Logger): () => void {
  let shutdownInProgress = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownInProgress) {
      logger.warn(
        { event: 'shutdown_signal', signal },
        'Shutdown already in progress — ignoring duplicate signal',
      );
      return;
    }
    shutdownInProgress = true;

    logger.info(
      { event: 'shutdown_signal', signal },
      'Received shutdown signal — starting graceful shutdown',
    );

    // Step 1: stop the listener (drains in-flight downloads).
    try {
      await client.stopListening();
    } catch (err) {
      logger.error(
        { err, event: 'shutdown_signal' },
        'Error while stopping listener — continuing with disconnect',
      );
    }

    // Step 2: disconnect (the facade uses client.destroy() internally).
    try {
      await client.disconnect();
    } catch (err) {
      if (isExpectedPostDisconnectError(err)) {
        logger.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Expected post-disconnect error during shutdown (gramjs#243) — suppressing',
        );
      } else {
        logger.error({ err }, 'Unexpected error during disconnect()');
      }
    }

    // Step 3: settle window — absorb any in-flight ping.
    await sleep(SETTLE_MS);

    logger.info({ event: 'shutdown_complete' }, 'Shutdown complete — exiting');
    process.exit(0);
  };

  const sigintHandler = (): void => {
    shutdown('SIGINT').catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Fatal error during shutdown:', err);
      process.exit(1);
    });
  };
  const sigtermHandler = (): void => {
    shutdown('SIGTERM').catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Fatal error during shutdown:', err);
      process.exit(1);
    });
  };

  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);

  logger.debug('Graceful shutdown handlers installed (SIGINT, SIGTERM)');

  // Uninstaller — removes both handlers. process.once already auto-removes
  // after firing, but calling removeListener is safe either way.
  return (): void => {
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
  };
}
