import type { Logger } from 'pino';

export function registerProcessHandlers(logger: Logger): void {
  process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    process.exit(1);
  });

  process.on('uncaughtException', (err: Error) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });
}
