import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadRepoConfig, validateRepoConfig } from './repo-config';

describe('validateRepoConfig', () => {
  it('accepts all four overrides', () => {
    const result = validateRepoConfig({
      systemPrompt: 'Custom system prompt',
      batchContextPrompt: 'Custom batch context',
      interactiveContextPrompt: 'Custom interactive context',
      loopContextPrompt: 'Custom loop context',
    });
    assert.equal(result.systemPrompt, 'Custom system prompt');
    assert.equal(result.batchContextPrompt, 'Custom batch context');
    assert.equal(result.interactiveContextPrompt, 'Custom interactive context');
    assert.equal(result.loopContextPrompt, 'Custom loop context');
  });

  it('accepts partial overrides', () => {
    const result = validateRepoConfig({
      systemPrompt: 'Only system prompt overridden',
    });
    assert.equal(result.systemPrompt, 'Only system prompt overridden');
    assert.equal(result.batchContextPrompt, undefined);
    assert.equal(result.interactiveContextPrompt, undefined);
    assert.equal(result.loopContextPrompt, undefined);
  });

  it('accepts empty object', () => {
    const result = validateRepoConfig({});
    assert.deepEqual(result, {});
  });

  it('rejects non-object values', () => {
    assert.throws(() => validateRepoConfig(null), /must be a JSON object/);
    assert.throws(() => validateRepoConfig('string'), /must be a JSON object/);
    assert.throws(() => validateRepoConfig(42), /must be a JSON object/);
  });

  it('rejects empty string values', () => {
    assert.throws(
      () => validateRepoConfig({ systemPrompt: '   ' }),
      /systemPrompt must be a non-empty string/,
    );
  });

  it('ignores unknown keys without error', () => {
    const result = validateRepoConfig({
      systemPrompt: 'Custom',
      unknownField: 'should be ignored',
    });
    assert.equal(result.systemPrompt, 'Custom');
    assert.ok(!('unknownField' in result));
  });

  it('rejects non-string values for allowed keys', () => {
    assert.throws(
      () => validateRepoConfig({ systemPrompt: 123 }),
      /systemPrompt must be a non-empty string/,
    );
  });
});

describe('loadRepoConfig', () => {
  it('returns null when config file does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-config-'));
    const result = loadRepoConfig(dir);
    assert.equal(result, null);
  });

  it('loads and validates partial repo config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-config-'));
    const repoDir = path.join(dir, '.localagent-box');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'config.json'),
      JSON.stringify({
        systemPrompt: 'My custom system prompt',
        batchContextPrompt: 'My custom batch context',
      }),
      'utf8',
    );

    const result = loadRepoConfig(dir);
    assert.ok(result !== null);
    assert.equal(result.systemPrompt, 'My custom system prompt');
    assert.equal(result.batchContextPrompt, 'My custom batch context');
    assert.equal(result.interactiveContextPrompt, undefined);
    assert.equal(result.loopContextPrompt, undefined);
  });

  it('throws on invalid JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-config-'));
    const repoDir = path.join(dir, '.localagent-box');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'config.json'), '{invalid json', 'utf8');

    assert.throws(() => loadRepoConfig(dir), /Failed to load/);
  });

  it('throws on validation failure in loaded file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-config-'));
    const repoDir = path.join(dir, '.localagent-box');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'config.json'),
      JSON.stringify({ systemPrompt: '' }),
      'utf8',
    );

    assert.throws(() => loadRepoConfig(dir), /Failed to load/);
  });
});
