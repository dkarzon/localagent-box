import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canCreatePullRequest,
  canReviewBranches,
  type Agent,
} from '../../client/src/api/types.ts';

function completedAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: 'agent-parent',
    repoId: 'repo-1',
    status: 'completed',
    pushed: true,
    agentBranch: 'localagent-feature',
    result: { opencodeSuccess: true },
    ...overrides,
  };
}

describe('canReviewBranches with canCreatePullRequest', () => {
  it('allows both shortcuts for a successful pushed agent before a PR exists', () => {
    const agent = completedAgent();
    assert.equal(canCreatePullRequest(agent), true);
    assert.equal(
      canReviewBranches(agent, {
        relatedAgents: [agent],
        baseBranch: 'main',
        agentsLoaded: true,
      }),
      true,
    );
  });

  it('keeps review hidden until agents are loaded even when Create PR is available', () => {
    const agent = completedAgent();
    assert.equal(canCreatePullRequest(agent), true);
    assert.equal(
      canReviewBranches(agent, {
        relatedAgents: [],
        baseBranch: 'main',
        agentsLoaded: false,
      }),
      false,
    );
  });

  it('still allows review after a PR is linked (Open PR does not consume the review slot)', () => {
    const agent = completedAgent({
      pullRequest: {
        number: 42,
        url: 'https://github.com/org/repo/pull/42',
        state: 'open',
        title: 'Agent changes',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    assert.equal(canCreatePullRequest(agent), false);
    assert.equal(
      canReviewBranches(agent, {
        relatedAgents: [agent],
        baseBranch: 'main',
        agentsLoaded: true,
      }),
      true,
    );
  });

  it('blocks review when an active duplicate exists for the same parent and branch pair', () => {
    const agent = completedAgent();
    const activeReview = completedAgent({
      agentId: 'agent-review',
      mode: 'review',
      status: 'running',
      parentAgentId: agent.agentId,
      review: { baseBranch: 'main', headBranch: agent.agentBranch },
    });
    assert.equal(
      canReviewBranches(agent, {
        relatedAgents: [agent, activeReview],
        baseBranch: 'main',
        agentsLoaded: true,
      }),
      false,
    );
  });
});
