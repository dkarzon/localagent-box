import fs from 'fs';
import { getServerEnv } from '../../../config/env';
import { createConfigStore } from '../../../services/config-store';
import { createGithubAppService } from '../../../services/github-app';
import { createGitService } from '../../../services/git-service';
import { createJsonStore } from '../../../lib/json-store';
import type { Agent, AgentJob, AppConfig, Repo } from '../../../types';
import type { JsonStore } from '../../../lib/json-store';
import type { GitService } from '../../../services/git-service';
import type { GithubAppService } from '../../../services/github-app';

export interface WorkerContext {
  job: AgentJob;
  logPath: string;
  config: AppConfig;
  repo?: Repo;
  agentsStore: JsonStore<{ agents: Agent[] }>;
  gitService: GitService;
  githubApp: GithubAppService;
}

export function getAgentMode(job: AgentJob): import('../../../types').AgentMode {
  return job.mode || 'batch';
}

export async function createWorkerContext(job: AgentJob): Promise<WorkerContext> {
  const logPath = job.logPath;
  const configStore = createConfigStore(job.dataDir, fs);
  const githubApp = createGithubAppService();
  const gitService = createGitService({ githubApp, workspaceRoot: job.workspaceRoot });
  const agentsStore = createJsonStore<{ agents: Agent[] }>(`${job.dataDir}/agents.json`, { agents: [] }, fs);

  const config = configStore.loadConfig();
  // Operator env overrides for bootstrap (P2-T4): `config.json` rarely exists
  // in a worker sandbox, so these keys must be hydrated from the server env.
  const serverEnv = getServerEnv();
  if (typeof config.bootstrapAutoDetect !== 'boolean' && serverEnv.bootstrapAutoDetect) {
    config.bootstrapAutoDetect = true;
  }
  if (
    typeof config.globalSetupTimeoutMs !== 'number' &&
    serverEnv.bootstrapGlobalSetupTimeoutMs > 0
  ) {
    config.globalSetupTimeoutMs = serverEnv.bootstrapGlobalSetupTimeoutMs;
  }
  githubApp.assertConfigured(config);

  if (config.gitUserName || config.gitUserEmail) {
    gitService.applyGitConfig(config);
  }

  return {
    job,
    logPath,
    config,
    agentsStore,
    gitService,
    githubApp,
  };
}
