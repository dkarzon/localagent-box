import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentJob, AppConfig } from '../../../types';
import { resolveAutoApprovePermissions } from './batch-run-flow';

const baseConfig: AppConfig = {
  ollamaBaseUrl: '',
  ollamaCloudApiKey: '',
  ollamaCloudBaseUrl: '',
  openaiCompatibleBaseUrl: '',
  openaiCompatibleApiKey: '',
  opencodeModel: '',
  opencodeProvider: 'ollama',
  reviewProvider: '',
  systemPrompt: '',
  githubAppId: '',
  githubAppInstallationId: '',
  githubAppPrivateKey: '',
  gitUserName: '',
  gitUserEmail: '',
  webhookUrl: '',
  batchAutoApprovePermissions: true,
  reviewModel: '',
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
  it('uses batchAutoApprovePermissions for batch mode', () => {
    const config = { ...baseConfig, batchAutoApprovePermissions: false };
    assert.equal(resolveAutoApprovePermissions(config, baseJob), false);
  });

  it('defaults batch auto-approve to true when the setting is unset', () => {
    const config = { ...baseConfig, batchAutoApprovePermissions: undefined as unknown as boolean };
    assert.equal(resolveAutoApprovePermissions(config, baseJob), true);
  });

  it('prefers the per-agent override', () => {
    const job = { ...baseJob, autoApprovePermissions: false };
    assert.equal(resolveAutoApprovePermissions(baseConfig, job), false);
  });
});
