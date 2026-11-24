import type { AppConfig, ConfigPartial, PublicConfig } from '../types';
import { sanitizeModelTokenCosts } from '../lib/model-cost';
import { resolveOpenCodeProvider } from '../lib/llm-provider';

export const DEFAULT_CONFIG: AppConfig = {
  ollamaBaseUrl: '',
  ollamaCloudApiKey: '',
  ollamaCloudBaseUrl: '',
  openaiCompatibleBaseUrl: '',
  openaiCompatibleApiKey: '',
  opencodeModel: '',
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
  autoCreatePullRequest: true,
  autoReviewPullRequests: false,
  reviewModel: '',
  ocrSkipWorkspaceBootstrap: false,
  modelTokenCosts: {},
};

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
      parsed.modelTokenCosts = sanitizeModelTokenCosts(parsed.modelTokenCosts);
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
      ollamaCloudApiKey: config.ollamaCloudApiKey ? '***' : '',
      ollamaCloudBaseUrl: config.ollamaCloudBaseUrl,
      hasOllamaCloudApiKey: Boolean(config.ollamaCloudApiKey),
      openaiCompatibleBaseUrl: config.openaiCompatibleBaseUrl,
      openaiCompatibleApiKey: config.openaiCompatibleApiKey ? '***' : '',
      hasOpenaiCompatibleApiKey: Boolean(config.openaiCompatibleApiKey),
      opencodeModel: config.opencodeModel,
      opencodeProvider: resolveOpenCodeProvider(config),
      reviewProvider: config.reviewProvider || '',
      systemPrompt: config.systemPrompt || null,
      githubAppId: config.githubAppId,
      githubAppInstallationId: config.githubAppInstallationId,
      githubAppPrivateKey: config.githubAppPrivateKey ? '***' : '',
      hasGithubAppPrivateKey: Boolean(config.githubAppPrivateKey),
      gitUserName: config.gitUserName,
      gitUserEmail: config.gitUserEmail,
      webhookUrl: config.webhookUrl,
      batchAutoApprovePermissions: config.batchAutoApprovePermissions !== false,
      autoCreatePullRequest: config.autoCreatePullRequest !== false,
      autoReviewPullRequests: config.autoReviewPullRequests === true,
      reviewModel: config.reviewModel || '',
      ocrSkipWorkspaceBootstrap: config.ocrSkipWorkspaceBootstrap === true,
      modelTokenCosts: config.modelTokenCosts ?? {},
    };
  }

  return { loadConfig, saveConfig, toPublicConfig };
}
