import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isProfileInitialized,
  isProfileReady,
  readProfileManifest,
} from './dsh-profile-state.mjs';

test('isProfileInitialized checks for package.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-'));
  assert.equal(isProfileInitialized(dir), false);
  fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8');
  assert.equal(isProfileInitialized(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isProfileReady requires sdk-app bundle and node_modules install', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-ready-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }),
    'utf8',
  );
  assert.equal(isProfileReady(dir), false);

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } },
    }),
    'utf8',
  );
  assert.equal(isProfileReady(dir), false);

  const sdkAppDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-sdk-app');
  fs.mkdirSync(sdkAppDir, { recursive: true });
  fs.writeFileSync(path.join(sdkAppDir, 'package.json'), '{"name":"@deepseek-ai/dsh-sdk-app"}', 'utf8');
  assert.equal(isProfileReady(dir), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('readProfileManifest returns null when missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-read-'));
  assert.equal(readProfileManifest(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
