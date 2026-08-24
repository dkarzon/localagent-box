import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GithubAppService } from './github-app';
import { createGitService } from './git-service';

const stubGithubApp: GithubAppService = {
  assertConfigured: () => {},
  getCredentialSummary: () => ({
    configured: false,
    githubAppId: '',
    githubAppInstallationId: '',
    hasPrivateKey: false,
    gitUserConfigured: false,
  }),
  getInstallationToken: async () => '',
  buildAuthenticatedCloneUrl: () => '',
  createPullRequest: async () => {
    throw new Error('not implemented');
  },
  fetchRepositoryBranches: async () => [],
  getPullRequest: async () => {
    throw new Error('not implemented');
  },
  findPullRequestByHead: async () => null,
  createPullRequestReview: async () => ({ id: '1', html_url: 'https://example.com/review/1' }),
  createPullRequestReviewComment: async () => ({ id: '2', html_url: 'https://example.com/review/comment/2' }),
  redactSecrets: (text) => text,
  createAppJwt: () => '',
  normalizePrivateKey: (key) => key,
  resolveBotGitIdentity: async () => ({
    gitUserName: 'test[bot]',
    gitUserEmail: '1+test[bot]@users.noreply.github.com',
  }),
};

describe('getPorcelainStatus', () => {
  it('preserves leading space on work-tree-only first line', async () => {
    const gitService = createGitService({
      githubApp: stubGithubApp,
      execFileAsync: async () => ({
        stdout: ' M src/app.ts\n',
        stderr: '',
      }),
    });
    const porcelain = await gitService.getPorcelainStatus('/repo');
    assert.equal(porcelain, ' M src/app.ts');
  });
});

describe('parsePorcelainStatus', () => {
  const gitService = createGitService({ githubApp: stubGithubApp });

  it('parses work-tree-only modified file on first line', () => {
    const files = gitService.parsePorcelainStatus(' M src/app.ts');
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'src/app.ts');
    assert.equal(files[0].kind, 'modified');
    assert.equal(files[0].statusCode, ' M');
  });

  it('parses work-tree-only deleted file on first line', () => {
    const files = gitService.parsePorcelainStatus(' D src/removed.ts');
    assert.equal(files[0].path, 'src/removed.ts');
    assert.equal(files[0].kind, 'deleted');
  });

  it('parses multiple lines including work-tree-only first line', () => {
    const files = gitService.parsePorcelainStatus(' M src/app.ts\n?? untracked.txt');
    assert.deepEqual(
      files.map((f) => ({ path: f.path, kind: f.kind })),
      [
        { path: 'src/app.ts', kind: 'modified' },
        { path: 'untracked.txt', kind: 'untracked' },
      ],
    );
  });

  it('uses destination path for renames', () => {
    const files = gitService.parsePorcelainStatus('R  old.ts -> new.ts');
    assert.equal(files[0].path, 'new.ts');
    assert.equal(files[0].kind, 'renamed');
  });
});

describe('remoteBranchExists', () => {
  it('is true when ls-remote returns a ref', async () => {
    const calls: { file: string; args: readonly string[]; cwd?: string }[] = [];
    const gitService = createGitService({
      githubApp: stubGithubApp,
      execFileAsync: async (file, args, options) => {
        calls.push({ file, args, cwd: options.cwd });
        return {
          stdout: 'abc123\trefs/heads/feature/project\n',
          stderr: '',
        };
      },
    });

    assert.equal(await gitService.remoteBranchExists('/workspace/agent', 'feature/project'), true);
    assert.deepEqual(calls[0], {
      file: 'git',
      args: ['ls-remote', '--heads', 'origin', 'feature/project'],
      cwd: '/workspace/agent',
    });
  });

  it('is false when ls-remote returns empty', async () => {
    const gitService = createGitService({
      githubApp: stubGithubApp,
      execFileAsync: async () => ({ stdout: '', stderr: '' }),
    });
    assert.equal(await gitService.remoteBranchExists('/workspace/agent', 'feature/missing'), false);
  });
});
