import { normalizeOpenCodeBaseUrl, normalizeProbeBaseUrl } from './opencode-config';
import {
  isProviderConfigured,
  providerApi,
  resolveOpenCodeProvider,
  resolveProviderHost,
  type ProviderApi,
} from '../lib/llm-provider';
import type { AppConfig, OllamaModel, OllamaProbeResult } from '../types';

export const PROBE_TIMEOUT_MS = 5000;

export interface OllamaProbeOptions {
  baseUrl?: string;
  apiKey?: string;
  notConfiguredMessage?: string;
  /** Default `ollama` (`/api/tags`); `openai` lists `/v1/models`. */
  api?: ProviderApi;
}

export interface OllamaProbe {
  probe: (options: OllamaProbeOptions | string | undefined) => Promise<OllamaProbeResult>;
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    size?: number;
    modified_at?: string;
  }>;
}

interface OpenAiModelsResponse {
  data?: Array<Record<string, unknown> & { id?: unknown; created?: unknown }>;
}

/** Strata's `/health` (outside `/v1`) reports the loaded model's context window. */
interface StrataHealthResponse {
  model?: unknown;
  max_context?: unknown;
}

/** Per-model context fields reported by common OpenAI-compatible servers (vLLM, OpenRouter, Strata). */
const CONTEXT_LENGTH_FIELDS = ['max_model_len', 'context_length', 'max_context', 'context_window'];

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function normalizeProbeOptions(
  options: OllamaProbeOptions | string | undefined,
): OllamaProbeOptions {
  if (typeof options === 'string') {
    return { baseUrl: options };
  }
  return options ?? {};
}

function parseOllamaModels(data: OllamaTagsResponse): OllamaModel[] {
  return Array.isArray(data.models)
    ? data.models
        .filter((entry) => entry?.name)
        .map((entry) => ({
          name: entry.name as string,
          size: typeof entry.size === 'number' ? entry.size : undefined,
          modifiedAt: entry.modified_at || undefined,
        }))
    : [];
}

function parseOpenAiModels(data: OpenAiModelsResponse): OllamaModel[] {
  return Array.isArray(data.data)
    ? data.data
        .filter((entry) => typeof entry?.id === 'string' && entry.id.trim())
        .map((entry) => {
          const created = positiveInt(entry.created);
          const contextLength = CONTEXT_LENGTH_FIELDS.map((field) => positiveInt(entry[field])).find(
            (value) => value !== undefined,
          );
          return {
            name: (entry.id as string).trim(),
            modifiedAt: created ? new Date(created * 1000).toISOString() : undefined,
            contextLength,
          };
        })
    : [];
}

export function createOllamaProbe(options: { fetchImpl?: typeof fetch } = {}): OllamaProbe {
  const fetchImpl = options.fetchImpl || fetch;

  /** Best-effort: fill missing context lengths from Strata's `/health`; other servers are ignored. */
  async function applyStrataHealthContext(
    baseUrl: string,
    headers: Record<string, string>,
    models: OllamaModel[],
  ): Promise<OllamaModel[]> {
    if (models.length === 0 || models.some((model) => model.contextLength)) {
      return models;
    }
    try {
      const response = await fetchImpl(`${normalizeProbeBaseUrl(baseUrl)}/health`, {
        headers,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) {
        return models;
      }
      const health = (await response.json()) as StrataHealthResponse;
      const maxContext = positiveInt(health?.max_context);
      if (!maxContext) {
        return models;
      }
      const loaded = typeof health.model === 'string' ? health.model : '';
      return models.map((model) =>
        model.name === loaded || models.length === 1
          ? { ...model, contextLength: maxContext }
          : model,
      );
    } catch {
      return models;
    }
  }

  async function probe(
    input: OllamaProbeOptions | string | undefined,
  ): Promise<OllamaProbeResult> {
    const { baseUrl, apiKey, notConfiguredMessage, api = 'ollama' } = normalizeProbeOptions(input);

    if (!baseUrl || !baseUrl.trim()) {
      return {
        status: 'not_configured',
        reachable: false,
        message: notConfiguredMessage || 'base URL is not set',
      };
    }

    const probeUrl =
      api === 'openai'
        ? `${normalizeOpenCodeBaseUrl(baseUrl)}/models`
        : `${normalizeProbeBaseUrl(baseUrl)}/api/tags`;
    const headers: Record<string, string> = {};
    if (apiKey?.trim()) {
      headers.Authorization = `Bearer ${apiKey.trim()}`;
    }

    try {
      const response = await fetchImpl(probeUrl, {
        headers,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });

      if (response.status === 401 || response.status === 403) {
        return {
          status: 'error',
          reachable: false,
          url: probeUrl,
          message: 'Invalid or missing API key',
        };
      }

      if (!response.ok) {
        return {
          status: 'error',
          reachable: false,
          url: probeUrl,
          message: `HTTP ${response.status}`,
        };
      }

      const models =
        api === 'openai'
          ? await applyStrataHealthContext(
              baseUrl,
              headers,
              parseOpenAiModels((await response.json()) as OpenAiModelsResponse),
            )
          : parseOllamaModels((await response.json()) as OllamaTagsResponse);

      return {
        status: 'ok',
        reachable: true,
        url: probeUrl,
        modelCount: models.length,
        models,
      };
    } catch (err) {
      return {
        status: 'error',
        reachable: false,
        url: probeUrl,
        message: err instanceof Error ? err.message : 'Failed to reach model server',
      };
    }
  }

  return { probe };
}

/**
 * Context windows reported by the OpenCode provider, keyed by model id. Empty for Ollama
 * providers (they don't report one via the probe) or when the server can't be reached.
 */
export async function resolveModelContextLengths(
  config: AppConfig,
  probe: OllamaProbe = createOllamaProbe(),
): Promise<Record<string, number>> {
  const providerId = resolveOpenCodeProvider(config);
  if (providerApi(providerId) !== 'openai' || !isProviderConfigured(config, providerId)) {
    return {};
  }
  const host = resolveProviderHost(config, providerId);
  const result = await probe.probe({ baseUrl: host.baseUrl, apiKey: host.apiKey, api: 'openai' });
  return Object.fromEntries(
    (result.models ?? []).flatMap((model) =>
      model.contextLength ? [[model.name, model.contextLength] as const] : [],
    ),
  );
}
