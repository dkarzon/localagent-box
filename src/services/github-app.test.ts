import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  createGithubAppService,
  formatBotGitIdentity,
  needsBotGitIdentity,
} from './github-app';
import { DEFAULT_CONFIG } from './config-store';
import type { AppConfig } from '../types';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const config: AppConfig = {
  ...DEFAULT_CONFIG,
  githubAppId: '1',
  githubAppInstallationId: '2',
  githubAppPrivateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
};

describe('formatBotGitIdentity', () => {
  it('builds the GitHub App bot noreply email from slug and bot user id', () => {
    assert.deepEqual(formatBotGitIdentity('localagent-box', 123456789), {
      gitUserName: 'localagent-box[bot]',
      gitUserEmail: '123456789+localagent-box[bot]@users.noreply.github.com',
    });
  });
});

describe('needsBotGitIdentity', () => {
  it('is true when app credentials exist and git author fields are blank', () => {
    assert.equal(needsBotGitIdentity(config), true);
    assert.equal(
      needsBotGitIdentity({
        ...DEFAULT_CONFIG,
        githubAppId: '',
      }),
      false,
    );
  });

  it('is false when either git author field is set', () => {
    assert.equal(
      needsBotGitIdentity({
        ...config,
        gitUserName: 'me',
        gitUserEmail: '',
      }),
      false,
    );
    assert.equal(
      needsBotGitIdentity({
        ...config,
        gitUserName: '',
        gitUserEmail: 'me@example.com',
      }),
      false,
    );
  });
});

describe('createGithubAppService', () => {
  it('resolves bot git identity from app slug and bot user id', async () => {
    const githubApp = createGithubAppService({
      fetchImpl: async (url) => {
        const path = String(url).replace('https://api.github.com', '');
        if (path === '/app') {
          return {
            ok: true,
            json: async () => ({ slug: 'localagent-box' }),
          } as Response;
        }
        if (path === '/users/localagent-box%5Bbot%5D') {
          return {
            ok: true,
            json: async () => ({ id: 987654321 }),
          } as Response;
        }
        return {
          ok: false,
          json: async () => ({ message: `unexpected path ${path}` }),
        } as Response;
      },
    });

    const identity = await githubApp.resolveBotGitIdentity(config);
    assert.deepEqual(identity, {
      gitUserName: 'localagent-box[bot]',
      gitUserEmail: '987654321+localagent-box[bot]@users.noreply.github.com',
    });
  });

  it('posts pull request reviews with line comments', async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const githubApp = createGithubAppService({
      fetchImpl: async (url, init) => {
        const path = String(url).replace('https://api.github.com', '');
        if (path.includes('/access_tokens')) {
          return {
            ok: true,
            json: async () => ({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600000).toISOString() }),
          } as Response;
        }

        requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });

        if (path.endsWith('/reviews')) {
          return {
            ok: true,
            json: async () => ({ id: 99, html_url: 'https://github.com/o/r/pull/1#review-99' }),
          } as Response;
        }

        return {
          ok: false,
          json: async () => ({ message: `unexpected path ${path}` }),
        } as Response;
      },
    });

    await githubApp.createPullRequestReview(config, 'owner', 'repo', 1, {
      body: '## Summary',
      event: 'COMMENT',
      comments: [
        {
          path: 'src/foo.ts',
          body: 'Issue found.',
          line: 10,
          start_line: 8,
        },
      ],
    });

    const reviewRequest = requests.find((request) => request.path.endsWith('/reviews'));
    assert.ok(reviewRequest);
    const reviewBody = reviewRequest.body as {
      body: string;
      comments: Array<Record<string, unknown>>;
    };
    assert.equal(reviewBody.body, '## Summary');
    assert.deepEqual(reviewBody.comments, [
      {
        path: 'src/foo.ts',
        body: 'Issue found.',
        line: 10,
        start_line: 8,
      },
    ]);
  });

  it('posts file-level pull request review comments', async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const githubApp = createGithubAppService({
      fetchImpl: async (url, init) => {
        const path = String(url).replace('https://api.github.com', '');
        if (path.includes('/access_tokens')) {
          return {
            ok: true,
            json: async () => ({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600000).toISOString() }),
          } as Response;
        }

        requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });

        if (path.endsWith('/comments')) {
          return {
            ok: true,
            json: async () => ({ id: 42, html_url: 'https://github.com/o/r/pull/1#discussion_r42' }),
          } as Response;
        }

        return {
          ok: false,
          json: async () => ({ message: `unexpected path ${path}` }),
        } as Response;
      },
    });

    await githubApp.createPullRequestReviewComment(config, 'owner', 'repo', 1, {
      commit_id: 'abc123',
      path: 'src/bar.ts',
      body: 'File-level issue.',
      subject_type: 'file',
    });

    const commentRequest = requests.find((request) => request.path.endsWith('/comments'));
    assert.ok(commentRequest);
    assert.deepEqual(commentRequest.body, {
      commit_id: 'abc123',
      path: 'src/bar.ts',
      body: 'File-level issue.',
      subject_type: 'file',
    });
  });
});
