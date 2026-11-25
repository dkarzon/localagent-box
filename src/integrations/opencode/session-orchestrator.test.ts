import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { WorkerContext } from '../../domains/agents/worker/worker-context';
import { createJsonStore } from '../../lib/json-store';
import type { Agent, AgentJob, AppConfig } from '../../types';
import type { OpenCodeModelRef } from './runner';
import {
  extractMessageTokenUsage,
  handleUnattendedRequest,
  resolveTurnAssistantText,
  runSessionOrchestrator,
  type CompletedTurn,
  type TurnFollowUp,
} from './session-orchestrator';
import type { OpenCodeServerEvent, OpenCodeSessionRunner } from './session-runner';

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

describe('resolveTurnAssistantText', () => {
  it('joins each finalized message with any text still streaming', () => {
    assert.equal(
      resolveTurnAssistantText({ messageTexts: ['one', '  ', 'two'], streamedAssistantText: 'three' }),
      'one\ntwo\nthree',
    );
  });

  it('is empty when the turn produced no assistant text', () => {
    assert.equal(resolveTurnAssistantText({ messageTexts: [], streamedAssistantText: '' }), '');
  });
});

interface FakePrompt {
  text: string;
  model: OpenCodeModelRef | null | undefined;
}

/**
 * Fake runner for the poll loop: `statuses` is consumed one poll at a time, so a
 * turn completes when the fake has shown busy and then idle. Assistant text is
 * delivered as a streamed delta after each prompt.
 */
function fakeSessionRunner(options: {
  statuses: Array<Record<string, { type?: string }>>;
  assistantTexts: string[];
}): { runner: OpenCodeSessionRunner; prompts: FakePrompt[] } {
  const prompts: FakePrompt[] = [];
  const statuses = [...options.statuses];
  const sessionId = 'ses_fake';
  let onEvent: ((event: OpenCodeServerEvent) => void) | undefined;

  const runner: OpenCodeSessionRunner = {
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    startServer: async () => {},
    waitForServerReady: async () => {},
    createSession: async () => ({ id: sessionId }),
    sendPromptAsync: async (_sessionId, body) => {
      prompts.push({ text: body.parts.map((part) => part.text).join('\n\n'), model: body.model });
      const assistantText = options.assistantTexts[prompts.length - 1];
      if (assistantText && onEvent) {
        // The prompt is accepted first; the turn's text streams afterwards.
        await new Promise((resolve) => setImmediate(resolve));
        onEvent({
          type: 'message.part.delta',
          properties: { partID: `part_${prompts.length}`, field: 'text', delta: assistantText },
        });
      }
    },
    replyPermission: async () => {},
    cancelForm: async () => {},
    getSessionStatusMap: async () => statuses.shift() ?? {},
    abort: async () => {},
    subscribeEvents: (event) => {
      onEvent = event;
      return { unsubscribe: () => {}, ready: Promise.resolve() };
    },
    dispose: async () => {},
  };

  return { runner, prompts };
}

/** Provider unconfigured so the orchestrator writes no OpenCode config and makes no calls. */
const orchestratorConfig: AppConfig = {
  ollamaBaseUrl: '',
  ollamaCloudApiKey: '',
  ollamaCloudBaseUrl: '',
  openaiCompatibleBaseUrl: '',
  openaiCompatibleApiKey: '',
  opencodeModel: 'qwen3',
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

function makeOrchestratorHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-orch-run-'));
  const dataDir = path.join(root, 'data');
  const agentDir = path.join(dataDir, 'agents', 'agent1');
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const job: AgentJob = {
    agentId: 'agent1',
    workspaceId: 'ws1',
    repoId: 'acme-demo',
    mode: 'batch',
    prompt: 'Fix the failing test',
    baseBranch: 'main',
    agentBranch: 'localagent-agent1',
    checksBaseBranch: 'main',
    commitMessage: 'test',
    push: false,
    pushOnFailure: false,
    agentTimeoutMs: 60000,
    dataDir,
    workspaceRoot: root,
    workspaceDir,
    logPath: path.join(agentDir, 'worker.log'),
  };

  const agentsStore = createJsonStore<{ agents: Agent[] }>(
    path.join(dataDir, 'agents.json'),
    {
      agents: [
        {
          agentId: job.agentId,
          workspaceId: job.workspaceId,
          repoId: job.repoId,
          mode: 'batch',
          prompt: job.prompt,
          systemPrompt: null,
          baseBranch: job.baseBranch,
          agentBranch: job.agentBranch,
          commitMessage: job.commitMessage,
          push: job.push,
          pushOnFailure: job.pushOnFailure,
          model: null,
          status: 'processing',
          turnCount: 0,
          commitSha: null,
          pushed: false,
          filesChanged: null,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: null,
          branch: job.agentBranch,
          error: null,
          result: null,
        },
      ],
    },
    fs,
  );

  const ctx = {
    job,
    logPath: job.logPath,
    config: orchestratorConfig,
    agentsStore,
  } as unknown as WorkerContext;

  return { ctx, job, agentsStore, conversationPath: path.join(agentDir, 'conversation.jsonl') };
}

function readTranscript(conversationPath: string): Array<{ role: string; text: string }> {
  return fs
    .readFileSync(conversationPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { role: string; text: string });
}

describe('runSessionOrchestrator multi-turn hook', () => {
  it('keeps the session alive for a host follow-up and reports every turn', async () => {
    const { ctx, job, agentsStore, conversationPath } = makeOrchestratorHarness();
    const { runner, prompts } = fakeSessionRunner({
      statuses: [
        { ses_fake: { type: 'busy' } },
        {}, // turn 0 idle → the hook asks for a follow-up
        { ses_fake: { type: 'busy' } },
        {}, // turn 1 idle → the hook ends the run
      ],
      assistantTexts: ['turn 0 text', 'turn 1 text'],
    });

    const hookTurns: CompletedTurn[] = [];
    const result = await runSessionOrchestrator({
      ctx,
      createRunner: () => runner,
      onTurnComplete: async (turn): Promise<TurnFollowUp | null> => {
        hookTurns.push(turn);
        return turn.index === 0 ? { followUp: 'Fix the check the host ran', model: 'gemma4' } : null;
      },
    });

    assert.equal(result.outcome, 'turn_complete');
    assert.deepEqual(result.turns, [
      { index: 0, assistantText: 'turn 0 text' },
      { index: 1, assistantText: 'turn 1 text' },
    ]);
    assert.deepEqual(hookTurns, result.turns);

    assert.equal(prompts.length, 2);
    // The first turn carries the `## Context` framing; a follow-up is the bare directive.
    assert.ok(prompts[0].text.startsWith('## Context'));
    assert.equal(prompts[1].text, 'Fix the check the host ran');
    assert.deepEqual(prompts[0].model, { providerID: 'ollama', modelID: 'qwen3' });
    assert.deepEqual(prompts[1].model, { providerID: 'ollama', modelID: 'gemma4' });

    const userLines = readTranscript(conversationPath).filter((entry) => entry.role === 'user');
    assert.deepEqual(userLines.map((entry) => entry.text), [job.prompt, 'Fix the check the host ran']);
    assert.equal(agentsStore.load().agents[0].turnCount, 2);
  });

  it('completes after one turn when no hook is given', async () => {
    const { ctx } = makeOrchestratorHarness();
    const { runner, prompts } = fakeSessionRunner({
      statuses: [{ ses_fake: { type: 'busy' } }, {}],
      assistantTexts: ['only turn'],
    });

    const result = await runSessionOrchestrator({ ctx, createRunner: () => runner });

    assert.equal(result.outcome, 'turn_complete');
    assert.equal(prompts.length, 1);
    assert.deepEqual(result.turns, [{ index: 0, assistantText: 'only turn' }]);
  });
});
