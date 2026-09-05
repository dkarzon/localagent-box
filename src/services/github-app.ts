import crypto from 'crypto';
import type { GitHubPullRequestResponse } from '../lib/agent-pull-request';
import type { AppConfig } from '../types';

const GITHUB_API = 'https://api.github.com';
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface InstallationTokenResponse {
  token?: string;
  expires_at?: string;
  message?: string;
}

interface GitHubBranchResponse {
  name: string;
  commit: {
    sha: string;
    url: string;
  };
  protected: boolean;
}

export interface GithubCredentialSummary {
  configured: boolean;
  githubAppId: string;
  githubAppInstallationId: string;
  hasPrivateKey: boolean;
  gitUserConfigured: boolean;
}

export interface BotGitIdentity {
  gitUserName: string;
  gitUserEmail: string;
}

/** True when GitHub App credentials are set but both git author fields are blank. */
export function needsBotGitIdentity(config: AppConfig): boolean {
  return Boolean(
    config.githubAppId &&
      config.githubAppInstallationId &&
      config.githubAppPrivateKey &&
      !config.gitUserName.trim() &&
      !config.gitUserEmail.trim(),
  );
}

/** Build the git author identity GitHub uses to attribute commits to a GitHub App bot. */
export function formatBotGitIdentity(slug: string, botUserId: number): BotGitIdentity {
  const login = `${slug}[bot]`;
  return {
    gitUserName: login,
    gitUserEmail: `${botUserId}+${login}@users.noreply.github.com`,
  };
}

export interface CreatePullRequestInput {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
}

export interface PullRequestReviewCommentInput {
  path: string;
  body: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  subject_type?: 'line' | 'file';
}

export interface CreatePullRequestReviewInput {
  body: string;
  event?: 'COMMENT';
  comments?: PullRequestReviewCommentInput[];
}

export interface CreatePullRequestReviewCommentInput {
  commit_id: string;
  path: string;
  body: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  subject_type?: 'line' | 'file';
}

/** REST review comment fields needed to map findings back to GitHub threads. */
export interface PullRequestReviewCommentSummary {
  id: number;
  html_url: string;
  path: string;
  line: number | null;
  start_line: number | null;
}

/** GraphQL review-thread node ID plus its current resolved state. */
export interface ReviewThreadLookupResult {
  threadId: string;
  isResolved: boolean;
}

interface ReviewThreadsQueryData {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          comments: { nodes: Array<{ databaseId: number | null }> };
        }>;
      };
    };
  };
}

interface ResolveReviewThreadMutationData {
  resolveReviewThread: {
    thread: { id: string; isResolved: boolean };
  };
}

export interface GithubAppService {
  assertConfigured: (config: AppConfig) => void;
  getCredentialSummary: (config: AppConfig) => GithubCredentialSummary;
  getInstallationToken: (config: AppConfig, forceRefresh?: boolean) => Promise<string>;
  buildAuthenticatedCloneUrl: (owner: string, name: string, token: string) => string;
  fetchRepositoryBranches: (config: AppConfig, owner: string, name: string) => Promise<string[]>;
  createPullRequest: (config: AppConfig, input: CreatePullRequestInput) => Promise<GitHubPullRequestResponse>;
  getPullRequest: (
    config: AppConfig,
    owner: string,
    repo: string,
    pullNumber: number,
  ) => Promise<GitHubPullRequestResponse>;
  findPullRequestByHead: (
    config: AppConfig,
    owner: string,
    repo: string,
    headBranch: string,
  ) => Promise<GitHubPullRequestResponse | null>;
  createPullRequestReview: (
    config: AppConfig,
    owner: string,
    repo: string,
    prNumber: number,
    input: CreatePullRequestReviewInput,
  ) => Promise<{ id: string; html_url: string }>;
  createPullRequestReviewComment: (
    config: AppConfig,
    owner: string,
    repo: string,
    prNumber: number,
    input: CreatePullRequestReviewCommentInput,
  ) => Promise<{ id: string; html_url: string }>;
  /** List comments belonging to an already submitted review. */
  listPullRequestReviewComments: (
    config: AppConfig,
    owner: string,
    repo: string,
    prNumber: number,
    reviewId: string,
  ) => Promise<PullRequestReviewCommentSummary[]>;
  /** Finds the GraphQL review-thread node ID containing a REST comment database ID. */
  findReviewThreadIdForComment: (
    config: AppConfig,
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
  ) => Promise<ReviewThreadLookupResult | null>;
  /** Idempotently resolves a review thread; an already-resolved thread is success. */
  resolvePullRequestReviewThread: (
    config: AppConfig,
    threadId: string,
  ) => Promise<{ threadId: string; isResolved: boolean }>;
  redactSecrets: (text: string | undefined | null) => string | undefined | null;
  createAppJwt: (appId: string, privateKeyPem: string) => string;
  normalizePrivateKey: (privateKey: string) => string;
  resolveBotGitIdentity: (config: AppConfig) => Promise<BotGitIdentity>;
}

export function normalizePrivateKey(privateKey: string): string {
  return privateKey.replace(/\\n/g, '\n').trim();
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value).toString('base64url');
}

export function createAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const iat = now - 60;
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat,
      exp: iat + 600,
      iss: String(appId),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(normalizePrivateKey(privateKeyPem), 'base64url');
  return `${signingInput}.${signature}`;
}

export function createGithubAppService(options: { fetchImpl?: typeof fetch } = {}): GithubAppService {
  const fetchImpl = options.fetchImpl || fetch;
  let cachedToken: { token: string; expiresAt: number } | null = null;

  function assertConfigured(config: AppConfig): void {
    if (!config.githubAppId || !config.githubAppInstallationId || !config.githubAppPrivateKey) {
      throw new Error('GitHub App credentials are not fully configured');
    }
  }

  function getCredentialSummary(config: AppConfig): GithubCredentialSummary {
    return {
      configured: Boolean(
        config.githubAppId && config.githubAppInstallationId && config.githubAppPrivateKey,
      ),
      githubAppId: config.githubAppId || '',
      githubAppInstallationId: config.githubAppInstallationId || '',
      hasPrivateKey: Boolean(config.githubAppPrivateKey),
      gitUserConfigured: Boolean(config.gitUserName && config.gitUserEmail),
    };
  }

  async function requestInstallationToken(config: AppConfig): Promise<string> {
    assertConfigured(config);

    const jwt = createAppJwt(config.githubAppId, config.githubAppPrivateKey);
    const response = await fetchImpl(
      `${GITHUB_API}/app/installations/${config.githubAppInstallationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          ...GITHUB_HEADERS,
        },
      },
    );

    const body = (await response.json().catch(() => ({}))) as InstallationTokenResponse;
    if (!response.ok) {
      const message = body.message || `GitHub API returned HTTP ${response.status}`;
      throw new Error(message);
    }

    if (!body.token || !body.expires_at) {
      throw new Error('GitHub API did not return an installation token');
    }

    cachedToken = {
      token: body.token,
      expiresAt: new Date(body.expires_at).getTime(),
    };

    return body.token;
  }

  async function getInstallationToken(config: AppConfig, forceRefresh = false): Promise<string> {
    if (
      !forceRefresh &&
      cachedToken &&
      cachedToken.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS
    ) {
      return cachedToken.token;
    }

    return requestInstallationToken(config);
  }

  function buildAuthenticatedCloneUrl(owner: string, name: string, token: string): string {
    return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${name}.git`;
  }

  async function githubAppJwtRequest<T>(config: AppConfig, path: string): Promise<T> {
    assertConfigured(config);
    const jwt = createAppJwt(config.githubAppId, config.githubAppPrivateKey);
    const response = await fetchImpl(`${GITHUB_API}${path}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...GITHUB_HEADERS,
      },
    });

    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      const message = body.message || `GitHub API returned HTTP ${response.status}`;
      throw new Error(message);
    }

    return body;
  }

  async function resolveBotGitIdentity(config: AppConfig): Promise<BotGitIdentity> {
    assertConfigured(config);

    const app = await githubAppJwtRequest<{ slug?: string; name?: string }>(config, '/app');
    const slug = app.slug?.trim() || app.name?.trim();
    if (!slug) {
      throw new Error('GitHub App response did not include a slug');
    }

    const botLogin = `${slug}[bot]`;
    const botUser = await fetchImpl(`${GITHUB_API}/users/${encodeURIComponent(botLogin)}`, {
      headers: GITHUB_HEADERS,
    }).then(async (response) => {
      const body = (await response.json().catch(() => ({}))) as { id?: number; message?: string };
      if (!response.ok) {
        const message = body.message || `GitHub API returned HTTP ${response.status}`;
        throw new Error(message);
      }
      return body;
    });

    if (typeof botUser.id !== 'number') {
      throw new Error(`GitHub bot user ${botLogin} was not found`);
    }

    return formatBotGitIdentity(slug, botUser.id);
  }

  async function githubApiRequest<T>(
    config: AppConfig,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const token = await getInstallationToken(config);
    const response = await fetchImpl(`${GITHUB_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...GITHUB_HEADERS,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      const message = body.message || `GitHub API returned HTTP ${response.status}`;
      throw new Error(message);
    }

    return body;
  }

  async function githubGraphQLRequest<T>(
    config: AppConfig,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const token = await getInstallationToken(config);
    const response = await fetchImpl(`${GITHUB_API}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...GITHUB_HEADERS,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      data?: T;
      errors?: Array<{ message?: string }>;
      message?: string;
    };
    if (!response.ok) {
      const message = body.message || `GitHub API returned HTTP ${response.status}`;
      throw new Error(message);
    }
    if (body.errors && body.errors.length > 0) {
      throw new Error(body.errors.map((entry) => entry.message || 'Unknown GraphQL error').join('; '));
    }
    if (!body.data) {
      throw new Error('GitHub GraphQL response did not include data');
    }
    return body.data;
  }

  async function fetchRepositoryBranches(config: AppConfig, owner: string, name: string): Promise<string[]> {
    const branches = await githubApiRequest<GitHubBranchResponse[]>(
      config,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`,
    );
    return branches.map((branch) => branch.name);
  }

  async function createPullRequest(
    config: AppConfig,
    input: CreatePullRequestInput,
  ): Promise<GitHubPullRequestResponse> {
    return githubApiRequest<GitHubPullRequestResponse>(
      config,
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body || '',
          draft: true,
        }),
      },
    );
  }

  async function getPullRequest(
    config: AppConfig,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<GitHubPullRequestResponse> {
    return githubApiRequest<GitHubPullRequestResponse>(
      config,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
    );
  }

  async function findPullRequestByHead(
    config: AppConfig,
    owner: string,
    repo: string,
    headBranch: string,
  ): Promise<GitHubPullRequestResponse | null> {
    const head = `${owner}:${headBranch}`;
    const pulls = await githubApiRequest<GitHubPullRequestResponse[]>(
      config,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?head=${encodeURIComponent(head)}&state=all&per_page=1`,
    );
    return pulls[0] ?? null;
  }

  async function createPullRequestReview(
    config: AppConfig,
    owner: string,
    repo: string,
    prNumber: number,
    input: CreatePullRequestReviewInput,
  ): Promise<{ id: string; html_url: string }> {
    const payload: Record<string, unknown> = {
      body: input.body,
      event: (input.event || 'COMMENT') as string,
    };

    if (input.comments && input.comments.length > 0) {
      payload.comments = input.comments.map((comment) => {
        const item: Record<string, unknown> = {
          path: comment.path,
          body: comment.body,
        };
        if (typeof comment.line === 'number') {
          item.line = comment.line;
        }
        if (comment.side) {
          item.side = comment.side;
        }
        if (typeof comment.start_line === 'number') {
          item.start_line = comment.start_line;
        }
        if (comment.start_side) {
          item.start_side = comment.start_side;
        }
        if (comment.subject_type) {
          item.subject_type = comment.subject_type;
        }
        return item;
      });
    }

    const result = await githubApiRequest<Record<string, unknown>>(
      config,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
    return {
      id: String(result.id ?? ''),
      html_url: String(result.html_url ?? ''),
    };
  }

  async function createPullRequestReviewComment(
    config: AppConfig,
    owner: string,
    repo: string,
    prNumber: number,
    input: CreatePullRequestReviewCommentInput,
  ): Promise<{ id: string; html_url: string }> {
    const payload: Record<string, unknown> = {
      commit_id: input.commit_id,
      path: input.path,
      body: input.body,
    };
    if (typeof input.line === 'number') {
      payload.line = input.line;
    }
    if (input.side) {
      payload.side = input.side;
    }
    if (typeof input.start_line === 'number') {
      payload.start_line = input.start_line;
    }
    if (input.start_side) {
      payload.start_side = input.start_side;
    }
    if (input.subject_type) {
      payload.subject_type = input.subject_type;
    }

    const result = await githubApiRequest<Record<string, unknown>>(
      config,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/comments`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
    return {
      id: String(result.id ?? ''),
      html_url: String(result.html_url ?? ''),
    };
  }

  async function listPullRequestReviewComments(
    config: AppConfig,
    owner: string,
    repo: string,
    prNumber: number,
    reviewId: string,
  ): Promise<PullRequestReviewCommentSummary[]> {
    const comments = await githubApiRequest<Array<Record<string, unknown>>>(
      config,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}/reviews/${encodeURIComponent(reviewId)}/comments`,
    );
    return comments
      .filter((comment) => typeof comment.id === 'number')
      .map((comment) => ({
        id: comment.id as number,
        html_url: String(comment.html_url ?? ''),
        path: String(comment.path ?? ''),
        line: typeof comment.line === 'number' ? comment.line : null,
        start_line: typeof comment.start_line === 'number' ? comment.start_line : null,
      }));
  }

  async function findReviewThreadIdForComment(
    config: AppConfig,
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
  ): Promise<ReviewThreadLookupResult | null> {
    const query = `
      query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $cursor) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                isResolved
                comments(first: 100) {
                  nodes {
                    databaseId
                  }
                }
              }
            }
          }
        }
      }
    `;

    let cursor: string | null = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const data: ReviewThreadsQueryData = await githubGraphQLRequest<ReviewThreadsQueryData>(
        config,
        query,
        {
          owner,
          name: repo,
          number: prNumber,
          cursor,
        },
      );

      for (const thread of data.repository.pullRequest.reviewThreads.nodes) {
        if (
          thread.comments.nodes.some(
            (comment) => comment.databaseId != null && Number(comment.databaseId) === commentId,
          )
        ) {
          return { threadId: thread.id, isResolved: thread.isResolved };
        }
      }

      hasNextPage = data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage;
      cursor = data.repository.pullRequest.reviewThreads.pageInfo.endCursor;
    }

    return null;
  }

  async function resolvePullRequestReviewThread(
    config: AppConfig,
    threadId: string,
  ): Promise<{ threadId: string; isResolved: boolean }> {
    const mutation = `
      mutation ResolveReviewThread($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread {
            id
            isResolved
          }
        }
      }
    `;

    const data: ResolveReviewThreadMutationData = await githubGraphQLRequest<ResolveReviewThreadMutationData>(
      config,
      mutation,
      { threadId },
    );

    const thread = data.resolveReviewThread?.thread;
    if (!thread || typeof thread.id !== 'string') {
      throw new Error('GitHub GraphQL resolveReviewThread response did not include a thread');
    }
    return { threadId: thread.id, isResolved: Boolean(thread.isResolved) };
  }

  function redactSecrets(text: string | undefined | null): string | undefined | null {
    if (!text) {
      return text;
    }
    return String(text).replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
  }

  return {
    assertConfigured,
    getCredentialSummary,
    getInstallationToken,
    buildAuthenticatedCloneUrl,
    fetchRepositoryBranches,
    createPullRequest,
    getPullRequest,
    createPullRequestReview,
    createPullRequestReviewComment,
    listPullRequestReviewComments,
    findReviewThreadIdForComment,
    resolvePullRequestReviewThread,
    findPullRequestByHead,
    redactSecrets,
    createAppJwt,
    normalizePrivateKey,
    resolveBotGitIdentity,
  };

}
