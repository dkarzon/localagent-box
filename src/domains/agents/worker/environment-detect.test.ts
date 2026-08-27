import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadRuntimeProfiles } from './runtime-profiles';
import {
  detectProfiles,
  detectSetupScript,
  resolveSetupCommand,
  setupScriptCommand,
  setupScriptRelative,
} from './environment-detect';
import type { RuntimeProfile } from './runtime-profiles';

const CATALOG: Record<string, RuntimeProfile> = loadRuntimeProfiles();

describe('detectProfiles', () => {
  function tmpWorkspace(files: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-detect-'));
    for (const file of files) {
      fs.writeFileSync(path.join(dir, file), '', 'utf8');
    }
    return dir;
  }

  it('returns no profiles for an empty workspace', () => {
    assert.deepEqual(detectProfiles(tmpWorkspace([]), CATALOG), []);
  });

  it('detects pnpm-lock.yaml as nodejs-pnpm', () => {
    // A monorepo has package.json too — the lockfile must rank first.
    assert.deepEqual(detectProfiles(tmpWorkspace(['package.json', 'pnpm-lock.yaml']), CATALOG), [
      'nodejs-pnpm',
      'nodejs',
    ]);
  });

  it('detects package-lock.json as nodejs', () => {
    assert.deepEqual(
      detectProfiles(tmpWorkspace(['package.json', 'package-lock.json']), CATALOG),
      ['nodejs'],
    );
  });

  it('detects yarn.lock as nodejs-yarn', () => {
    assert.deepEqual(
      detectProfiles(tmpWorkspace(['package.json', 'yarn.lock']), CATALOG),
      ['nodejs-yarn', 'nodejs'],
    );
  });

  it('detects go.mod as go', () => {
    assert.deepEqual(detectProfiles(tmpWorkspace(['go.mod']), CATALOG), ['go']);
  });

  it('detects Cargo.toml as rust', () => {
    assert.deepEqual(detectProfiles(tmpWorkspace(['Cargo.toml']), CATALOG), ['rust']);
  });

  it('detects pyproject.toml or requirements.txt as python', () => {
    assert.deepEqual(detectProfiles(tmpWorkspace(['pyproject.toml']), CATALOG), ['python']);
    assert.deepEqual(detectProfiles(tmpWorkspace(['requirements.txt']), CATALOG), ['python']);
    assert.deepEqual(
      detectProfiles(tmpWorkspace(['pyproject.toml', 'requirements.txt']), CATALOG),
      ['python'],
    );
  });

  it('returns all matching profiles in priority order', () => {
    const ws = tmpWorkspace(['package.json', 'pnpm-lock.yaml']);
    assert.deepEqual(detectProfiles(ws, CATALOG), ['nodejs-pnpm', 'nodejs']);
  });
});

describe('resolveSetupCommand', () => {
  function tmpWorkspace(files: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-detect-'));
    for (const file of files) {
      fs.writeFileSync(path.join(dir, file), '', 'utf8');
    }
    return dir;
  }

  it('resolves an explicit setup.command before anything else', () => {
    const dir = tmpWorkspace(['package-lock.json']);
    const resolved = resolveSetupCommand({ version: 1, setup: { command: 'make build' } }, dir, CATALOG);
    assert.deepEqual(resolved, { command: 'make build', profiles: [], source: 'explicit' });
  });

  it('uses an explicit command even when profiles would win on priority', () => {
    const dir = tmpWorkspace(['pnpm-lock.yaml', 'package.json']);
    const resolved = resolveSetupCommand(
      { version: 1, setup: { command: 'make build' }, profiles: ['nodejs-pnpm'] },
      dir,
      CATALOG,
    );
    assert.deepEqual(resolved, { command: 'make build', profiles: [], source: 'explicit' });
  });

  it('uses the first requested profile default when profiles are present', () => {
    const dir = tmpWorkspace([]);
    const resolved = resolveSetupCommand(
      { version: 1, profiles: ['nodejs', 'nodejs-pnpm'] },
      dir,
      CATALOG,
    );
    assert.deepEqual(resolved, {
      command: 'npm ci --ignore-scripts',
      profiles: ['nodejs'],
      source: 'profile',
    });
  });

  it('prefers explicit profiles over auto-detected ones', () => {
    const dir = tmpWorkspace(['pnpm-lock.yaml', 'package.json']);
    const resolved = resolveSetupCommand(
      { version: 1, profiles: ['nodejs'] },
      dir,
      CATALOG,
    );
    assert.deepEqual(resolved, { command: 'npm ci --ignore-scripts', profiles: ['nodejs'], source: 'profile' });
  });

  it('resolves to none when all requested profiles are disabled', () => {
    const dir = tmpWorkspace([]);
    const resolved = resolveSetupCommand(
      { version: 1, profiles: ['nodejs'] },
      dir,
      CATALOG,
      ['nodejs-pnpm'],
    );
    assert.deepEqual(resolved, { command: '', profiles: [], source: 'none' });
  });

  it('resolves to none when all requested profiles are unknown', () => {
    const dir = tmpWorkspace([]);
    const resolved = resolveSetupCommand(
      { version: 1, profiles: ['not-a-profile'] },
      dir,
      CATALOG,
    );
    assert.deepEqual(resolved, { command: '', profiles: [], source: 'none' });
  });

  it('auto-detects the first priority-matched profile when no explicit config', () => {
    const dir = tmpWorkspace(['package.json', 'pnpm-lock.yaml']);
    const resolved = resolveSetupCommand(
      { version: 1 },
      dir,
      CATALOG,
    );
    assert.deepEqual(resolved, {
      command: 'corepack enable && pnpm install --frozen-lockfile',
      profiles: ['nodejs-pnpm'],
      source: 'detect',
    });
  });

  it('auto-detects python for pyproject.toml', () => {
    const dir = tmpWorkspace(['pyproject.toml']);
    const resolved = resolveSetupCommand({ version: 1 }, dir, CATALOG);
    assert.equal(resolved.source, 'detect');
    assert.deepEqual(resolved.profiles, ['python']);
  });

  it('auto-detects go for go.mod', () => {
    const dir = tmpWorkspace(['go.mod']);
    const resolved = resolveSetupCommand({ version: 1 }, dir, CATALOG);
    assert.equal(resolved.source, 'detect');
    assert.deepEqual(resolved.profiles, ['go']);
  });

  it('auto-detects rust for Cargo.toml', () => {
    const dir = tmpWorkspace(['Cargo.toml']);
    const resolved = resolveSetupCommand({ version: 1 }, dir, CATALOG);
    assert.equal(resolved.source, 'detect');
    assert.deepEqual(resolved.profiles, ['rust']);
  });

  it('auto-detects nodejs for package-lock.json', () => {
    const dir = tmpWorkspace(['package.json', 'package-lock.json']);
    const resolved = resolveSetupCommand({ version: 1 }, dir, CATALOG);
    assert.equal(resolved.source, 'detect');
    assert.deepEqual(resolved.profiles, ['nodejs']);
    assert.equal(resolved.command, 'npm ci --ignore-scripts');
  });

  it('respects autoDetect: false in the environment config', () => {
    const dir = tmpWorkspace(['pnpm-lock.yaml', 'package.json']);
    const resolved = resolveSetupCommand({ version: 1, autoDetect: false }, dir, CATALOG);
    assert.deepEqual(resolved, { command: '', profiles: [], source: 'none' });
  });

  it('resolves to none when no lockfile exists and there is no explicit config', () => {
    const dir = tmpWorkspace(['README.md']);
    const resolved = resolveSetupCommand({ version: 1 }, dir, CATALOG);
    assert.deepEqual(resolved, { command: '', profiles: [], source: 'none' });
  });

  it('honors enabledProfileNames filter on auto-detect', () => {
    const dir = tmpWorkspace(['package.json', 'pnpm-lock.yaml']);
    const resolved = resolveSetupCommand(
      { version: 1 },
      dir,
      CATALOG,
      ['nodejs'],
    );
    // nodejs-pnpm is off, so fall back to nodejs which is still matched
    assert.deepEqual(resolved, {
      command: 'npm ci --ignore-scripts',
      profiles: ['nodejs'],
      source: 'detect',
    });
  });

  it('honors enabledProfileNames filter when all detected profiles are off', () => {
    const dir = tmpWorkspace(['package.json', 'pnpm-lock.yaml']);
    const resolved = resolveSetupCommand({ version: 1 }, dir, CATALOG, ['go', 'python']);
    assert.deepEqual(resolved, { command: '', profiles: [], source: 'none' });
  });

  it('reports skipped profiles via the onProfileSkipped callback', () => {
    const dir = tmpWorkspace(['pnpm-lock.yaml', 'package.json']);
    const skipped: Array<{ profile: string; reason: string }> = [];
    const resolved = resolveSetupCommand(
      { version: 1 },
      dir,
      CATALOG,
      ['go'],
      (profile, reason) => {
        skipped.push({ profile, reason });
      },
    );
    // Both detected profiles are disabled by the gate, so resolution is none.
    assert.deepEqual(resolved, { command: '', profiles: [], source: 'none' });
    assert.deepEqual(skipped, [
      { profile: 'nodejs-pnpm', reason: 'disabled' },
      { profile: 'nodejs', reason: 'disabled' },
    ]);
  });

  it('reports disabled and unknown requested profiles distinctly', () => {
    const dir = tmpWorkspace([]);
    const skipped: Array<{ profile: string; reason: string }> = [];
    const resolved = resolveSetupCommand(
      { version: 1, profiles: ['go', 'nodejs-pnpm', 'not-a-profile'] },
      dir,
      CATALOG,
      ['nodejs-pnpm'],
      (profile, reason) => {
        skipped.push({ profile, reason });
      },
    );
    // nodejs-pnpm is enabled and wins; the others are skipped in order.
    assert.deepEqual(resolved, {
      command: 'corepack enable && pnpm install --frozen-lockfile',
      profiles: ['nodejs-pnpm'],
      source: 'profile',
    });
    assert.deepEqual(skipped, [{ profile: 'go', reason: 'disabled' }]);
  });
});

describe('setup script resolution (P4-T1)', () => {
  function tmpWorkspace(files: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-detect-'));
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), '', 'utf8');
    }
    return dir;
  }

  it('exports the setup script path and invocation', () => {
    assert.equal(setupScriptRelative, '.localagent-box/setup.sh');
    assert.equal(setupScriptCommand, 'bash .localagent-box/setup.sh');
  });

  it('detects a committed setup.sh', () => {
    const dir = tmpWorkspace(['setup-marker', '.localagent-box/setup.sh']);
    assert.equal(detectSetupScript(dir), 'bash .localagent-box/setup.sh');
  });

  it('returns null when the setup script is absent', () => {
    const dir = tmpWorkspace(['setup-marker']);
    assert.equal(detectSetupScript(dir), null);
  });

  it('resolves a committed setup.sh before an explicit setup.command', () => {
    const dir = tmpWorkspace(['setup-marker', '.localagent-box/setup.sh']);
    const resolved = resolveSetupCommand(
      { version: 1, setup: { command: 'make build' } },
      dir,
      CATALOG,
    );
    assert.deepEqual(resolved, {
      command: 'bash .localagent-box/setup.sh',
      profiles: [],
      source: 'script',
    });
  });

  it('resolves a committed setup.sh before profiles and auto-detect', () => {
    const dir = tmpWorkspace(['setup-marker', 'pnpm-lock.yaml', 'package.json', '.localagent-box/setup.sh']);
    const resolved = resolveSetupCommand(
      { version: 1, profiles: ['nodejs-pnpm'], autoDetect: true },
      dir,
      CATALOG,
    );
    assert.deepEqual(resolved, {
      command: 'bash .localagent-box/setup.sh',
      profiles: [],
      source: 'script',
    });
  });

  it('still resolves explicit setup.command when no setup.sh is committed', () => {
    const dir = tmpWorkspace(['setup-marker']);
    const resolved = resolveSetupCommand(
      { version: 1, setup: { command: 'make build' }, profiles: ['nodejs'] },
      dir,
      CATALOG,
    );
    assert.deepEqual(resolved, { command: 'make build', profiles: [], source: 'explicit' });
  });
});
