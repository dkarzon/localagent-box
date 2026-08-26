import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  DETECTION_PRIORITY,
  DETECT_FALLBACK_PRIORITY,
  detectProfiles,
} from './environment-detect';
import {
  loadRuntimeProfiles,
  type RuntimeProfile,
} from './runtime-profiles';

/**
 * Lockfiles that pin the same dependency tree as a detect file but are not
 * listed in a profile's `detect` (usually because a different file already
 * wins detection for that profile). Included in the key so changes to the
 * manifest still invalidate the cache.
 */
const PROFILE_SUPPLEMENTAL_LOCKFILES: Record<string, string[]> = {
  nodejs: ['package-lock.json'],
};

/** Longest usable length of a repo/cache path segment. */
export const MAX_CACHE_KEY_SEGMENT_LENGTH = 200;

/** Fallback key when the workspace has no lockfile for the active profiles. */
export const NO_LOCKFILE_CACHE_KEY = 'unknown';

/** How `cacheKey` was derived. */
export type DepCacheKeyMethod = 'explicit' | 'hash';

export interface ComputeCacheKeyOptions {
  /** Repo id from the host repo store; sanitized to a filesystem-safe segment. */
  repoId: string;
  /**
   * Profile names the bootstrap resolved (`resolved.profiles`). When omitted
   * or empty the workspace lockfiles are auto-detected instead, so
   * explicit-`setup.command` repos still key off their lockfile content.
   */
  profiles?: readonly string[];
  /**
   * Optional explicit key from `environment.json` `cacheKey` (P3-T6);
   * sanitized to alphanumerics and hyphens, non-explicit keys that sanitize
   * to empty fall back to hashing.
   */
  explicitCacheKey?: string;
  /** Workspace directory whose lockfiles are read. */
  workspaceDir: string;
  /** Runtime profile catalog used to resolve profile lockfiles; defaults to the bundled catalog. */
  catalog?: Record<string, RuntimeProfile>;
}

export interface DepCacheKey {
  repoId: string;
  cacheKey: string;
  /** Cache entry location under the dep cache root: `{repoId}/{cacheKey}`. */
  relativePath: string;
  /** How `cacheKey` was derived. */
  method: DepCacheKeyMethod;
  /** SHA-256 of the lockfile inputs when `method === 'hash'` and lockfiles exist. */
  lockfileHash?: string;
}

/**
 * Reduces an explicit cache key to a safe path segment: alphanumerics and
 * hyphens only (leading hyphens stripped), capped at
 * {@link MAX_CACHE_KEY_SEGMENT_LENGTH}. Returns `null` when nothing usable
 * remains or the result would be a path-traversal name.
 */
export function sanitizeCacheKey(raw: string): string | null {
  const sanitized = raw
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/^-+/, '')
    .slice(0, MAX_CACHE_KEY_SEGMENT_LENGTH);
  if (sanitized === '' || sanitized === '.' || sanitized === '..') {
    return null;
  }
  return sanitized;
}

function sanitizeRepoId(repoId: string): string | null {
  const sanitized = repoId.replace(/[^a-zA-Z0-9-]/g, '').slice(
    0,
    MAX_CACHE_KEY_SEGMENT_LENGTH,
  );
  if (sanitized === '' || sanitized === '.' || sanitized === '..') {
    return null;
  }
  return sanitized;
}

/**
 * Lockfile candidates for the active profiles, in a stable order: detect
 * files plus supplemental lockfiles (see `PROFILE_SUPPLEMENTAL_LOCKFILES`),
 * deduplicated across profiles and sorted by rank of all detect files listed
 * in `environment-detect`, ties by name. Missing files are dropped per file
 * at read time so partially-matching workspaces still get a stable key.
 */
function collectLockfiles(
  workspaceDir: string,
  profileNames: readonly string[],
  catalog: Record<string, RuntimeProfile>,
): string[] {
  const candidates: string[] = [];
  for (const name of profileNames) {
    const profile = catalog[name];
    if (profile === undefined) {
      continue;
    }
    const detectFiles = [
      ...profile.detect,
      ...(PROFILE_SUPPLEMENTAL_LOCKFILES[name] ?? []),
    ];
    for (const file of detectFiles) {
      if (!candidates.includes(file)) {
        candidates.push(file);
      }
    }
  }
  const ranked = candidates.map((file) => ({
    file,
    rank: DETECTION_PRIORITY[file] ?? DETECT_FALLBACK_PRIORITY,
  }));
  return ranked
    .sort((a, b) => a.rank - b.rank || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map((entry) => {
      if (fs.existsSync(path.join(workspaceDir, entry.file))) {
        return entry.file;
      }
      return null;
    })
    .filter((file): file is string => file !== null);
}

function hashLockfiles(
  workspaceDir: string,
  profileNames: readonly string[],
  lockfiles: readonly string[],
): string {
  const digest = createHash('sha256');
  digest.update(profileNames.join('\0'));
  for (const file of lockfiles) {
    digest.update(file);
    digest.update('\0');
    digest.update(fs.readFileSync(path.join(workspaceDir, file)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

/**
 * Computes the dependency-cache key for a repo workspace.
 *
 * Key derivation:
 * 1. `environment.json` `cacheKey` (explicit) wins when it sanitizes to a
 *    non-empty segment.
 * 2. Otherwise SHA-256 over the active profiles' lockfile contents plus the
 *    (sorted) profile names; with no lockfiles at all the key is the stable
 *    {@link NO_LOCKFILE_CACHE_KEY}.
 *
 * The result is a path segment pair (`repoId` + `cacheKey`) used under the
 * dep cache root as `{repoId}/{cacheKey}`.
 */
export function computeCacheKey(options: ComputeCacheKeyOptions): DepCacheKey {
  const repoId = sanitizeRepoId(options.repoId);
  if (repoId === null) {
    throw new Error(`Cannot compute dep cache path for unusable repoId: "${options.repoId}"`);
  }

  if (options.explicitCacheKey !== undefined && options.explicitCacheKey !== '') {
    const sanitized = sanitizeCacheKey(options.explicitCacheKey);
    if (sanitized !== null) {
      return {
        repoId,
        cacheKey: sanitized,
        relativePath: path.posix.join(repoId, sanitized),
        method: 'explicit',
      };
    }
  }

  const catalog = options.catalog ?? loadRuntimeProfiles();
  const profileNames =
    options.profiles !== undefined && options.profiles.length > 0
      ? [...options.profiles].sort()
      : detectProfiles(options.workspaceDir, catalog);

  const lockfiles = collectLockfiles(options.workspaceDir, profileNames, catalog);

  if (lockfiles.length === 0) {
    return {
      repoId,
      cacheKey: NO_LOCKFILE_CACHE_KEY,
      relativePath: path.posix.join(repoId, NO_LOCKFILE_CACHE_KEY),
      method: 'hash',
    };
  }

  const lockfileHash = hashLockfiles(options.workspaceDir, profileNames, lockfiles);
  return {
    repoId,
    cacheKey: lockfileHash,
    relativePath: path.posix.join(repoId, lockfileHash),
    method: 'hash',
    lockfileHash,
  };
}
