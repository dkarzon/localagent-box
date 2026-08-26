import type { IncomingMessage, ServerResponse } from 'http';
import { sendJson, readJsonBody, requireAuth, parseUrl } from '../lib/http';
import { withErrorHandling } from '../lib/error-handler';
import { getServerEnv } from '../config/env';
import { listDepCacheEntries, purgeDepCacheEntries } from '../domains/agents/worker/dep-cache';
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

/** Lists the repo's dependency cache entries (P3-T5). */
const handleListDepCache = withErrorHandling((_req, res, ctx, repoId) => {
  // Resolving the repo doubles as existence validation and as the safety
  // net for path construction (unknown / malformed ids are rejected here).
  ctx.repoManager.getRepo(repoId);
  const cacheRoot = getServerEnv().depCacheRoot;
  const listing = listDepCacheEntries(cacheRoot, repoId);
  if (listing.error) {
    throw new Error('Failed to inspect the dependency cache');
  }
  sendJson(res, 200, { repoId, entries: listing.entries });
});

/** Purges one dependency cache entry (`?key=`) or all of a repo's entries (P3-T5). */
const handlePurgeDepCache = withErrorHandling(async (req, res, ctx, repoId) => {
  // Resolving the repo doubles as existence validation and as the safety
  // net for path construction (unknown / malformed ids are rejected here).
  ctx.repoManager.getRepo(repoId);
  const cacheRoot = getServerEnv().depCacheRoot;
  const url = parseUrl(req);
  const key = url.searchParams.get('key') ?? undefined;
  const result = purgeDepCacheEntries(cacheRoot, repoId, key);
  sendJson(res, 200, { repoId, existed: result.existed, removed: result.removed });
});

const handleUpdateRepo = withErrorHandling(async (req, res, ctx, repoId) => {
  const body = await readJsonBody(req);
  const updates: { autoReviewPullRequests?: boolean | null } = {};
  if (Object.prototype.hasOwnProperty.call(body, 'autoReviewPullRequests')) {
    if (body.autoReviewPullRequests === null) {
      updates.autoReviewPullRequests = null;
    } else if (typeof body.autoReviewPullRequests === 'boolean') {
      updates.autoReviewPullRequests = body.autoReviewPullRequests;
    }
  }
  const repo = ctx.repoManager.updateRepo(repoId, updates);
  sendJson(res, 200, { repo });
});

const reposRoute: Route = {
  match: (_method, pathname) => pathname.startsWith('/api/v1/repos'),
  handle: async (req, res, ctx) => {
    const { pathname } = parseUrl(req);

    const depCacheMatch = pathname.match(/^\/api\/v1\/repos\/([^/]+)\/dep-cache$/);
    if (depCacheMatch) {
      const repoId = depCacheMatch[1];
      if (req.method === 'GET') {
        await handleListDepCache(req, res, ctx, repoId);
        return;
      }
      if (req.method === 'DELETE') {
        if (!requireAuth(req, res)) {
          return;
        }
        await handlePurgeDepCache(req, res, ctx, repoId);
        return;
      }
    }

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

      if (req.method === 'PUT') {
        if (!requireAuth(req, res)) {
          return;
        }
        await handleUpdateRepo(req, res, ctx, repoId);
        return;
      }

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
