import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentJob, AppConfig } from '../../../types';
import { resolveAutoApprovePermissions } from './batch-run-flow';

const baseConfig: AppConfig = {
  ollamaBaseUrl: '',
  opencodeModel: '',
  opencodeProvider: 'ollama',
  systemPrompt: '',
  githubAppId: '',
  githubAppInstallationId: '',
  githubAppPrivateKey: '',
  gitUserName: '',
  gitUserEmail: '',
  webhookUrl: '',
  batchAutoApprovePermissions: true,
  loopAutoApprovePermissions: true,
  interactiveAutoApprovePermissions: false,
  reviewModel: '',
  interactiveAgentTimeoutSeconds: 3600,
  loopAgentTimeoutSeconds: 3600,
  loopVerbModels: {
    INITIAL_PLAN: '',
    ORIENT: '',
    ACT: '',
    REFLECT: '',
  },
};

const baseJob: AgentJob = {
  agentId: 'agent1',
  workspaceId: 'ws1',
  repoId: 'acme-demo',
  prompt: 'goal',
  baseBranch: 'main',
  agentBranch: 'localagent-agent1',
  commitMessage: 'test',
  push: true,
  pushOnFailure: false,
  agentTimeoutMs: 3600000,
  dataDir: '/data',
  workspaceRoot: '/workspaces',
  workspaceDir: '/workspaces/ws1',
  logPath: '/data/agents/agent1/worker.log',
};

describe('resolveAutoApprovePermissions', () => {
  it('uses loopAutoApprovePermissions for loop mode', () => {
    const config = { ...baseConfig, loopAutoApprovePermissions: false };
    assert.equal(resolveAutoApprovePermissions(config, baseJob, 'loop'), false);
  });

  it('defaults loop auto-approve to true when setting is unset', () => {
    const config = { ...baseConfig, loopAutoApprovePermissions: undefined as unknown as boolean };
    assert.equal(resolveAutoApprovePermissions(config, baseJob, 'loop'), true);
  });

  it('prefers per-agent override for loop mode', () => {
    const job = { ...baseJob, autoApprovePermissions: false };
    assert.equal(resolveAutoApprovePermissions(baseConfig, job, 'loop'), false);
  });
});
