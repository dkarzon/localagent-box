import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOllamaProbe } from './ollama-probe';

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
