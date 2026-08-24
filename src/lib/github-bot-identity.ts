import type { AppConfig } from '../types';
import type { GithubAppService } from '../services/github-app';
import { needsBotGitIdentity } from '../services/github-app';

export async function maybePopulateBotGitIdentity(
  config: AppConfig,
  githubApp: GithubAppService,
  options: { onFailure?: (err: unknown) => void } = {},
): Promise<AppConfig> {
  if (!needsBotGitIdentity(config)) {
    return config;
  }

  try {
    const identity = await githubApp.resolveBotGitIdentity(config);
    return { ...config, ...identity };
  } catch (err) {
    options.onFailure?.(err);
    return config;
  }
}
