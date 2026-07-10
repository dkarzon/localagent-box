import type { IncomingMessage, ServerResponse } from 'http';
import { sendJson, readJsonBody, requireAuth, parseUrl } from '../lib/http';
import { parseSinceSeq } from '../lib/sse';
import { withErrorHandling } from '../lib/error-handler';
import { parsePositiveInt } from '../lib/parse';
import { CodedError } from '../types';
import { handleAgentEvents } from '../entrypoints/http/sse/agent-events';
import {
  toCreateAgentResponse,
  parseCreatePullRequestOptions,
  type CreateAgentRequest,
} from '../domains/agents/dto';
import type { Route, ServerContext } from '../types';

function redact(ctx: ServerContext, message: string): string {
  return ctx.githubApp.redactSecrets(message) ?? message;
}

const secretRedact = { redact: (message: string, ctx: ServerContext) => redact(ctx, message) };

function handleListAgents(req: IncomingMessage, res: ServerResponse, ctx: ServerContext): void {
  const url = new URL(req.url || '/', 'http://localhost');
  const agents = ctx.agentManager.listAgents({
    repoId: url.searchParams.get('repoId') || undefined,
    status: url.searchParams.get('status') || undefined,
  });
  const overallTokenUsage = agents.reduce(
    (acc, agent) => {
      if (agent.tokenUsage) {
        acc.inputTokens += agent.tokenUsage.inputTokens;
        acc.outputTokens += agent.tokenUsage.outputTokens;
        acc.cacheReadTokens += agent.tokenUsage.cacheReadTokens ?? 0;
        acc.cacheWriteTokens += agent.tokenUsage.cacheWriteTokens ?? 0;
        acc.cost += agent.tokenUsage.cost ?? 0;
      }
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
  );
  sendJson(res, 200, { agents, overallTokenUsage });
}

const handleGetAgent = withErrorHandling((_req, res, ctx, agentId) => {
  const agent = ctx.agentManager.getAgent(agentId);
  sendJson(res, 200, { agent });
});

const handleGetGitStatus = withErrorHandling((_req, res, ctx, agentId) => {
  const agent = ctx.agentManager.getAgent(agentId);
  const gitStatus = agent.gitStatus;
  sendJson(res, 200, {
    filesChanged: gitStatus?.filesChanged ?? 0,
    files: gitStatus?.files ?? [],
    updatedAt: gitStatus?.updatedAt ?? null,
  });
});

const handleGetLogs = withErrorHandling((req, res, ctx, agentId) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const tailParam = url.searchParams.get('tail');
  const tail = tailParam ? parseInt(tailParam, 10) : 200;
  const agent = ctx.agentManager.getAgent(agentId);
  const { logs } = ctx.agentManager.readLogs(agentId, Number.isFinite(tail) ? tail : 200);
  sendJson(res, 200, {
    agentId: agent.agentId,
    workspaceId: agent.workspaceId,
    status: agent.status,
    logs,
  });
});

const handleGetMessages = withErrorHandling((req, res, ctx, agentId) => {
  const sinceSeq = parseSinceSeq(req, parseUrl(req));
  const messages = ctx.agentManager.readMessages(agentId);
  const lastEventSeq = ctx.agentManager.getLastEventSeq(agentId);
  const events = ctx.agentManager.readEvents(agentId, sinceSeq);
  sendJson(res, 200, { agentId, messages, lastEventSeq, events });
});

const handleCreateAgent = withErrorHandling(async (req, res, ctx) => {
  const body = await readJsonBody(req);
  const agent = ctx.agentManager.createAgent(body as unknown as CreateAgentRequest);
  sendJson(res, 201, toCreateAgentResponse(agent));
}, secretRedact);

const handleSendMessage = withErrorHandling(async (req, res, ctx, agentId) => {
  const body = await readJsonBody(req);
  const agent = ctx.agentManager.sendMessage(agentId, body.text);
  sendJson(res, 200, { agent });
});

const handleFinishAgent = withErrorHandling(async (_req, res, ctx, agentId) => {
  const agent = ctx.agentManager.finishAgent(agentId);
  sendJson(res, 200, { agent });
});

const handleCommitOutstanding = withErrorHandling(async (_req, res, ctx, agentId) => {
  const agent = await ctx.agentManager.commitOutstandingChanges(agentId);
  sendJson(res, 200, { agent });
}, secretRedact);

const handleCancelAgent = withErrorHandling((_req, res, ctx, agentId) => {
  const agent = ctx.agentManager.cancelAgent(agentId);
  sendJson(res, 200, { agent });
});

const handleDeleteAgent = withErrorHandling((_req, res, ctx, agentId) => {
  ctx.agentManager.deleteAgent(agentId);
  sendJson(res, 200, { deleted: true, agentId });
});

const handleCleanupOldWorkspaces = withErrorHandling(async (req, res, ctx) => {
  const body = await readJsonBody(req);
  const daysToKeep = parsePositiveInt(body.daysToKeep, 0);
  if (daysToKeep < 1) {
    throw new CodedError('daysToKeep must be at least 1', 'VALIDATION_ERROR');
  }
  const result = ctx.agentManager.cleanupOldWorkspaces(daysToKeep);
  sendJson(res, 200, result);
});

const handleCreatePullRequest = withErrorHandling(async (req, res, ctx, agentId) => {
  const body = await readJsonBody(req);
  const agent = await ctx.agentManager.createPullRequest(agentId, parseCreatePullRequestOptions(body));
  sendJson(res, 201, { agent, pullRequest: agent.pullRequest });
}, secretRedact);

const handleRefreshPullRequest = withErrorHandling(async (_req, res, ctx, agentId) => {
  const agent = await ctx.agentManager.refreshPullRequest(agentId);
  sendJson(res, 200, { agent, pullRequest: agent.pullRequest });
}, secretRedact);

const agentsRoute: Route = {
  match: (_method, pathname) => pathname.startsWith('/api/v1/agents'),
  handle: async (req, res, ctx) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;

    if (req.method === 'GET' && pathname === '/api/v1/agents') {
      handleListAgents(req, res, ctx);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/agents') {
      if (!requireAuth(req, res)) {
        return;
      }
      await handleCreateAgent(req, res, ctx);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/agents/cleanup') {
      if (!requireAuth(req, res)) {
        return;
      }
      await handleCleanupOldWorkspaces(req, res, ctx);
      return;
    }

    const gitStatusMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/git-status$/);
    if (gitStatusMatch && req.method === 'GET') {
      await handleGetGitStatus(req, res, ctx, gitStatusMatch[1]);
      return;
    }

    const logsMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/logs$/);
    if (logsMatch && req.method === 'GET') {
      await handleGetLogs(req, res, ctx, logsMatch[1]);
      return;
    }

    const messagesMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/messages$/);
    if (messagesMatch && req.method === 'GET') {
      await handleGetMessages(req, res, ctx, messagesMatch[1]);
      return;
    }

    if (messagesMatch && req.method === 'POST') {
      if (!requireAuth(req, res)) {
        return;
      }
      await handleSendMessage(req, res, ctx, messagesMatch[1]);
      return;
    }

    const eventsMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/events$/);
    if (eventsMatch && req.method === 'GET') {
      handleAgentEvents(req, res, ctx, eventsMatch[1]);
      return;
    }

    const finishMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/finish$/);
    if (finishMatch && req.method === 'POST') {
      if (!requireAuth(req, res)) {
        return;
      }
      await handleFinishAgent(req, res, ctx, finishMatch[1]);
      return;
    }

    const commitOutstandingMatch = pathname.match(
      /^\/api\/v1\/agents\/([^/]+)\/commit-outstanding$/,
    );
    if (commitOutstandingMatch && req.method === 'POST') {
      if (!requireAuth(req, res)) {
        return;
      }
      await handleCommitOutstanding(req, res, ctx, commitOutstandingMatch[1]);
      return;
    }

    const pullRequestMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/pull-request$/);
    if (pullRequestMatch) {
      const agentId = pullRequestMatch[1];
      if (req.method === 'POST') {
        if (!requireAuth(req, res)) {
          return;
        }
        await handleCreatePullRequest(req, res, ctx, agentId);
        return;
      }
      if (req.method === 'GET') {
        await handleRefreshPullRequest(req, res, ctx, agentId);
        return;
      }
    }

    const deleteMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/delete$/);
    if (deleteMatch && req.method === 'POST') {
      if (!requireAuth(req, res)) {
        return;
      }
      await handleDeleteAgent(req, res, ctx, deleteMatch[1]);
      return;
    }

    const detailMatch = pathname.match(/^\/api\/v1\/agents\/([^/]+)$/);
    if (detailMatch) {
      const agentId = detailMatch[1];

      if (req.method === 'GET') {
        await handleGetAgent(req, res, ctx, agentId);
        return;
      }

      if (req.method === 'DELETE') {
        if (!requireAuth(req, res)) {
          return;
        }
        await handleCancelAgent(req, res, ctx, agentId);
        return;
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  },
};

export default agentsRoute;
