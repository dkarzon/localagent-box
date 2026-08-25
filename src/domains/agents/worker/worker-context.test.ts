import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { createWorkerContext } from './worker-context';
import { resetServerEnvCache } from '../../../config/env';
import type { AgentJob, AppConfig } from '../../../types';

function makeJob(dataDir: string): AgentJob {
  return {
    agentId: 'agent1',
    workspaceId: 'ws1',
    repoId: 'acme-demo',
    mode: 'batch',
    prompt: 'goal',
    baseBranch: 'main',
    agentBranch: 'main',
    commitMessage: 'test',
    push: false,
    pushOnFailure: false,
    agentTimeoutMs: 3600000,
    dataDir,
    workspaceRoot: dataDir,
    workspaceDir: path.join(dataDir, 'workspaces', 'agent1'),
    logPath: path.join(dataDir, 'agents', 'agent1', 'worker.log'),
  };
}

function writeConfig(dataDir: string, extra: Partial<AppConfig>): void {
  const config: AppConfig = {
    ollamaBaseUrl: '',
    opencodeModel: '',
    opencodeProvider: 'ollama',
    systemPrompt: '',
    // Valid GitHub App credentials so assertConfigured passes.
    githubAppId: '12345',
    githubAppInstallationId: '67890',
    githubAppPrivateKey: 'test-private-key',
    gitUserName: '',
    gitUserEmail: '',
    webhookUrl: '',
    batchAutoApprovePermissions: true,
    loopAutoApprovePermissions: true,
    interactiveAutoApprovePermissions: false,
    reviewModel: '',
    interactiveAgentTimeoutSeconds: 3600,
    loopAgentTimeoutSeconds: 3600,
    loopVerbModels: { INITIAL_PLAN: '', ORIENT: '', ACT: '', REFLECT: '' },
    ...extra,
  };
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

describe('createWorkerContext bootstrap env hydration (P2-T4)', () => {
  const savedAutoDetect = process.env.BOOTSTRAP_AUTO_DETECT;
  const savedTimeoutMs = process.env.BOOTSTRAP_SETUP_TIMEOUT_MS;

  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-context-bootstrap-'));
    process.env.BOOTSTRAP_AUTO_DETECT = 'true';
    process.env.BOOTSTRAP_SETUP_TIMEOUT_MS = '120000';
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (savedAutoDetect === undefined) delete process.env.BOOTSTRAP_AUTO_DETECT;
    else process.env.BOOTSTRAP_AUTO_DETECT = savedAutoDetect;
    if (savedTimeoutMs === undefined) delete process.env.BOOTSTRAP_SETUP_TIMEOUT_MS;
    else process.env.BOOTSTRAP_SETUP_TIMEOUT_MS = savedTimeoutMs;
    resetServerEnvCache();
  });

  it('hydrates bootstrap fields from env when config.json exists without them', async () => {
    writeConfig(dataDir, {});
    const ctx = await createWorkerContext(makeJob(dataDir));

    assert.equal(ctx.config.bootstrapAutoDetect, true);
    assert.equal(ctx.config.globalSetupTimeoutMs, 120000);
  });

  it('leaves config.json values untouched when they are explicitly set', async () => {
    writeConfig(dataDir, { bootstrapAutoDetect: false, globalSetupTimeoutMs: 600000 });
    const ctx = await createWorkerContext(makeJob(dataDir));

    assert.equal(ctx.config.bootstrapAutoDetect, false);
    assert.equal(ctx.config.globalSetupTimeoutMs, 600000);
  });

  it('keeps fields undefined when env vars are absent', async () => {
    delete process.env.BOOTSTRAP_AUTO_DETECT;
    delete process.env.BOOTSTRAP_SETUP_TIMEOUT_MS;
    writeConfig(dataDir, {});
    const ctx = await createWorkerContext(makeJob(dataDir));

    assert.equal(ctx.config.bootstrapAutoDetect, undefined);
    assert.equal(ctx.config.globalSetupTimeoutMs, undefined);
  });
});
