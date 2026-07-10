import { buildInteractiveState } from '../../../lib/interactive-state';
import { runSessionOrchestrator } from '../../../integrations/opencode/session-orchestrator';
import {
  appendLog,
  getInboxPath,
  InboxReader,
  updateAgentRecord,
} from './agent-state-writer';
import { resolveAutoApprovePermissions } from './batch-run-flow';
import { finalizeGitChanges } from './workspace-setup';
import type { WorkerContext } from './worker-context';

export async function runInteractiveSession(ctx: WorkerContext): Promise<void> {
  const { job, logPath, config, agentsStore, gitService, githubApp } = ctx;
  const repo = ctx.repo;
  if (!repo) {
    throw new Error('Worker repository is not initialized');
  }

  const inboxReader = new InboxReader(getInboxPath(job));

  const markFinishRequested = () => {
    appendLog(logPath, 'Finish requested — finalizing session');
    updateAgentRecord(agentsStore, job.agentId, {
      status: 'completing',
      interactive: buildInteractiveState('completing'),
    });
  };

  const result = await runSessionOrchestrator({
    mode: 'interactive',
    ctx,
    autoApprovePermissions: resolveAutoApprovePermissions(config, job, 'interactive'),
    pollFinishBeforeStart: () => inboxReader.pollFinishOnly(),
    pollInbox: () => inboxReader.poll(),
    onFinishRequested: markFinishRequested,
  });

  if (result.outcome === 'cancelled' || result.outcome === 'incomplete') {
    return;
  }

  if (result.outcome === 'failed') {
    throw new Error(result.failureMessage || 'OpenCode session failed');
  }

  const gitResult = await finalizeGitChanges({
    gitService,
    githubApp,
    config,
    repo,
    job,
    logPath,
    allowCommit: true,
  });

  const finishedAt = new Date().toISOString();
  if (gitResult.filesChanged === 0) {
    updateAgentRecord(agentsStore, job.agentId, {
      status: 'failed',
      finishedAt,
      error: 'Finish requested but no file changes to commit',
      branch: job.agentBranch,
      filesChanged: 0,
      pushed: false,
    });
    appendLog(logPath, 'Finish failed — no committable changes');
    return;
  }

  updateAgentRecord(agentsStore, job.agentId, {
    status: 'completed',
    finishedAt,
    branch: job.agentBranch,
    commitSha: gitResult.commitSha,
    pushed: gitResult.pushed,
    filesChanged: gitResult.filesChanged,
    error: null,
    result: {
      branch: job.agentBranch,
      baseBranch: job.baseBranch,
      workspaceId: job.workspaceId,
      commitSha: gitResult.commitSha,
      pushed: gitResult.pushed,
      filesChanged: gitResult.filesChanged,
      warning: null,
      opencodeSuccess: true,
    },
  });

  appendLog(
    logPath,
    `Interactive agent completed — ${gitResult.filesChanged} file(s) changed, pushed=${gitResult.pushed}`,
  );
}
