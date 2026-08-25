import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  getDepCacheDirs,
  restoreDepCache,
  snapshotDepCache,
  type DepCacheManifest,
} from './dep-cache';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function seedWorkspace(workspaceDir: string, files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(workspaceDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, 'utf8');
  }
}

async function rmrf(target: string): Promise<void> {
  fs.rmSync(target, { recursive: true, force: true });
}

const manifest: DepCacheManifest = {
  command: 'npm ci --ignore-scripts',
  profiles: ['nodejs'],
  lockfileHash: 'a'.repeat(64),
};

describe('getDepCacheDirs', () => {
  it('caches node_modules for nodejs profiles only', () => {
    assert.deepEqual(getDepCacheDirs('nodejs'), ['node_modules']);
    assert.deepEqual(getDepCacheDirs('nodejs-pnpm'), ['node_modules']);
  });

  it('does not cache anything for unsupported profiles yet', () => {
    assert.deepEqual(getDepCacheDirs('python'), []);
    assert.deepEqual(getDepCacheDirs('unknown'), []);
  });
});

describe('restoreDepCache', () => {
  it('returns false on a cache miss (no cache directory)', async () => {
    const cacheRoot = tmpDir('dep-cache-restore-miss-');
    const cacheDir = path.join(cacheRoot, 'repo', 'key');
    const workspace = tmpDir('dep-cache-restore-miss-workspace-');
    try {
      assert.equal(await restoreDepCache(cacheDir, workspace, 'nodejs'), false);
      assert.equal(fs.existsSync(path.join(workspace, 'node_modules')), false);
    } finally {
      await Promise.all([rmrf(cacheRoot), rmrf(workspace)]);
    }
  });

  it('returns false for unsupported profiles even with cached data', async () => {
    const cacheRoot = tmpDir('dep-cache-restore-unsupported-');
    const cacheDir = path.join(cacheRoot, 'repo', 'key');
    fs.mkdirSync(path.join(cacheDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'node_modules', 'pkg.js'), 'x');
    const workspace = tmpDir('dep-cache-restore-unsupported-workspace-');
    try {
      assert.equal(await restoreDepCache(cacheDir, workspace, 'python'), false);
      assert.equal(fs.existsSync(path.join(workspace, 'node_modules')), false);
    } finally {
      await Promise.all([rmrf(cacheRoot), rmrf(workspace)]);
    }
  });

  it('returns false when the cache entry exists but has no cached directories', async () => {
    const cacheRoot = tmpDir('dep-cache-restore-empty-');
    const cacheDir = path.join(cacheRoot, 'repo', 'key');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'manifest.json'), '{}');
    const workspace = tmpDir('dep-cache-restore-empty-workspace-');
    try {
      assert.equal(await restoreDepCache(cacheDir, workspace, 'nodejs'), false);
    } finally {
      await Promise.all([rmrf(cacheRoot), rmrf(workspace)]);
    }
  });

  it('restores node_modules on a cache hit', async () => {
    const cacheRoot = tmpDir('dep-cache-restore-hit-');
    const cacheDir = path.join(cacheRoot, 'repo', 'key');
    fs.mkdirSync(path.join(cacheDir, 'node_modules', 'left-pad', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(cacheDir, 'node_modules', 'left-pad', 'dist', 'index.js'), 'dist');
    fs.writeFileSync(path.join(cacheDir, 'manifest.json'), '{}');

    const workspace = tmpDir('dep-cache-restore-hit-workspace-');
    try {
      assert.equal(
        await restoreDepCache(cacheDir, workspace, 'nodejs-pnpm'),
        true,
      );
      assert.deepEqual(
        fs.readdirSync(path.join(workspace, 'node_modules')).sort(),
        ['left-pad'],
      );
      assert.equal(
        fs.readFileSync(path.join(workspace, 'node_modules', 'left-pad', 'index.js'), 'utf8'),
        'module.exports = 1;',
      );
      assert.equal(
        fs.existsSync(path.join(workspace, 'node_modules', 'left-pad', 'dist', 'index.js')),
        true,
      );
    } finally {
      await Promise.all([rmrf(cacheRoot), rmrf(workspace)]);
    }
  });

  it('replaces pre-existing stale directories in the workspace', async () => {
    const cacheRoot = tmpDir('dep-cache-restore-stale-');
    const cacheDir = path.join(cacheRoot, 'repo', 'key');
    fs.mkdirSync(path.join(cacheDir, 'node_modules', 'fresh'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'node_modules', 'fresh', 'pkg.js'), 'fresh');
    fs.writeFileSync(path.join(cacheDir, 'manifest.json'), '{}');

    const workspace = tmpDir('dep-cache-restore-stale-workspace-');
    seedWorkspace(workspace, { 'node_modules/stale/pkg.js': 'stale' });
    try {
      assert.equal(await restoreDepCache(cacheDir, workspace, 'nodejs'), true);
      assert.deepEqual(
        fs.readdirSync(path.join(workspace, 'node_modules')).sort(),
        ['fresh'],
      );
    } finally {
      await Promise.all([rmrf(cacheRoot), rmrf(workspace)]);
    }
  });

  it('leaves no partial state when the restore fails', async () => {
    const cacheRoot = tmpDir('dep-cache-restore-fail-');
    const cacheDir = path.join(cacheRoot, 'repo', 'key');
    fs.mkdirSync(path.join(cacheDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'node_modules', 'pkg.js'), 'pkg');
    fs.writeFileSync(path.join(cacheDir, 'manifest.json'), '{}');

    const workspace = tmpDir('dep-cache-restore-fail-workspace-');
    const target = path.join(workspace, 'node_modules');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'protected.js'), 'guarded');
    const originalRename = fs.promises.rename;
    fs.promises.rename = (() => {
      throw new Error('disk full');
    }) as typeof fs.promises.rename;
    try {
      await assert.rejects(
        restoreDepCache(cacheDir, workspace, 'nodejs'),
        /Failed to restore node_modules into workspace/,
      );
      assert.deepEqual(
        fs.readdirSync(target).sort(),
        ['protected.js'],
        'stale workspace dir must stay intact after a failed restore',
      );
      for (const entry of fs.readdirSync(workspace)) {
        assert.ok(!entry.startsWith('.dep-cache-restore-'));
      }
    } finally {
      fs.promises.rename = originalRename;
      await Promise.all([rmrf(cacheRoot), rmrf(workspace)]);
    }
  });
});

describe('snapshotDepCache', () => {
  it('creates a cache entry with a manifest.json on success', async () => {
    const cacheRoot = tmpDir('dep-cache-snapshot-');
    const cacheDir = path.join(cacheRoot, 'repo', 'key');
    const workspace = tmpDir('dep-cache-snapshot-workspace-');
    seedWorkspace(workspace, {
      'node_modules/left-pad/index.js': 'module.exports = 1;',
      'node_modules/left-pad/dist/index.js': 'dist',
    });
    try {
      await snapshotDepCache(cacheDir, workspace, 'nodejs', manifest);
      const manifestPath = path.join(cacheDir, 'manifest.json');
      assert.ok(fs.existsSync(manifestPath));
      const stored = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.equal(stored.command, manifest.command);
      assert.deepEqual(stored.profiles, ['nodejs']);
      assert.equal(stored.lockfileHash, manifest.lockfileHash);
      assert.equal(typeof stored.createdAt, 'string');
      assert.deepEqual(
        fs.readdirSync(path.join(cacheDir, 'node_modules')).sort(),
        ['left-pad'],
      );
    } finally {
      await Promise.all([rmrf(cacheRoot), rmrf(workspace)]);
    }
  });

  it('round-trips a snapshot into a fresh workspace restore', async () => {
    const cacheRoot = tmpDir('dep-cache-round-trip-');
    const cacheDir = path.join(cacheRoot, 'repo', 'key');
    const source = tmpDir('dep-cache-round-trip-source-');
    const target = tmpDir('dep-cache-round-trip-target-');
    seedWorkspace(source, {
      'node_modules/pkg/index.js': 'ok',
      'src/main.ts': 'src',
    });
    try {
      await snapshotDepCache(cacheDir, source, 'nodejs-pnpm', manifest);
      assert.equal(await restoreDepCache(cacheDir, target, 'nodejs-pnpm'), true);
      assert.deepEqual(
        fs.readdirSync(path.join(target, 'node_modules')).sort(),
        ['pkg'],
      );
      assert.equal(
        fs.readFileSync(path.join(target, 'node_modules', 'pkg', 'index.js'), 'utf8'),
        'ok',
      );
      assert.equal(fs.existsSync(path.join(target, 'src')), false, 'only node_modules is cached');
    } finally {
      await Promise.all([rmrf(cacheRoot), rmrf(source), rmrf(target)]);
    }
  });

  it('is a no-op for unsupported profiles', async () => {
    const cacheRoot = tmpDir('dep-cache-snapshot-unsupported-');
    const cacheDir = path.join(cacheRoot, 'repo', 'key');
    const workspace = tmpDir('dep-cache-snapshot-unsupported-workspace-');
    seedWorkspace(workspace, { '.venv/lib/site-packages/pkg.py': 'py' });
    try {
      await snapshotDepCache(cacheDir, workspace, 'python', manifest);
      assert.equal(fs.existsSync(cacheDir), false);
    } finally {
      await Promise.all([rmrf(cacheRoot), rmrf(workspace)]);
    }
  });

  it('throws when the profile has no cacheable directories in the workspace', async () => {
    const cacheRoot = tmpDir('dep-cache-snapshot-missing-');
    const cacheDir = path.join(cacheRoot, 'repo', 'key');
    const workspace = tmpDir('dep-cache-snapshot-missing-workspace-');
    try {
      await assert.rejects(
        snapshotDepCache(cacheDir, workspace, 'nodejs', manifest),
        /No cacheable node_modules directories found/,
      );
      assert.equal(fs.existsSync(cacheDir), false);
      for (const entry of fs.readdirSync(path.dirname(cacheDir))) {
        assert.ok(!entry.startsWith(`${path.basename(cacheDir)}.staging`));
      }
    } finally {
      await Promise.all([rmrf(cacheRoot), rmrf(workspace)]);
    }
  });

  it('replaces the cache entry atomically, preserving the old entry on failure', async () => {
    const cacheRoot = tmpDir('dep-cache-snapshot-replace-');
    const cacheDir = path.join(cacheRoot, 'repo', 'key');
    fs.mkdirSync(path.join(cacheDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'node_modules', 'old.js'), 'old');
    fs.writeFileSync(path.join(cacheDir, 'manifest.json'), '"old"');
    fs.closeSync(fs.openSync(path.join(cacheDir, 'node_modules', 'old.js'), 'r'));

    const workspace = tmpDir('dep-cache-snapshot-replace-workspace-');
    seedWorkspace(workspace, { 'node_modules/new.js': 'new' });

    const originalCp = fs.promises.cp;
    fs.promises.cp = (() => {
      throw new Error('copied broken');
    }) as typeof fs.promises.cp;
    try {
      await assert.rejects(
        snapshotDepCache(cacheDir, workspace, 'nodejs', manifest),
        /Failed to copy node_modules into dependency cache staging/,
      );
      assert.equal(
        fs.readFileSync(path.join(cacheDir, 'node_modules', 'old.js'), 'utf8'),
        'old',
        'a failed snapshot must not clobber the existing entry',
      );
    } finally {
      fs.promises.cp = originalCp;
    }
    await rmrf(workspace);
    await rmrf(cacheRoot);
  });
});
