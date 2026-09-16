import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppConfig } from '../types';
import {
  DEFAULT_OLLAMA_CLOUD_BASE_URL,
  isProviderConfigured,
  resolveOpenCodeProvider,
  resolveProviderHost,
  resolveReviewProvider,
  stripProviderModelPrefix,
} from './llm-provider';

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ollamaBaseUrl: '',
    ollamaCloudApiKey: '',
    ollamaCloudBaseUrl: '',
    opencodeModel: '',
    opencodeProvider: 'ollama',
    reviewProvider: '',
    systemPrompt: '',
    githubAppId: '',
    githubAppInstallationId: '',
    githubAppPrivateKey: '',
    gitUserName: '',
    gitUserEmail: '',
    webhookUrl: '',
    batchAutoApprovePermissions: true,
    loopAutoApprovePermissions: true,
    interactiveAutoApprovePermissions: false,
    reviewModel: '',
    interactiveAgentTimeoutSeconds: 3600,
    loopAgentTimeoutSeconds: 3600,
    loopVerbModels: {
      INITIAL_PLAN: '',
      ORIENT: '',
      ACT: '',
      REFLECT: '',
    },
    ...overrides,
  };
}

describe('llm-provider', () => {
  it('inherits review provider from OpenCode when empty', () => {
    const config = baseConfig({ opencodeProvider: 'ollama-cloud', reviewProvider: '' });
    assert.equal(resolveReviewProvider(config), 'ollama-cloud');
  });

  it('uses explicit review provider when set', () => {
    const config = baseConfig({ opencodeProvider: 'ollama-cloud', reviewProvider: 'ollama' });
    assert.equal(resolveReviewProvider(config), 'ollama');
  });

  it('defaults cloud base URL', () => {
    const config = baseConfig({ ollamaCloudApiKey: 'secret' });
    assert.equal(
      resolveProviderHost(config, 'ollama-cloud').baseUrl,
      DEFAULT_OLLAMA_CLOUD_BASE_URL,
    );
  });

  it('detects configured providers', () => {
    assert.equal(isProviderConfigured(baseConfig({ ollamaBaseUrl: 'http://localhost:11434' }), 'ollama'), true);
    assert.equal(isProviderConfigured(baseConfig(), 'ollama'), false);
    assert.equal(isProviderConfigured(baseConfig({ ollamaCloudApiKey: 'key' }), 'ollama-cloud'), true);
    assert.equal(isProviderConfigured(baseConfig(), 'ollama-cloud'), false);
  });

  it('resolves OpenCode provider with fallback', () => {
    assert.equal(resolveOpenCodeProvider(baseConfig()), 'ollama');
    assert.equal(resolveOpenCodeProvider(baseConfig({ opencodeProvider: 'ollama-cloud' })), 'ollama-cloud');
  });

  it('strips provider prefixes from model ids', () => {
    assert.equal(stripProviderModelPrefix('ollama/llama3.2'), 'llama3.2');
    assert.equal(stripProviderModelPrefix('ollama-cloud/gemma4:31b'), 'gemma4:31b');
  });
});
