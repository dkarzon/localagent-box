import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { getServerEnv } from '../../../config/env';
import { CODEGRAPH_BIN } from '../../../services/opencode-config';
import { createRepoService } from '../../repos/repo.service';
import { createJsonStore } from '../../../lib/json-store';
import type { AgentJob, AppConfig, Repo } from '../../../types';
import type { GitService } from '../../../services/git-service';
import type { GithubAppService } from '../../../services/github-app';
import { appendLog, updateAgentRecord } from './agent-state-writer';
import { runWorkspaceBootstrap } from './workspace-bootstrap';
import type { WorkerContext } from './worker-context';
import { getAgentMode } from './worker-context';

const execFileAsync = promisify(execFile);
const CODEGRAPH_INIT_TIMEOUT_MS = 180_000;

/**
 * `codegraph serve --mcp` expects a `.codegraph/` index — without this post-clone
 * `init` its explore tool has nothing to query. Failures are non-fatal: the agent
 * still runs, just without graph context.
 */
export async function initCodegraph(
  workspaceDir: string,
  logPath: string,
  execFileAsyncImpl: typeof execFileAsync = execFileAsync,
): Promise<boolean> {
  appendLog(logPath, 'Building codegraph index…');
  try {
    const startedAt = Date.now();
    // `init` creates `.codegraph/` and builds the full graph in one step.
    await execFileAsyncImpl(CODEGRAPH_BIN, ['init'], {
      cwd: workspaceDir,
      timeout: CODEGRAPH_INIT_TIMEOUT_MS,
      env: { ...process.env, CODEGRAPH_TELEMETRY: '0' },
    });
    appendLog(
      logPath,
      `codegraph index built in ${Math.round((Date.now() - startedAt) / 1000)}s`,
    );
    return true;
  } catch (err) {
    appendLog(
      logPath,
      `codegraph init failed — agent continues without graph context (${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }
}

export async function checkoutJobBranch(
  gitService: Pick<GitService, 'remoteBranchExists' | 'fetchAndCheckoutBranch' | 'createBranch'>,
  job: Pick<AgentJob, 'workspaceDir' | 'baseBranch' | 'agentBranch'>,
  options: { shallow: boolean; logPath: string },
): Promise<'cloned' | 'fetched' | 'created'> {
  const { workspaceDir, baseBranch, agentBranch } = job;
  const { shallow, logPath } = options;

  if (agentBranch === baseBranch) {
    appendLog(logPath, `Checked out existing branch ${agentBranch}`);
    return 'cloned';
  }

  const exists = await gitService.remoteBranchExists(workspaceDir, agentBranch);
  if (exists) {
    appendLog(logPath, `Fetching and checking out ${agentBranch}…`);
    await gitService.fetchAndCheckoutBranch(workspaceDir, agentBranch, { shallow });
    appendLog(logPath, `Checked out existing branch ${agentBranch}`);
    return 'fetched';
  }

  appendLog(logPath, `Creating branch ${agentBranch}…`);
  await gitService.createBranch(workspaceDir, agentBranch);
  appendLog(logPath, `Branch ${agentBranch} checked out`);
  return 'created';
}

export async function prepareWorkspace(ctx: WorkerContext): Promise<void> {
  const { job, logPath, config, agentsStore, gitService, githubApp } = ctx;

  appendLog(logPath, `Agent worker started for ${job.repoId} (mode=${getAgentMode(job)})`);
  appendLog(logPath, `Workspace: ${job.workspaceDir}`);
  appendLog(logPath, `Base branch: ${job.baseBranch}`);
  appendLog(logPath, `Agent branch: ${job.agentBranch}`);

  updateAgentRecord(agentsStore, job.agentId, {
    status: 'running',
    startedAt: new Date().toISOString(),
  });

  fs.mkdirSync(path.dirname(job.workspaceDir), { recursive: true });
  if (fs.existsSync(job.workspaceDir)) {
    fs.rmSync(job.workspaceDir, { recursive: true, force: true });
  }

  const isReview = getAgentMode(job) === 'review';
  appendLog(logPath, `Cloning repository @ ${job.baseBranch}…`);
  const repoManager = createRepoService({
    reposStore: createJsonStore<{ repos: Repo[] }>(`${job.dataDir}/repos.json`, { repos: [] }, fs),
    githubApp,
    gitService,
  });
  const cloneResult = await repoManager.cloneToWorkspace(
    config,
    job.repoId,
    job.workspaceDir,
    job.baseBranch,
    { fullHistory: isReview },
  );
  ctx.repo = cloneResult.repo;
  appendLog(logPath, `Cloned ${ctx.repo.owner}/${ctx.repo.name} @ ${cloneResult.branch}`);

  await checkoutJobBranch(gitService, job, { shallow: !isReview, logPath });

  // Remember where this run started so finalizeGitChanges can detect commits
  // the agent made itself (e.g. `git commit` via its shell tool).
  try {
    await gitService.markRunStart(job.workspaceDir);
  } catch (err) {
    appendLog(
      logPath,
      `Could not record run start commit — agent-made commits will not be detected (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (isReview && config.ocrSkipWorkspaceBootstrap === true) {
    appendLog(logPath, 'Workspace bootstrap skipped: ocrSkipWorkspaceBootstrap is enabled for review runs');
  } else {
    await runWorkspaceBootstrap({
      workspaceDir: job.workspaceDir,
      logPath,
      agentId: job.agentId,
      agentsStore,
      config,
      // Mode filter (P4-T3): honor setup.runOnModes for this run.
      mode: getAgentMode(job),
      // Dependency cache (P3-T4): persist node_modules across runs when the
      // operator opts in (DEP_CACHE_ENABLED / depCacheEnabled under dataDir).
      depCache: getServerEnv().depCacheEnabled
        ? { root: getServerEnv().depCacheRoot, repoId: job.repoId }
        : undefined,
    });
  }

  if (getServerEnv().enableCodegraph) {
    await initCodegraph(job.workspaceDir, logPath);
  }
}

/**
 * Deterministic, host-generated summary of the current working-tree changes
 * (`git status --short` file list + the `git diff --stat` totals line), truncated
 * to a handful of lines. Injected into the first step of each iteration so the model
 * gets ground truth about what has changed instead of rediscovering it with tool calls.
 * Returns null when the working tree is clean or git fails.
 *
 * Kept as prior art for the planned Phase 1.5 escalation content
 * (`docs/plans/v1.plan.md`, section 1.5), even though no caller remains now that the
 * interactive/loop paths are gone. Those removals also took the git-status checkpoint
 * with them, so nothing writes `Agent.gitStatus` any more and the `AgentGitStatus` panel
 * plus `GET /api/v1/agents/:id/git-status` serve pre-v1 legacy records only.
 */
export async function buildHostChangeSummary({
  gitService,
  workspaceDir,
  logPath,
}: {
  gitService: GitService;
  workspaceDir: string;
  logPath: string;
}): Promise<string | null> {
  const MAX_STATUS_LINES = 15;
  try {
    const [porcelain, diffStat] = await Promise.all([
      gitService.getPorcelainStatus(workspaceDir),
      gitService.getDiffStat(workspaceDir),
    ]);
    const statusLines = porcelain
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean);
    if (statusLines.length === 0) {
      return null;
    }

    const body = statusLines.slice(0, MAX_STATUS_LINES);
    if (statusLines.length > MAX_STATUS_LINES) {
      body.push(`… (${statusLines.length - MAX_STATUS_LINES} more files)`);
    }

    // Last line of `git diff --stat` is the "N files changed, …" totals summary.
    const diffLines = diffStat.split('\n').map((line) => line.trim()).filter(Boolean);
    const totals = diffLines[diffLines.length - 1];
    if (totals && /\bchanged\b/.test(totals)) {
      body.push(totals);
    }

    return `## Changes so far (host-generated)\n${body.join('\n')}`;
  } catch (err) {
    appendLog(
      logPath,
      `Host change summary failed (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

/** What the host counts as this run's work, before anything is committed. */
export interface WorkspaceChanges {
  filesChanged: number;
  /** Working-tree changes still to be committed. */
  uncommittedFiles: number;
  /** Commits the agent made itself since the run started. */
  agentCommits: number;
  /** Files those commits changed; an empty commit counts as none. */
  committedFiles: number;
}

/**
 * Read-only change detection, shared by the completion gate (v1 1.3) and the commit
 * step. Agent commits count even when the working tree is clean, because the agent
 * may have committed through its shell tool.
 */
export async function detectWorkspaceChanges(
  ctx: Pick<WorkerContext, 'job' | 'gitService'>,
): Promise<WorkspaceChanges> {
  const porcelain = await ctx.gitService.getPorcelainStatus(ctx.job.workspaceDir);
  const uncommittedFiles = ctx.gitService.countChangedFiles(porcelain);
  // Null when the start marker is missing (workspaces prepared before it existed).
  const agentCommits = await ctx.gitService.getCommitsSinceRunStart(ctx.job.workspaceDir);
  const committedFiles = agentCommits?.filesChanged ?? 0;

  return {
    filesChanged: committedFiles + uncommittedFiles,
    uncommittedFiles,
    agentCommits: agentCommits?.commits ?? 0,
    committedFiles,
  };
}

export async function finalizeGitChanges({
  gitService,
  githubApp,
  config,
  repo,
  job,
  logPath,
  allowCommit,
}: {
  gitService: GitService;
  githubApp: GithubAppService;
  config: AppConfig;
  repo: Repo;
  job: AgentJob;
  logPath: string;
  allowCommit: boolean;
}): Promise<{ commitSha: string | null; pushed: boolean; filesChanged: number }> {
  if (!allowCommit) {
    return { commitSha: null, pushed: false, filesChanged: 0 };
  }

  const changes = await detectWorkspaceChanges({ job, gitService });

  if (changes.filesChanged === 0) {
    appendLog(logPath, 'No file changes detected after OpenCode run');
    return { commitSha: null, pushed: false, filesChanged: 0 };
  }

  if (changes.agentCommits > 0 && changes.committedFiles > 0) {
    appendLog(
      logPath,
      `Agent created ${changes.agentCommits} commit(s) itself (${changes.committedFiles} file(s) changed)`,
    );
  }

  let commitSha: string | null;
  if (changes.uncommittedFiles > 0) {
    appendLog(logPath, `Committing ${changes.uncommittedFiles} changed file(s)…`);
    commitSha = await gitService.commitAll(job.workspaceDir, job.commitMessage);
    appendLog(logPath, `Created commit ${commitSha}`);
  } else {
    commitSha = await gitService.getHeadSha(job.workspaceDir);
    appendLog(logPath, `No uncommitted changes; using agent commit ${commitSha ?? '(unknown)'}`);
  }

  // Files changed across the whole run (agent commits + our commit): `commitAll`
  // commits exactly the uncommitted files, so the pre-commit count already holds.
  const filesChanged = changes.filesChanged;

  let pushed = false;
  if (job.push) {
    appendLog(logPath, `Pushing branch ${job.agentBranch} to origin…`);
    const token = await githubApp.getInstallationToken(config, true);
    await gitService.pushBranch(job.workspaceDir, job.agentBranch, {
      owner: repo.owner,
      name: repo.name,
      token,
    });
    pushed = true;
    appendLog(logPath, 'Push completed');
  } else {
    appendLog(logPath, 'Push skipped (push=false)');
  }

  return { commitSha, pushed, filesChanged };
}
