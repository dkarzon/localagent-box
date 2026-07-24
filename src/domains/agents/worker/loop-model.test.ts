import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentJob, AppConfig } from '../../../types';
import { collectLoopModels, resolveLoopStepModel } from './loop-model';

const baseConfig: AppConfig = {
  ollamaBaseUrl: 'http://localhost:11434',
  opencodeModel: 'llama3.2',
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
  autoCreatePullRequest: true,
  interactiveAgentTimeoutSeconds: 3600,
  loopAgentTimeoutSeconds: 3600,
  loopVerbModels: {
    INITIAL_PLAN: '',
    ORIENT: '',
    ACT: 'qwen3-coder:30b',
    REFLECT: 'llama3.2',
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
  model: 'mistral',
};

describe('resolveLoopStepModel', () => {
  it('prefers verb-specific setting over job and global defaults', () => {
    assert.equal(resolveLoopStepModel('ACT', baseConfig, baseJob), 'qwen3-coder:30b');
  });

  it('falls back to job.model when verb slot is blank', () => {
    assert.equal(resolveLoopStepModel('ORIENT', baseConfig, baseJob), 'mistral');
  });

  it('falls back to opencodeModel when verb and job are blank', () => {
    const config = {
      ...baseConfig,
      loopVerbModels: { INITIAL_PLAN: '', ORIENT: '', ACT: '', REFLECT: '' },
    };
    const job = { ...baseJob, model: undefined };
    assert.equal(resolveLoopStepModel('ORIENT', config, job), 'llama3.2');
  });

  it('returns null when no model is configured', () => {
    const config = {
      ...baseConfig,
      opencodeModel: '',
      loopVerbModels: { INITIAL_PLAN: '', ORIENT: '', ACT: '', REFLECT: '' },
    };
    assert.equal(resolveLoopStepModel('REFLECT', config), null);
  });

  it('prefers run override over Settings and job.model', () => {
    const job = {
      ...baseJob,
      loopVerbModels: { ACT: 'qwen3-coder:32b' },
    };
    assert.equal(resolveLoopStepModel('ACT', baseConfig, job), 'qwen3-coder:32b');
  });

  it('inherits Settings when run override slot is blank', () => {
    const job = {
      ...baseJob,
      loopVerbModels: { ACT: '', REFLECT: 'mistral-large' },
    };
    assert.equal(resolveLoopStepModel('ACT', baseConfig, job), 'qwen3-coder:30b');
    assert.equal(resolveLoopStepModel('REFLECT', baseConfig, job), 'mistral-large');
  });

  it('falls back to job.model when run and Settings verb slots are blank', () => {
    const job = {
      ...baseJob,
      loopVerbModels: { ORIENT: '' },
    };
    assert.equal(resolveLoopStepModel('ORIENT', baseConfig, job), 'mistral');
  });

  it('resolves legacy OBSERVE/PLAN run overrides for ORIENT steps', () => {
    const jobObserve = {
      ...baseJob,
      loopVerbModels: { OBSERVE: 'legacy-observe-model' },
    } as AgentJob;
    assert.equal(resolveLoopStepModel('ORIENT', baseConfig, jobObserve), 'legacy-observe-model');

    const jobPlan = {
      ...baseJob,
      loopVerbModels: { PLAN: 'legacy-plan-model' },
    } as AgentJob;
    assert.equal(resolveLoopStepModel('ORIENT', baseConfig, jobPlan), 'legacy-plan-model');
  });

  it('resolves legacy OBSERVE/PLAN settings for ORIENT steps', () => {
    const config = {
      ...baseConfig,
      loopVerbModels: { OBSERVE: 'settings-observe-model' },
    } as AppConfig;
    assert.equal(resolveLoopStepModel('ORIENT', config, baseJob), 'settings-observe-model');
  });
});

describe('collectLoopModels', () => {
  it('dedupes global, verb, and job models', () => {
    const models = collectLoopModels(baseConfig, baseJob);
    assert.deepEqual(models.sort(), ['llama3.2', 'mistral', 'qwen3-coder:30b'].sort());
  });

  it('omits empty model ids', () => {
    const config = {
      ...baseConfig,
      opencodeModel: '',
      loopVerbModels: { INITIAL_PLAN: '', ORIENT: '', ACT: 'coder', REFLECT: '' },
    };
    assert.deepEqual(collectLoopModels(config), ['coder']);
  });

  it('includes run override models', () => {
    const job = {
      ...baseJob,
      loopVerbModels: { ACT: 'qwen3-coder:32b', REFLECT: 'mistral-large' },
    };
    const models = collectLoopModels(baseConfig, job);
    assert.ok(models.includes('qwen3-coder:32b'));
    assert.ok(models.includes('mistral-large'));
  });

  it('includes legacy OBSERVE/PLAN run override models', () => {
    const job = {
      ...baseJob,
      loopVerbModels: { OBSERVE: 'legacy-orient-model' },
    } as AgentJob;
    const models = collectLoopModels(baseConfig, job);
    assert.ok(models.includes('legacy-orient-model'));
  });
});
