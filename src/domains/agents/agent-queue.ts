import type { QueueDecision } from './queue-eligibility';

export interface AgentQueue {
  enqueue: (agentId: string) => void;
  remove: (agentId: string) => void;
  clear: () => void;
  process: () => void;
  readonly length: number;
}

export function createAgentQueue(options: {
  maxConcurrent: number;
  getActiveWorkerCount: () => number;
  decide: (agentId: string) => QueueDecision;
  onStartAgent: (agentId: string) => void;
}): AgentQueue {
  const queue: string[] = [];

  function process(): void {
    while (options.getActiveWorkerCount() < options.maxConcurrent) {
      let started = false;
      for (let i = 0; i < queue.length; ) {
        const agentId = queue[i];
        const decision = options.decide(agentId);
        if (decision === 'drop') {
          queue.splice(i, 1);
          continue;
        }
        if (decision === 'start') {
          queue.splice(i, 1);
          options.onStartAgent(agentId);
          started = true;
          break;
        }
        i += 1;
      }
      if (!started) {
        break;
      }
    }
  }

  return {
    enqueue: (agentId) => {
      queue.push(agentId);
      process();
    },
    remove: (agentId) => {
      const index = queue.indexOf(agentId);
      if (index !== -1) {
        queue.splice(index, 1);
      }
    },
    clear: () => {
      queue.length = 0;
    },
    process,
    get length() {
      return queue.length;
    },
  };
}
