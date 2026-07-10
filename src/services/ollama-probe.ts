import { normalizeProbeBaseUrl } from './opencode-config';
import type { OllamaProbeResult } from '../types';

export const PROBE_TIMEOUT_MS = 5000;

export interface OllamaProbe {
  probe: (baseUrl: string | undefined) => Promise<OllamaProbeResult>;
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    size?: number;
    modified_at?: string;
  }>;
}

export function createOllamaProbe(options: { fetchImpl?: typeof fetch } = {}): OllamaProbe {
  const fetchImpl = options.fetchImpl || fetch;

  async function probe(baseUrl: string | undefined): Promise<OllamaProbeResult> {
    if (!baseUrl || !baseUrl.trim()) {
      return {
        status: 'not_configured',
        reachable: false,
        message: 'ollamaBaseUrl is not set',
      };
    }

    const probeUrl = `${normalizeProbeBaseUrl(baseUrl)}/api/tags`;

    try {
      const response = await fetchImpl(probeUrl, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });

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
