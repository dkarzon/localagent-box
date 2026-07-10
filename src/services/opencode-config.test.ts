import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildGemmaReasoningWorkaroundOptions,
  buildModelConfig,
  buildOpenCodeConfig,
  isGemmaThinkingModel,
} from './opencode-config';
import type { AppConfig, AgentJob } from '../types';

describe('isGemmaThinkingModel', () => {
  it('detects Gemma 4 model ids', () => {
    assert.equal(isGemmaThinkingModel('gemma4:e4b'), true);
    assert.equal(isGemmaThinkingModel('gemma4:31b'), true);
    assert.equal(isGemmaThinkingModel('gemma-4-26b'), true);
    assert.equal(isGemmaThinkingModel('llama3.2'), false);
  });
});

describe('buildModelConfig', () => {
  it('adds reasoning workaround for Gemma models', () => {
    const config = buildModelConfig('gemma4:e4b');
    assert.deepEqual(config.options, buildGemmaReasoningWorkaroundOptions());
  });

  it('leaves non-Gemma models unchanged', () => {
    assert.deepEqual(buildModelConfig('llama3.2'), { name: 'llama3.2' });
  });
});

describe('buildOpenCodeConfig', () => {
  it('writes Gemma workaround into provider model options', () => {
    const config = {
      ollamaBaseUrl: 'http://localhost:11434',
      opencodeProvider: 'ollama',
      opencodeModel: 'gemma4:e4b',
    } as AppConfig;
    const file = buildOpenCodeConfig(config);
    assert.equal(file.model, 'ollama/gemma4:e4b');
    assert.deepEqual(file.provider.ollama?.models['gemma4:e4b']?.options, {
      reasoningEffort: 'none',
      extraBody: { reasoning_effort: 'none' },
    });
  });

  it('registers all distinct loop verb and job models', () => {
    const config = {
      ollamaBaseUrl: 'http://localhost:11434',
      opencodeProvider: 'ollama',
      opencodeModel: 'llama3.2',
      loopVerbModels: {
        ACT: 'qwen3-coder:30b',
        REFLECT: 'llama3.2',
      },
    } as AppConfig;
    const job = { model: 'mistral' } as AgentJob;
    const file = buildOpenCodeConfig(config, { job });
    assert.ok(file.provider.ollama?.models['llama3.2']);
    assert.ok(file.provider.ollama?.models['qwen3-coder:30b']);
    assert.ok(file.provider.ollama?.models.mistral);
    assert.equal(Object.keys(file.provider.ollama?.models ?? {}).length, 3);
  });
});
