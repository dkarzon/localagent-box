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
  }) => Promise<void>;
  verifyClone: (
    config: AppConfig,
    params: { owner: string; name: string; branch: string },
  ) => Promise<{ ok: boolean; owner: string; name: string; branch: string; message: string }>;
  createBranch: (targetDir: string, branchName: string) => Promise<void>;
  getPorcelainStatus: (targetDir: string) => Promise<string>;
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
}

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
  }: {
    owner: string;
    name: string;
    branch: string;
    targetDir: string;
    token: string;
  }): Promise<void> {
    const cloneUrl = githubApp.buildAuthenticatedCloneUrl(owner, name, token);
    const args = [
      'clone',
      '--depth',
      '1',
      '--single-branch',
      '--branch',
      branch,
      cloneUrl,
      targetDir,
    ];

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
    getPorcelainStatus,
    parsePorcelainStatus,
    countChangedFiles,
    commitAll,
    pushBranch,
    getCommitDiff,
  };
}
