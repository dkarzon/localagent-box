import type { IncomingMessage, ServerResponse } from 'http';
import {
  isProviderConfigured,
  providerNotConfiguredMessage,
  resolveProviderHost,
} from '../lib/llm-provider';
import { sendJson } from '../lib/http';
import type { LlmProviderId, OllamaProbeResult, Route, ServerContext } from '../types';
import { LLM_PROVIDER_IDS } from '../types';

async function probeProvider(
  ctx: ServerContext,
  config: ReturnType<ServerContext['configStore']['loadConfig']>,
  id: LlmProviderId,
): Promise<OllamaProbeResult> {
  const notConfiguredMessage = providerNotConfiguredMessage(id);
  if (!isProviderConfigured(config, id)) {
    return ctx.ollamaProbe.probe({ notConfiguredMessage });
  }

  const host = resolveProviderHost(config, id);
  return ctx.ollamaProbe.probe({
    baseUrl: host.baseUrl,
    apiKey: host.apiKey,
    notConfiguredMessage,
  });
}

async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const config = ctx.configStore.loadConfig();
  const entries = await Promise.all(
    LLM_PROVIDER_IDS.map(async (id) => [id, await probeProvider(ctx, config, id)] as const),
  );
  const providers = Object.fromEntries(entries) as Record<LlmProviderId, OllamaProbeResult>;
  const ollama = providers.ollama;

  sendJson(res, 200, {
    status: 'ok',
    service: 'localagent-box',
    ollama,
    providers,
  });
}

const healthRoute: Route = {
  match: (method, pathname) => method === 'GET' && pathname === '/health',
  handle: handleHealth,
};

export default healthRoute;
