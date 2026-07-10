import type { AppConfig } from '../types';
import { normalizeProbeBaseUrl } from './opencode-config';

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
  async function chatCompletion(messages: Array<{ role?: string; content?: string }>, model: string, baseUrl: string): Promise<string> {
    const url = `${normalizeProbeBaseUrl(baseUrl)}/api/chat`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    if (override?.trim()) return override.trim();
    const m = config.opencodeModel;
    if (m) {
      return m.replace(/^ollama\//i, '');
    }
    return '';
  }

  async function generateText(config: AppConfig, messages: OllamaMessage[], modelOverride?: string): Promise<OllamaGenerateResult> {
    const baseUrl = config.ollamaBaseUrl;
    if (!baseUrl?.trim()) {
      throw new Error('Ollama is not configured (ollamaBaseUrl is empty)');
    }

    let model = modelOverride || resolveModel(config);
    if (!model.trim()) {
      return { text: '' };
    }

    model = model.trim();
    const payload = messages.map((m) => ({ role: m.role, content: m.content }));

    const chatFn = chatCompletion;
    return chatFn(payload, model, baseUrl).then((content) => ({ text: content }));
  }

  return { generateText };
}
