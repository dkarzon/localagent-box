import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  NO_LOCKFILE_CACHE_KEY,
  computeCacheKey,
  sanitizeCacheKey,
} from './dep-cache-key';
import { loadRuntimeProfiles } from './runtime-profiles';
import type { RuntimeProfile } from './runtime-profiles';

const CATALOG: Record<string, RuntimeProfile> = loadRuntimeProfiles();

function tmpWorkspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-cache-key-'));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents, 'utf8');
  }
  return dir;
}

describe('sanitizeCacheKey', () => {
  it('keeps alphanumerics and hyphens', () => {
    assert.equal(sanitizeCacheKey('myrepo-node22-pnpm9'), 'myrepo-node22-pnpm9');
  });

  it('strips slashes, extensions and other path-hostile characters', () => {
    assert.equal(sanitizeCacheKey('a/b/c.ext'), 'abcext');
  });

  it('strips leading hyphens so the segment cannot be a flag', () => {
    assert.equal(sanitizeCacheKey('---node---'), 'node---');
  });

  it('caps the segment at max length', () => {
    const sanitized = sanitizeCacheKey('abcdefghijklmnopqrstuvwxyz-'.repeat(100));
    assert.ok(sanitized !== null);
    assert.equal(sanitized.length, 200);
    assert.match(sanitized, /^[a-zA-Z0-9-]+$/);
  });

  it('returns null when nothing usable remains or the result is a traversal name', () => {
    assert.equal(sanitizeCacheKey(''), null);
    assert.equal(sanitizeCacheKey('/\\.\\.$$/'), null);
    assert.equal(sanitizeCacheKey('..'), null);
  });
});

describe('computeCacheKey', () => {
  const nodejsLock = {
    'package.json': '{ lock: "a" }',
    'package-lock.json': '{ "lockfileVersion": 3, "version": 1 }',
  };

  it('returns the {repoId}/{cacheKey} path segment for a hashed key', () => {
    const dir = tmpWorkspace(nodejsLock);
    const key = computeCacheKey({
      repoId: 'acme/repo 1',
      profiles: ['nodejs'],
      workspaceDir: dir,
      catalog: CATALOG,
    });
    assert.equal(key.repoId, 'acmerepo1');
    assert.equal(key.relativePath, `acmerepo1/${key.cacheKey}`);
    assert.equal(key.method, 'hash');
  });

  it('uses the explicit cacheKey when provided (sanitized)', () => {
    const dir = tmpWorkspace(nodejsLock);
    const key = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs'],
      explicitCacheKey: 'myrepo-node22-pnpm9',
      workspaceDir: dir,
      catalog: CATALOG,
    });
    assert.equal(key.cacheKey, 'myrepo-node22-pnpm9');
    assert.equal(key.method, 'explicit');
    assert.equal(key.lockfileHash, undefined);
  });

  it('ignores the explicit cacheKey when it sanitizes to empty', () => {
    const dir = tmpWorkspace(nodejsLock);
    const key = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs'],
      explicitCacheKey: '/./..',
      workspaceDir: dir,
      catalog: CATALOG,
    });
    assert.equal(key.method, 'hash');
    assert.equal(key.cacheKey.length, 64);
  });

  it('produces the same key for the same lockfile content', () => {
    const a = tmpWorkspace(nodejsLock);
    const b = tmpWorkspace(nodejsLock);
    const keyA = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs'],
      workspaceDir: a,
      catalog: CATALOG,
    });
    const keyB = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs'],
      workspaceDir: b,
      catalog: CATALOG,
    });
    assert.equal(keyA.cacheKey, keyB.cacheKey);
    assert.ok(keyA.lockfileHash !== undefined);
    assert.ok(keyB.lockfileHash !== undefined);
  });

  it('produces a different key when a lockfile changes', () => {
    const a = tmpWorkspace(nodejsLock);
    const b = tmpWorkspace({
      ...nodejsLock,
      'package-lock.json': '{ "lockfileVersion": 3, "version": 2 }',
    });
    const keyA = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs'],
      workspaceDir: a,
      catalog: CATALOG,
    });
    const keyB = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs'],
      workspaceDir: b,
      catalog: CATALOG,
    });
    assert.notEqual(keyA.cacheKey, keyB.cacheKey);
  });

  it('includes profile names in the hash so different profiles do not collide', () => {
    const pnpmLock = {
      'package.json': '{}',
      'pnpm-lock.yaml': 'lockfileVersion: ' + '6.0.0\n',
    };
    const dir = tmpWorkspace(pnpmLock);
    const nodeKey = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs'],
      workspaceDir: dir,
      catalog: CATALOG,
    });
    const pnpmKey = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs-pnpm'],
      workspaceDir: dir,
      catalog: CATALOG,
    });
    assert.notEqual(nodeKey.cacheKey, pnpmKey.cacheKey);
  });

  it('keys off all active profiles lockfiles for multi-profile runs', () => {
    const files = {
      'package.json': '{}',
      'pnpm-lock.yaml': 'lock: "pnpm" ',
      'package-lock.json': 'lock: "npm"',
    };
    const dir = tmpWorkspace(files);
    const both = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs-pnpm', 'nodejs'],
      workspaceDir: dir,
      catalog: CATALOG,
    });
    const onlyPnpm = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs-pnpm'],
      workspaceDir: dir,
      catalog: CATALOG,
    });
    assert.notEqual(both.lockfileHash, onlyPnpm.lockfileHash);
  });

  it('orders lockfile ranking the same for sorted and unsorted profile lists', () => {
    const files = {
      'package.json': '{}',
      'pnpm-lock.yaml': 'lock: "pnpm"',
    };
    const dir = tmpWorkspace(files);
    const first = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs', 'nodejs-pnpm'],
      workspaceDir: dir,
      catalog: CATALOG,
    });
    const second = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs-pnpm', 'nodejs'],
      workspaceDir: dir,
      catalog: CATALOG,
    });
    assert.equal(first.cacheKey, second.cacheKey);
  });

  it('auto-detects profiles when none are passed', () => {
    const dir = tmpWorkspace({ 'pnpm-lock.yaml': 'lockfileVersion: 6.0.0' });
    const detected = computeCacheKey({
      repoId: 'repo',
      workspaceDir: dir,
      catalog: CATALOG,
    });
    const explicit = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs-pnpm'],
      workspaceDir: dir,
      catalog: CATALOG,
    });
    assert.equal(detected.lockfileHash, explicit.lockfileHash);
  });

  it('skips missing lockfile candidates and drops files that disappear', () => {
    const withExtra = tmpWorkspace({
      'package.json': '{}',
      'pnpm-lock.yaml': 'lockfileVersion: 6.0.0',
    });
    const withoutExtra = tmpWorkspace({
      'package.json': '{}',
      'pnpm-lock.yaml': 'lockfileVersion: 6.0.0',
    });
    fs.writeFileSync(path.join(withExtra, 'package-lock.json'), 'extra', 'utf8');

    const keyWith = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs-pnpm', 'nodejs'],
      workspaceDir: withExtra,
      catalog: CATALOG,
    });
    const keyWithout = computeCacheKey({
      repoId: 'repo',
      profiles: ['nodejs-pnpm', 'nodejs'],
      workspaceDir: withoutExtra,
      catalog: CATALOG,
    });
    assert.notEqual(keyWith.cacheKey, keyWithout.cacheKey);
  });

  it('falls back to a stable key when no lockfile matches the active profiles', () => {
    const dir = tmpWorkspace({ 'package.json': '{"no":"lock"}' });
    const python = tmpWorkspace({});
    const keyA = computeCacheKey({
      repoId: 'repo',
      profiles: ['python'],
      workspaceDir: python,
      catalog: CATALOG,
    });
    const keyB = computeCacheKey({
      repoId: 'repo',
      profiles: ['python'],
      workspaceDir: dir,
      catalog: CATALOG,
    });
    assert.equal(keyA.cacheKey, NO_LOCKFILE_CACHE_KEY);
    assert.equal(keyB.cacheKey, NO_LOCKFILE_CACHE_KEY);
    assert.equal(keyA.method, 'hash');
    assert.equal(keyA.lockfileHash, undefined);
  });

  it('throws for repo ids that sanitize to nothing usable', () => {
    const dir = tmpWorkspace(nodejsLock);
    assert.throws(
      () =>
        computeCacheKey({
          repoId: '///',
          profiles: ['nodejs'],
          workspaceDir: dir,
          catalog: CATALOG,
        }),
      /unusable repoId/,
    );
  });
});
