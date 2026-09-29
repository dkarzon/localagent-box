import {
  LLM_PROVIDER_LABELS,
  type AppConfig,
  type LlmProviderId,
  type OllamaStatus,
  type StatusVariant,
} from '../../api/types';
import type { SettingsSectionId } from '../../navigation';

/** Search keywords per settings card, grouped by section — drives card filtering and the empty state. */
export const SETTINGS_SEARCH_KEYWORDS = {
  general: {
    apiToken: ['api', 'token', 'bearer'],
    webhook: ['webhook', 'url', 'hook'],
    pullRequest: ['pull request', 'auto-create', 'pr'],
    workspace: ['workspace', 'cleanup', 'retention', 'delete', 'session'],
  },
  models: {
    local: ['ollama', 'local', 'model'],
    cloud: ['cloud', 'ollama cloud', 'api key'],
  },
  github: {
    app: ['github', 'git', 'app', 'private key'],
  },
  opencode: {
    defaults: ['opencode', 'model', 'provider', 'system prompt'],
    permissions: ['opencode', 'permissions', 'auto-approve', 'timeout', 'interactive', 'loop'],
    loop: ['loop', 'observe', 'plan', 'act', 'reflect', 'initial plan', 'model'],
  },
  ocr: {
    review: ['review', 'ocr', 'code review', 'auto-review'],
  },
} satisfies Record<SettingsSectionId, Record<string, string[]>>;

export function makeShowSection(searchQuery: string) {
  const query = searchQuery.trim().toLowerCase();
  return (labels: string[]) =>
    !query || labels.some((label) => label.toLowerCase().includes(query));
}

export function sectionMatchesSearch(id: SettingsSectionId, searchQuery: string): boolean {
  const showSection = makeShowSection(searchQuery);
  return Object.values(SETTINGS_SEARCH_KEYWORDS[id]).some(showSection);
}

export function describeModelCatalog(
  status: OllamaStatus | null | undefined,
  providerId: LlmProviderId,
): { catalog: string[]; unreachableLabel: string } {
  const catalog = [...(status?.models ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((model) => model.name);
  const unreachableLabel =
    status?.reachable === false
      ? `— ${LLM_PROVIDER_LABELS[providerId]} unreachable —`
      : '— no models available —';
  return { catalog, unreachableLabel };
}

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
