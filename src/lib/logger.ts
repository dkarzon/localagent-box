import pino from 'pino';
import { getServerEnv } from '../config/env';

let cachedLogger: pino.Logger | null = null;

export function createLogger(): pino.Logger {
  const { logLevel } = getServerEnv();

  return pino({
    level: logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'authorization',
        'githubAppPrivateKey',
        '*.githubAppPrivateKey',
        'apiToken',
        '*.apiToken',
      ],
      censor: '[REDACTED]',
    },
  });
}

export function getLogger(): pino.Logger {
  if (!cachedLogger) {
    cachedLogger = createLogger();
  }
  return cachedLogger;
}

/** @internal Test helper */
export function resetLoggerCache(): void {
  cachedLogger = null;
}
