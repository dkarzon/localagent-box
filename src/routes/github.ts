import type { IncomingMessage, ServerResponse } from 'http';
import { sendJson, readJsonBody, requireAuth, parseUrl } from '../lib/http';
import { withErrorHandling } from '../lib/error-handler';
import { validateOwner, validateRepoName, validateBranchName } from '../lib/validation';
import type { Route, ServerContext } from '../types';

function redact(ctx: ServerContext, message: string): string {
  return ctx.githubApp.redactSecrets(message) ?? message;
}

async function handleStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const config = ctx.configStore.loadConfig();
  sendJson(res, 200, ctx.githubApp.getCredentialSummary(config));
}

const handleVerify = withErrorHandling(async (req, res, ctx) => {
  const body = await readJsonBody(req);
  const owner = validateOwner(body.owner);
  const name = validateRepoName(body.name);
  const branch = validateBranchName(body.branch || 'main');
  const config = ctx.configStore.loadConfig();
  const result = await ctx.gitService.verifyClone(config, { owner, name, branch });
  sendJson(res, 200, result);
}, { redact: (message, ctx) => redact(ctx, message) });

const handleListBranches = withErrorHandling(async (req, res, ctx) => {
  const { searchParams } = parseUrl(req);
  const owner = validateOwner(searchParams.get('owner'));
  const name = validateRepoName(searchParams.get('name'));
  const config = ctx.configStore.loadConfig();
  const branches = await ctx.githubApp.fetchRepositoryBranches(config, owner, name);
  sendJson(res, 200, { branches });
}, { redact: (message, ctx) => redact(ctx, message) });

const githubRoute: Route = {
  match: (_method, pathname) => pathname.startsWith('/api/v1/github'),
  handle: async (req, res, ctx) => {
    const { pathname } = parseUrl(req);

    if (req.method === 'GET' && pathname === '/api/v1/github/status') {
      await handleStatus(req, res, ctx);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/github/verify') {
      if (!requireAuth(req, res)) {
        return;
      }
      await handleVerify(req, res, ctx);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/github/branches') {
      if (!requireAuth(req, res)) {
        return;
      }
      await handleListBranches(req, res, ctx);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  },
};

export default githubRoute;
