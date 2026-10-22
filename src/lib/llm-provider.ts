import {
  DEFAULT_OLLAMA_CLOUD_BASE_URL,
  LLM_PROVIDER_IDS,
  type AppConfig,
  type LlmProviderId,
} from '../types';

export { LLM_PROVIDER_IDS, DEFAULT_OLLAMA_CLOUD_BASE_URL };

/** Wire protocol used for probing and direct chat (OpenCode itself always uses `/v1`). */
export type ProviderApi = 'ollama' | 'openai';

export function isLlmProviderId(value: unknown): value is LlmProviderId {
  return typeof value === 'string' && (LLM_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isProviderConfigured(config: AppConfig, id: LlmProviderId): boolean {
  switch (id) {
    case 'ollama':
      return Boolean(config.ollamaBaseUrl?.trim());
    case 'ollama-cloud':
      return Boolean(config.ollamaCloudApiKey?.trim());
    case 'openai-compatible':
      return Boolean(config.openaiCompatibleBaseUrl?.trim());
    default:
      return false;
  }
}

export function resolveOpenCodeProvider(config: AppConfig): LlmProviderId {
  if (isLlmProviderId(config.opencodeProvider)) {
    return config.opencodeProvider;
  }
  return 'ollama';
}

export function resolveReviewProvider(config: AppConfig): LlmProviderId {
  if (config.reviewProvider && isLlmProviderId(config.reviewProvider)) {
    return config.reviewProvider;
  }
  return resolveOpenCodeProvider(config);
}

export function resolveProviderHost(
  config: AppConfig,
  id: LlmProviderId,
): { baseUrl: string; apiKey?: string } {
  switch (id) {
    case 'ollama':
      return { baseUrl: config.ollamaBaseUrl?.trim() ?? '' };
    case 'ollama-cloud':
      return {
        baseUrl: config.ollamaCloudBaseUrl?.trim() || DEFAULT_OLLAMA_CLOUD_BASE_URL,
        apiKey: config.ollamaCloudApiKey?.trim(),
      };
    case 'openai-compatible':
      return {
        baseUrl: config.openaiCompatibleBaseUrl?.trim() ?? '',
        apiKey: config.openaiCompatibleApiKey?.trim() || undefined,
      };
  }
}

export function providerApi(id: LlmProviderId): ProviderApi {
  return id === 'openai-compatible' ? 'openai' : 'ollama';
}

export function providerNotConfiguredMessage(id: LlmProviderId): string {
  switch (id) {
    case 'ollama':
      return 'ollamaBaseUrl is not set';
    case 'ollama-cloud':
      return 'ollamaCloudApiKey is not set';
    case 'openai-compatible':
      return 'openaiCompatibleBaseUrl is not set';
  }
}

export function stripProviderModelPrefix(model: string): string {
  return model.trim().replace(/^(ollama|ollama-cloud|openai-compatible)\//i, '');
}

export function providerDisplayName(id: LlmProviderId): string {
  switch (id) {
    case 'ollama':
      return 'Ollama';
    case 'ollama-cloud':
      return 'Ollama Cloud';
    case 'openai-compatible':
      return 'OpenAI-compatible';
  }
}
