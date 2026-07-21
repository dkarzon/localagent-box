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
