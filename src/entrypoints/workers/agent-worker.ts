import fs from 'fs';
import { createJsonStore } from '../../lib/json-store';
import { getLogger } from '../../lib/logger';
import { buildInteractiveState, INTERACTIVE_ACTIVE_STATUSES } from '../../lib/interactive-state';
import { buildLoopState, LOOP_ACTIVE_STATUSES } from '../../lib/loop-state';
import { BATCH_ACTIVE_STATUSES } from '../../domains/agents/agent.types';
import type { Agent, AgentJob } from '../../types';
import { appendLog } from '../../domains/agents/worker/agent-state-writer';
import { runBatchJob } from '../../domains/agents/worker/batch-run-flow';
import { runLoopJob } from '../../domains/agents/worker/loop-run-flow';
import { createWorkerContext, getAgentMode } from '../../domains/agents/worker/worker-context';
import { prepareWorkspace } from '../../domains/agents/worker/workspace-setup';
import { runInteractiveSession } from '../../domains/agents/worker/interactive-session';

export async function runJob(job: AgentJob): Promise<void> {
  const ctx = await createWorkerContext(job);
  await prepareWorkspace(ctx);

  if (getAgentMode(job) === 'interactive') {
    await runInteractiveSession(ctx);
  } else if (getAgentMode(job) === 'loop') {
    await runLoopJob(ctx);
  } else {
    await runBatchJob(ctx);
  }
}

async function main(): Promise<void> {
  const jobFile = process.env.LOCALAGENT_JOB_FILE;
  if (!jobFile || !fs.existsSync(jobFile)) {
    getLogger().fatal('LOCALAGENT_JOB_FILE missing or not found');
    process.exit(1);
  }

  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8')) as AgentJob;
  const log = getLogger().child({ agentId: job.agentId, repoId: job.repoId });
  const agentsStore = createJsonStore<{ agents: Agent[] }>(`${job.dataDir}/agents.json`, { agents: [] }, fs);
  const mode = getAgentMode(job);
  const activeStatuses =
    mode === 'interactive'
      ? INTERACTIVE_ACTIVE_STATUSES
      : mode === 'loop'
        ? LOOP_ACTIVE_STATUSES
        : BATCH_ACTIVE_STATUSES;

  try {
    await runJob(job);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Agent worker failed';
    if (job.logPath) {
      appendLog(job.logPath, `ERROR: ${message}`);
    }

    const data = agentsStore.load();
    const agents = data.agents || [];
    const index = agents.findIndex((entry: Agent) => entry.agentId === job.agentId);
    if (index !== -1 && activeStatuses.has(agents[index].status)) {
      const wasCompleting = agents[index].status === 'completing';
      agents[index] = {
        ...agents[index],
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error:
          wasCompleting && mode === 'interactive'
            ? `Finish failed during workspace setup: ${message}`
            : message,
        pushed: false,
      };
      if (mode === 'interactive') {
        agents[index].interactive = buildInteractiveState('failed');
      }
      if (mode === 'loop') {
        agents[index].loop = buildLoopState('failed', agents[index].loop, agents[index]);
      }
      agentsStore.save({ agents });
    }

    log.error({ err }, message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { appendLog } from '../../domains/agents/worker/agent-state-writer';
