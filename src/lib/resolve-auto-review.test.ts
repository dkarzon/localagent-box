import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDuplicateReview, resolveAutoReviewPullRequests } from './resolve-auto-review';
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
