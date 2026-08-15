import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { getServerEnv } from '../../../config/env';
import { CODEGRAPH_BIN } from '../../../services/opencode-config';
import { createRepoService } from '../../repos/repo.service';
import { createJsonStore } from '../../../lib/json-store';
import type { Agent, AgentGitStatus, AgentJob, AppConfig, Repo } from '../../../types';
import type { JsonStore } from '../../../lib/json-store';
import type { GitService } from '../../../services/git-service';
import type { GithubAppService } from '../../../services/github-app';
import { appendLog, readAgentStatus, updateAgentRecord } from './agent-state-writer';
import type { WorkerContext } from './worker-context';
import { getAgentMode } from './worker-context';

const LOCALAGENT_BOX_IGNORE_ENTRY = '.localagent-box/';

export function ensureLocalagentBoxIgnored(workspaceDir: string): void {
  const gitignorePath = path.join(workspaceDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, LOCALAGENT_BOX_IGNORE_ENTRY + '\n', 'utf8');
    return;
  }
  const content = fs.readFileSync(gitignorePath, 'utf8');
  if (!content.includes(LOCALAGENT_BOX_IGNORE_ENTRY)) {
    const prefix = content.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(gitignorePath, content + prefix + LOCALAGENT_BOX_IGNORE_ENTRY + '\n', 'utf8');
  }
}

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

export async function prepareWorkspace(ctx: WorkerContext): Promise<void> {
  const { job, logPath, config, agentsStore, gitService, githubApp } = ctx;

  appendLog(logPath, `Agent worker started for ${job.repoId} (mode=${getAgentMode(job)})`);
  appendLog(logPath, `Workspace: ${job.workspaceDir}`);
  appendLog(logPath, `Base branch: ${job.baseBranch}`);
  appendLog(logPath, `Agent branch: ${job.agentBranch}`);
  if (job.useExistingBranch) {
    appendLog(logPath, 'Using existing branch (no new branch will be created)');
  }

  const currentStatus = readAgentStatus(agentsStore, job.agentId);
  const finishAlreadyRequested =
    getAgentMode(job) === 'interactive' && currentStatus === 'completing';

  updateAgentRecord(agentsStore, job.agentId, {
    ...(finishAlreadyRequested ? {} : { status: 'running' }),
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

  if (job.useExistingBranch) {
    if (job.agentBranch !== job.baseBranch) {
      appendLog(logPath, `Fetching and checking out ${job.agentBranch}…`);
      await gitService.fetchAndCheckoutBranch(job.workspaceDir, job.agentBranch, {
        shallow: !isReview,
      });
    }
    appendLog(logPath, `Checked out existing branch ${job.agentBranch}`);
  } else {
    appendLog(logPath, `Creating branch ${job.agentBranch}…`);
    await gitService.createBranch(job.workspaceDir, job.agentBranch);
    appendLog(logPath, `Branch ${job.agentBranch} checked out`);
  }

  ensureLocalagentBoxIgnored(job.workspaceDir);

  if (getServerEnv().enableCodegraph) {
    await initCodegraph(job.workspaceDir, logPath);
  }
}

const GIT_FILE_KIND_LABEL: Record<AgentGitStatus['files'][number]['kind'], string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  untracked: 'new',
  unknown: 'changed',
};

export async function captureGitStatusCheckpoint({
  gitService,
  workspaceDir,
  logPath,
  agentsStore,
  agentId,
}: {
  gitService: GitService;
  workspaceDir: string;
  logPath: string;
  agentsStore: JsonStore<{ agents: Agent[] }>;
  agentId: string;
}): Promise<void> {
  try {
    const porcelain = await gitService.getPorcelainStatus(workspaceDir);
    const files = gitService.parsePorcelainStatus(porcelain);
    const filesChanged = files.length;
    const gitStatus: AgentGitStatus = {
      filesChanged,
      files,
      updatedAt: new Date().toISOString(),
    };

    updateAgentRecord(agentsStore, agentId, { gitStatus });

    if (filesChanged === 0) {
      appendLog(logPath, 'Checkpoint: no file changes in working tree');
      return;
    }

    appendLog(logPath, `Checkpoint: ${filesChanged} changed file(s) in working tree`);
    for (const file of files) {
      appendLog(logPath, `  ${GIT_FILE_KIND_LABEL[file.kind]}: ${file.path}`);
    }
  } catch (err) {
    appendLog(
      logPath,
      `Checkpoint git status failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * Deterministic, host-generated summary of the current working-tree changes
 * (`git status --short` file list + the `git diff --stat` totals line), truncated
 * to a handful of lines. Injected into the first step of each iteration so the model
 * gets ground truth about what has changed instead of rediscovering it with tool calls.
 * Returns null when the working tree is clean or git fails.
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

  const porcelain = await gitService.getPorcelainStatus(job.workspaceDir);
  const filesChanged = gitService.countChangedFiles(porcelain);

  if (filesChanged === 0) {
    appendLog(logPath, 'No file changes detected after OpenCode run');
    return { commitSha: null, pushed: false, filesChanged: 0 };
  }

  appendLog(logPath, `Committing ${filesChanged} changed file(s)…`);
  const commitSha = await gitService.commitAll(job.workspaceDir, job.commitMessage);
  appendLog(logPath, `Created commit ${commitSha}`);

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
