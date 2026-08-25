import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { loadServerEnv, resetServerEnvCache } from './env';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
  for (const key of Object.keys(ORIGINAL_ENV)) {
    if (ORIGINAL_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINAL_ENV[key];
    }
  }
  delete process.env.NODE_ENV;
  resetServerEnvCache();
}

test.afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  restoreEnv();
});

test('loadServerEnv reads .env from cwd without overriding existing vars', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localagent-env-'));
  fs.writeFileSync(
    path.join(dir, '.env'),
    ['PORT=8123', 'DATA_DIR=./from-env', 'API_TOKEN=from-env', '# comment', 'BAD LINE', ''].join(
      '\n',
    ),
  );

  process.chdir(dir);
  process.env.API_TOKEN = 'from-shell';
  delete process.env.PORT;
  delete process.env.DATA_DIR;
  delete process.env.NODE_ENV;
  resetServerEnvCache();

  const env = loadServerEnv();
  assert.equal(env.port, 8123);
  assert.equal(env.dataDir, './from-env');
  assert.equal(env.apiToken, 'from-shell');
});

test('codegraph flag defaults to disabled', () => {
  delete process.env.ENABLE_CODEGRAPH;
  resetServerEnvCache();

  const env = loadServerEnv();
  assert.equal(env.enableCodegraph, false);
});

test('codegraph env parsing: enable flag', () => {
  process.env.ENABLE_CODEGRAPH = 'true';
  resetServerEnvCache();
  let env = loadServerEnv();
  assert.equal(env.enableCodegraph, true);

  process.env.ENABLE_CODEGRAPH = 'false';
  resetServerEnvCache();
  env = loadServerEnv();
  assert.equal(env.enableCodegraph, false);
});

test('bootstrap env vars default to disabled auto-detect and no timeout override', () => {
  delete process.env.BOOTSTRAP_AUTO_DETECT;
  delete process.env.BOOTSTRAP_SETUP_TIMEOUT_MS;
  resetServerEnvCache();

  const env = loadServerEnv();
  assert.equal(env.bootstrapAutoDetect, false);
  assert.equal(env.bootstrapGlobalSetupTimeoutMs, 0);
});

test('bootstrap env vars are parsed', () => {
  process.env.BOOTSTRAP_AUTO_DETECT = 'true';
  process.env.BOOTSTRAP_SETUP_TIMEOUT_MS = '120000';
  resetServerEnvCache();

  const env = loadServerEnv();
  assert.equal(env.bootstrapAutoDetect, true);
  assert.equal(env.bootstrapGlobalSetupTimeoutMs, 120_000);
});

test('dep-cache env vars default to disabled and dataDir/dep-cache', () => {
  delete process.env.DEP_CACHE_ENABLED;
  delete process.env.DEP_CACHE_ROOT;
  process.env.DATA_DIR = '/tmp/fake-data-dir';
  resetServerEnvCache();

  const env = loadServerEnv();
  assert.equal(env.depCacheEnabled, false);
  assert.equal(env.depCacheRoot, path.join('/tmp/fake-data-dir', 'dep-cache'));
});

test('dep-cache env vars are parsed', () => {
  process.env.DEP_CACHE_ENABLED = 'true';
  process.env.DEP_CACHE_ROOT = '/data/dep-cache';
  resetServerEnvCache();

  const env = loadServerEnv();
  assert.equal(env.depCacheEnabled, true);
  assert.equal(env.depCacheRoot, '/data/dep-cache');
});
