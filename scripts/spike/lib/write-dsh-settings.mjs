/**
 * Write $DSH_HOME/settings.yaml for an Ollama-backed DSH runtime.
 * Reused by Phase 2 (dsh-config.ts); keep field names aligned with the integration plan.
 */

/**
 * @param {string} ollamaBaseUrl e.g. http://host.docker.internal:11434 or http://ollama:11434
 * @param {string} modelId Ollama model tag, e.g. llama3.2
 * @param {{ unattended?: boolean }} [opts]
 * @returns {string}
 */
export function buildDshSettingsYaml(ollamaBaseUrl, modelId, opts = {}) {
  const unattended = opts.unattended !== false;
  const baseUrl = normalizeOllamaBaseUrl(ollamaBaseUrl);
  const safeModelId = String(modelId || 'llama3.2').trim();

  const lines = [
    'llm-pi-ai:',
    '  providers:',
    '    ollama:',
    '      displayName: Ollama',
    '      apiKeyEnv: OLLAMA_API_KEY',
    '      api: openai-completions',
    `      baseURL: ${baseUrl}`,
    '      compat:',
    '        supportsDeveloperRole: false',
    '        thinkingFormat: deepseek',
    '      models:',
    `        - id: ${yamlScalar(safeModelId)}`,
    `          name: ${yamlScalar(safeModelId)}`,
    '          contextWindow: 32768',
    '          maxTokens: 8192',
    '',
    'agent-default-model:',
    '  provider: ollama',
    `  model: ${yamlScalar(safeModelId)}`,
  ];

  if (unattended) {
    lines.push(
      '',
      'permission:',
      '  defaultPreset: danger-full-access',
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeOllamaBaseUrl(raw) {
  const trimmed = String(raw || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function yamlScalar(value) {
  if (/^[a-zA-Z0-9._:@/+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}
