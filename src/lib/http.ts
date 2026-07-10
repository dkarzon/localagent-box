import type { IncomingMessage, ServerResponse } from 'http';
import { getServerEnv } from '../config/env';
import { getApiToken } from './auth';
import { CodedError } from '../types';

export function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendText(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function readBody(req: IncomingMessage, maxBytes?: number): Promise<string> {
  const limit = maxBytes ?? getServerEnv().maxBodyBytes;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const tryResolve = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const tryReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > limit) {
        req.destroy();
        tryReject(new CodedError('Request body too large', 'PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => tryResolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', tryReject);
  });
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);

  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new CodedError('Invalid JSON body', 'INVALID_JSON');
  }
}

export function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url || '/', 'http://localhost');
}

export function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const token = getApiToken();
  const header = req.headers.authorization || '';

  if (header === `Bearer ${token}`) {
    return true;
  }

  sendJson(res, 401, { error: 'Unauthorized' });
  return false;
}

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
