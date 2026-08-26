import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  getDepCacheDirs,
  purgeDepCacheEntries,
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

  it('tolerates a concurrent bootstrap winning the same-workspace rename race', async () => {
    const cacheRoot = tmpDir('dep-cache-restore-race-');
    const cacheDir = path.join(cacheRoot, 'repo', 'key');
    fs.mkdirSync(path.join(cacheDir, 'node_modules', 'cached'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'node_modules', 'cached', 'pkg.js'), 'cached');
    fs.writeFileSync(path.join(cacheDir, 'manifest.json'), '{}');

    const workspace = tmpDir('dep-cache-restore-race-workspace-');
    const target = path.join(workspace, 'node_modules');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'old.js'), 'old');

    const originalRename = fs.promises.rename;
    const leftovers = (dir: string): string[] =>
      fs.readdirSync(dir).filter(
        (name) => name.includes('.staging-') || name.includes('.original-'),
      );
    try {
      // Case 1: the target->original move loses the race (ENOENT): a
      // concurrent bootstrap moved the old tree out first. The loser
      // keeps the stale tree in place and must not abort the restore.
      fs.promises.rename = (async (): Promise<void> => {
        throw Object.assign(new Error('ENOENT: concurrent bootstrap'), {
          code: 'ENOENT',
        });
      }) as typeof fs.promises.rename;
      assert.equal(await restoreDepCache(cacheDir, workspace, 'nodejs'), true);
      assert.deepEqual(
        fs.readdirSync(target).sort(),
        ['old.js'],
        'the stale workspace directory must remain in place',
      );
      assert.deepEqual(leftovers(workspace), []);
      fs.promises.rename = originalRename;

      // Case 2: the move succeeds but the staging->target swap loses to a
      // concurrent bootstrap's tree (ENOTEMPTY). The loser drops the staged
      // copy and the partial-swap state; the restore must not throw.
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'old.js'), 'old');
      let moveDone = false;
      fs.promises.rename = (async (src: string, dst: string): Promise<void> => {
        if (!moveDone) {
          moveDone = true;
          await originalRename(src, dst);
          return;
        }
        throw Object.assign(new Error('ENOTEMPTY: concurrent bootstrap'), {
          code: 'ENOTEMPTY',
        });
      }) as typeof fs.promises.rename;
      assert.equal(await restoreDepCache(cacheDir, workspace, 'nodejs'), true);
      assert.deepEqual(leftovers(workspace), []);
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

describe('purgeDepCacheEntries', () => {
  function makeCacheDir(root: string, entryKey: string): string {
    const entryDir = path.join(root, 'repo', entryKey);
    fs.mkdirSync(path.join(entryDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(entryDir, 'node_modules', 'pkg.js'), 'v');
    return entryDir;
  }

  it('removes only the requested entry', () => {
    const root = tmpDir('dep-cache-purge-one-');
    const sibling = makeCacheDir(root, 'keep-me');
    const targetDir = makeCacheDir(root, 'purge-me');
    try {
      const result = purgeDepCacheEntries(root, 'repo', 'purge-me');
      assert.deepEqual(result, { existed: true, removed: 1 });
      assert.equal(fs.existsSync(targetDir), false);
      assert.equal(fs.existsSync(sibling), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes the whole repo directory when no key is given (idempotent)', () => {
    const root = tmpDir('dep-cache-purge-all-');
    makeCacheDir(root, 'entry-a');
    try {
      assert.deepEqual(purgeDepCacheEntries(root, 'repo'), { existed: true, removed: 1 });
      assert.equal(fs.existsSync(path.join(root, 'repo')), false);
      assert.deepEqual(purgeDepCacheEntries(root, 'repo'), { existed: false, removed: 0 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws when the key resolves outside the repo directory without removing anything', () => {
    const root = tmpDir('dep-cache-purge-traversal-');
    makeCacheDir(root, 'entry-x');
    fs.mkdirSync(path.join(root, 'outside'), { recursive: true });
    try {
      for (const key of ['..', '../../..', 'a/../../../..']) {
        assert.throws(
          () => purgeDepCacheEntries(root, 'repo', key),
          /cache key escapes repo cache directory/,
        );
      }
      assert.equal(fs.existsSync(path.join(root, 'repo', 'entry-x')), true);
      assert.equal(fs.existsSync(path.join(root, 'outside')), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalizes keys that stay inside the repo directory', () => {
    const root = tmpDir('dep-cache-purge-normalize-');
    const sub = path.join(root, 'repo', 'a');
    fs.mkdirSync(sub, { recursive: true });
    try {
      // `a` and `a/b/..` both resolve to the same entry; removing the
      // already-absent one is idempotent (not an error).
      assert.deepEqual(purgeDepCacheEntries(root, 'repo', 'a/b/..'), { existed: true, removed: 1 });
      assert.equal(fs.existsSync(sub), false);
      assert.deepEqual(purgeDepCacheEntries(root, 'repo', 'a'), { existed: true, removed: 1 });
      assert.equal(fs.existsSync(sub), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a key that resolves to the repo directory itself as an escape', () => {
    const root = tmpDir('dep-cache-purge-self-');
    makeCacheDir(root, 'entry-y');
    try {
      assert.throws(
        () => purgeDepCacheEntries(root, 'repo', '.'),
        /cache key escapes repo cache directory/,
      );
      assert.equal(fs.existsSync(path.join(root, 'repo', 'entry-y')), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
