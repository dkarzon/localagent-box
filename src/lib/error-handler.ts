import type { IncomingMessage, ServerResponse } from 'http';
import { sendJson } from './http';
import { getLogger } from './logger';
import { getErrorCode, getErrorMessage } from '../types';
import type { ServerContext } from '../types';

const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  PR_NOT_FOUND: 404,
  DUPLICATE: 409,
  BRANCH_IN_USE: 409,
  NOT_INTERACTIVE: 409,
  NOT_ACTIVE: 409,
  NOT_READY: 409,
  PR_EXISTS: 409,
  PR_NOT_READY: 409,
  UNAUTHORIZED: 401,
  PAYLOAD_TOO_LARGE: 413,
  VALIDATION_ERROR: 400,
  INVALID_JSON: 400,
};

export interface RouteErrorOptions {
  ctx?: ServerContext;
  redact?: (message: string, ctx: ServerContext) => string;
}

export function httpStatusForError(err: unknown): number {
  const code = getErrorCode(err);
  if (code) {
    return STATUS_BY_CODE[code] ?? 400;
  }
  if (err instanceof Error) {
    return 500;
  }
  return 500;
}

export function handleRouteError(
  res: ServerResponse,
  err: unknown,
  options: RouteErrorOptions = {},
): void {
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }

  const status = httpStatusForError(err);
  let message = getErrorMessage(err);

  if (status >= 500) {
    getLogger().error({ err }, 'Unhandled route error');
    message = 'Internal server error';
  } else if (options.redact && options.ctx) {
    message = options.redact(message, options.ctx);
  }

  sendJson(res, status, { error: message });
}

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
  ...args: string[]
) => void | Promise<void>;

export function withErrorHandling(
  handler: RouteHandler,
  options: RouteErrorOptions = {},
): RouteHandler {
  return async (req, res, ctx, ...args) => {
    try {
      await handler(req, res, ctx, ...args);
    } catch (err) {
      handleRouteError(res, err, { ...options, ctx });
    }
  };
}
