import pino from 'pino';
import { getServerEnv } from '../config/env';

let cachedLogger: pino.Logger | null = null;

const REDACT_PATHS = [
  'req.headers.authorization',
  'authorization',
  'githubAppPrivateKey',
  '*.githubAppPrivateKey',
  'apiToken',
  '*.apiToken',
];

export function createBootstrapLogger(): pino.Logger {
  const isProduction = process.env.NODE_ENV === 'production';

  return pino({
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
  });
}

export function createLogger(): pino.Logger {
  const { logLevel } = getServerEnv();

  return pino({
    level: logLevel,
    redact: {
      paths: REDACT_PATHS,
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
