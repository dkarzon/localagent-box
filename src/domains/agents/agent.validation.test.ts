import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCreateAgentPayload } from './agent.validation';
import type { Repo } from '../../types';

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
});
