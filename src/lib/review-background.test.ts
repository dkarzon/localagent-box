import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAutoSpawnReviewBackground,
  buildReviewBackground,
  DEFAULT_REVIEW_RULES,
  readParentTranscriptLines,
  REVIEW_BACKGROUND_HEADER,
} from './review-background';
import type { Agent } from '../types';

const baseAgent: Agent = {
  agentId: 'agent123',
  workspaceId: 'ws1',
  repoId: 'repo1',
  mode: 'review',
  prompt: 'Implement feature',
  systemPrompt: null,
  baseBranch: 'main',
  agentBranch: 'feature/foo',
  commitMessage: '',
  push: false,
  pushOnFailure: false,
  model: null,
  status: 'queued',
  commitSha: null,
  pushed: false,
  filesChanged: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  branch: null,
  error: null,
  result: null,
  parentAgentId: 'parent1',
  review: {
    baseBranch: 'main',
    headBranch: 'feature/foo',
    background: 'Focus on security',
  },
};

describe('buildReviewBackground', () => {
  it('merges repo preamble and caller context', () => {
    const result = buildReviewBackground(baseAgent, { reviewBackground: 'Check auth flows' }, null);
    assert.match(result, /Repository Review Instructions: Check auth flows/);
    assert.match(result, /Current Request Context: Focus on security/);
  });

  it('places default review rules first when no repo config exists', () => {
    const result = buildReviewBackground(baseAgent, null, null);
    assert.ok(result.startsWith(`${REVIEW_BACKGROUND_HEADER}\n\n${DEFAULT_REVIEW_RULES}`));
    assert.match(result, /Current Request Context: Focus on security/);
  });

  it('uses review.background and lists risk areas after the default rules', () => {
    const result = buildReviewBackground(
      baseAgent,
      {
        review: {
          background: 'Check auth flows',
          riskAreas: [
            { paths: ['src/auth/**', 'src/session/**'], description: 'Token expiry and scope', risk: 'high' },
            { description: 'Anything touching billing' },
          ],
        },
      },
      null,
    );
    assert.match(result, /Repository Review Instructions: Check auth flows/);
    assert.match(
      result,
      /Repository Risk Areas \(review changes here with extra scrutiny\):\n- `src\/auth\/\*\*`, `src\/session\/\*\*` \(high risk\): Token expiry and scope\n- Across the codebase: Anything touching billing/,
    );
    const rulesIndex = result.indexOf(DEFAULT_REVIEW_RULES);
    const riskIndex = result.indexOf('Repository Risk Areas');
    const callerIndex = result.indexOf('Current Request Context');
    assert.ok(rulesIndex >= 0 && rulesIndex < riskIndex && riskIndex < callerIndex);
  });

  it('leaves out the default rules when the repo replaces them, and still reuses the result on retry', () => {
    const overrides = { review: { background: 'Our own rules', replaceDefaultRules: true } };
    const firstPass = buildReviewBackground(baseAgent, overrides, null);
    assert.ok(firstPass.startsWith(REVIEW_BACKGROUND_HEADER));
    assert.ok(!firstPass.includes(DEFAULT_REVIEW_RULES));
    assert.match(firstPass, /Repository Review Instructions: Our own rules/);

    const retried = buildReviewBackground(
      { ...baseAgent, review: { ...baseAgent.review!, background: firstPass } },
      overrides,
      null,
    );
    assert.equal(retried, firstPass);
  });

  it('reuses a persisted background built before the header existed', () => {
    const legacy = `${DEFAULT_REVIEW_RULES}\n\nCurrent Request Context: old`;
    const retried = buildReviewBackground(
      { ...baseAgent, review: { ...baseAgent.review!, background: legacy } },
      null,
      null,
    );
    assert.equal(retried, legacy);
  });

  it('keeps default rules first and repo, caller, parent sections in order after them', () => {
    const result = buildReviewBackground(
      baseAgent,
      { reviewBackground: 'Check auth flows' },
      'assistant: done',
    );
    const rulesIndex = result.indexOf(DEFAULT_REVIEW_RULES);
    const repoIndex = result.indexOf('Repository Review Instructions');
    const callerIndex = result.indexOf('Current Request Context');
    const parentIndex = result.indexOf('Previous Activity Summary');
    assert.equal(rulesIndex, REVIEW_BACKGROUND_HEADER.length + 2);
    assert.ok(repoIndex > rulesIndex);
    assert.ok(callerIndex > repoIndex);
    assert.ok(parentIndex > callerIndex);
  });

  it('reuses the persisted built background verbatim on retry instead of rebuilding it', () => {
    const firstPass = buildReviewBackground(baseAgent, { reviewBackground: 'Check auth flows' }, null);
    const retried = buildReviewBackground(
      { ...baseAgent, review: { ...baseAgent.review!, background: firstPass } },
      { reviewBackground: 'Check auth flows' },
      null,
    );
    assert.equal(retried, firstPass);
    assert.equal(retried.split(DEFAULT_REVIEW_RULES).length, 2);
    assert.ok(!retried.includes('Current Request Context: Repository Review Instructions'));

    // A changed override must not re-embed a fresh section over the stale one.
    const changedOverride = buildReviewBackground(
      { ...baseAgent, review: { ...baseAgent.review!, background: firstPass } },
      { reviewBackground: 'Check tenant isolation' },
      null,
    );
    assert.equal(changedOverride, firstPass);
    assert.ok(!changedOverride.includes('Check tenant isolation'));
  });

  it('includes parent transcript when provided', () => {
    const result = buildReviewBackground(
      { ...baseAgent, review: { ...baseAgent.review!, background: null } },
      null,
      'assistant: done',
    );
    assert.match(result, /Previous Activity Summary/);
    assert.match(result, /assistant: done/);
  });

  it('falls back to parent task when transcript is missing', () => {
    const result = buildReviewBackground(
      { ...baseAgent, prompt: '', review: { ...baseAgent.review!, background: null } },
      null,
      null,
      'Implement feature',
    );
    assert.match(result, /Parent Agent Task: Implement feature/);
  });
});

describe('buildAutoSpawnReviewBackground', () => {
  it('combines parent task and transcript', () => {
    const result = buildAutoSpawnReviewBackground(baseAgent, 'assistant: implemented retries');
    assert.match(result, /Task: Implement feature/);
    assert.match(result, /assistant: implemented retries/);
  });
});

describe('readParentTranscriptLines', () => {
  it('parses conversation jsonl and caps length', () => {
    const lines = [
      JSON.stringify({ role: 'user', text: 'Hello' }),
      JSON.stringify({ role: 'assistant', text: 'World' }),
    ];
    assert.equal(readParentTranscriptLines(lines), 'user: Hello\nassistant: World');
  });
});
