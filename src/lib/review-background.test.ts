import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAutoSpawnReviewBackground,
  buildReviewBackground,
  readParentTranscriptLines,
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
