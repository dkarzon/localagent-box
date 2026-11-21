import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { getServerEnv } from '../../config/env';
import type { AppConfig } from '../../types';
import { DEFAULT_CONFIG } from '../../services/config-store';
import { buildEnvConfigDefaults } from './env-config-defaults';

type ServerEnv = ReturnType<typeof getServerEnv>;
const env = (vars: Partial<ServerEnv>) => vars as ServerEnv;

describe('buildEnvConfigDefaults', () => {
  it('seeds an openai-compatible provider from env when Settings are empty', () => {
    const partial = buildEnvConfigDefaults(
      { ...DEFAULT_CONFIG },
      env({
        opencodeProvider: 'openai-compatible',
        openaiCompatibleBaseUrl: 'http://192.168.1.10:8080',
        openaiCompatibleApiKey: 'sk-test',
        opencodeModel: 'qwen-next',
      }),
    );
    assert.equal(partial.opencodeProvider, 'openai-compatible');
    assert.equal(partial.openaiCompatibleBaseUrl, 'http://192.168.1.10:8080');
    assert.equal(partial.openaiCompatibleApiKey, 'sk-test');
    assert.equal(partial.opencodeModel, 'qwen-next');
  });

  it('never overrides values already saved in Settings', () => {
    const current = {
      ...DEFAULT_CONFIG,
      openaiCompatibleBaseUrl: 'http://saved:8080',
      openaiCompatibleApiKey: 'saved-key',
    } as AppConfig;
    const partial = buildEnvConfigDefaults(
      current,
      env({
        opencodeProvider: 'openai-compatible',
        openaiCompatibleBaseUrl: 'http://env:8080',
        openaiCompatibleApiKey: 'env-key',
      }),
    );
    assert.deepEqual(partial, {});
  });

  it('ignores invalid URLs and provider ids with a warning', () => {
    const warnings: string[] = [];
    const partial = buildEnvConfigDefaults(
      { ...DEFAULT_CONFIG, ollamaBaseUrl: '' } as AppConfig,
      env({ ollamaBaseUrl: 'http://ollama:11434', opencodeProvider: 'bogus', openaiCompatibleBaseUrl: 'not a url' }),
      (_fields, message) => warnings.push(message),
    );
    assert.equal(partial.ollamaBaseUrl, 'http://ollama:11434');
    assert.equal(partial.openaiCompatibleBaseUrl, undefined);
    assert.equal(warnings.length, 2);
  });
});
