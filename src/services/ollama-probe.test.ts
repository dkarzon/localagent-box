import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOllamaProbe, resolveModelContextLengths } from './ollama-probe';
import type { AppConfig } from '../types';

describe('ollama-probe', () => {
  it('probes local Ollama without auth', async () => {
    let authHeader: string | undefined;
    const probe = createOllamaProbe({
      fetchImpl: async (_url, init) => {
        authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'llama3.2' }] }),
        } as Response;
      },
    });

    const result = await probe.probe({ baseUrl: 'http://localhost:11434' });
    assert.equal(result.reachable, true);
    assert.equal(result.modelCount, 1);
    assert.equal(authHeader, undefined);
  });

  it('sends bearer token for cloud probes', async () => {
    let authHeader: string | undefined;
    const probe = createOllamaProbe({
      fetchImpl: async (_url, init) => {
        authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'gemma4:31b' }] }),
        } as Response;
      },
    });

    const result = await probe.probe({
      baseUrl: 'https://ollama.com',
      apiKey: 'cloud-key',
    });
    assert.equal(result.reachable, true);
    assert.equal(authHeader, 'Bearer cloud-key');
  });

  it('treats 401 as invalid key', async () => {
    const probe = createOllamaProbe({
      fetchImpl: async () =>
        ({
          ok: false,
          status: 401,
          json: async () => ({}),
        }) as Response,
    });

    const result = await probe.probe({
      baseUrl: 'https://ollama.com',
      apiKey: 'bad',
    });
    assert.equal(result.reachable, false);
    assert.match(result.message || '', /invalid or missing api key/i);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

describe('ollama-probe openai api', () => {
  it('lists /v1/models and reads per-model context length', async () => {
    const urls: string[] = [];
    const probe = createOllamaProbe({
      fetchImpl: async (url) => {
        urls.push(String(url));
        return jsonResponse({
          data: [
            { id: 'qwen-coder', created: 1_700_000_000, max_model_len: 65536 },
            { id: 'other' },
          ],
        });
      },
    });

    const result = await probe.probe({ baseUrl: 'http://localhost:8000', api: 'openai' });
    assert.equal(result.reachable, true);
    assert.deepEqual(urls, ['http://localhost:8000/v1/models']);
    assert.equal(result.models?.[0]?.name, 'qwen-coder');
    assert.equal(result.models?.[0]?.contextLength, 65536);
    assert.equal(result.models?.[0]?.modifiedAt, new Date(1_700_000_000_000).toISOString());
    assert.equal(result.models?.[1]?.contextLength, undefined);
  });

  it("falls back to Strata's /health max_context for the loaded model", async () => {
    const urls: string[] = [];
    const probe = createOllamaProbe({
      fetchImpl: async (url) => {
        urls.push(String(url));
        if (String(url).endsWith('/health')) {
          return jsonResponse({ service: 'strata', model: 'qwen-next', max_context: 262144 });
        }
        return jsonResponse({ data: [{ id: 'qwen-next' }, { id: 'other' }] });
      },
    });

    const result = await probe.probe({ baseUrl: 'http://127.0.0.1:8080/v1', api: 'openai' });
    assert.deepEqual(urls, ['http://127.0.0.1:8080/v1/models', 'http://127.0.0.1:8080/health']);
    assert.equal(result.models?.[0]?.contextLength, 262144);
    assert.equal(result.models?.[1]?.contextLength, undefined);
  });

  it('stays reachable when /health is missing', async () => {
    const probe = createOllamaProbe({
      fetchImpl: async (url) =>
        String(url).endsWith('/health')
          ? jsonResponse({}, 404)
          : jsonResponse({ data: [{ id: 'model-a' }] }),
    });

    const result = await probe.probe({ baseUrl: 'http://localhost:1234', api: 'openai' });
    assert.equal(result.reachable, true);
    assert.equal(result.models?.[0]?.contextLength, undefined);
  });
});

describe('resolveModelContextLengths', () => {
  it('returns lengths for the openai-compatible provider', async () => {
    const probe = createOllamaProbe({
      fetchImpl: async () => jsonResponse({ data: [{ id: 'm1', context_length: 32768 }, { id: 'm2' }] }),
    });
    const config = {
      opencodeProvider: 'openai-compatible',
      openaiCompatibleBaseUrl: 'http://localhost:8080',
    } as AppConfig;
    assert.deepEqual(await resolveModelContextLengths(config, probe), { m1: 32768 });
  });

  it('skips probing for Ollama providers', async () => {
    const probe = createOllamaProbe({
      fetchImpl: async () => {
        throw new Error('should not fetch');
      },
    });
    const config = { opencodeProvider: 'ollama', ollamaBaseUrl: 'http://localhost:11434' } as AppConfig;
    assert.deepEqual(await resolveModelContextLengths(config, probe), {});
  });

  it('returns no lengths when the server is unreachable', async () => {
    const probe = createOllamaProbe({
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const config = {
      opencodeProvider: 'openai-compatible',
      openaiCompatibleBaseUrl: 'http://localhost:8080',
    } as AppConfig;
    assert.deepEqual(await resolveModelContextLengths(config, probe), {});
  });
});
