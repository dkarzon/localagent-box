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

  it('lists comments belonging to a submitted review', async () => {
    const githubApp = createGithubAppService({
      fetchImpl: async (url) => {
        const path = String(url).replace('https://api.github.com', '');
        if (path.includes('/access_tokens')) {
          return {
            ok: true,
            json: async () => ({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600000).toISOString() }),
          } as Response;
        }

        if (path.endsWith('/reviews/99/comments')) {
          return {
            ok: true,
            json: async () => [
              {
                id: 7,
                html_url: 'https://github.com/o/r/pull/1#discussion_r7',
                path: 'src/a.ts',
                line: 10,
                start_line: 8,
              },
              { id: 8, html_url: 'https://github.com/o/r/pull/1#discussion_r8', path: 'src/b.ts' },
            ],
          } as Response;
        }

        return {
          ok: false,
          json: async () => ({ message: `unexpected path ${path}` }),
        } as Response;
      },
    });

    const comments = await githubApp.listPullRequestReviewComments(config, 'owner', 'repo', 1, '99');
    assert.deepEqual(comments, [
      {
        id: 7,
        html_url: 'https://github.com/o/r/pull/1#discussion_r7',
        path: 'src/a.ts',
        line: 10,
        start_line: 8,
      },
      {
        id: 8,
        html_url: 'https://github.com/o/r/pull/1#discussion_r8',
        path: 'src/b.ts',
        line: null,
        start_line: null,
      },
    ]);
  });

  it('finds the thread containing a comment database ID', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const githubApp = createGithubAppService({
      fetchImpl: async (url, init) => {
        const path = String(url).replace('https://api.github.com', '');
        if (path.includes('/access_tokens')) {
          return {
            ok: true,
            json: async () => ({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600000).toISOString() }),
          } as Response;
        }

        if (path === '/graphql') {
          bodies.push(JSON.parse(String(init?.body)));
          return {
            ok: true,
            json: async () => ({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          id: 'thread-other',
                          isResolved: false,
                          comments: { nodes: [{ databaseId: 1 }] },
                        },
                        {
                          id: 'thread-mine',
                          isResolved: false,
                          comments: { nodes: [{ databaseId: 41 }, { databaseId: 42 }] },
                        },
                      ],
                    },
                  },
                },
              },
            }),
          } as Response;
        }

        return {
          ok: false,
          json: async () => ({ message: `unexpected path ${path}` }),
        } as Response;
      },
    });

    const result = await githubApp.findReviewThreadIdForComment(config, 'owner', 'repo', 1, 42);
    assert.deepEqual(result, { threadId: 'thread-mine', isResolved: false });
    assert.equal(bodies.length, 1);
    const firstBody = bodies[0] as { variables: { cursor: string | null } };
    assert.equal(firstBody.variables.cursor, null);
  });

  it('paginates review threads until the matching comment is found', async () => {
    let page = 0;
    const githubApp = createGithubAppService({
      fetchImpl: async (url, init) => {
        const path = String(url).replace('https://api.github.com', '');
        if (path.includes('/access_tokens')) {
          return {
            ok: true,
            json: async () => ({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600000).toISOString() }),
          } as Response;
        }

        if (path === '/graphql') {
          const body = JSON.parse(String(init?.body)) as {
            variables: { cursor: string | null };
          };
          if (page === 0) {
            page += 1;
            assert.equal(body.variables.cursor, null);
            return {
              ok: true,
              json: async () => ({
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                        nodes: [
                          {
                            id: 'thread-page-0',
                            isResolved: false,
                            comments: { nodes: [{ databaseId: 1 }] },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            } as Response;
          }
          assert.equal(body.variables.cursor, 'cursor-1');
          return {
            ok: true,
            json: async () => ({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          id: 'thread-page-1',
                          isResolved: true,
                          comments: { nodes: [{ databaseId: 42 }] },
                        },
                      ],
                    },
                  },
                },
              },
            }),
          } as Response;
        }

        return {
          ok: false,
          json: async () => ({ message: `unexpected path ${path}` }),
        } as Response;
      },
    });

    const result = await githubApp.findReviewThreadIdForComment(config, 'owner', 'repo', 1, 42);
    assert.deepEqual(result, { threadId: 'thread-page-1', isResolved: true });
  });

  it('returns null when no thread contains the comment', async () => {
    const githubApp = createGithubAppService({
      fetchImpl: async (url) => {
        const path = String(url).replace('https://api.github.com', '');
        if (path.includes('/access_tokens')) {
          return {
            ok: true,
            json: async () => ({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600000).toISOString() }),
          } as Response;
        }

        if (path === '/graphql') {
          return {
            ok: true,
            json: async () => ({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          id: 'thread-other',
                          isResolved: false,
                          comments: { nodes: [{ databaseId: 1 }] },
                        },
                      ],
                    },
                  },
                },
              },
            }),
          } as Response;
        }

        return {
          ok: false,
          json: async () => ({ message: `unexpected path ${path}` }),
        } as Response;
      },
    });

    const result = await githubApp.findReviewThreadIdForComment(config, 'owner', 'repo', 1, 999);
    assert.equal(result, null);
  });

  it('resolves a review thread and reports the resolved state', async () => {
    const githubApp = createGithubAppService({
      fetchImpl: async (url, init) => {
        const path = String(url).replace('https://api.github.com', '');
        if (path.includes('/access_tokens')) {
          return {
            ok: true,
            json: async () => ({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600000).toISOString() }),
          } as Response;
        }

        if (path === '/graphql') {
          const body = JSON.parse(String(init?.body)) as { query: string; variables: { threadId: string } };
          assert.ok(body.query.includes('mutation ResolveReviewThread'));
          assert.equal(body.variables.threadId, 'thread-mine');
          return {
            ok: true,
            json: async () => ({
              data: {
                resolveReviewThread: {
                  thread: { id: 'thread-mine', isResolved: true },
                },
              },
            }),
          } as Response;
        }

        return {
          ok: false,
          json: async () => ({ message: `unexpected path ${path}` }),
        } as Response;
      },
    });

    const result = await githubApp.resolvePullRequestReviewThread(config, 'thread-mine');
    assert.deepEqual(result, { threadId: 'thread-mine', isResolved: true });
  });

  it('throws when GraphQL reports errors', async () => {
    const githubApp = createGithubAppService({
      fetchImpl: async (url) => {
        const path = String(url).replace('https://api.github.com', '');
        if (path.includes('/access_tokens')) {
          return {
            ok: true,
            json: async () => ({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600000).toISOString() }),
          } as Response;
        }

        if (path === '/graphql') {
          return {
            ok: true,
            json: async () => ({
              errors: [{ message: 'Something went wrong' }],
            }),
          } as Response;
        }

        return {
          ok: false,
          json: async () => ({ message: `unexpected path ${path}` }),
        } as Response;
      },
    });

    await assert.rejects(
      githubApp.resolvePullRequestReviewThread(config, 'thread-x'),
      /Something went wrong/,
    );
  });
});
