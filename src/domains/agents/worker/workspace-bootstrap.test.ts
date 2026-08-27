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
import type { RuntimeProfile } from './runtime-profiles';

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
    /** Copy of the bootstrap state on the agent record before this run. */
    agentRecordBefore: AgentBootstrapState | undefined;
  }>;
}

/** Write `.localagent-box/environment.json` with the given raw JSON. */
function writeConfig(workspaceDir: string, json: string): void {
  const repoDir = path.join(workspaceDir, '.localagent-box');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'environment.json'), json, 'utf8');
}

/** Commit `.localagent-box/setup.sh` in the workspace. */
function writeSetupScript(workspaceDir: string, body = '#!/usr/bin/env bash\nset -euo pipefail\necho setup-script-ok\n'): void {
  const repoDir = path.join(workspaceDir, '.localagent-box');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'setup.sh'), body, 'utf8');
}

/**
 * Fake runtime profiles so detection/profiling tests do not depend on the
 * bundled catalog (whose `defaultSetup` would shell out during real runs).
 */
const FAKE_CATALOG: Record<string, RuntimeProfile> = {
  pnpm: {
    detect: ['pnpm-lock.yaml'],
    defaultSetup: 'pnpm setup --fake',
    tools: [],
    cacheDirs: [],
  },
  pkg: {
    detect: ['package.json'],
    defaultSetup: 'npm ci --ignore-scripts',
    tools: [],
    cacheDirs: [],
  },
  go: {
    detect: ['go.mod'],
    defaultSetup: 'go mod download',
    tools: [],
    cacheDirs: [],
  },
};

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
      agentRecordBefore: h.agent.bootstrap ? { ...h.agent.bootstrap } : undefined,
    });
    return result;
  };
  return fn as unknown as typeof runWorkspaceCommand;
}

const SUCCESS: WorkspaceCommandResult = {
  command: '',
  exitCode: 0,
  outputTail: 'ok',
  timedOut: false,
  success: true,
};

function runBootstrap(
  h: Harness,
  extra: Partial<Parameters<typeof runWorkspaceBootstrap>[0]> = {},
): Promise<AgentBootstrapState> {
  return runWorkspaceBootstrap({
    workspaceDir: h.workspaceDir,
    logPath: h.logPath,
    agentId: h.agent.agentId,
    agentsStore: h.agentsStore,
    ...extra,
  });
}

function touchFile(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, name), '', 'utf8');
}

describe('runWorkspaceBootstrap', () => {
  it('exports the default setup timeout', () => {
    assert.equal(DEFAULT_SETUP_TIMEOUT_MS, 600_000);
  });

  it('auto-detects lockfile profiles when BOOTSTRAP_AUTO_DETECT is on (config.bootstrapAutoDetect)', async () => {
    const h = makeHarness();
    touchFile(h.workspaceDir, 'package.json');

    const state = await runBootstrap(h, {
      config: { bootstrapAutoDetect: true },
      loadProfiles: () => FAKE_CATALOG,
      runCommand: fakeRunCommand(h, {
        command: 'npm ci --ignore-scripts',
        exitCode: 0,
        outputTail: 'added 12 packages',
        timedOut: false,
        success: true,
      }),
    });

    assert.equal(state.status, 'completed');
    assert.equal(state.source, 'detect');
    assert.deepEqual(state.profiles, ['pkg']);
  });

  it('skips lockfile auto-detect without environment.json when BOOTSTRAP_AUTO_DETECT is off (default)', async () => {
    const h = makeHarness();
    touchFile(h.workspaceDir, 'package.json');

    const state = await runBootstrap(h, {
      loadProfiles: () => FAKE_CATALOG,
      runCommand: fakeRunCommand(h, {
        command: 'should-not-run',
        exitCode: 0,
        outputTail: 'ok',
        timedOut: false,
        success: true,
      }),
    });

    assert.deepEqual(state, { status: 'skipped' });
    assert.equal(h.runCalls.length, 0);
  });

  it('skips file-less auto-detect for empty workspaces even when enabled', async () => {
    const h = makeHarness();

    const state = await runBootstrap(h, {
      config: { bootstrapAutoDetect: true },
      loadProfiles: () => FAKE_CATALOG,
      runCommand: fakeRunCommand(h, {
        command: 'should-not-run',
        exitCode: 0,
        outputTail: 'ok',
        timedOut: false,
        success: true,
      }),
    });

    assert.deepEqual(state, { status: 'skipped' });
    assert.equal(h.runCalls.length, 0);
  });

  it('returns skipped when environment.json does not exist', async () => {
    const h = makeHarness();
    const state = await runBootstrap(h);
    assert.deepEqual(state, { status: 'skipped' });
    assert.equal(h.agent.bootstrap, undefined);
    assert.equal(h.runCalls.length, 0);
  });

  it('returns skipped when the config has no setup block', async () => {
    const h = makeHarness();
    writeConfig(h.workspaceDir, JSON.stringify({ version: 1 }));

    const state = await runBootstrap(h, {
      runCommand: fakeRunCommand(h, SUCCESS),
    });
    assert.deepEqual(state, { status: 'skipped' });
    assert.equal(h.runCalls.length, 0);
    assert.equal(h.agent.bootstrap, undefined);
  });

  describe('setup script (P4-T1)', () => {
    it('runs the committed setup.sh in place of an explicit setup.command', async () => {
      const h = makeHarness();
      writeSetupScript(h.workspaceDir);
      writeConfig(
        h.workspaceDir,
        JSON.stringify({ version: 1, setup: { command: 'should-not-run' } }),
      );

      const state = await runBootstrap(h, {
        runCommand: fakeRunCommand(h, {
          command: 'bash .localagent-box/setup.sh',
          exitCode: 0,
          outputTail: 'setup-script-ok',
          timedOut: false,
          success: true,
        }),
      });

      assert.equal(h.runCalls.length, 1);
      assert.equal(h.runCalls[0].command, 'bash .localagent-box/setup.sh');
      assert.equal(state.command, 'bash .localagent-box/setup.sh');
      assert.equal(state.source, 'script');
      assert.deepEqual(state.profiles, []);
      assert.equal(state.status, 'completed');
    });

    it('runs the committed setup.sh in place of profiles and auto-detect', async () => {
      const h = makeHarness();
      touchFile(h.workspaceDir, 'package.json');
      writeSetupScript(h.workspaceDir);
      writeConfig(h.workspaceDir, JSON.stringify({ version: 1, profiles: ['pkg'] }));

      const state = await runBootstrap(h, {
        loadProfiles: () => FAKE_CATALOG,
        runCommand: fakeRunCommand(h, {
          command: 'bash .localagent-box/setup.sh',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
      });

      assert.equal(state.status, 'completed');
      assert.equal(state.command, 'bash .localagent-box/setup.sh');
      assert.equal(state.source, 'script');
      assert.deepEqual(state.profiles, []);
    });

    it('runs the committed setup.sh even without an environment.json', async () => {
      const h = makeHarness();
      writeSetupScript(h.workspaceDir);

      const state = await runBootstrap(h, {
        runCommand: fakeRunCommand(h, {
          command: 'bash .localagent-box/setup.sh',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
      });

      assert.equal(state.status, 'completed');
      assert.equal(state.command, 'bash .localagent-box/setup.sh');
      assert.equal(state.source, 'script');
      assert.equal(h.runCalls.length, 1);
    });

    it('logs the setup script command line during a run', async () => {
      const h = makeHarness();
      writeSetupScript(h.workspaceDir);

      await runBootstrap(h, {
        runCommand: fakeRunCommand(h, {
          command: 'bash .localagent-box/setup.sh',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
      });

      const log = fs.readFileSync(h.logPath, 'utf8');
      assert.match(log, /Bootstrap: source=script/);
      assert.match(log, /setup script command: bash \.localagent-box\/setup\.sh/);
      assert.match(log, /Running workspace bootstrap/);
    });

    it('treats a failing setup.sh like any other failed setup and throws', async () => {
      const h = makeHarness();
      writeSetupScript(h.workspaceDir, '#!/usr/bin/env bash\nexit 1\n');

      let caught: unknown;
      try {
        await runBootstrap(h, {
          runCommand: fakeRunCommand(h, {
            command: 'bash .localagent-box/setup.sh',
            exitCode: 1,
            outputTail: 'failure in setup.sh',
            timedOut: false,
            success: false,
          }),
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught instanceof Error);
      assert.match((caught as { message: string }).message, /^Bootstrap failed: `bash \.localagent-box\/setup\.sh` exited 1/);
      assert.equal(h.agent.bootstrap?.status, 'failed');
      assert.equal(h.agent.bootstrap?.source, 'script');
    });

    it('executes a real setup.sh end to end without an injected runner', async () => {
      const h = makeHarness();
      writeSetupScript(h.workspaceDir);

      const state = await runBootstrap(h);

      assert.equal(state.status, 'completed');
      assert.equal(state.command, 'bash .localagent-box/setup.sh');
      assert.equal(state.source, 'script');
      assert.match(state.outputTail ?? '', /setup-script-ok/);
    });
  });

  it('runs the configured command and records a completed bootstrap', async () => {
    const h = makeHarness();
    writeConfig(
      h.workspaceDir,
      JSON.stringify({ version: 1, setup: { command: 'npm ci && npm run build' } }),
    );

    const state = await runBootstrap(h, {
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
    assert.equal(state.source, 'explicit');
    assert.deepEqual(state.profiles, []);

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
      JSON.stringify({
        version: 1,
        setup: { command: 'pnpm install', timeoutMs: 300_000 },
      }),
    );

    await runBootstrap(h, {
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

    await runBootstrap(h, {
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
    assert.equal(before?.source, 'explicit');
    assert.deepEqual(before?.profiles, []);
  });

  it('throws when the setup command fails with the default failOnError', async () => {
    const h = makeHarness();
    writeConfig(h.workspaceDir, JSON.stringify({ version: 1, setup: { command: 'npm ci' } }));
    const opts = {
      runCommand: fakeRunCommand(h, {
        command: 'npm ci',
        exitCode: 1,
        outputTail: 'npm ERR! Missing script: "prepare"',
        timedOut: false,
        success: false,
      }),
    };
    let caught: unknown;
    try {
      await runBootstrap(h, opts);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof Error);
    assert.match((caught as { message: string }).message, /^Bootstrap failed: `npm ci` exited 1/);
    assert.match((caught as { message: string }).message, /npm ERR! Missing script: "prepare"/);
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

    const state = await runBootstrap(h, {
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
      JSON.stringify({
        version: 1,
        setup: { command: 'npm ci', timeoutMs: 60_000 },
      }),
    );

    let caught: unknown;
    const opts = {
      runCommand: fakeRunCommand(h, {
        command: 'npm ci',
        exitCode: 124,
        outputTail: '',
        timedOut: true,
        success: false,
      }),
    };
    try {
      await runBootstrap(h, opts);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof Error);
    assert.match((caught as { message: string }).message, /Bootstrap timed out/);
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

    const state = await runBootstrap(h);

    assert.equal(state.status, 'failed');
    assert.equal(state.exitCode, 1);
  });

  it('completes a real shell echo by default', async () => {
    const h = makeHarness();
    writeConfig(h.workspaceDir, JSON.stringify({ version: 1, setup: { command: 'echo bootstrap-ok' } }));

    const state = await runBootstrap(h);

    assert.equal(state.status, 'completed');
    assert.equal(state.exitCode, 0);
    assert.match(state.outputTail ?? '', /bootstrap-ok/);
  });

  describe('profile resolution (P2-T3)', () => {
    it('auto-detects a profile when config exists with no setup (source=detect)', async () => {
      const h = makeHarness();
      touchFile(h.workspaceDir, 'package.json');
      writeConfig(h.workspaceDir, JSON.stringify({ version: 1 }));

      const state = await runBootstrap(h, {
        loadProfiles: () => FAKE_CATALOG,
        runCommand: fakeRunCommand(h, {
          command: 'npm ci --ignore-scripts',
          exitCode: 0,
          outputTail: 'added 12 packages',
          timedOut: false,
          success: true,
        }),
      });

      assert.equal(state.status, 'completed');
      assert.equal(state.command, 'npm ci --ignore-scripts');
      assert.equal(state.source, 'detect');
      assert.deepEqual(state.profiles, ['pkg']);
      assert.ok(h.agent.bootstrap);
      assert.equal(h.agent.bootstrap.status, 'completed');
      assert.equal(h.agent.bootstrap.source, 'detect');
      assert.deepEqual(h.agent.bootstrap.profiles, ['pkg']);

      const log = fs.readFileSync(h.logPath, 'utf8');
      assert.match(
        log,
        /Bootstrap: source=detect profiles=\[pkg\] command=npm ci --ignore-scripts/,
      );
    });

    it('uses the first requested profile default when profiles are present (source=profile)', async () => {
      const h = makeHarness();
      writeConfig(
        h.workspaceDir,
        JSON.stringify({ version: 1, profiles: ['pkg', 'go'] }),
      );

      const state = await runBootstrap(h, {
        loadProfiles: () => FAKE_CATALOG,
        runCommand: fakeRunCommand(h, {
          command: 'npm ci --ignore-scripts',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
      });

      assert.equal(state.status, 'completed');
      assert.equal(state.command, 'npm ci --ignore-scripts');
      assert.equal(state.source, 'profile');
      assert.deepEqual(state.profiles, ['pkg']);
    });

    it('explicit setup.command wins over profiles (source=explicit)', async () => {
      const h = makeHarness();
      writeConfig(
        h.workspaceDir,
        JSON.stringify({
          version: 1,
          setup: { command: 'make build' },
          profiles: ['pkg'],
        }),
      );

      const state = await runBootstrap(h, {
        loadProfiles: () => FAKE_CATALOG,
        runCommand: fakeRunCommand(h, {
          command: 'make build',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
      });

      assert.equal(state.status, 'completed');
      assert.equal(state.command, 'make build');
      assert.equal(state.source, 'explicit');
      assert.deepEqual(state.profiles, []);
    });

    it('respects autoDetect=false when no setup.command (source=none -> skipped)', async () => {
      const h = makeHarness();
      touchFile(h.workspaceDir, 'package.json');
      writeConfig(h.workspaceDir, JSON.stringify({ version: 1, autoDetect: false }));

      const state = await runBootstrap(h, {
        loadProfiles: () => FAKE_CATALOG,
        runCommand: fakeRunCommand(h, {
          command: 'npm ci --ignore-scripts',
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

    it('skips when requested profiles are unknown and nothing else matches', async () => {
      const h = makeHarness();
      writeConfig(
        h.workspaceDir,
        JSON.stringify({ version: 1, profiles: ['not-a-profile'] }),
      );

      const state = await runBootstrap(h, {
        loadProfiles: () => FAKE_CATALOG,
        runCommand: fakeRunCommand(h, {
          command: 'should-not-run',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
      });

      assert.deepEqual(state, { status: 'skipped' });
      assert.equal(h.runCalls.length, 0);
    });

    describe('server config profile gate (P2-T4)', () => {
    it('disables profiles not in enabledRuntimeProfiles (source=none -> skipped)', async () => {
      const h = makeHarness();
      writeConfig(h.workspaceDir, JSON.stringify({ version: 1, profiles: ['pkg'] }));

      const state = await runBootstrap(h, {
        config: { enabledRuntimeProfiles: ['go'] },
        loadProfiles: () => FAKE_CATALOG,
        runCommand: fakeRunCommand(h, {
          command: 'should-not-run',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
      });

      assert.deepEqual(state, { status: 'skipped' });
      assert.equal(h.runCalls.length, 0);
      assert.match(
        fs.readFileSync(h.logPath, 'utf8'),
        /Bootstrap: skipping disabled runtime profile 'pkg'/,
      );
    });

    it('still resolves an enabled profile when enabledRuntimeProfiles is a subset', async () => {
      const h = makeHarness();
      writeConfig(h.workspaceDir, JSON.stringify({ version: 1, profiles: ['go'] }));

      const state = await runBootstrap(h, {
        config: { enabledRuntimeProfiles: ['go'] },
        loadProfiles: () => FAKE_CATALOG,
        runCommand: fakeRunCommand(h, {
          command: 'go mod download',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
      });

      assert.equal(state.status, 'completed');
      assert.equal(state.command, 'go mod download');
      assert.deepEqual(state.profiles, ['go']);
    });

    it('defaults to all catalog profiles enabled when enabledRuntimeProfiles is undefined', async () => {
      const h = makeHarness();
      writeConfig(h.workspaceDir, JSON.stringify({ version: 1, profiles: ['pkg'] }));

      const state = await runBootstrap(h, {
        config: {},
        loadProfiles: () => FAKE_CATALOG,
        runCommand: fakeRunCommand(h, {
          command: 'npm ci --ignore-scripts',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
      });

      assert.equal(state.status, 'completed');
      assert.deepEqual(state.profiles, ['pkg']);
    });

    it('filters detected profiles against enabledRuntimeProfiles (source=detect)', async () => {
      const h = makeHarness();
      touchFile(h.workspaceDir, 'pnpm-lock.yaml');
      touchFile(h.workspaceDir, 'package.json');
      touchFile(h.workspaceDir, 'go.mod');
      writeConfig(h.workspaceDir, JSON.stringify({ version: 1 }));

      const state = await runBootstrap(h, {
        config: { enabledRuntimeProfiles: ['go'] },
        loadProfiles: () => FAKE_CATALOG,
        runCommand: fakeRunCommand(h, {
          command: 'go mod download',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
      });

      // pnpm is disabled by the gate (reported); go (go.mod) is enabled and
      // wins detection so pkg is never reached.
      assert.equal(state.status, 'completed');
      assert.equal(state.command, 'go mod download');
      assert.deepEqual(state.profiles, ['go']);
      const log = fs.readFileSync(h.logPath, 'utf8');
      assert.match(log, /Bootstrap: skipping disabled runtime profile 'pnpm'/);
      assert.match(log, /Bootstrap: source=detect profiles=\[go\] command=go mod download/);
    });

    it('globalSetupTimeoutMs overrides the repo setup.timeoutMs', async () => {
      const h = makeHarness();
      writeConfig(
        h.workspaceDir,
        JSON.stringify({ version: 1, setup: { command: 'npm ci', timeoutMs: 300_000 } }),
      );

      await runBootstrap(h, {
        config: { globalSetupTimeoutMs: 45_000 },
        runCommand: fakeRunCommand(h, {
          command: 'npm ci',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
      });

      assert.equal(h.runCalls[0].timeoutMs, 45_000);
    });

    it('keeps the repo setup.timeoutMs when globalSetupTimeoutMs is not set', async () => {
      const h = makeHarness();
      writeConfig(
        h.workspaceDir,
        JSON.stringify({ version: 1, setup: { command: 'npm ci', timeoutMs: 300_000 } }),
      );

      await runBootstrap(h, {
        config: {},
        runCommand: fakeRunCommand(h, {
          command: 'npm ci',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
      });

      assert.equal(h.runCalls[0].timeoutMs, 300_000);
    });
  });

  it('propagates profiles/source on a failed bootstrap', async () => {
      const h = makeHarness();
      writeConfig(
        h.workspaceDir,
        JSON.stringify({ version: 1, setup: { command: 'npm ci', failOnError: false } }),
      );

      const state = await runBootstrap(h, {
        loadProfiles: () => FAKE_CATALOG,
        runCommand: fakeRunCommand(h, {
          command: 'npm ci',
          exitCode: 1,
          outputTail: 'npm ERR! missing',
          timedOut: false,
          success: false,
        }),
      });

      assert.equal(state.status, 'failed');
      assert.equal(state.source, 'explicit');
      assert.deepEqual(state.profiles, []);
      assert.equal(h.agent.bootstrap?.source, 'explicit');
    });
  });

  describe('dependency cache explicit cacheKey (P3-T6)', () => {
    const NODEJS_CATALOG: Record<string, RuntimeProfile> = {
      ...FAKE_CATALOG,
      nodejs: {
        detect: ['package.json'],
        defaultSetup: 'npm ci --ignore-scripts',
        tools: [],
        cacheDirs: [],
      },
    };

    it('addresses the cache entry by the explicit cacheKey from environment.json', async () => {
      const h = makeHarness();
      touchFile(h.workspaceDir, 'package.json');
      writeConfig(
        h.workspaceDir,
        JSON.stringify({
          version: 1,
          setup: { command: 'npm ci --ignore-scripts' },
          cacheKey: 'myrepo-node22-pnpm9',
        }),
      );

      const restoreDirs: string[] = [];
      const snapshotDirs: string[] = [];
      await runBootstrap(h, {
        loadProfiles: () => NODEJS_CATALOG,
        runCommand: fakeRunCommand(h, {
          command: 'npm ci --ignore-scripts',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
        restoreCache: async (cacheDir) => {
          restoreDirs.push(cacheDir);
          return false;
        },
        snapshotCache: async (cacheDir) => {
          snapshotDirs.push(cacheDir);
        },
        depCache: { root: '/tmp/dep-cache-root', repoId: 'acme-demo' },
      });

      assert.equal(h.runCalls.length, 1);
      assert.equal(restoreDirs.length, 1);
      assert.equal(snapshotDirs.length, 1);
      const expected = path.join('/tmp/dep-cache-root', 'acme-demo', 'myrepo-node22-pnpm9');
      assert.equal(restoreDirs[0], expected);
      assert.equal(snapshotDirs[0], expected);
    });

    it('falls back to the hashed key when cacheKey is absent', async () => {
      const h = makeHarness();
      touchFile(h.workspaceDir, 'package.json');
      writeConfig(
        h.workspaceDir,
        JSON.stringify({ version: 1, setup: { command: 'npm ci --ignore-scripts' } }),
      );

      const restoreDirs: string[] = [];
      await runBootstrap(h, {
        loadProfiles: () => NODEJS_CATALOG,
        runCommand: fakeRunCommand(h, {
          command: 'npm ci --ignore-scripts',
          exitCode: 0,
          outputTail: 'ok',
          timedOut: false,
          success: true,
        }),
        restoreCache: async (cacheDir) => {
          restoreDirs.push(cacheDir);
          return false;
        },
        snapshotCache: async () => undefined,
        depCache: { root: '/tmp/dep-cache-root', repoId: 'acme-demo' },
      });

      assert.equal(restoreDirs.length, 1);
      const entry = path.basename(restoreDirs[0]);
      assert.notEqual(entry, 'unknown');
      assert.equal(entry.length, 64);
      assert.equal(restoreDirs[0].endsWith(path.join('acme-demo', entry)), true);
    });
  });
});