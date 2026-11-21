import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { extractMessageTokenUsage, handleUnattendedRequest } from './session-orchestrator';

function fakeRunner() {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      replyPermission: async (sessionId: string, requestId: string, reply?: string) => {
        calls.push(`reply ${sessionId} ${requestId} ${reply}`);
      },
      cancelForm: async (sessionId: string, formId: string) => {
        calls.push(`cancel ${sessionId} ${formId}`);
      },
    },
  };
}

const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-orch-')), 'agent.log');
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('handleUnattendedRequest', () => {
  it('auto-approves permission requests on their session when enabled', async () => {
    const { runner, calls } = fakeRunner();
    handleUnattendedRequest(
      { type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_1', action: 'shell' } },
      runner,
      logPath,
      true,
    );
    await flush();
    assert.deepEqual(calls, ['reply ses_1 per_1 once']);
  });

  it('leaves permission requests alone when auto-approve is off', async () => {
    const { runner, calls } = fakeRunner();
    handleUnattendedRequest(
      { type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_1' } },
      runner,
      logPath,
      false,
    );
    await flush();
    assert.deepEqual(calls, []);
  });

  it('cancels forms so an unattended turn never blocks on a question', async () => {
    const { runner, calls } = fakeRunner();
    handleUnattendedRequest(
      { type: 'form.created', properties: { form: { id: 'frm_1', sessionID: 'ses_1', title: 'Pick' } } },
      runner,
      logPath,
      false,
    );
    await flush();
    assert.deepEqual(calls, ['cancel ses_1 frm_1']);
  });
});

describe('extractMessageTokenUsage', () => {
  const payload = (info: Record<string, unknown>) => ({ info });

  it('uses the cost reported by the provider', () => {
    const usage = extractMessageTokenUsage(
      payload({ model: 'gpt-4o', tokens: { input: 1000, output: 200 }, cost: 0.0031 }),
      { 'gpt-4o': { input: 1, output: 3 } },
    );
    assert.ok(usage);
    assert.equal(usage.cost, 0.0031);
    assert.equal(usage.estimatedCost, false);
  });

  it('computes cost from configured rates when the provider reports none (Ollama)', () => {
    const usage = extractMessageTokenUsage(
      payload({ model: 'llama3.2', tokens: { input: 500_000, output: 100_000, cache_read: 200_000 } }),
      { 'llama3.2': { input: 0.2, output: 0.6, cacheRead: 0.05 } },
    );
    assert.ok(usage);
    assert.ok(Math.abs(usage.cost - (0.1 + 0.06 + 0.01)) < 1e-9);
    assert.equal(usage.estimatedCost, true);
    assert.equal(usage.cacheRead, 200_000);
  });

  it('bills reasoning tokens at the output rate', () => {
    const usage = extractMessageTokenUsage(
      payload({ model: 'ollama/qwen3', tokens: { input: 0, output: 100_000, reasoning: 400_000 } }),
      { qwen3: { output: 1 } },
    );
    assert.ok(usage);
    assert.ok(Math.abs(usage.cost - 0.5) < 1e-9);
  });

  it('costs zero for models without their own entry (no wildcard fallback)', () => {
    const usage = extractMessageTokenUsage(
      payload({ model: 'mistral', tokens: { input: 1_000_000 } }),
      { '*': { input: 0.1, output: 0.3 }, 'llama3.2': { input: 1 } },
    );
    assert.ok(usage);
    assert.equal(usage.cost, 0);
    assert.equal(usage.estimatedCost, false);
  });

  it('costs zero for a model whose entry has no rates', () => {
    const usage = extractMessageTokenUsage(payload({ model: 'llama3.2', tokens: { input: 1_000_000 } }), {
      'llama3.2': {},
    });
    assert.ok(usage);
    assert.equal(usage.cost, 0);
    assert.equal(usage.estimatedCost, false);
  });

  it('stays at zero cost when no rates are configured', () => {
    const usage = extractMessageTokenUsage(payload({ model: 'llama3.2', tokens: { input: 10 } }), {});
    assert.ok(usage);
    assert.equal(usage.cost, 0);
    assert.equal(usage.estimatedCost, false);
  });

  it('returns null when no token data is present', () => {
    assert.equal(extractMessageTokenUsage({ info: { model: 'llama3.2' } }, { 'llama3.2': { input: 1 } }), null);
  });
});
