import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getRuntimeProfile,
  loadRuntimeProfiles,
} from './runtime-profiles';

describe('loadRuntimeProfiles', () => {
  it('loads the bundled catalog and validates each profile shape', () => {
    const profiles = loadRuntimeProfiles();

    assert.ok(Object.keys(profiles).length > 0, 'catalog should not be empty');

    for (const [name, profile] of Object.entries(profiles)) {
      assert.ok(Array.isArray(profile.detect), `${name}.detect must be an array`);
      assert.ok(
        profile.detect.every((entry) => typeof entry === 'string' && entry.length > 0),
        `${name}.detect entries must be non-empty strings`,
      );
      assert.equal(typeof profile.defaultSetup, 'string');
      assert.ok(profile.defaultSetup.trim().length > 0, `${name}.defaultSetup must be non-empty`);
      assert.ok(Array.isArray(profile.tools), `${name}.tools must be an array`);
      assert.ok(Array.isArray(profile.cacheDirs), `${name}.cacheDirs must be an array`);
    }
  });

  it('exposes the known profile keys', () => {
    const profiles = loadRuntimeProfiles();

    for (const name of [
      'nodejs',
      'nodejs-pnpm',
      'nodejs-yarn',
      'python',
      'go',
      'rust',
    ] as const) {
      assert.ok(profiles[name], `expected profile ${name} in catalog`);
      assert.ok(getRuntimeProfile(name), `expected profile ${name} to resolve`);
    }
  });
});

describe('getRuntimeProfile', () => {
  it('returns undefined for unknown profiles', () => {
    assert.equal(getRuntimeProfile('definitely-not-a-profile'), undefined);
  });
});
