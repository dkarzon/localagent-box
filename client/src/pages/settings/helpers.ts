import type { AppConfig, LlmProviderId, OllamaStatus, StatusVariant } from '../../api/types';

export function describeProviderStatus(
  status: OllamaStatus | null | undefined,
  label: string,
): {
  message: string;
  variant: StatusVariant;
  connected: boolean;
} {
  if (!status) return { message: 'No status', variant: '', connected: false };
  if (status.status === 'not_configured') {
    return { message: 'Not configured', variant: '', connected: false };
  }
  if (!status.reachable) {
    return {
      message: `${label} unreachable`,
      variant: 'error',
      connected: false,
    };
  }
  return { message: 'Connected', variant: 'success', connected: true };
}

export function fieldMatchesSearch(label: string, value: string, query: string) {
  const haystack = `${label} ${value}`.toLowerCase();
  return haystack.includes(query);
}

export function isProviderConfigured(
  config: AppConfig,
  providerId: LlmProviderId,
): boolean {
  if (providerId === 'ollama') {
    return Boolean(config.ollamaBaseUrl?.trim());
  }
  return Boolean(config.hasOllamaCloudApiKey || config.ollamaCloudApiKey?.trim());
}

export function modelOptions(
  catalog: string[],
  selected: string,
): string[] {
  if (selected && !catalog.includes(selected)) {
    return [selected, ...catalog];
  }
  return catalog;
}
