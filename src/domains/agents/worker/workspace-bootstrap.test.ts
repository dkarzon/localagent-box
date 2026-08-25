import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Agent, AgentBootstrapState } from '../../../types';
import { runWorkspaceCommand, type WorkspaceCommandResult } from './workspace-command';
import {
  DEFAULT_SETUP_TIMEOUT_MS,
  runWorkspaceBootstrap,
} from './workspace-bootstrap';

type FakeRunCommand = (
  workspaceDir: string,
  command: string,
  options?: { timeoutMs?: number },
) => Promise<WorkspaceCommandResult>;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agentId: 'agent1',
    workspaceId: 'ws1',
    repoId: 'acme-demo',
    mode: 'batch',
    prompt: 'goal',
    systemPrompt: null,
    baseBranch: 'main',
    agentBranch: 'localagent-agent1',
    commitMessage: 'test',
    push: false,
    pushOnFailure: false,
    model: null,
    status: 'queued',
    commitSha: null,
    pushed: false,
    filesChanged: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    branch: null,
    error: null,
    result: null,
    ...overrides,
  };
}

interface Harness {
  workspaceDir: string;
  logPath: string;
  agent: Agent;
  agentsStore: { load: () => { agents: Agent[] }; save: (value: { agents: Agent[] }) => void };
  runCalls: Array<{
    workspaceDir: string;
    command: string;
    timeoutMs?: number;
    agentRecordBefore: AgentBootstrapState | undefined;
  }>;
}

function writeConfig(dir: string, content: string): void {
  const repoDir = path.join(dir, '.localagent-box');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'environment.json'), content, 'utf8');
}

function makeHarness(): Harness {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-bootstrap-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-bootstrap-log-'));
  const harness: Harness = {
    workspaceDir,
    logPath: path.join(logDir, 'worker.log'),
    agent: makeAgent(),
    agentsStore: {
      load: () => ({ agents: [harness.agent] }),
      save: (value) => {
        harness.agent = value.agents[0];
      },
    },
    runCalls: [],
  };
  fs.writeFileSync(harness.logPath, '', 'utf8');
  return harness;
}

/** Capture calls (incl. the agent record before/during the run) and return a configured result. */
function fakeRunCommand(
  h: Harness,
  result: WorkspaceCommandResult,
): typeof runWorkspaceCommand {
  const fn: FakeRunCommand = async (workspaceDir, command, options) => {
    h.runCalls.push({
      workspaceDir,
      command,
      timeoutMs: options?.timeoutMs,
      agentRecordBefore: h.agent.bootstrap,
    });
    return result;
  };
  return fn as unknown as typeof runWorkspaceCommand;
}

describe('runWorkspaceBootstrap', () => {
  it('exports the default setup timeout', () => {
    assert.equal(DEFAULT_SETUP_TIMEOUT_MS, 600_000);
  });

  it('returns skipped when environment.json does not exist', async () => {
    const h = makeHarness();
    const state = await runWorkspaceBootstrap({
      workspaceDir: h.workspaceDir,
      logPath: h.logPath,
      agentId: h.agent.agentId,
      agentsStore: h.agentsStore,
    });
    assert.deepEqual(state, { status: 'skipped' });
    assert.equal(h.agent.bootstrap, undefined);
    assert.equal(h.runCalls.length, 0);
  });

  it('returns skipped when the config has no setup block', async () => {
    const h = makeHarness();
    writeConfig(h.workspaceDir, JSON.stringify({ version: 1 }));

    const state = await runWorkspaceBootstrap({
      workspaceDir: h.workspaceDir,
      logPath: h.logPath,
      agentId: h.agent.agentId,
      agentsStore: h.agentsStore,
      runCommand: fakeRunCommand(h, {
        command: 'npm ci',
        exitCode: 0,
        outputTail: 'ok',
        timedOut: false,
        success: true,
      }),
    });

    assert.deepEqual(state, { status: 'skipped' });
    assert.equal(h.runCalls.length, 0);
    assert.equal(h.agent.bootstrap, undefined);
  });

  it('runs the configured command and records a completed bootstrap', async () => {
    const h = makeHarness();
    writeConfig(
      h.workspaceDir,
      JSON.stringify({ version: 1, setup: { command: 'npm ci && npm run build' } }),
    );

    const state = await runWorkspaceBootstrap({
      workspaceDir: h.workspaceDir,
      logPath: h.logPath,
      agentId: h.agent.agentId,
      agentsStore: h.agentsStore,
      runCommand: fakeRunCommand(h, {
        command: 'npm ci && npm run build',
        exitCode: 0,
        outputTail: 'added 12 packages',
        timedOut: false,
        success: true,
      }),
    });

    assert.equal(typeof state.durationMs, 'number');
    assert.equal(state.status, 'completed');
    assert.equal(state.command, 'npm ci && npm run build');
    assert.equal(state.exitCode, 0);
    assert.equal(state.outputTail, 'added 12 packages');

    assert.equal(h.runCalls.length, 1);
    const run = h.runCalls[0];
    assert.equal(run.workspaceDir, h.workspaceDir);
    assert.equal(run.command, 'npm ci && npm run build');
    assert.equal(run.timeoutMs, DEFAULT_SETUP_TIMEOUT_MS);

    assert.ok(h.agent.bootstrap);
    assert.equal(h.agent.bootstrap.status, 'completed');
    assert.equal(h.agent.bootstrap.command, 'npm ci && npm run build');
    assert.equal(h.agent.bootstrap.exitCode, 0);

    const log = fs.readFileSync(h.logPath, 'utf8');
    assert.match(log, /Running workspace bootstrap/);
    assert.match(log, /Workspace bootstrap completed in \d+ms \(exit code 0\)/);
  });

  it('passes the configured timeoutMs to the command runner', async () => {
    const h = makeHarness();
    writeConfig(
      h.workspaceDir,
      JSON.stringify({ version: 1, setup: { command: 'pnpm install', timeoutMs: 300_000 } }),
    );

    await runWorkspaceBootstrap({
      workspaceDir: h.workspaceDir,
      logPath: h.logPath,
      agentId: h.agent.agentId,
      agentsStore: h.agentsStore,
      runCommand: fakeRunCommand(h, {
        command: 'pnpm install',
        exitCode: 0,
        outputTail: 'ok',
        timedOut: false,
        success: true,
      }),
    });

    assert.equal(h.runCalls.length, 1);
    assert.equal(h.runCalls[0].timeoutMs, 300_000);
  });

  it('updates the agent record to running before the command starts', async () => {
    const h = makeHarness();
    writeConfig(h.workspaceDir, JSON.stringify({ version: 1, setup: { command: 'npm ci' } }));

    await runWorkspaceBootstrap({
      workspaceDir: h.workspaceDir,
      logPath: h.logPath,
      agentId: h.agent.agentId,
      agentsStore: h.agentsStore,
      runCommand: fakeRunCommand(h, {
        command: 'npm ci',
        exitCode: 0,
        outputTail: 'ok',
        timedOut: false,
        success: true,
      }),
    });

    assert.equal(h.runCalls.length, 1);
    const before = h.runCalls[0].agentRecordBefore;
    assert.equal(before?.status, 'running');
    assert.equal(before?.command, 'npm ci');
  });

  it('throws when the setup command fails with the default failOnError', async () => {
    const h = makeHarness();
    writeConfig(h.workspaceDir, JSON.stringify({ version: 1, setup: { command: 'npm ci' } }));

    let caught: unknown;
    const opts = {
      workspaceDir: h.workspaceDir,
      logPath: h.logPath,
      agentId: h.agent.agentId,
      agentsStore: h.agentsStore,
      runCommand: fakeRunCommand(h, {
        command: 'npm ci',
        exitCode: 1,
        outputTail: 'npm ERR! Missing script: "prepare"',
        timedOut: false,
        success: false,
      }),
    };
    try {
      await runWorkspaceBootstrap(opts);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof Error);
    assert.match(caught.message, /^Bootstrap failed: `npm ci` exited 1/);
    assert.match(caught.message, /npm ERR! Missing script: "prepare"/);
    assert.equal(h.agent.bootstrap?.status, 'failed');
    const log = fs.readFileSync(h.logPath, 'utf8');
    assert.match(log, /Workspace bootstrap failed with exit code 1/);
  });

  it('does not throw when the setup command fails with failOnError=false', async () => {
    const h = makeHarness();
    writeConfig(
      h.workspaceDir,
      JSON.stringify({ version: 1, setup: { command: 'npm ci', failOnError: false } }),
    );

    const state = await runWorkspaceBootstrap({
      workspaceDir: h.workspaceDir,
      logPath: h.logPath,
      agentId: h.agent.agentId,
      agentsStore: h.agentsStore,
      runCommand: fakeRunCommand(h, {
        command: 'npm ci',
        exitCode: 1,
        outputTail: 'npm ERR! missing',
        timedOut: false,
        success: false,
      }),
    });

    assert.equal(state.status, 'failed');
    assert.equal(state.exitCode, 1);
    assert.equal(state.error, 'Bootstrap failed: `npm ci` exited 1');
    assert.equal(h.agent.bootstrap?.status, 'failed');
    const log = fs.readFileSync(h.logPath, 'utf8');
    assert.match(log, /failOnError=false/);
  });

  it('treats a timed-out setup as a failure and throws', async () => {
    const h = makeHarness();
    writeConfig(
      h.workspaceDir,
      JSON.stringify({ version: 1, setup: { command: 'npm ci', timeoutMs: 60_000 } }),
    );

    let caught: unknown;
    const opts = {
      workspaceDir: h.workspaceDir,
      logPath: h.logPath,
      agentId: h.agent.agentId,
      agentsStore: h.agentsStore,
      runCommand: fakeRunCommand(h, {
        command: 'npm ci',
        exitCode: 124,
        outputTail: '',
        timedOut: true,
        success: false,
      }),
    };
    try {
      await runWorkspaceBootstrap(opts);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof Error);
    assert.match(caught.message, /Bootstrap timed out/);
    assert.equal(h.agent.bootstrap?.status, 'failed');
    assert.equal(h.agent.bootstrap?.exitCode, 124);
    const log = fs.readFileSync(h.logPath, 'utf8');
    assert.match(log, /Workspace bootstrap timed out/);
  });

  it('uses the real shell by default and still surfaces a real failure', async () => {
    const h = makeHarness();
    writeConfig(
      h.workspaceDir,
      JSON.stringify({ version: 1, setup: { command: 'exit 1', failOnError: false } }),
    );

    const state = await runWorkspaceBootstrap({
      workspaceDir: h.workspaceDir,
      logPath: h.logPath,
      agentId: h.agent.agentId,
      agentsStore: h.agentsStore,
    });

    assert.equal(state.status, 'failed');
    assert.equal(state.exitCode, 1);
  });

  it('completes a real shell echo by default', async () => {
    const h = makeHarness();
    writeConfig(
      h.workspaceDir,
      JSON.stringify({ version: 1, setup: { command: 'echo bootstrap-ok' } }),
    );

    const state = await runWorkspaceBootstrap({
      workspaceDir: h.workspaceDir,
      logPath: h.logPath,
      agentId: h.agent.agentId,
      agentsStore: h.agentsStore,
    });

    assert.equal(state.status, 'completed');
    assert.equal(state.exitCode, 0);
    assert.match(state.outputTail ?? '', /bootstrap-ok/);
  });
});
