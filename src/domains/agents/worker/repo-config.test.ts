import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadRepoConfig, validateRepoConfig } from './repo-config';

describe('validateRepoConfig', () => {
  it('accepts both prompt overrides', () => {
    const result = validateRepoConfig({
      systemPrompt: 'Custom system prompt',
      batchContextPrompt: 'Custom batch context',
    });
    assert.equal(result.overrides.systemPrompt, 'Custom system prompt');
    assert.equal(result.overrides.batchContextPrompt, 'Custom batch context');
    assert.deepEqual(result.notes, []);
  });

  it('accepts partial overrides', () => {
    const result = validateRepoConfig({
      systemPrompt: 'Only system prompt overridden',
    });
    assert.equal(result.overrides.systemPrompt, 'Only system prompt overridden');
    assert.equal(result.overrides.batchContextPrompt, undefined);
  });

  it('accepts empty object', () => {
    const result = validateRepoConfig({});
    assert.deepEqual(result.overrides, {});
    assert.deepEqual(result.notes, []);
  });

  it('reports unknown keys as a note instead of erroring', () => {
    const result = validateRepoConfig({
      systemPrompt: 'Custom',
      unknownField: 'should be ignored',
    });
    assert.equal(result.overrides.systemPrompt, 'Custom');
    assert.ok(!('unknownField' in result.overrides));
    assert.deepEqual(result.notes, [
      'Ignoring unknown keys in .localagent-box/config.json: unknownField',
    ]);
  });

  it('reports keys from removed modes as the same note', () => {
    const result = validateRepoConfig({
      systemPrompt: 'Custom',
      interactiveContextPrompt: 'Legacy text',
      loopContextPrompt: 'Legacy text',
      checkCommand: 'npm test',
    });
    assert.deepEqual(result.notes, [
      'Ignoring unknown keys in .localagent-box/config.json: checkCommand, interactiveContextPrompt, loopContextPrompt',
    ]);
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

  it('rejects non-string values for allowed keys', () => {
    assert.throws(
      () => validateRepoConfig({ systemPrompt: 123 }),
      /systemPrompt must be a non-empty string/,
    );
  });

  it('accepts a full review block', () => {
    const result = validateRepoConfig({
      review: {
        background: 'Check auth flows',
        riskAreas: [
          { paths: ['src/auth/**'], description: ' Token expiry ', risk: 'high' },
          { description: 'Billing' },
        ],
        exclude: ['**/generated/**'],
        effort: 'high',
        replaceDefaultRules: true,
      },
    });
    assert.deepEqual(result.overrides.review, {
      background: 'Check auth flows',
      riskAreas: [
        { paths: ['src/auth/**'], description: 'Token expiry', risk: 'high' },
        { description: 'Billing' },
      ],
      exclude: ['**/generated/**'],
      effort: 'high',
      replaceDefaultRules: true,
    });
  });

  it('maps legacy reviewBackground onto review.background', () => {
    const result = validateRepoConfig({ reviewBackground: 'Legacy text', review: { effort: 'low' } });
    assert.deepEqual(result.overrides.review, { effort: 'low', background: 'Legacy text' });
  });

  it('rejects setting both reviewBackground and review.background', () => {
    assert.throws(
      () => validateRepoConfig({ reviewBackground: 'a', review: { background: 'b' } }),
      /both reviewBackground and review\.background/,
    );
  });

  it('rejects invalid review fields', () => {
    assert.throws(() => validateRepoConfig({ review: 'x' }), /review must be an object/);
    assert.throws(() => validateRepoConfig({ review: { riskAreas: [] } }), /riskAreas must be a non-empty array/);
    assert.throws(
      () => validateRepoConfig({ review: { riskAreas: [{ paths: ['a'] }] } }),
      /riskAreas\[0\]\.description must be a non-empty string/,
    );
    assert.throws(
      () => validateRepoConfig({ review: { riskAreas: [{ description: 'd', paths: [] }] } }),
      /riskAreas\[0\]\.paths must be a non-empty array/,
    );
    assert.throws(
      () => validateRepoConfig({ review: { riskAreas: [{ description: 'd', risk: 'severe' }] } }),
      /riskAreas\[0\]\.risk must be one of/,
    );
    assert.throws(() => validateRepoConfig({ review: { exclude: ['src/{a,b}/**'] } }), /must not contain commas/);
    assert.throws(() => validateRepoConfig({ review: { effort: 'max' } }), /effort must be one of/);
    assert.throws(
      () => validateRepoConfig({ review: { replaceDefaultRules: 'yes' } }),
      /replaceDefaultRules must be a boolean/,
    );
  });
});

describe('loadRepoConfig', () => {
  function writeConfig(dir: string, content: string): void {
    const repoDir = path.join(dir, '.localagent-box');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'config.json'), content, 'utf8');
  }

  it('returns null when config file does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-config-'));
    assert.equal(loadRepoConfig(dir), null);
  });

  it('loads and validates partial repo config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-config-'));
    writeConfig(
      dir,
      JSON.stringify({
        systemPrompt: 'My custom system prompt',
        batchContextPrompt: 'My custom batch context',
      }),
    );

    const result = loadRepoConfig(dir);
    assert.ok(result !== null);
    assert.equal(result.overrides.systemPrompt, 'My custom system prompt');
    assert.equal(result.overrides.batchContextPrompt, 'My custom batch context');
  });

  it('returns a note for a legacy key in the loaded file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-config-'));
    writeConfig(dir, JSON.stringify({ loopContextPrompt: 'Legacy text' }));

    const result = loadRepoConfig(dir);
    assert.ok(result !== null);
    assert.deepEqual(result.notes, [
      'Ignoring unknown keys in .localagent-box/config.json: loopContextPrompt',
    ]);
  });

  it('throws on invalid JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-config-'));
    writeConfig(dir, '{invalid json');

    assert.throws(() => loadRepoConfig(dir), /Failed to load/);
  });

  it('throws on validation failure in loaded file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-config-'));
    writeConfig(dir, JSON.stringify({ systemPrompt: '' }));

    assert.throws(() => loadRepoConfig(dir), /Failed to load/);
  });
});
