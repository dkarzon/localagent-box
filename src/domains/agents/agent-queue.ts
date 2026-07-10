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
  shouldStart: (agentId: string) => boolean;
  onStartAgent: (agentId: string) => void;
}): AgentQueue {
  const queue: string[] = [];

  function process(): void {
    while (options.getActiveWorkerCount() < options.maxConcurrent && queue.length > 0) {
      const agentId = queue.shift();
      if (!agentId) {
        continue;
      }
      if (!options.shouldStart(agentId)) {
        continue;
      }
      options.onStartAgent(agentId);
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
