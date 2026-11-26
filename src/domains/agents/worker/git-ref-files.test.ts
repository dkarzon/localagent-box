import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { loadEnvironmentConfigFromBase, readFileAtRef, resolveBaseRef } from './git-ref-files';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function write(dir: string, relativePath: string, content: string): void {
  const filePath = path.join(dir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

const configRelative = '.localagent-box/environment.json';

/**
 * A workspace like a batch run's: `main` holds `baseConfig`, then the agent
 * branch changes it. The working tree (and HEAD) is the agent branch.
 */
function makeRepo(baseConfig: string | null, headConfig: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ref-files-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  write(dir, 'README.md', 'x');
  if (baseConfig !== null) write(dir, configRelative, baseConfig);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'localagent-agent1');
  if (headConfig !== null) write(dir, configRelative, headConfig);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'head', '--allow-empty');
  return dir;
}

const baseConfig = JSON.stringify({
  version: 1,
  checks: { build: 'npm run build', test: 'npm test' },
  repairAttempts: 1,
});
const headConfig = JSON.stringify({
  version: 1,
  checks: { build: 'echo "agent changed the check"', test: 'echo true' },
  repairAttempts: 3,
});

describe('loadEnvironmentConfigFromBase', () => {
  it('uses the base branch version of a config the head branch changed', async () => {
    const dir = makeRepo(baseConfig, headConfig);

    const { config, notes } = await loadEnvironmentConfigFromBase(dir, 'main');

    assert.deepEqual(config?.checks, { build: 'npm run build', test: 'npm test' });
    assert.equal(config?.repairAttempts, 1);
    assert.ok(notes.some((note) => note.includes('from base branch main')));
    // The working tree still holds the head version, which is not what is used.
    assert.equal(fs.readFileSync(path.join(dir, ...configRelative.split('/')), 'utf8'), headConfig);
  });

  it('returns null when the base branch has no environment.json', async () => {
    const dir = makeRepo(null, headConfig);
    const { config, notes, available } = await loadEnvironmentConfigFromBase(dir, 'main');
    assert.equal(config, null);
    assert.equal(available, true, 'no config file is not the same as an unreadable branch');
    assert.deepEqual(notes, []);
  });

  it('fails closed when the base branch is not in the workspace', async () => {
    const dir = makeRepo(baseConfig, headConfig);
    const { config, notes, available } = await loadEnvironmentConfigFromBase(dir, 'does-not-exist');
    assert.equal(config, null);
    assert.equal(available, false);
    assert.ok(notes.some((note) => note.startsWith('Warning: base branch does-not-exist')));
  });

  it('throws on an invalid config on the base branch', async () => {
    const dir = makeRepo(JSON.stringify({ version: 1, repairAttempts: 9 }), headConfig);
    await assert.rejects(
      () => loadEnvironmentConfigFromBase(dir, 'main'),
      /Failed to load .*repairAttempts must be an integer between 0 and 3/,
    );
  });

  it('prefers the fetched remote ref over the local branch', async () => {
    const dir = makeRepo(baseConfig, headConfig);
    // A `--single-branch` clone only has the base branch as a remote ref.
    const baseSha = execFileSync('git', ['rev-parse', 'main'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    git(dir, 'update-ref', 'refs/remotes/origin/main', baseSha);

    assert.equal(await resolveBaseRef(dir, 'main'), 'refs/remotes/origin/main');

    const { config } = await loadEnvironmentConfigFromBase(dir, 'main');
    assert.deepEqual(config?.checks, { build: 'npm run build', test: 'npm test' });
  });
});

describe('readFileAtRef', () => {
  it('returns null for a file that does not exist at the ref', async () => {
    const dir = makeRepo(null, headConfig);
    assert.equal(await readFileAtRef(dir, 'refs/heads/main', configRelative), null);
  });

  it('returns the file contents at the ref', async () => {
    const dir = makeRepo(baseConfig, headConfig);
    assert.equal(await readFileAtRef(dir, 'refs/heads/main', configRelative), baseConfig);
  });
});
