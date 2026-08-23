import type { AppConfig, ConfigPartial, LoopVerbModels, PublicConfig } from '../types';
import { loadServerDefaultLoopConfig } from '../domains/agents/worker/loop-config';
import { normalizeLoopVerbModels } from '../lib/loop-verb-models';

export const DEFAULT_CONFIG: AppConfig = {
  ollamaBaseUrl: '',
  opencodeModel: '',
  opencodeProvider: 'ollama',
  systemPrompt: '',
  githubAppId: '',
  githubAppInstallationId: '',
  githubAppPrivateKey: '',
  gitUserName: '',
  gitUserEmail: '',
  webhookUrl: '',
  batchAutoApprovePermissions: true,
  loopAutoApprovePermissions: true,
  interactiveAutoApprovePermissions: false,
  autoCreatePullRequest: true,
  autoReviewPullRequests: false,
  reviewModel: '',
  interactiveAgentTimeoutSeconds: 3600,
  loopAgentTimeoutSeconds: 3600,
  loopVerbModels: {
    INITIAL_PLAN: '',
    ORIENT: '',
    ACT: '',
    REFLECT: '',
  },
};

export function getLoopVerbModelsDefault(): LoopVerbModels {
  return {
    INITIAL_PLAN: '',
    ORIENT: '',
    ACT: '',
    REFLECT: '',
  };
}

export interface ConfigStore {
  loadConfig: () => AppConfig;
  saveConfig: (partial: ConfigPartial) => AppConfig;
  toPublicConfig: (config: AppConfig) => PublicConfig;
}

type FsLike = Pick<
  typeof import('fs'),
  'readFileSync' | 'writeFileSync' | 'existsSync' | 'mkdirSync'
>;

export function createConfigStore(dataDir: string, fs: FsLike): ConfigStore {
  const configPath = `${dataDir}/config.json`;

  function loadRaw(): AppConfig {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as AppConfig;
      // Migrate configs persisted before OBSERVE/PLAN were merged into ORIENT.
      parsed.loopVerbModels = {
        ...getLoopVerbModelsDefault(),
        ...normalizeLoopVerbModels(parsed.loopVerbModels),
      };
      return parsed;
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
        return { ...DEFAULT_CONFIG };
      }
      throw err;
    }
  }

  function saveRaw(config: AppConfig): void {
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  function loadConfig(): AppConfig {
    return loadRaw();
  }

  function saveConfig(partial: ConfigPartial): AppConfig {
    const current = loadRaw();
    const allowed = Object.keys(DEFAULT_CONFIG) as (keyof AppConfig)[];
    const sanitized = Object.fromEntries(
      allowed.flatMap((key) =>
        Object.prototype.hasOwnProperty.call(partial, key) ? [[key, partial[key]]] : [],
      ),
    ) as ConfigPartial;
    const next: AppConfig = { ...current, ...sanitized };
    saveRaw(next);
    return next;
  }

  function toPublicConfig(config: AppConfig): PublicConfig {
    return {
      ollamaBaseUrl: config.ollamaBaseUrl,
      opencodeModel: config.opencodeModel,
      opencodeProvider: config.opencodeProvider,
      systemPrompt: config.systemPrompt || null,
      githubAppId: config.githubAppId,
      githubAppInstallationId: config.githubAppInstallationId,
      githubAppPrivateKey: config.githubAppPrivateKey ? '***' : '',
      hasGithubAppPrivateKey: Boolean(config.githubAppPrivateKey),
      gitUserName: config.gitUserName,
      gitUserEmail: config.gitUserEmail,
      webhookUrl: config.webhookUrl,
      batchAutoApprovePermissions: config.batchAutoApprovePermissions !== false,
      loopAutoApprovePermissions: config.loopAutoApprovePermissions !== false,
      interactiveAutoApprovePermissions: config.interactiveAutoApprovePermissions === true,
      interactiveAgentTimeoutSeconds: config.interactiveAgentTimeoutSeconds || 3600,
      loopAgentTimeoutSeconds: config.loopAgentTimeoutSeconds || 3600,
      autoCreatePullRequest: config.autoCreatePullRequest !== false,
      autoReviewPullRequests: config.autoReviewPullRequests === true,
      reviewModel: config.reviewModel || '',
      loopVerbModels: config.loopVerbModels,
      loopDefaultMaxIterations: loadServerDefaultLoopConfig().maxIterations,
    };
  }

  return { loadConfig, saveConfig, toPublicConfig };
}
