import type { IncomingMessage, ServerResponse } from 'http';
import { sendJson, readJsonBody, requireAuth } from '../lib/http';
import { withErrorHandling } from '../lib/error-handler';
import { maybePopulateBotGitIdentity } from '../lib/github-bot-identity';
import { getLogger } from '../lib/logger';
import type { ConfigPartial, Route, ServerContext } from '../types';
import { CodedError } from '../types';
import { getLoopVerbModelsDefault } from '../services/config-store';
import { sanitizeLoopVerbModels } from '../lib/loop-verb-models';

function isValidHttpUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_err) {
    return false;
  }
}

function assertValidHttpUrl(field: string, value: unknown): void {
  if (value && !isValidHttpUrl(value)) {
    throw new CodedError(`${field} must be a valid http(s) URL`, 'VALIDATION_ERROR');
  }
}

async function handleGetConfig(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const config = ctx.configStore.loadConfig();
  sendJson(res, 200, ctx.configStore.toPublicConfig(config));
}

const handlePutConfig = withErrorHandling(async (req, res, ctx) => {
  const body = await readJsonBody(req);

  assertValidHttpUrl('ollamaBaseUrl', body.ollamaBaseUrl);
  if (
    body.webhookUrl &&
    typeof body.webhookUrl === 'string' &&
    body.webhookUrl.trim()
  ) {
    assertValidHttpUrl('webhookUrl', body.webhookUrl.trim());
  }

  const current = ctx.configStore.loadConfig();
  const partial: ConfigPartial = { ...body } as ConfigPartial;

  if (partial.githubAppPrivateKey === '***') {
    delete partial.githubAppPrivateKey;
  }

  if (partial.githubAppPrivateKey === '' && current.githubAppPrivateKey) {
    delete partial.githubAppPrivateKey;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'loopVerbModels')) {
    partial.loopVerbModels = {
      ...getLoopVerbModelsDefault(),
      ...current.loopVerbModels,
      ...sanitizeLoopVerbModels(body.loopVerbModels),
    };
  }

  const saved = ctx.configStore.saveConfig(partial);
  const withBotIdentity = await maybePopulateBotGitIdentity(saved, ctx.githubApp, {
    onFailure: (err) => {
      getLogger().warn({ err }, 'Failed to auto-populate GitHub App bot git identity');
    },
  });
  const finalConfig =
    withBotIdentity === saved ? saved : ctx.configStore.saveConfig(withBotIdentity);
  let opencode = null;

  if (finalConfig.ollamaBaseUrl) {
    opencode = ctx.opencodeConfig.writeOpenCodeConfig(finalConfig);
  }

  if (finalConfig.gitUserName || finalConfig.gitUserEmail) {
    ctx.gitService.applyGitConfig(finalConfig);
  }

  const ollama = await ctx.ollamaProbe.probe(finalConfig.ollamaBaseUrl);

  sendJson(res, 200, {
    ...ctx.configStore.toPublicConfig(finalConfig),
    ollama,
    opencode: opencode
      ? { path: opencode.path, model: opencode.config.model }
      : null,
  });
});

const configRoute: Route = {
  match: (method, pathname) =>
    pathname === '/api/v1/config' && (method === 'GET' || method === 'PUT'),
  handle: async (req, res, ctx) => {
    if (req.method === 'GET') {
      await handleGetConfig(req, res, ctx);
      return;
    }

    if (!requireAuth(req, res)) {
      return;
    }
    await handlePutConfig(req, res, ctx);
  },
};

export default configRoute;
