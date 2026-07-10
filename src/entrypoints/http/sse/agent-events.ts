import type { IncomingMessage, ServerResponse } from 'http';
import { handleRouteError } from '../../../lib/error-handler';
import { initSseResponse, writeSseEvent, parseSinceSeq } from '../../../lib/sse';
import { parseUrl } from '../../../lib/http';
import { TERMINAL_STATUSES } from '../../../domains/agents/agent.types';
import type { ServerContext } from '../../../types';

export function handleAgentEvents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
  agentId: string,
): void {
  try {
    ctx.agentManager.getAgent(agentId);
    const sinceSeq = parseSinceSeq(req, parseUrl(req));
    const initialEvents = ctx.agentManager.readEvents(agentId, sinceSeq);
    let currentSeq = sinceSeq;

    initSseResponse(res);

    for (const event of initialEvents) {
      writeSseEvent(res, event.seq, event);
      currentSeq = event.seq;
    }

    let closed = false;
    req.on('close', () => {
      closed = true;
      clearInterval(interval);
    });

    const interval = setInterval(() => {
      if (closed || res.writableEnded) {
        clearInterval(interval);
        return;
      }

      try {
        const newEvents = ctx.agentManager.readEvents(agentId, currentSeq);
        for (const event of newEvents) {
          writeSseEvent(res, event.seq, event);
          currentSeq = event.seq;
        }

        const agent = ctx.agentManager.getAgent(agentId);
        if (TERMINAL_STATUSES.has(agent.status)) {
          clearInterval(interval);
          setTimeout(() => {
            if (!res.writableEnded) {
              res.end();
            }
          }, 1500);
        }
      } catch {
        clearInterval(interval);
        if (!res.writableEnded) {
          res.end();
        }
      }
    }, 400);
  } catch (err) {
    handleRouteError(res, err);
  }
}
