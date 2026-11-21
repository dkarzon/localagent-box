import type { getServerEnv } from '../../config/env';
import { isLlmProviderId } from '../../lib/llm-provider';
import { isValidHttpUrl } from '../../lib/validation';
import type { AppConfig, ConfigPartial } from '../../types';

type ServerEnv = ReturnType<typeof getServerEnv>;

/**
 * Settings seeded from env / `.env` (OLLAMA_*, OPENAI_COMPATIBLE_*, OPENCODE_MODEL/PROVIDER).
 * Only fills fields still empty in `current` — values saved in Settings always win.
 * The server persists the result on startup; the smoke test applies it in memory.
 */
export function buildEnvConfigDefaults(
  current: AppConfig,
  env: ServerEnv,
  warn: (fields: Record<string, unknown>, message: string) => void = () => undefined,
): ConfigPartial {
  const partial: ConfigPartial = {};

  if (env.ollamaBaseUrl && !current.ollamaBaseUrl) {
    partial.ollamaBaseUrl = env.ollamaBaseUrl;
    partial.opencodeModel = env.opencodeModel || current.opencodeModel;
    if (env.opencodeProvider && !isLlmProviderId(env.opencodeProvider)) {
      warn({ opencodeProvider: env.opencodeProvider }, 'Ignoring invalid OPENCODE_PROVIDER env value');
    }
    partial.opencodeProvider = isLlmProviderId(env.opencodeProvider)
      ? env.opencodeProvider
      : current.opencodeProvider;
  }
  if (env.ollamaCloudApiKey && !current.ollamaCloudApiKey) {
    partial.ollamaCloudApiKey = env.ollamaCloudApiKey;
  }
  if (env.ollamaCloudBaseUrl && !current.ollamaCloudBaseUrl) {
    if (isValidHttpUrl(env.ollamaCloudBaseUrl)) {
      partial.ollamaCloudBaseUrl = env.ollamaCloudBaseUrl;
    } else {
      warn(
        { ollamaCloudBaseUrl: env.ollamaCloudBaseUrl },
        'Ignoring invalid OLLAMA_CLOUD_BASE_URL env value (must be an http(s) URL)',
      );
    }
  }
  if (env.openaiCompatibleBaseUrl && !current.openaiCompatibleBaseUrl) {
    if (isValidHttpUrl(env.openaiCompatibleBaseUrl)) {
      partial.openaiCompatibleBaseUrl = env.openaiCompatibleBaseUrl;
      if (env.opencodeProvider === 'openai-compatible') {
        partial.opencodeProvider = 'openai-compatible';
        partial.opencodeModel = env.opencodeModel || current.opencodeModel;
      }
    } else {
      warn(
        { openaiCompatibleBaseUrl: env.openaiCompatibleBaseUrl },
        'Ignoring invalid OPENAI_COMPATIBLE_BASE_URL env value (must be an http(s) URL)',
      );
    }
  }
  if (env.openaiCompatibleApiKey && !current.openaiCompatibleApiKey) {
    partial.openaiCompatibleApiKey = env.openaiCompatibleApiKey;
  }

  return partial;
}
