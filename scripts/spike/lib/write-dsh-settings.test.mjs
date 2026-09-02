import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDshSettingsYaml, normalizeOllamaBaseUrl } from './write-dsh-settings.mjs';

test('normalizeOllamaBaseUrl appends /v1', () => {
  assert.equal(normalizeOllamaBaseUrl('http://ollama:11434'), 'http://ollama:11434/v1');
  assert.equal(normalizeOllamaBaseUrl('http://ollama:11434/'), 'http://ollama:11434/v1');
  assert.equal(normalizeOllamaBaseUrl('http://ollama:11434/v1'), 'http://ollama:11434/v1');
});

test('buildDshSettingsYaml includes ollama provider and unattended preset', () => {
  const yaml = buildDshSettingsYaml('http://host.docker.internal:11434', 'llama3.2');
  assert.match(yaml, /baseURL: http:\/\/host\.docker\.internal:11434\/v1/);
  assert.match(yaml, /id: llama3\.2/);
  assert.match(yaml, /defaultPreset: danger-full-access/);
  assert.match(yaml, /supportsDeveloperRole: false/);
});
