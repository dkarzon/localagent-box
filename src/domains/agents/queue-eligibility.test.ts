import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Agent } from '../../types';
import {
  decideQueueAction,
  findCodingPredecessor,
  predecessorAllowsStart,
} from './queue-eligibility';

function agent(overrides: Partial<Agent> & Pick<Agent, 'agentId' | 'status'>): Agent {
  return {
    workspaceId: 'ws',
    repoId: 'acme-demo',
    prompt: 'do work',
    systemPrompt: null,
    baseBranch: 'main',
    agentBranch: 'feature/project',
    commitMessage: 'msg',
    push: true,
    pushOnFailure: false,
    model: null,
    commitSha: null,
    pushed: false,
    filesChanged: null,
    createdAt: '2026-08-16T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    branch: null,
    error: null,
    result: null,
    pullRequest: null,
    ...overrides,
  };
}

describe('queue-eligibility', () => {
  const first = agent({
    agentId: 'a1',
    status: 'queued',
    createdAt: '2026-08-16T00:00:01.000Z',
  });
  const second = agent({
    agentId: 'a2',
    status: 'queued',
    createdAt: '2026-08-16T00:00:02.000Z',
  });

  it('starts the first queued agent on a branch', () => {
    assert.equal(decideQueueAction(first, [first], () => false), 'start');
  });

  it('defers a successor while a worker occupies the branch', () => {
    const running = { ...first, status: 'running' as const };
    assert.equal(decideQueueAction(second, [running, second], (id) => id === 'a1'), 'defer');
  });

  it('defers a successor when the predecessor has not pushed', () => {
    const completed = { ...first, status: 'completed' as const, pushed: false };
    assert.equal(decideQueueAction(second, [completed, second], () => false), 'defer');
  });

  it('starts a successor after the predecessor completed and pushed', () => {
    const completed = { ...first, status: 'completed' as const, pushed: true };
    assert.equal(decideQueueAction(second, [completed, second], () => false), 'start');
  });

  it('defers a successor when the predecessor failed without allowSuccessors', () => {
    const failed = { ...first, status: 'failed' as const };
    assert.equal(decideQueueAction(second, [failed, second], () => false), 'defer');
  });

  it('starts a successor when the predecessor failed with allowSuccessors', () => {
    const failed = { ...first, status: 'failed' as const, allowSuccessors: true };
    assert.equal(decideQueueAction(second, [failed, second], () => false), 'start');
  });

  it('ignores review agents when walking the coding predecessor chain', () => {
    const completed = { ...first, status: 'completed' as const, pushed: true };
    const review = agent({
      agentId: 'rev1',
      mode: 'review',
      status: 'failed',
      createdAt: '2026-08-16T00:00:01.500Z',
    });
    assert.equal(findCodingPredecessor([completed, review, second], second)?.agentId, 'a1');
    assert.equal(predecessorAllowsStart(findCodingPredecessor([completed, review, second], second)), true);
    assert.equal(decideQueueAction(second, [completed, review, second], () => false), 'start');
  });

  it('drops missing, terminal, or already-running agents', () => {
    assert.equal(decideQueueAction(undefined, [], () => false), 'drop');
    assert.equal(decideQueueAction({ ...first, status: 'failed' }, [first], () => false), 'drop');
    assert.equal(decideQueueAction({ ...first, status: 'running' }, [first], () => true), 'drop');
  });

  it('starts a completing agent that no longer has a worker', () => {
    const completing = { ...first, status: 'completing' as const };
    assert.equal(decideQueueAction(completing, [completing], () => false), 'start');
  });
});
