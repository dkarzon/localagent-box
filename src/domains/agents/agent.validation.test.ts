import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCreateAgentPayload } from './agent.validation';
import { CodedError, type Repo } from '../../types';

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

describe('parseCreateAgentPayload', () => {
  it('defaults useExistingBranch to false and generates agent branch', () => {
    const payload = parseCreateAgentPayload(
      { repoId: 'acme-demo', prompt: 'Do work' },
      repo,
      'abc123',
    );

    assert.equal(payload.useExistingBranch, false);
    assert.equal(payload.agentBranch, 'localagent-abc123');
    assert.equal(payload.baseBranch, 'main');
  });

  it('uses baseBranch as agentBranch when useExistingBranch is true', () => {
    const payload = parseCreateAgentPayload(
      {
        repoId: 'acme-demo',
        prompt: 'Do work',
        useExistingBranch: true,
        baseBranch: 'feature/existing',
      },
      repo,
      'abc123',
    );

    assert.equal(payload.useExistingBranch, true);
    assert.equal(payload.baseBranch, 'feature/existing');
    assert.equal(payload.agentBranch, 'feature/existing');
  });

  it('accepts loop mode', () => {
    const payload = parseCreateAgentPayload(
      { repoId: 'acme-demo', prompt: 'Refactor auth', mode: 'loop' },
      repo,
      'abc123',
    );

    assert.equal(payload.mode, 'loop');
    assert.equal(payload.prompt, 'Refactor auth');
  });

  it('defaults review mode to existing branch checkout of head branch', () => {
    const payload = parseCreateAgentPayload(
      {
        repoId: 'acme-demo',
        mode: 'review',
        headBranch: 'feature/review-me',
        baseBranch: 'main',
      },
      repo,
      'abc123',
    );

    assert.equal(payload.mode, 'review');
    assert.equal(payload.useExistingBranch, true);
    assert.equal(payload.agentBranch, 'feature/review-me');
    assert.equal(payload.push, false);
    assert.equal(payload.commitMessage, '');
  });

  it('ignores agentBranch when useExistingBranch is true', () => {
    const payload = parseCreateAgentPayload(
      {
        repoId: 'acme-demo',
        prompt: 'Do work',
        useExistingBranch: true,
        baseBranch: 'feature/existing',
        agentBranch: 'other-branch',
      },
      repo,
      'abc123',
    );

    assert.equal(payload.agentBranch, 'feature/existing');
  });

  it('accepts partial loopVerbModels for loop mode', () => {
    const payload = parseCreateAgentPayload(
      {
        repoId: 'acme-demo',
        prompt: 'Refactor auth',
        mode: 'loop',
        loopVerbModels: { ACT: 'qwen3-coder:30b', REFLECT: '' },
      },
      repo,
      'abc123',
    );

    assert.equal(payload.mode, 'loop');
    assert.deepEqual(payload.loopVerbModels, { ACT: 'qwen3-coder:30b' });
  });

  it('ignores loopVerbModels for batch mode', () => {
    const payload = parseCreateAgentPayload(
      {
        repoId: 'acme-demo',
        prompt: 'Do work',
        mode: 'batch',
        loopVerbModels: { ACT: 'qwen3-coder:30b' },
      },
      repo,
      'abc123',
    );

    assert.equal(payload.mode, 'batch');
    assert.equal(payload.loopVerbModels, undefined);
  });

  it('accepts loopMaxIterations for loop mode', () => {
    const payload = parseCreateAgentPayload(
      { repoId: 'acme-demo', prompt: 'Refactor auth', mode: 'loop', loopMaxIterations: 42 },
      repo,
      'abc123',
    );

    assert.equal(payload.mode, 'loop');
    assert.equal(payload.loopMaxIterations, 42);
  });

  it('defaults loopMaxIterations to undefined so repo/server defaults apply', () => {
    const payload = parseCreateAgentPayload(
      { repoId: 'acme-demo', prompt: 'Refactor auth', mode: 'loop' },
      repo,
      'abc123',
    );

    assert.equal(payload.loopMaxIterations, undefined);
  });

  it('ignores loopMaxIterations for batch mode', () => {
    const payload = parseCreateAgentPayload(
      {
        repoId: 'acme-demo',
        prompt: 'Do work',
        mode: 'batch',
        loopMaxIterations: 5,
      },
      repo,
      'abc123',
    );

    assert.equal(payload.mode, 'batch');
    assert.equal(payload.loopMaxIterations, undefined);
  });

  it('rejects invalid loopMaxIterations values for loop mode', () => {
    for (const loopMaxIterations of [0, -1, 2.5, 'five', '10', Infinity]) {
      assert.throws(
        () =>
          parseCreateAgentPayload(
            { repoId: 'acme-demo', prompt: 'Refactor auth', mode: 'loop', loopMaxIterations },
            repo,
            'abc123',
          ),
        (err: unknown) => {
          assert.ok(err instanceof CodedError);
          assert.equal(err.code, 'VALIDATION_ERROR');
          assert.match(String(err.message), /loopMaxIterations must be a positive integer/);
          return true;
        },
      );
    }
  });

  it('parses autofix metadata', () => {
    const payload = parseCreateAgentPayload(
      {
        repoId: 'acme-demo',
        prompt: 'Fix finding',
        useExistingBranch: true,
        autofix: {
          kind: 'automatic',
          sourceReviewAgentId: 'review1',
          findingIds: ['f1', 'f2'],
          batchIndex: 0,
        },
      },
      repo,
      'abc123',
    );

    assert.deepEqual(payload.autofix, {
      kind: 'automatic',
      sourceReviewAgentId: 'review1',
      findingIds: ['f1', 'f2'],
      batchIndex: 0,
    });
  });

  it('leaves autofix unset when absent', () => {
    const payload = parseCreateAgentPayload(
      { repoId: 'acme-demo', prompt: 'Do work' },
      repo,
      'abc123',
    );

    assert.equal(payload.autofix, undefined);
  });

  it('rejects malformed autofix payloads', () => {
    const invalid = [
      ['autofix must be an object', 'not-an-object'],
      ['autofix.kind must be', { kind: 'auto', sourceReviewAgentId: 'review1', findingIds: [] }],
      ['autofix.sourceReviewAgentId is required', { kind: 'manual', sourceReviewAgentId: '', findingIds: [] }],
      ['autofix.findingIds must be an array of strings', { kind: 'manual', sourceReviewAgentId: 'review1', findingIds: 'nope' }],
      ['autofix.findingIds entries must be non-empty strings', { kind: 'manual', sourceReviewAgentId: 'review1', findingIds: ['ok', 42] }],
      ['autofix.batchIndex must be a non-negative integer', { kind: 'manual', sourceReviewAgentId: 'review1', findingIds: ['f1'], batchIndex: -1 }],
    ] as const;
    for (const [messagePart, autofix] of invalid) {
      assert.throws(
        () =>
          parseCreateAgentPayload(
            { repoId: 'acme-demo', prompt: 'Fix finding', autofix: autofix as unknown },
            repo,
            'abc123',
          ),
        (err: unknown) => {
          assert.ok(err instanceof CodedError);
          assert.equal(err.code, 'VALIDATION_ERROR');
          assert.match(String(err.message), new RegExp(messagePart));
          return true;
        },
      );
    }
  });
});
