import type { ServerResponse } from 'http';

export function initSseResponse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

export function writeSseEvent(
  res: ServerResponse,
  id: string | number,
  data: unknown,
  event?: string,
): void {
  if (event) {
    res.write(`event: ${event}\n`);
  }
  res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function parseSinceSeq(req: { headers: Record<string, string | string[] | undefined> }, url: URL): number {
  const sinceParam = url.searchParams.get('since');
  if (sinceParam) {
    const parsed = parseInt(sinceParam, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  const lastEventId = req.headers['last-event-id'];
  if (lastEventId) {
    const raw = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return 0;
}
