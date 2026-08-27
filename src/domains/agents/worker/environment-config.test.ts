import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  environmentConfigRelative,
  loadEnvironmentConfig,
  validateEnvironmentConfig,
} from './environment-config';

describe('validateEnvironmentConfig', () => {
  it('accepts minimal config with only version', () => {
    const result = validateEnvironmentConfig({ version: 1 });
    assert.deepEqual(result, { version: 1 });
  });

  it('accepts setup with command only', () => {
    const result = validateEnvironmentConfig({
      version: 1,
      setup: { command: 'npm ci && npm run build' },
    });
    assert.deepEqual(result, {
      version: 1,
      setup: { command: 'npm ci && npm run build' },
    });
  });

  it('accepts optional timeoutMs and failOnError', () => {
    const result = validateEnvironmentConfig({
      version: 1,
      setup: { command: 'pnpm install', timeoutMs: 300_000, failOnError: false },
    });
    assert.deepEqual(result, {
      version: 1,
      setup: { command: 'pnpm install', timeoutMs: 300_000, failOnError: false },
    });
  });

  it('accepts timeoutMs at the 30 min maximum', () => {
    const result = validateEnvironmentConfig({
      version: 1,
      setup: { command: 'npm ci', timeoutMs: 1_800_000 },
    });
    assert.equal(result.setup?.timeoutMs, 1_800_000);
  });

  it('rejects non-object values', () => {
    assert.throws(
      () => validateEnvironmentConfig(null),
      /environment\.json must be a JSON object/,
    );
    assert.throws(
      () => validateEnvironmentConfig('string'),
      /environment\.json must be a JSON object/,
    );
    assert.throws(
      () => validateEnvironmentConfig(42),
      /environment\.json must be a JSON object/,
    );
    assert.throws(
      () => validateEnvironmentConfig([]),
      /environment\.json must be a JSON object/,
    );
  });

  it('rejects non-object setup', () => {
    assert.throws(
      () => validateEnvironmentConfig({ version: 1, setup: 'npm ci' }),
      /environment\.json setup must be a JSON object/,
    );
    assert.throws(
      () => validateEnvironmentConfig({ version: 1, setup: ['npm ci'] }),
      /environment\.json setup must be a JSON object/,
    );
  });

  it('rejects bad version values', () => {
    for (const version of [2, '1', 0, null, true]) {
      assert.throws(
        () => validateEnvironmentConfig({ version }),
        /environment\.json version must be exactly 1/,
      );
    }
  });

  it('rejects missing command inside setup', () => {
    assert.throws(
      () => validateEnvironmentConfig({ version: 1, setup: {} }),
      /environment\.json setup command must be a non-empty string when provided/,
    );
  });

  it('rejects empty command inside setup', () => {
    assert.throws(
      () => validateEnvironmentConfig({ version: 1, setup: { command: '   ' } }),
      /environment\.json setup command must be a non-empty string when provided/,
    );
  });

  it('rejects non-string command inside setup', () => {
    assert.throws(
      () => validateEnvironmentConfig({ version: 1, setup: { command: 42 } }),
      /environment\.json setup command must be a non-empty string when provided/,
    );
  });

  it('rejects bad timeoutMs values', () => {
    const cases: unknown[] = [0, -1, -1_800_000, 1.5, 0.5, '300000', null, true, NaN, Infinity];
    for (const timeoutMs of cases) {
      assert.throws(
        () =>
          validateEnvironmentConfig({
            version: 1,
            setup: { command: 'x', timeoutMs },
          }),
        /environment\.json setup timeoutMs must be a positive integer no greater than 1800000 when provided/,
      );
    }
  });

  it('rejects timeoutMs above the 30 min maximum', () => {
    assert.throws(
      () =>
        validateEnvironmentConfig({
          version: 1,
          setup: { command: 'x', timeoutMs: 1_800_001 },
        }),
      /environment\.json setup timeoutMs must be a positive integer no greater than 1800000 when provided/,
    );
  });

  it('rejects non-boolean failOnError', () => {
    assert.throws(
      () =>
        validateEnvironmentConfig({
          version: 1,
          setup: { command: 'x', failOnError: 'no' },
        }),
      /environment\.json setup failOnError must be a boolean when provided/,
    );
  });

  it('accepts optional profiles and autoDetect', () => {
    const result = validateEnvironmentConfig({
      version: 1,
      profiles: ['nodejs-pnpm', 'nodejs'],
      autoDetect: false,
    });
    assert.deepEqual(result, { version: 1, profiles: ['nodejs-pnpm', 'nodejs'], autoDetect: false });
  });

  it('rejects non-array or malformed profiles', () => {
    assert.throws(
      () => validateEnvironmentConfig({ version: 1, profiles: 'nodejs' }),
      /environment\.json profiles must be an array of strings when provided/,
    );
    assert.throws(
      () => validateEnvironmentConfig({ version: 1, profiles: ['nodejs', 42, ''] }),
      /environment\.json profiles\[1\] must be a non-empty string/,
    );
  });

  it('rejects non-boolean autoDetect', () => {
    assert.throws(
      () => validateEnvironmentConfig({ version: 1, autoDetect: 'no' }),
      /environment\.json autoDetect must be a boolean when provided/,
    );
  });

  it('accepts an optional cacheKey', () => {
    const result = validateEnvironmentConfig({
      version: 1,
      cacheKey: 'acme-monorepo-pnpm9',
    });
    assert.deepEqual(result, { version: 1, cacheKey: 'acme-monorepo-pnpm9' });
  });

  it('rejects non-string cacheKey values', () => {
    for (const cacheKey of [42, null, true, ['a'], { a: 1 }]) {
      assert.throws(
        () => validateEnvironmentConfig({ version: 1, cacheKey }),
        /environment\.json cacheKey must be a non-empty string when provided/,
      );
    }
  });

  it('rejects empty or whitespace-only cacheKey', () => {
    for (const cacheKey of ['', '   ']) {
      assert.throws(
        () => validateEnvironmentConfig({ version: 1, cacheKey }),
        /environment\.json cacheKey must be a non-empty string when provided/,
      );
    }
  });

  it('accepts an optional verifyCommand', () => {
    const result = validateEnvironmentConfig({
      version: 1,
      setup: { command: 'npm ci' },
      verifyCommand: 'npm test --passWithNoTests',
    });
    assert.equal(result.verifyCommand, 'npm test --passWithNoTests');
  });

  it('rejects non-string or empty verifyCommand values', () => {
    for (const verifyCommand of [42, null, true, [], '', '   ']) {
      assert.throws(
        () => validateEnvironmentConfig({ version: 1, verifyCommand }),
        /environment\.json verifyCommand must be a non-empty string when provided/,
      );
    }
  });

  it('accepts an optional verifyTimeoutMs', () => {
    const result = validateEnvironmentConfig({
      version: 1,
      verifyCommand: 'npm test',
      verifyTimeoutMs: 300_000,
    });
    assert.equal(result.verifyTimeoutMs, 300_000);
  });

  it('rejects bad verifyTimeoutMs values', () => {
    const cases: unknown[] = [0, -1, -300_000, 1.5, 0.5, '300000', null, true, NaN, Infinity, 1_800_001];
    for (const verifyTimeoutMs of cases) {
      assert.throws(
        () =>
          validateEnvironmentConfig({
            version: 1,
            verifyCommand: 'npm test',
            verifyTimeoutMs,
          }),
        /environment\.json verifyTimeoutMs must be a positive integer no greater than 1800000 when provided/,
      );
    }
  });

  it('ignores unknown keys without error', () => {
    const result = validateEnvironmentConfig({
      version: 1,
      unknownTopLevel: 'should be ignored',
      setup: { command: 'npm ci', unknown: true },
    });
    assert.deepEqual(result, { version: 1, setup: { command: 'npm ci' } });
    assert.ok(!('unknownTopLevel' in result));
  });
});

describe('loadEnvironmentConfig', () => {
  function tmpdir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'environment-config-'));
  }

  function writeConfig(dir: string, content: string): void {
    const repoDir = path.join(dir, '.localagent-box');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'environment.json'), content, 'utf8');
  }

  it('returns null when environment.json does not exist', () => {
    const dir = tmpdir();
    const result = loadEnvironmentConfig(dir);
    assert.equal(result, null);
  });

  it('loads a valid minimal config', () => {
    const dir = tmpdir();
    writeConfig(dir, JSON.stringify({ version: 1, setup: { command: 'npm ci' } }));

    const result = loadEnvironmentConfig(dir);
    assert.ok(result !== null);
    assert.equal(result.version, 1);
    assert.deepEqual(result.setup, { command: 'npm ci' });
  });

  it('exposes the well-known relative path', () => {
    assert.equal(
      environmentConfigRelative.split(path.sep).join('/'),
      '.localagent-box/environment.json',
    );
  });

  it('throws on invalid JSON', () => {
    const dir = tmpdir();
    writeConfig(dir, '{invalid json');

    assert.throws(
      () => loadEnvironmentConfig(dir),
      /Failed to load \.localagent-box\/environment\.json/,
    );
  });

  it('throws on validation failure in loaded file', () => {
    const dir = tmpdir();
    writeConfig(dir, JSON.stringify({ version: 9 }));

    assert.throws(
      () => loadEnvironmentConfig(dir),
      /Failed to load \.localagent-box\/environment\.json/,
    );
  });
});
