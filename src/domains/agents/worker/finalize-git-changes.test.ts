import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, it } from 'node:test';
import { createGitService } from '../../../services/git-service';
import { excludeWorkspaceInfrastructureFromGit } from '../../../services/opencode-config';
import type { GithubAppService } from '../../../services/github-app';
import type { AgentJob, AppConfig, Repo } from '../../../types';
import { detectWorkspaceChanges, finalizeGitChanges } from './workspace-setup';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Bare `origin` with one commit on `feature`, plus a clone checked out on it. */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-git-'));
  roots.push(root);
  const origin = path.join(root, 'origin.git');
  const workspaceDir = path.join(root, 'workspace');
  git(root, 'init', '--bare', '-b', 'feature', origin);
  git(root, 'clone', origin, workspaceDir);
  git(workspaceDir, 'config', 'user.name', 'Test');
  git(workspaceDir, 'config', 'user.email', 'test@example.com');
  git(workspaceDir, 'config', 'commit.gpgsign', 'false');
  git(workspaceDir, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), 'hello\n');
  git(workspaceDir, 'add', '-A');
  git(workspaceDir, 'commit', '-m', 'initial');
  git(workspaceDir, 'push', '-u', 'origin', 'feature');

  const githubApp = {
    buildAuthenticatedCloneUrl: () => origin,
    getInstallationToken: async () => 'token',
    redactSecrets: (text: string) => text,
  } as unknown as GithubAppService;
  const gitService = createGitService({ githubApp, workspaceRoot: root });

  const logPath = path.join(root, 'worker.log');
  const job = {
    agentId: 'agent1',
    workspaceId: 'ws1',
    repoId: 'acme-demo',
    mode: 'batch',
    prompt: 'goal',
    baseBranch: 'main',
    agentBranch: 'feature',
    commitMessage: 'Agent: feature',
    push: true,
    pushOnFailure: false,
    agentTimeoutMs: 1000,
    dataDir: root,
    workspaceRoot: root,
    workspaceDir,
    logPath,
  } as AgentJob;

  const finalize = () =>
    finalizeGitChanges({
      gitService,
      githubApp,
      config: {} as AppConfig,
      repo: { owner: 'acme', name: 'demo' } as Repo,
      job,
      logPath,
      allowCommit: true,
    });

  return { origin, workspaceDir, gitService, job, finalize, logPath };
}

afterEach(() => {
  while (roots.length) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('finalizeGitChanges — agent-made commits', () => {
  it('pushes commits the agent made itself when nothing is left uncommitted', async () => {
    const t = setup();
    await t.gitService.markRunStart(t.workspaceDir);

    fs.writeFileSync(path.join(t.workspaceDir, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(t.workspaceDir, 'b.txt'), 'b\n');
    git(t.workspaceDir, 'add', '-A');
    git(t.workspaceDir, 'commit', '-m', 'agent did this');
    const agentSha = git(t.workspaceDir, 'rev-parse', 'HEAD');

    const result = await t.finalize();

    assert.equal(result.filesChanged, 2);
    assert.equal(result.commitSha, agentSha);
    assert.equal(result.pushed, true);
    assert.equal(git(t.origin, 'rev-parse', 'feature'), agentSha);
    assert.match(fs.readFileSync(t.logPath, 'utf8'), /Agent created 1 commit\(s\) itself/);
  });

  it('commits leftover changes on top of agent commits and counts both', async () => {
    const t = setup();
    await t.gitService.markRunStart(t.workspaceDir);

    fs.writeFileSync(path.join(t.workspaceDir, 'a.txt'), 'a\n');
    git(t.workspaceDir, 'add', '-A');
    git(t.workspaceDir, 'commit', '-m', 'agent did this');
    fs.writeFileSync(path.join(t.workspaceDir, 'c.txt'), 'c\n');

    const result = await t.finalize();

    assert.equal(result.filesChanged, 2);
    assert.equal(git(t.workspaceDir, 'log', '-1', '--format=%s'), 'Agent: feature');
    assert.equal(git(t.origin, 'rev-parse', 'feature'), result.commitSha);
  });

  it('counts a file the agent committed and then edited again once', async () => {
    const t = setup();
    await t.gitService.markRunStart(t.workspaceDir);

    fs.writeFileSync(path.join(t.workspaceDir, 'a.txt'), 'a\n');
    git(t.workspaceDir, 'add', '-A');
    git(t.workspaceDir, 'commit', '-m', 'agent did this');
    fs.writeFileSync(path.join(t.workspaceDir, 'a.txt'), 'a2\n');

    const result = await t.finalize();

    assert.equal(result.filesChanged, 1);
  });

  it('still reports no changes when the agent neither edited nor committed', async () => {
    const t = setup();
    await t.gitService.markRunStart(t.workspaceDir);

    const result = await t.finalize();

    assert.deepEqual(result, { commitSha: null, pushed: false, filesChanged: 0 });
  });

  it('ignores agent commits whose net diff is empty', async () => {
    const t = setup();
    await t.gitService.markRunStart(t.workspaceDir);

    fs.writeFileSync(path.join(t.workspaceDir, 'a.txt'), 'a\n');
    git(t.workspaceDir, 'add', '-A');
    git(t.workspaceDir, 'commit', '-m', 'add');
    git(t.workspaceDir, 'rm', '-q', 'a.txt');
    git(t.workspaceDir, 'commit', '-m', 'remove');

    const result = await t.finalize();

    assert.equal(result.filesChanged, 0);
    assert.equal(result.pushed, false);
  });

  it('falls back to uncommitted-only detection without a start marker', async () => {
    const t = setup();

    fs.writeFileSync(path.join(t.workspaceDir, 'a.txt'), 'a\n');
    git(t.workspaceDir, 'add', '-A');
    git(t.workspaceDir, 'commit', '-m', 'agent did this');

    const result = await t.finalize();

    assert.equal(result.filesChanged, 0);
  });
});

describe('detectWorkspaceChanges', () => {
  it('counts agent commits and working-tree changes together', async () => {
    const t = setup();
    await t.gitService.markRunStart(t.workspaceDir);

    fs.writeFileSync(path.join(t.workspaceDir, 'a.txt'), 'a\n');
    git(t.workspaceDir, 'add', '-A');
    git(t.workspaceDir, 'commit', '-m', 'agent did this');
    fs.writeFileSync(path.join(t.workspaceDir, 'b.txt'), 'b\n');

    assert.deepEqual(await detectWorkspaceChanges({ job: t.job, gitService: t.gitService }), {
      filesChanged: 2,
      uncommittedFiles: 1,
      agentCommits: 1,
      committedFiles: 1,
    });
  });

  it('does not count an artefact excluded from git, so a write-only turn stays zero-change', async () => {
    const t = setup();
    await t.gitService.markRunStart(t.workspaceDir);
    excludeWorkspaceInfrastructureFromGit(t.workspaceDir);

    fs.mkdirSync(path.join(t.workspaceDir, '.localagent-box', 'artefacts'), { recursive: true });
    fs.writeFileSync(path.join(t.workspaceDir, '.localagent-box', 'artefacts', 'no-change.json'), '{}\n');

    const changes = await detectWorkspaceChanges({ job: t.job, gitService: t.gitService });
    assert.equal(changes.filesChanged, 0);
    assert.match(fs.readFileSync(path.join(t.workspaceDir, '.git', 'info', 'exclude'), 'utf8'), /\.localagent-box\/artefacts\//);
  });
});
