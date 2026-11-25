import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { AppConfig } from '../types';
import type { GitChangedFile, GitFileChangeKind } from '../types/git-file-change';
import type { GithubAppService } from './github-app';

export type { GitChangedFile, GitFileChangeKind } from '../types/git-file-change';

export const CLONE_TIMEOUT_MS = 300000;

export interface GitService {
  applyGitConfig: (config: AppConfig) => void;
  shallowClone: (params: {
    owner: string;
    name: string;
    branch: string;
    targetDir: string;
    token: string;
    fullHistory?: boolean;
  }) => Promise<void>;
  verifyClone: (
    config: AppConfig,
    params: { owner: string; name: string; branch: string },
  ) => Promise<{ ok: boolean; owner: string; name: string; branch: string; message: string }>;
  createBranch: (targetDir: string, branchName: string) => Promise<void>;
  fetchAndCheckoutBranch: (
    targetDir: string,
    branchName: string,
    options?: { shallow?: boolean },
  ) => Promise<void>;
  /** True when `origin` advertises `refs/heads/<branchName>` (ls-remote). */
  remoteBranchExists: (targetDir: string, branchName: string) => Promise<boolean>;
  /**
   * Make `refs/remotes/origin/<branchName>` readable. A `--single-branch` clone
   * has no remote ref for another branch, so it is fetched at depth 1 when
   * missing. Never throws: when the ref cannot be made available the caller is
   * told and the run proceeds without that branch's config.
   */
  ensureRemoteRef: (
    targetDir: string,
    branchName: string,
  ) => Promise<{ available: boolean; fetched: boolean; message?: string }>;
  getPorcelainStatus: (targetDir: string) => Promise<string>;
  /** `git diff --stat <baseRef>` (default HEAD) — deterministic working-tree change summary; '' on failure. */
  getDiffStat: (targetDir: string, baseRef?: string) => Promise<string>;
  parsePorcelainStatus: (porcelain: string) => GitChangedFile[];
  countChangedFiles: (porcelain: string) => number;
  commitAll: (targetDir: string, message: string) => Promise<string>;
  pushBranch: (
    targetDir: string,
    branchName: string,
    params: { owner: string; name: string; token: string },
  ) => Promise<void>;
  getCommitDiff: (
    targetDir: string,
    commitSha: string,
    options?: { maxPatchChars?: number },
  ) => Promise<{ stat: string; patch: string } | null>;
  /**
   * Record the current HEAD as the run's starting point (local-only ref
   * `refs/localagent-box/start`, never pushed).
   */
  markRunStart: (targetDir: string) => Promise<void>;
  /** Current HEAD sha, or null when it cannot be resolved. */
  getHeadSha: (targetDir: string) => Promise<string | null>;
  /**
   * Commits on HEAD since `markRunStart`, e.g. ones the agent made itself via
   * shell. Null when no start marker exists (or git fails).
   */
  getCommitsSinceRunStart: (
    targetDir: string,
  ) => Promise<{ commits: number; filesChanged: number } | null>;
}

export const RUN_START_REF = 'refs/localagent-box/start';

type FsLike = Pick<typeof fs, 'mkdirSync' | 'existsSync' | 'rmSync'>;
type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export function createGitService(options: {
  fs?: FsLike;
  path?: typeof path;
  execFile?: typeof execFile;
  execFileSync?: typeof execFileSync;
  execFileAsync?: ExecFileAsync;
  workspaceRoot?: string;
  githubApp: GithubAppService;
}): GitService {
  const fsImpl = options.fs || fs;
  const pathImpl = options.path || path;
  const execFileImpl = options.execFile || execFile;
  const execFileSyncImpl = options.execFileSync || execFileSync;
  const execFileAsyncImpl = options.execFileAsync || promisify(execFileImpl);
  const workspaceRoot = options.workspaceRoot || '/workspace/agents';
  const githubApp = options.githubApp;

  function applyGitConfig(config: AppConfig): void {
    if (config.gitUserName) {
      execFileSyncImpl('git', ['config', '--global', 'user.name', config.gitUserName]);
    }
    if (config.gitUserEmail) {
      execFileSyncImpl('git', ['config', '--global', 'user.email', config.gitUserEmail]);
    }
    execFileSyncImpl('git', ['config', '--global', 'credential.helper', '']);
  }

  async function shallowClone({
    owner,
    name,
    branch,
    targetDir,
    token,
    fullHistory = false,
  }: {
    owner: string;
    name: string;
    branch: string;
    targetDir: string;
    token: string;
    fullHistory?: boolean;
  }): Promise<void> {
    const cloneUrl = githubApp.buildAuthenticatedCloneUrl(owner, name, token);
    const args = ['clone', '--branch', branch, cloneUrl, targetDir];
    if (!fullHistory) {
      args.splice(1, 0, '--depth', '1', '--single-branch');
    }

    try {
      await execFileAsyncImpl('git', args, {
        timeout: CLONE_TIMEOUT_MS,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
    } catch (err) {
      const execErr = err as { stderr?: string; message?: string };
      const message = githubApp.redactSecrets(
        execErr.stderr || execErr.message || 'Git clone failed',
      );
      throw new Error(message || 'Git clone failed');
    }
  }

  async function verifyClone(
    config: AppConfig,
    { owner, name, branch }: { owner: string; name: string; branch: string },
  ) {
    githubApp.assertConfigured(config);
    const token = await githubApp.getInstallationToken(config);
    const workspaceId = `verify-${crypto.randomUUID()}`;
    const targetDir = pathImpl.join(workspaceRoot, workspaceId);

    fsImpl.mkdirSync(workspaceRoot, { recursive: true });
    if (fsImpl.existsSync(targetDir)) {
      fsImpl.rmSync(targetDir, { recursive: true, force: true });
    }

    try {
      await shallowClone({ owner, name, branch, targetDir, token });
      return {
        ok: true,
        owner,
        name,
        branch,
        message: 'Successfully cloned repository using GitHub App credentials',
      };
    } finally {
      if (fsImpl.existsSync(targetDir)) {
        fsImpl.rmSync(targetDir, { recursive: true, force: true });
      }
    }
  }

  async function createBranch(targetDir: string, branchName: string): Promise<void> {
    try {
      await execFileAsyncImpl('git', ['checkout', '-b', branchName], {
        cwd: targetDir,
        timeout: 60000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
    } catch (err) {
      const execErr = err as { stderr?: string; message?: string };
      const message = githubApp.redactSecrets(
        execErr.stderr || execErr.message || 'Git branch creation failed',
      );
      throw new Error(message || 'Git branch creation failed');
    }
  }

  async function fetchAndCheckoutBranch(
    targetDir: string,
    branchName: string,
    options?: { shallow?: boolean },
  ): Promise<void> {
    const gitEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    };
    const fetchArgs = ['fetch', 'origin', `${branchName}:refs/heads/${branchName}`];
    if (options?.shallow !== false) {
      fetchArgs.push('--depth', '1');
    }
    try {
      await execFileAsyncImpl(
        'git',
        fetchArgs,
        {
          cwd: targetDir,
          timeout: CLONE_TIMEOUT_MS,
          env: gitEnv,
        },
      );
      await execFileAsyncImpl('git', ['checkout', branchName], {
        cwd: targetDir,
        timeout: 60000,
        env: gitEnv,
      });
    } catch (err) {
      const execErr = err as { stderr?: string; message?: string };
      const message = githubApp.redactSecrets(
        execErr.stderr || execErr.message || 'Git fetch/checkout failed',
      );
      throw new Error(message || 'Git fetch/checkout failed');
    }
  }

  async function remoteBranchExists(targetDir: string, branchName: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsyncImpl(
        'git',
        ['ls-remote', '--heads', 'origin', branchName],
        {
          cwd: targetDir,
          timeout: CLONE_TIMEOUT_MS,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
          },
        },
      );
      return stdout.trim().length > 0;
    } catch (err) {
      const execErr = err as { stderr?: string; message?: string };
      const message = githubApp.redactSecrets(
        execErr.stderr || execErr.message || 'Git ls-remote failed',
      );
      throw new Error(message || 'Git ls-remote failed');
    }
  }

  async function ensureRemoteRef(targetDir: string, branchName: string) {
    const ref = `refs/remotes/origin/${branchName}`;
    const env = gitEnv();

    try {
      await execFileAsyncImpl('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        cwd: targetDir,
        timeout: 60000,
        env,
      });
      return { available: true, fetched: false };
    } catch {
      // The single-branch clone does not have it; fetch it shallowly.
    }

    try {
      await execFileAsyncImpl('git', ['fetch', '--depth', '1', 'origin', `${branchName}:${ref}`], {
        cwd: targetDir,
        timeout: CLONE_TIMEOUT_MS,
        env,
      });
      return { available: true, fetched: true };
    } catch (err) {
      const execErr = err as { stderr?: string; message?: string };
      const message = githubApp.redactSecrets(
        execErr.stderr || execErr.message || 'Git fetch failed',
      );
      return { available: false, fetched: false, message: message || 'Git fetch failed' };
    }
  }

  async function getPorcelainStatus(targetDir: string): Promise<string> {
    const { stdout } = await execFileAsyncImpl('git', ['status', '--porcelain'], {
      cwd: targetDir,
      timeout: 60000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return stdout.trimEnd();
  }

  async function getDiffStat(targetDir: string, baseRef = 'HEAD'): Promise<string> {
    try {
      const { stdout } = await execFileAsyncImpl('git', ['diff', '--stat', baseRef], {
        cwd: targetDir,
        timeout: 60000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      return stdout.trimEnd();
    } catch {
      return '';
    }
  }

  function countChangedFiles(porcelain: string): number {
    if (!porcelain) {
      return 0;
    }
    return porcelain.split('\n').filter((line) => line.trim()).length;
  }

  function classifyPorcelainCode(code: string): GitFileChangeKind {
    if (code === '??') {
      return 'untracked';
    }
    const chars = code.replace(/ /g, '');
    if (chars.includes('R')) {
      return 'renamed';
    }
    if (chars.includes('C')) {
      return 'copied';
    }
    if (chars.includes('A')) {
      return 'added';
    }
    if (chars.includes('D')) {
      return 'deleted';
    }
    if (chars.includes('M') || chars.includes('U')) {
      return 'modified';
    }
    return 'unknown';
  }

  function parsePorcelainPath(code: string, rawPath: string): string {
    if (code.includes('R') || code.includes('C')) {
      const arrow = rawPath.indexOf(' -> ');
      if (arrow !== -1) {
        return rawPath.slice(arrow + 4);
      }
    }
    return rawPath;
  }

  function parsePorcelainStatus(porcelain: string): GitChangedFile[] {
    if (!porcelain.trim()) {
      return [];
    }
    return porcelain
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const statusCode = line.slice(0, 2);
        const rawPath = line.slice(3).trim();
        return {
          path: parsePorcelainPath(statusCode, rawPath),
          kind: classifyPorcelainCode(statusCode),
          statusCode,
        };
      });
  }

  async function commitAll(targetDir: string, message: string): Promise<string> {
    try {
      await execFileAsyncImpl('git', ['add', '-A'], {
        cwd: targetDir,
        timeout: 120000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      await execFileAsyncImpl('git', ['commit', '-m', message], {
        cwd: targetDir,
        timeout: 120000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      const { stdout } = await execFileAsyncImpl('git', ['rev-parse', 'HEAD'], {
        cwd: targetDir,
        timeout: 60000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      return stdout.trim();
    } catch (err) {
      const execErr = err as { stderr?: string; message?: string };
      const messageText = githubApp.redactSecrets(
        execErr.stderr || execErr.message || 'Git commit failed',
      );
      throw new Error(messageText || 'Git commit failed');
    }
  }

  function gitEnv(): NodeJS.ProcessEnv {
    return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  }

  async function markRunStart(targetDir: string): Promise<void> {
    await execFileAsyncImpl('git', ['update-ref', RUN_START_REF, 'HEAD'], {
      cwd: targetDir,
      timeout: 60000,
      env: gitEnv(),
    });
  }

  async function getHeadSha(targetDir: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsyncImpl('git', ['rev-parse', 'HEAD'], {
        cwd: targetDir,
        timeout: 60000,
        env: gitEnv(),
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async function getCommitsSinceRunStart(
    targetDir: string,
  ): Promise<{ commits: number; filesChanged: number } | null> {
    try {
      const { stdout: count } = await execFileAsyncImpl(
        'git',
        ['rev-list', '--count', `${RUN_START_REF}..HEAD`],
        { cwd: targetDir, timeout: 60000, env: gitEnv() },
      );
      const commits = Number.parseInt(count.trim(), 10) || 0;
      if (commits === 0) {
        return { commits: 0, filesChanged: 0 };
      }
      const { stdout: names } = await execFileAsyncImpl(
        'git',
        ['diff', '--name-only', RUN_START_REF, 'HEAD'],
        { cwd: targetDir, timeout: 60000, env: gitEnv() },
      );
      const filesChanged = names
        .split('\n')
        .filter((line) => line.trim()).length;
      return { commits, filesChanged };
    } catch {
      return null;
    }
  }

  async function pushBranch(
    targetDir: string,
    branchName: string,
    { owner, name, token }: { owner: string; name: string; token: string },
  ): Promise<void> {
    const remoteUrl = githubApp.buildAuthenticatedCloneUrl(owner, name, token);
    try {
      await execFileAsyncImpl('git', ['remote', 'set-url', 'origin', remoteUrl], {
        cwd: targetDir,
        timeout: 60000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
      await execFileAsyncImpl('git', ['push', '-u', 'origin', branchName], {
        cwd: targetDir,
        timeout: CLONE_TIMEOUT_MS,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
    } catch (err) {
      const execErr = err as { stderr?: string; message?: string };
      const message = githubApp.redactSecrets(execErr.stderr || execErr.message || 'Git push failed');
      throw new Error(message || 'Git push failed');
    }
  }

  async function getCommitDiff(
    targetDir: string,
    commitSha: string,
    options: { maxPatchChars?: number } = {},
  ): Promise<{ stat: string; patch: string } | null> {
    const maxPatchChars = options.maxPatchChars ?? 12_000;
    const gitEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    };

    try {
      const [{ stdout: stat }, { stdout: patchRaw }] = await Promise.all([
        execFileAsyncImpl('git', ['show', '--stat', '--format=', commitSha], {
          cwd: targetDir,
          timeout: 60_000,
          env: gitEnv,
        }),
        execFileAsyncImpl('git', ['show', commitSha, '--no-color', '-U3'], {
          cwd: targetDir,
          timeout: 60_000,
          env: gitEnv,
        }),
      ]);

      let patch = patchRaw.trimEnd();
      if (patch.length > maxPatchChars) {
        patch = `${patch.slice(0, maxPatchChars)}\n\n[diff truncated]`;
      }

      return {
        stat: stat.trimEnd(),
        patch,
      };
    } catch {
      return null;
    }
  }

  return {
    applyGitConfig,
    shallowClone,
    verifyClone,
    createBranch,
    fetchAndCheckoutBranch,
    remoteBranchExists,
    ensureRemoteRef,
    getPorcelainStatus,
    getDiffStat,
    parsePorcelainStatus,
    countChangedFiles,
    commitAll,
    markRunStart,
    getHeadSha,
    getCommitsSinceRunStart,
    pushBranch,
    getCommitDiff,
  };
}
