// src/client/PinoBridgeLogger.ts
//
// Bridges GramJS's internal Logger base class (telegram/extensions/Logger) to
// a pino logger. The goal is to silence GramJS's default stderr output and
// route its warnings/errors through pino with a stable { component: 'gramjs' }
// tag. Pass an instance via TelegramClientParams.baseLogger.

import { Logger as GramLogger, LogLevel } from 'telegram/extensions/Logger.js';
import type { Logger as PinoLogger } from '../logger/logger.js';

export class PinoBridgeLogger extends GramLogger {
  private readonly pino: PinoLogger;

  constructor(pino: PinoLogger, level: LogLevel = LogLevel.WARN) {
    super(level);
    this.pino = pino;
  }

  /**
   * Override. `color` is an ANSI escape sequence for terminal colorization;
   * we discard it since pino handles formatting.
   */
  override log(level: LogLevel, message: string, _color: string): void {
    switch (level) {
      case LogLevel.DEBUG:
        this.pino.debug({ component: 'gramjs' }, message);
        return;
      case LogLevel.INFO:
        this.pino.info({ component: 'gramjs' }, message);
        return;
      case LogLevel.WARN:
        this.pino.warn({ component: 'gramjs' }, message);
        return;
      case LogLevel.ERROR:
        this.pino.error({ component: 'gramjs' }, message);
        return;
      default:
        // LogLevel.NONE — drop.
        return;
    }
  }
}
