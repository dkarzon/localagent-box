import { normalizeProbeBaseUrl } from './opencode-config';
import type { OllamaProbeResult } from '../types';

export const PROBE_TIMEOUT_MS = 5000;

export interface OllamaProbeOptions {
  baseUrl?: string;
  apiKey?: string;
  notConfiguredMessage?: string;
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

function normalizeProbeOptions(
  options: OllamaProbeOptions | string | undefined,
): OllamaProbeOptions {
  if (typeof options === 'string') {
    return { baseUrl: options };
  }
  return options ?? {};
}

export function createOllamaProbe(options: { fetchImpl?: typeof fetch } = {}): OllamaProbe {
  const fetchImpl = options.fetchImpl || fetch;

  async function probe(
    input: OllamaProbeOptions | string | undefined,
  ): Promise<OllamaProbeResult> {
    const { baseUrl, apiKey, notConfiguredMessage } = normalizeProbeOptions(input);

    if (!baseUrl || !baseUrl.trim()) {
      return {
        status: 'not_configured',
        reachable: false,
        message: notConfiguredMessage || 'base URL is not set',
      };
    }

    const probeUrl = `${normalizeProbeBaseUrl(baseUrl)}/api/tags`;
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

      const data = (await response.json()) as OllamaTagsResponse;
      const models = Array.isArray(data.models)
        ? data.models
            .filter((entry) => entry?.name)
            .map((entry) => ({
              name: entry.name as string,
              size: typeof entry.size === 'number' ? entry.size : undefined,
              modifiedAt: entry.modified_at || undefined,
            }))
        : [];

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
        message: err instanceof Error ? err.message : 'Failed to reach Ollama',
      };
    }
  }

  return { probe };
}
