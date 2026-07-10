import http from 'http';
import https from 'https';
import type { IncomingHttpHeaders } from 'http';

export interface WebhookResponse {
  statusCode?: number;
  headers: IncomingHttpHeaders;
}

export interface WebhookOptions {
  headers?: Record<string, string>;
  timeout?: number;
}

export interface WebhookSender {
  sendWebhook: (url: string, data: unknown, options?: WebhookOptions) => Promise<WebhookResponse | undefined>;
}

export function createWebhookSender(deps: {
  http?: typeof http;
  https?: typeof https;
} = {}): WebhookSender {
  const httpImpl = deps.http || http;
  const httpsImpl = deps.https || https;

  function sendWebhook(
    url: string,
    data: unknown,
    options: WebhookOptions = {},
  ): Promise<WebhookResponse | undefined> {
    return new Promise((resolve, reject) => {
      const trimmedUrl = typeof url === 'string' ? url.trim() : '';
      if (!trimmedUrl) {
        resolve(undefined);
        return;
      }

      let parsed: URL;
      try {
        parsed = new URL(trimmedUrl);
      } catch (_err) {
        reject(new Error('Invalid webhook URL'));
        return;
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        reject(new Error('Webhook URL must use http or https'));
        return;
      }

      const buffer = Buffer.from(JSON.stringify(data));
      const transport = parsed.protocol === 'https:' ? httpsImpl : httpImpl;
      const requestOptions: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': buffer.length,
          ...options.headers,
        },
        timeout: options.timeout ?? 10000,
      };

      const req = transport.request(requestOptions, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
          });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Webhook timeout'));
      });
      req.write(buffer);
      req.end();
    });
  }

  return { sendWebhook };
}
