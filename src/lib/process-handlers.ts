import type { Logger } from 'pino';

export interface ProcessHandlerOptions {
  /** Exit on uncaught exceptions. Default false for long-running servers. */
  exitOnUncaughtException?: boolean;
  /** Exit on unhandled promise rejections. Default false for long-running servers. */
  exitOnUnhandledRejection?: boolean;
}

let registered = false;

export function formatErrorForLog(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      err,
      errName: err.name,
      errMessage: err.message,
      errStack: err.stack,
    };
  }

  if (typeof err === 'object' && err !== null) {
    return {
      err,
      errType: err.constructor?.name ?? 'object',
      errValue: String(err),
    };
  }

  return {
    err,
    errType: typeof err,
    errValue: String(err),
  };
}

export function registerProcessHandlers(
  logger: Logger,
  options: ProcessHandlerOptions = {},
): void {
  if (registered) {
    return;
  }
  registered = true;

  const exitOnUncaught = options.exitOnUncaughtException ?? false;
  const exitOnRejection = options.exitOnUnhandledRejection ?? false;

  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    logger.error(
      {
        ...formatErrorForLog(reason),
        promise: String(promise),
      },
      'Unhandled promise rejection',
    );

    if (exitOnRejection) {
      logger.fatal('Exiting after unhandled promise rejection');
      process.exit(1);
    }
  });

  process.on('uncaughtException', (err: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
    logger.fatal(
      {
        ...formatErrorForLog(err),
        origin,
      },
      'Uncaught exception',
    );

    if (exitOnUncaught) {
      logger.fatal('Exiting after uncaught exception');
      process.exit(1);
    }
  });

  process.on('warning', (warning: Error) => {
    logger.warn(
      {
        errName: warning.name,
        errMessage: warning.message,
        errStack: warning.stack,
      },
      'Process warning',
    );
  });
}

/** @internal Test helper */
export function resetProcessHandlersForTests(): void {
  registered = false;
}
