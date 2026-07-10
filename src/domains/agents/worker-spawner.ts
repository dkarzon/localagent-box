import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { getLogger } from '../../lib/logger';
import type { Agent, AgentJob, SpawnFn } from '../../types';
import type { AgentRepository } from './agent.repository';
import { getAgentMode } from './agent.types';

const WORKER_ENTRY = path.join(__dirname, '..', '..', 'entrypoints', 'workers', 'agent-worker');

function resolveWorkerLaunch(): { executable: string; args: string[] } {
  const compiled = `${WORKER_ENTRY}.js`;
  if (fs.existsSync(compiled)) {
    return { executable: process.execPath, args: [compiled] };
  }

  const source = `${WORKER_ENTRY}.ts`;
  if (!fs.existsSync(source)) {
    throw new Error(`Agent worker entry not found (tried ${compiled} and ${source})`);
  }

  const tsxCli = require.resolve('tsx/cli');
  return { executable: process.execPath, args: [tsxCli, source] };
}

type FsLike = Pick<
  typeof import('fs'),
  'mkdirSync' | 'existsSync' | 'writeFileSync' | 'appendFileSync'
>;

export interface WorkerSpawner {
  start: (agent: Agent) => void;
  kill: (agentId: string) => ChildProcess | undefined;
  has: (agentId: string) => boolean;
  activeCount: () => number;
  shutdown: () => Promise<void>;
}

const DEFAULT_SHUTDOWN_WAIT_MS = 30_000;

export function createWorkerSpawner(options: {
  repository: AgentRepository;
  dataDir: string;
  workspaceRoot: string;
  agentTimeoutMs: number;
  getInteractiveAgentTimeoutMs: () => number;
  getLoopAgentTimeoutMs: () => number;
  shutdownWaitMs?: number;
  fs?: FsLike;
  path?: typeof path;
  spawn?: SpawnFn;
  onWorkerExit: (agentId: string, code: number | null, signal: NodeJS.Signals | null) => void;
  onWorkerError: (agentId: string, message: string) => void;
}): WorkerSpawner {
  const fsImpl = options.fs || fs;
  const pathImpl = options.path || path;
  const spawnImpl = options.spawn || spawn;
  const workers = new Map<string, ChildProcess>();

  function pumpStream(stream: NodeJS.ReadableStream | null | undefined, logPath: string): void {
    stream?.on('data', (chunk: Buffer) => {
      fsImpl.appendFileSync(logPath, chunk);
    });
  }

  function start(agent: Agent): void {
    const log = getLogger().child({
      agentId: agent.agentId,
      repoId: agent.repoId,
      workspaceId: agent.workspaceId,
    });
    log.info({ mode: getAgentMode(agent) }, 'Starting agent worker');

    const agentDir = options.repository.getAgentDir(agent.agentId);
    fsImpl.mkdirSync(agentDir, { recursive: true });
    const logPath = options.repository.getLogPath(agent.agentId);
    if (!fsImpl.existsSync(logPath)) {
      fsImpl.writeFileSync(logPath, '', 'utf8');
    }

    const mode = getAgentMode(agent);
    const job: AgentJob = {
      agentId: agent.agentId,
      workspaceId: agent.workspaceId,
      repoId: agent.repoId,
      mode,
      prompt: agent.prompt,
      systemPrompt: agent.systemPrompt || undefined,
      baseBranch: agent.baseBranch,
      agentBranch: agent.agentBranch,
      useExistingBranch: agent.useExistingBranch,
      commitMessage: agent.commitMessage,
      push: agent.push,
      pushOnFailure: agent.pushOnFailure,
      autoApprovePermissions: agent.autoApprovePermissions,
      model: agent.model || undefined,
      ...(agent.loopVerbModels ? { loopVerbModels: agent.loopVerbModels } : {}),
      agentTimeoutMs:
        mode === 'interactive'
          ? options.getInteractiveAgentTimeoutMs()
          : mode === 'loop'
            ? options.getLoopAgentTimeoutMs()
            : options.agentTimeoutMs,
      dataDir: options.dataDir,
      workspaceRoot: options.workspaceRoot,
      workspaceDir: options.repository.getWorkspaceDir(agent.workspaceId),
      logPath,
    };

    const jobPath = pathImpl.join(agentDir, 'job.json');
    fsImpl.writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');

    const { executable, args } = resolveWorkerLaunch();
    const child = spawnImpl(executable, args, {
      env: {
        ...process.env,
        LOCALAGENT_JOB_FILE: jobPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    workers.set(agent.agentId, child);
    pumpStream(child.stdout, logPath);
    pumpStream(child.stderr, logPath);

    child.on('exit', (code, signal) => {
      workers.delete(agent.agentId);
      options.onWorkerExit(agent.agentId, code, signal);
    });

    child.on('error', (err) => {
      workers.delete(agent.agentId);
      options.onWorkerError(agent.agentId, err.message);
    });
  }

  function kill(agentId: string): ChildProcess | undefined {
    const child = workers.get(agentId);
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
    workers.delete(agentId);
    return child;
  }

  return {
    start,
    kill,
    has: (agentId) => workers.has(agentId),
    activeCount: () => workers.size,
    shutdown: () => {
      getLogger().info({ workerCount: workers.size }, 'Shutting down agent workers');
      const children = [...workers.values()];

      for (const child of children) {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      }

      workers.clear();

      if (children.length === 0) {
        return Promise.resolve();
      }

      const shutdownWaitMs = options.shutdownWaitMs ?? DEFAULT_SHUTDOWN_WAIT_MS;

      return new Promise((resolve) => {
        let remaining = children.length;
        let settled = false;

        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve();
        };

        const onDone = () => {
          remaining -= 1;
          if (remaining <= 0) {
            finish();
          }
        };

        const timer = setTimeout(() => {
          getLogger().warn(
            { workerCount: children.length, shutdownWaitMs },
            'Worker shutdown timed out waiting for child processes',
          );
          finish();
        }, shutdownWaitMs);
        timer.unref();

        for (const child of children) {
          child.once('exit', onDone);
          child.once('error', onDone);
        }
      });
    },
  };
}
