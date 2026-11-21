import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCodegraphMcpServer,
  buildGemmaReasoningWorkaroundOptions,
  buildModelCost,
  buildModelConfig,
  buildModelLimit,
  buildOpenCodeConfig,
  createOpenCodeConfigService,
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

  it('adds a limit when the context length is known', () => {
    assert.deepEqual(buildModelConfig('qwen', 65536), {
      name: 'qwen',
      limit: { context: 65536, output: 16384 },
    });
  });

  it('adds configured token costs in the OpenCode v1 cost shape', () => {
    assert.deepEqual(buildModelConfig('llama3.2', undefined, { input: 0.2, output: 0.6, cacheRead: 0.05 }), {
      name: 'llama3.2',
      cost: { input: 0.2, output: 0.6, cache_read: 0.05 },
    });
  });

  it('omits cost when no rates are configured', () => {
    assert.deepEqual(buildModelConfig('llama3.2', undefined, { input: 0 }), { name: 'llama3.2' });
    assert.equal(buildModelCost(null), null);
  });
});

describe('buildModelLimit', () => {
  it('clamps output to between 256 and 32768 tokens', () => {
    assert.deepEqual(buildModelLimit(262144), { context: 262144, output: 32768 });
    assert.deepEqual(buildModelLimit(512), { context: 512, output: 256 });
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

  it('writes configured token costs into provider model entries with wildcard fallback', () => {
    const config = {
      ollamaBaseUrl: 'http://localhost:11434',
      opencodeProvider: 'ollama',
      opencodeModel: 'llama3.2',
      modelTokenCosts: {
        'llama3.2': { input: 0.2, output: 0.6 },
        '*': { input: 0.1, output: 0.3, cacheRead: 0.05 },
      },
    } as unknown as AppConfig;
    const job = { model: 'mistral' } as AgentJob;
    const file = buildOpenCodeConfig(config, { job });
    assert.deepEqual(file.provider.ollama?.models['llama3.2']?.cost, { input: 0.2, output: 0.6 });
    assert.deepEqual(file.provider.ollama?.models.mistral?.cost, {
      input: 0.1,
      output: 0.3,
      cache_read: 0.05,
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

  it('omits the mcp block by default', () => {
    const config = {
      ollamaBaseUrl: 'http://localhost:11434',
      opencodeProvider: 'ollama',
      opencodeModel: 'llama3.2',
    } as AppConfig;
    const file = buildOpenCodeConfig(config);
    assert.equal(file.mcp, undefined);
  });

  it('emits the codegraph mcp block when requested', () => {
    const config = {
      ollamaBaseUrl: 'http://localhost:11434',
      opencodeProvider: 'ollama',
      opencodeModel: 'llama3.2',
    } as AppConfig;
    const file = buildOpenCodeConfig(config, { codegraph: true });
    assert.deepEqual(file.mcp?.servers.codegraph, {
      type: 'local',
      command: ['codegraph', 'serve', '--mcp'],
      disabled: false,
      timeout: { catalog: 15000 },
    });
  });

  it('keeps external_directory on ask by default (v2 allows it otherwise)', () => {
    const config = {
      ollamaBaseUrl: 'http://localhost:11434',
      opencodeProvider: 'ollama',
      opencodeModel: 'llama3.2',
    } as AppConfig;
    const file = buildOpenCodeConfig(config);
    assert.deepEqual(file.permissions, [
      { action: 'external_directory', resource: '*', effect: 'ask' },
    ]);
  });

  it('denies the question permission when requested for unattended modes', () => {
    const config = {
      ollamaBaseUrl: 'http://localhost:11434',
      opencodeProvider: 'ollama',
      opencodeModel: 'llama3.2',
    } as AppConfig;
    const file = buildOpenCodeConfig(config, { disableQuestionTool: true });
    assert.deepEqual(file.permissions, [
      { action: 'external_directory', resource: '*', effect: 'ask' },
      { action: 'question', resource: '*', effect: 'deny' },
    ]);
  });

  it('denies question after wildcard allow so auto-approve cannot re-enable it', () => {
    const config = {
      ollamaBaseUrl: 'http://localhost:11434',
      opencodeProvider: 'ollama',
      opencodeModel: 'llama3.2',
    } as AppConfig;
    const file = buildOpenCodeConfig(config, {
      autoApprovePermissions: true,
      disableQuestionTool: true,
    });
    assert.deepEqual(file.permissions, [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'question', resource: '*', effect: 'deny' },
    ]);
  });

  it('emits no legacy v1 tools/permission keys', () => {
    const config = {
      ollamaBaseUrl: 'http://localhost:11434',
      opencodeProvider: 'ollama',
      opencodeModel: 'llama3.2',
    } as AppConfig;
    const file = buildOpenCodeConfig(config, { autoApprovePermissions: true }) as unknown as Record<string, unknown>;
    assert.equal(file.tools, undefined);
    assert.equal(file.permission, undefined);
  });
});

describe('buildOpenCodeConfig cloud provider', () => {
  it('builds cloud provider options with apiKey', () => {
    const config = {
      ollamaBaseUrl: '',
      ollamaCloudApiKey: 'cloud-secret',
      ollamaCloudBaseUrl: 'https://ollama.com',
      opencodeProvider: 'ollama-cloud',
      opencodeModel: 'gemma4:31b',
    } as AppConfig;
    const file = buildOpenCodeConfig(config);
    assert.equal(file.model, 'ollama-cloud/gemma4:31b');
    assert.equal(file.provider['ollama-cloud']?.name, 'Ollama Cloud');
    assert.equal(file.provider['ollama-cloud']?.options.baseURL, 'https://ollama.com/v1');
    assert.equal(file.provider['ollama-cloud']?.options.apiKey, 'cloud-secret');
  });

  it('writeOpenCodeConfig succeeds for cloud-only installs', () => {
    const fs = {
      existsSync: () => false,
      readFileSync: () => '',
      appendFileSync: () => {},
      mkdirSync: () => {},
      writeFileSync: () => {},
    };
    const service = createOpenCodeConfigService({
      fs: fs as never,
      configDir: '/tmp/opencode-test',
    });
    const config = {
      ollamaBaseUrl: '',
      ollamaCloudApiKey: 'cloud-secret',
      ollamaCloudBaseUrl: '',
      opencodeProvider: 'ollama-cloud',
      opencodeModel: 'gemma4:31b',
    } as AppConfig;
    const result = service.writeOpenCodeConfig(config);
    assert.ok(result);
    assert.equal(result?.config.model, 'ollama-cloud/gemma4:31b');
  });

  it('writeOpenCodeConfig references the instructions file by absolute path', () => {
    const writes: Record<string, string> = {};
    const fs = {
      existsSync: () => false,
      readFileSync: () => '',
      appendFileSync: () => {},
      mkdirSync: () => {},
      writeFileSync: (p: string, data: string) => {
        writes[p] = data;
      },
    };
    const service = createOpenCodeConfigService({
      fs: fs as never,
      path: require('path').posix,
      configDir: '/agents/a1/xdg/config/opencode',
    });
    const config = {
      ollamaBaseUrl: 'http://localhost:11434',
      opencodeProvider: 'ollama',
      opencodeModel: 'llama3.2',
      systemPrompt: 'Be terse.',
    } as AppConfig;
    const result = service.writeOpenCodeConfig(config);
    const expected = '/agents/a1/xdg/config/opencode/localagent-instructions.md';
    assert.deepEqual(result?.config.instructions, [expected]);
    assert.ok(writes[expected]?.includes('Be terse.'));
    const written = JSON.parse(writes['/agents/a1/xdg/config/opencode/opencode.json'] ?? '{}');
    assert.deepEqual(written.instructions, [expected]);
  });

  it('writeOpenCodeConfig no-ops when selected host is missing', () => {
    const fs = {
      existsSync: () => false,
      readFileSync: () => '',
      appendFileSync: () => {},
      mkdirSync: () => {},
      writeFileSync: () => {
        throw new Error('should not write');
      },
    };
    const service = createOpenCodeConfigService({
      fs: fs as never,
      configDir: '/tmp/opencode-test',
    });
    const config = {
      ollamaBaseUrl: '',
      ollamaCloudApiKey: '',
      opencodeProvider: 'ollama-cloud',
      opencodeModel: 'gemma4:31b',
    } as AppConfig;
    assert.equal(service.writeOpenCodeConfig(config), null);
  });
});

describe('buildOpenCodeConfig openai-compatible provider', () => {
  it('builds the provider entry with limits from reported context lengths', () => {
    const config = {
      openaiCompatibleBaseUrl: 'http://127.0.0.1:8080',
      openaiCompatibleApiKey: '',
      opencodeProvider: 'openai-compatible',
      opencodeModel: 'qwen-next',
    } as AppConfig;
    const file = buildOpenCodeConfig(config, { modelContextLengths: { 'qwen-next': 131072 } });
    const provider = file.provider['openai-compatible'];
    assert.equal(file.model, 'openai-compatible/qwen-next');
    assert.equal(provider?.name, 'OpenAI-compatible');
    assert.equal(provider?.npm, '@ai-sdk/openai-compatible');
    assert.deepEqual(provider?.options, { baseURL: 'http://127.0.0.1:8080/v1' });
    assert.deepEqual(provider?.models['qwen-next']?.limit, { context: 131072, output: 32768 });
  });

  it('passes the optional api key through', () => {
    const config = {
      openaiCompatibleBaseUrl: 'http://localhost:1234/v1',
      openaiCompatibleApiKey: 'sk-local',
      opencodeProvider: 'openai-compatible',
      opencodeModel: 'm',
    } as AppConfig;
    const file = buildOpenCodeConfig(config);
    assert.equal(file.provider['openai-compatible']?.options.apiKey, 'sk-local');
    assert.equal(file.provider['openai-compatible']?.models.m?.limit, undefined);
  });
});

describe('buildCodegraphMcpServer', () => {
  it('matches the OpenCode v2 mcp.servers local shape', () => {
    const server = buildCodegraphMcpServer();
    assert.deepEqual(server.command, ['codegraph', 'serve', '--mcp']);
    assert.equal(server.type, 'local');
    assert.equal(server.disabled, false);
  });
});
