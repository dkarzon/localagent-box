import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isDuplicateBranchReview,
  isDuplicateReview,
  resolveAutoReviewPullRequests,
} from './resolve-auto-review';
import type { AppConfig, Repo } from '../types';

const repo: Repo = {
  repoId: 'acme-demo',
  owner: 'acme',
  name: 'demo',
  defaultBranch: 'main',
  cloneUrl: 'https://github.com/acme/demo.git',
  registeredAt: '2026-01-01T00:00:00.000Z',
  lastVerifiedAt: null,
  lastVerifyStatus: null,
  lastVerifyMessage: null,
  autoReviewPullRequests: null,
};

const globalConfig = {
  autoReviewPullRequests: false,
} as AppConfig;

describe('resolveAutoReviewPullRequests', () => {
  it('defaults to false when unset', () => {
    assert.equal(resolveAutoReviewPullRequests(undefined, repo, globalConfig), false);
  });

  it('uses repo override when set', () => {
    assert.equal(
      resolveAutoReviewPullRequests(undefined, { ...repo, autoReviewPullRequests: true }, globalConfig),
      true,
    );
    assert.equal(
      resolveAutoReviewPullRequests(undefined, { ...repo, autoReviewPullRequests: false }, {
        ...globalConfig,
        autoReviewPullRequests: true,
      }),
      false,
    );
  });

  it('uses global config when repo inherits', () => {
    assert.equal(
      resolveAutoReviewPullRequests(undefined, repo, { ...globalConfig, autoReviewPullRequests: true }),
      true,
    );
  });

  it('uses agent override when provided', () => {
    assert.equal(resolveAutoReviewPullRequests(false, { ...repo, autoReviewPullRequests: true }, globalConfig), false);
    assert.equal(resolveAutoReviewPullRequests(true, { ...repo, autoReviewPullRequests: false }, globalConfig), true);
  });
});

describe('isDuplicateReview', () => {
  it('matches pr number and head sha', () => {
    const agent = {
      review: { prNumber: 42, headSha: 'abc123' },
    };
    assert.equal(isDuplicateReview(agent, 42, 'abc123'), true);
    assert.equal(isDuplicateReview(agent, 42, 'def456'), false);
    assert.equal(isDuplicateReview(agent, 41, 'abc123'), false);
  });

  it('returns false when review metadata missing', () => {
    assert.equal(isDuplicateReview({}, 42, 'abc123'), false);
  });
});

describe('isDuplicateBranchReview', () => {
  const parentAgentId = 'parent-1';
  const baseBranch = 'main';
  const headBranch = 'feature/review';

  it('blocks only active reviews for the same parent and branch pair', () => {
    const active = {
      mode: 'review',
      status: 'queued',
      parentAgentId,
      review: { baseBranch, headBranch },
    };
    assert.equal(isDuplicateBranchReview(active, parentAgentId, baseBranch, headBranch), true);
    assert.equal(
      isDuplicateBranchReview({ ...active, status: 'running' }, parentAgentId, baseBranch, headBranch),
      true,
    );
    assert.equal(
      isDuplicateBranchReview({ ...active, status: 'completed' }, parentAgentId, baseBranch, headBranch),
      false,
    );
    assert.equal(
      isDuplicateBranchReview({ ...active, status: 'failed' }, parentAgentId, baseBranch, headBranch),
      false,
    );
    assert.equal(
      isDuplicateBranchReview({ ...active, status: 'cancelled' }, parentAgentId, baseBranch, headBranch),
      false,
    );
  });

  it('ignores reviews for other parents or branches', () => {
    const active = {
      mode: 'review',
      status: 'queued',
      parentAgentId,
      review: { baseBranch, headBranch },
    };
    assert.equal(isDuplicateBranchReview(active, 'other-parent', baseBranch, headBranch), false);
    assert.equal(
      isDuplicateBranchReview(
        { ...active, review: { baseBranch, headBranch: 'other-branch' } },
        parentAgentId,
        baseBranch,
        headBranch,
      ),
      false,
    );
  });
});
