import type { IncomingMessage, ServerResponse } from 'http';
import { sendJson, readJsonBody, requireAuth, parseUrl } from '../lib/http';
import { withErrorHandling } from '../lib/error-handler';
import type { Route, ServerContext } from '../types';

function redact(ctx: ServerContext, message: string): string {
  return ctx.githubApp.redactSecrets(message) ?? message;
}

function handleListRepos(_req: IncomingMessage, res: ServerResponse, ctx: ServerContext): void {
  sendJson(res, 200, { repos: ctx.repoManager.listRepos() });
}

const handleGetRepo = withErrorHandling(
  (_req, res, ctx, repoId) => {
    const repo = ctx.repoManager.getRepo(repoId);
    sendJson(res, 200, { repo });
  },
);

const handleRegisterRepo = withErrorHandling(async (req, res, ctx) => {
  const body = await readJsonBody(req);
  const repo = ctx.repoManager.registerRepo({
    owner: body.owner,
    name: body.name,
    defaultBranch: body.defaultBranch,
  });
  sendJson(res, 201, { repo });
});

const handleVerifyRepo = withErrorHandling(
  async (req, res, ctx, repoId) => {
    const body = await readJsonBody(req);
    const config = ctx.configStore.loadConfig();
    ctx.repoManager.validateRepoId(repoId);
    const result = await ctx.repoManager.verifyRepo(config, repoId, body.branch);
    sendJson(res, 200, result);
  },
  { redact: (message, ctx) => redact(ctx, message) },
);

const handleDeleteRepo = withErrorHandling(
  (_req, res, ctx, repoId) => {
    const repo = ctx.repoManager.deleteRepo(repoId);
    sendJson(res, 200, { repo });
  },
);

const reposRoute: Route = {
  match: (_method, pathname) => pathname.startsWith('/api/v1/repos'),
  handle: async (req, res, ctx) => {
    const { pathname } = parseUrl(req);

    const verifyMatch = pathname.match(/^\/api\/v1\/repos\/([^/]+)\/verify$/);
    if (verifyMatch && req.method === 'POST') {
      if (!requireAuth(req, res)) {
        return;
      }
      await handleVerifyRepo(req, res, ctx, verifyMatch[1]);
      return;
    }

    const detailMatch = pathname.match(/^\/api\/v1\/repos\/([^/]+)$/);
    if (detailMatch) {
      const repoId = detailMatch[1];

      if (req.method === 'GET') {
        await handleGetRepo(req, res, ctx, repoId);
        return;
      }

      if (req.method === 'DELETE') {
        if (!requireAuth(req, res)) {
          return;
        }
        await handleDeleteRepo(req, res, ctx, repoId);
        return;
      }
    }

    if (req.method === 'GET' && pathname === '/api/v1/repos') {
      handleListRepos(req, res, ctx);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/repos') {
      if (!requireAuth(req, res)) {
        return;
      }
      await handleRegisterRepo(req, res, ctx);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  },
};

export default reposRoute;
