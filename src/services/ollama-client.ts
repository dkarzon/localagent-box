import {
  isProviderConfigured,
  resolveOpenCodeProvider,
  resolveProviderHost,
  stripProviderModelPrefix,
} from '../lib/llm-provider';
import { normalizeProbeBaseUrl } from './opencode-config';
import type { AppConfig } from '../types';

const CHAT_TIMEOUT_MS = 60_000;

export interface OllamaGenerateResult {
  text: string;
}

export interface OllamaChatService {
  generateText: (config: AppConfig, messages: OllamaMessage[], model?: string) => Promise<OllamaGenerateResult>;
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
  done?: boolean;
}

export function createOllamaChat(): OllamaChatService {
  async function chatCompletion(
    messages: Array<{ role?: string; content?: string }>,
    model: string,
    baseUrl: string,
    apiKey?: string,
  ): Promise<string> {
    const url = `${normalizeProbeBaseUrl(baseUrl)}/api/chat`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey?.trim()) {
      headers.Authorization = `Bearer ${apiKey.trim()}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Ollama chat failed with HTTP ${response.status}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    return data.message?.content || '';
  }

  function resolveModel(config: AppConfig, override?: string): string {
    if (override?.trim()) {
      return stripProviderModelPrefix(override);
    }
    const m = config.opencodeModel;
    if (m) {
      return stripProviderModelPrefix(m);
    }
    return '';
  }

  async function generateText(
    config: AppConfig,
    messages: OllamaMessage[],
    modelOverride?: string,
  ): Promise<OllamaGenerateResult> {
    const providerId = resolveOpenCodeProvider(config);
    if (!isProviderConfigured(config, providerId)) {
      throw new Error(`OpenCode provider "${providerId}" is not configured`);
    }

    const host = resolveProviderHost(config, providerId);
    let model = modelOverride || resolveModel(config);
    if (!model.trim()) {
      return { text: '' };
    }

    model = stripProviderModelPrefix(model);
    const payload = messages.map((m) => ({ role: m.role, content: m.content }));

    const content = await chatCompletion(payload, model, host.baseUrl, host.apiKey);
    return { text: content };
  }

  return { generateText };
}
