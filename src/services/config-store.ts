import type { AppConfig, ConfigPartial, PublicConfig } from '../types';
import { getLogger } from '../lib/logger';
import { sanitizeModelTokenCosts } from '../lib/model-cost';
import { resolveOpenCodeProvider } from '../lib/llm-provider';

/**
 * Keys from modes removed in v1. They are no longer part of `AppConfig`, so a
 * pre-v1 `config.json` that still lists them is dropped with a warning rather
 * than being kept in memory and written back.
 */
export const LEGACY_CONFIG_KEYS = [
  'interactiveAutoApprovePermissions',
  'interactiveAgentTimeoutSeconds',
  'loopAutoApprovePermissions',
  'loopAgentTimeoutSeconds',
  'loopVerbModels',
  'loopDefaultMaxIterations',
] as const;

/**
 * Keys `AppConfig` declares but `DEFAULT_CONFIG` does not default; a `config.json`
 * may still set them, so they are not unknown.
 */
const OPTIONAL_CONFIG_KEYS = ['enabledRuntimeProfiles', 'bootstrapAutoDetect', 'globalSetupTimeoutMs'] as const;

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

type WarnLogger = { warn(obj: Record<string, unknown>, message: string): void };

export function createConfigStore(
  dataDir: string,
  fs: FsLike,
  logger: WarnLogger = getLogger(),
): ConfigStore {
  const configPath = `${dataDir}/config.json`;

  function loadRaw(): AppConfig {
    try {
      const rawParsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      // A top-level JSON `null` (or any other non-object) must still fall back to
      // defaults, as the previous spread-based load did — `Object.keys(null)` throws.
      const parsed: Record<string, unknown> =
        rawParsed !== null && typeof rawParsed === 'object'
          ? (rawParsed as Record<string, unknown>)
          : {};
      const knownKeys = new Set<string>([...Object.keys(DEFAULT_CONFIG), ...OPTIONAL_CONFIG_KEYS]);
      const unknownKeys = Object.keys(parsed).filter((key) => !knownKeys.has(key));
      if (unknownKeys.length > 0) {
        logger.warn({ keys: unknownKeys }, 'ignoring unknown config keys');
      }

      const config = {
        ...DEFAULT_CONFIG,
        ...Object.fromEntries(Object.entries(parsed).filter(([key]) => knownKeys.has(key))),
      } as AppConfig;
      config.modelTokenCosts = sanitizeModelTokenCosts(config.modelTokenCosts);
      return config;
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
