import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createConfigStore, DEFAULT_CONFIG, LEGACY_CONFIG_KEYS } from './config-store';

interface CapturedWarn {
  obj: Record<string, unknown>;
  message: string;
}

function createTestStore(warns: CapturedWarn[]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-store-'));
  const store = createConfigStore(dataDir, fs, {
    warn: (obj: Record<string, unknown>, message: string) => warns.push({ obj, message }),
  });
  return { dataDir, store, warns };
}

describe('config-store unknown keys', () => {
  it('lists the config keys removed in v1', () => {
    assert.deepEqual([...LEGACY_CONFIG_KEYS], [
      'interactiveAutoApprovePermissions',
      'interactiveAgentTimeoutSeconds',
      'loopAutoApprovePermissions',
      'loopAgentTimeoutSeconds',
      'loopVerbModels',
      'loopDefaultMaxIterations',
    ]);
    for (const key of LEGACY_CONFIG_KEYS) {
      assert.ok(!(key in DEFAULT_CONFIG), `${key} must not be part of AppConfig`);
    }
  });

  it('drops a legacy key, warns once, and saves without it', () => {
    const { dataDir, store, warns } = createTestStore([]);
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        opencodeModel: 'qwen2.5-coder:7b',
        loopVerbModels: { build: 'qwen2.5-coder:7b' },
        legacyUnknownKey: 1,
      }),
      'utf8',
    );

    const config = store.loadConfig();
    assert.equal(config.opencodeModel, 'qwen2.5-coder:7b');
    assert.ok(!('loopVerbModels' in config), 'legacy key must not be loaded into memory');

    assert.equal(warns.length, 1);
    assert.equal(warns[0].message, 'ignoring unknown config keys');
    assert.deepEqual(warns[0].obj.keys, ['loopVerbModels', 'legacyUnknownKey']);

    store.saveConfig({ opencodeModel: 'gemma4:e4b' });
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.deepEqual(saved, { ...DEFAULT_CONFIG, opencodeModel: 'gemma4:e4b' });
  });

  it('does not warn when every key is known', () => {
    const { store, warns } = createTestStore([]);
    const config = store.loadConfig();
    assert.equal(config.opencodeModel, '');
    assert.deepEqual(warns, []);
  });

  it('falls back to defaults when the top-level JSON value is null', () => {
    const { dataDir, store, warns } = createTestStore([]);
    fs.writeFileSync(path.join(dataDir, 'config.json'), 'null', 'utf8');

    const config = store.loadConfig();
    assert.deepEqual(config, { ...DEFAULT_CONFIG });
    assert.deepEqual(warns, []);
  });
});
