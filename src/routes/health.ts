import type { IncomingMessage, ServerResponse } from 'http';
import { sendJson } from '../lib/http';
import type { Route, ServerContext } from '../types';

async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const config = ctx.configStore.loadConfig();
  const ollama = await ctx.ollamaProbe.probe(config.ollamaBaseUrl);

  sendJson(res, 200, {
    status: 'ok',
    service: 'localagent-box',
    ollama,
  });
}

const healthRoute: Route = {
  match: (method, pathname) => method === 'GET' && pathname === '/health',
  handle: handleHealth,
};

export default healthRoute;
