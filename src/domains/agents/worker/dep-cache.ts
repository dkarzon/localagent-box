import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import type { RuntimeProfile } from './runtime-profiles';

/**
 * Manifest describing what was snapshotted into the dependency cache.
 * Written as `manifest.json` inside the cache directory by
 * {@link snapshotDepCache}.
 */
export interface DepCacheManifest {
  /** ISO timestamp of snapshot creation; defaults to now when omitted. */
  createdAt?: string;
  /** Setup command that produced the workspace directories. */
  command: string;
  /** Runtime profiles that were active when the snapshot was taken. */
  profiles: readonly string[];
  /** SHA-256 over the hashed lockfile set (see `dep-cache-key.ts`), if any. */
  lockfileHash?: string;
}

/**
 * Workspace directories that are snapshotted per profile. Only profiles whose
 * package manager reuses an existing install benefit: `pnpm install` and
 * `yarn install` skip work when the restored `node_modules` is already up to
 * date. `npm ci` deletes `node_modules` before installing, so caching it for
 * the `nodejs` profile would be a copy that buys nothing — the `nodejs` profile
 * is cached through its package-manager cache instead (see `getDepCacheEnv`).
 */
const WORKSPACE_CACHE_DIRS: Record<string, readonly string[]> = {
  'nodejs-pnpm': ['node_modules'],
  'nodejs-yarn': ['node_modules'],
};

/** Workspace directories cached for a profile; empty when unsupported. */
export function getDepCacheDirs(profile: string): readonly string[] {
  return WORKSPACE_CACHE_DIRS[profile] ?? [];
}

/** Directory name holding a cache entry's package-manager cache. */
export const PM_CACHE_DIR_NAME = 'pm-cache';

/** Package-manager cache directory of a cache entry (`{root}/{repoId}/{cacheKey}`). */
export function getPmCacheDir(entryDir: string): string {
  return path.join(entryDir, PM_CACHE_DIR_NAME);
}

/**
 * Env var each profile's package manager honours to redirect its download
 * cache. Only profiles that declare `cacheDirs` in the runtime profile catalog
 * get one, so the catalog is what decides whether a profile is cacheable.
 */
const PROFILE_CACHE_ENV: Record<string, string> = {
  nodejs: 'npm_config_cache',
  'nodejs-pnpm': 'npm_config_store_dir',
  'nodejs-yarn': 'YARN_CACHE_FOLDER',
  python: 'PIP_CACHE_DIR',
  go: 'GOMODCACHE',
  rust: 'CARGO_HOME',
};

/** Env var that redirects the profile's package-manager cache; null when unsupported. */
export function getDepCacheEnvVar(
  profile: string,
  catalog: Record<string, RuntimeProfile>,
): string | null {
  if ((catalog[profile]?.cacheDirs ?? []).length === 0) {
    return null;
  }
  return PROFILE_CACHE_ENV[profile] ?? null;
}

/**
 * Env entries to merge into the setup command's environment so the package
 * manager reads/writes its cache in the persistent dep cache volume. Empty when
 * the profile has no catalog cache dirs or no known env var.
 */
export function getDepCacheEnv(
  profile: string,
  entryDir: string,
  catalog: Record<string, RuntimeProfile>,
): Record<string, string> {
  const envVar = getDepCacheEnvVar(profile, catalog);
  return envVar === null ? {} : { [envVar]: getPmCacheDir(entryDir) };
}

/** True when the profile is cacheable through either mechanism (workspace dirs or env). */
export function isDepCacheProfile(
  profile: string,
  catalog: Record<string, RuntimeProfile>,
): boolean {
  return getDepCacheDirs(profile).length > 0 || getDepCacheEnvVar(profile, catalog) !== null;
}

/** Injectable async filesystem ops for the copy/replace primitives. */
export interface DepCacheFs {
  cp: typeof fs.promises.cp;
  rm: (target: string, opts: fs.RmOptions & { recursive: true }) => Promise<void>;
  rename: (source: string, target: string) => Promise<void>;
  mkdir: (dir: string, opts?: fs.MakeDirectoryOptions) => Promise<void>;
  stat: (target: string) => Promise<fs.Stats | null>;
  readdir: (dir: string) => Promise<string[]>;
}

const defaultDepCacheFs: DepCacheFs = {
  cp: (source, destination, opts) => fs.promises.cp(source, destination, opts),
  rm: (target, opts) => fs.promises.rm(target, opts),
  rename: (source, destination) => fs.promises.rename(source, destination),
  mkdir: (dir, opts) => fs.promises.mkdir(dir, opts).then(() => undefined),
  stat: (target) => fs.promises.stat(target),
  readdir: (dir) => fs.promises.readdir(dir),
};

/**
 * Returns true when `dir` exists and is a directory. Only missing-entry errors
 * (`ENOENT`/`ENOTDIR`) yield `false`; other errors propagate.
 */
async function isDirectory(
  fsImpl: DepCacheFs,
  dir: string,
): Promise<boolean> {
  const stats = await fsImpl.stat(dir).catch((err) => {
    if (isEntryGone(err)) return null;
    throw err;
  });
  return stats ? stats.isDirectory() : false;
}

function wrapError(err: unknown, message: string): Error {
  const cause = err instanceof Error ? err : new Error(String(err));
  return new Error(`${message}: ${cause.message}`, { cause });
}

/**
 * Returns true (`ENOTEMPTY`/`EEXIST`) in the case of a lost concurrent rename
 * of the same target (a concurrent bootstrap left the directory in place,
 * and we lost the swap).
 */
function isConcurrentSwapLoss(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  return code === 'ENOTEMPTY' || code === 'EEXIST';
}

/**
 * Returns true (`ENOENT`/`ENOTDIR`) in the case of a path that got
 * deleted in the middle of the race.
 */
function isEntryGone(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Returns true in the case of a race that should be tolerated for this
 * operation, rather than aborting the restore. */
function isConcurrentRace(err: unknown): boolean {
  return isConcurrentSwapLoss(err) || isEntryGone(err);
}

async function runStep(
  step: () => Promise<void>,
  message: string,
): Promise<void> {
  try {
    await step();
  } catch (err) {
    throw wrapError(err, message);
  }
}

/**
 * `fs.cp` rewrites every relative symlink into an absolute path pointing at the
 * source tree by default, which strands the link as soon as the source is
 * deleted (pnpm's `node_modules` is almost entirely symlinks, and `node_modules/.bin`
 * entries on a restored tree would point at the run that created the snapshot).
 * `verbatimSymlinks` keeps the links as they were recorded in the source, and it
 * also avoids the `EPERM` failures Windows hits when recreating those rewritten
 * links. (Requires Node 20.15+.)
 */
const COPY_OPTIONS: fs.CopyOptions = { recursive: true, verbatimSymlinks: true };

/** True when `dir` exists and holds at least one entry. */
async function hasEntries(fsImpl: DepCacheFs, dir: string): Promise<boolean> {
  if (!(await isDirectory(fsImpl, dir))) {
    return false;
  }
  try {
    return (await fsImpl.readdir(dir)).length > 0;
  } catch (err) {
    if (isEntryGone(err)) return false;
    throw err;
  }
}

/**
 * Replaces `target` with a copy of `source` without leaving a partial copy
 * behind: the copy is staged next to the target and swapped in via renames;
 * when the swap fails, the original directory is put back.
 *
 * A concurrent workspace bootstrap of the same repo (two agents) races on
 * these exact paths; the race shows up as `ENOENT`/`ENOTDIR` (`rename`
 * meeting a path the other side already handled) or as a lost rename
 * (`ENOTEMPTY`/`EEXIST`). Those are tolerated: the loser discards its staged
 * copy and lets the winner's tree stand instead of aborting the restore and
 * stranding the stale directory.
 */
async function replaceDirectory(
  fsImpl: DepCacheFs,
  source: string,
  target: string,
): Promise<void> {
  const suffix = randomUUID();
  const staging = `${target}.staging-${suffix}`;
  const original = `${target}.original-${suffix}`;
  let heldOriginal = false;
  const cleanUpStaging = async (): Promise<void> => {
    await fsImpl.rm(staging, { recursive: true, force: true }).catch(() => {});
  };
  const cleanUpOriginal = async (restore: boolean): Promise<void> => {
    if (!heldOriginal) return;
    if (restore) {
      // Rollover the partial swap so the prior (stale) tree is kept.
      await fsImpl.rename(original, target).catch(() => {});
      return;
    }
    await fsImpl.rm(original, { recursive: true, force: true }).catch(() => {});
  };
  try {
    await runStep(
      () => fsImpl.cp(source, staging, COPY_OPTIONS),
      `Failed to stage ${path.basename(source)} for restore at ${target}`,
    );
    const originalExists = await fsImpl.stat(target).catch(() => null);
    if (originalExists) {
      try {
        await fsImpl.rename(target, original);
        heldOriginal = true;
      } catch (err) {
        // A concurrent bootstrap moved the old tree out of the way in the
        // meantime; it owns it now, so drop the bookkeeping and carry on.
        if (!isConcurrentRace(err)) throw err;
      }
    }
    try {
      await fsImpl.rename(staging, target);
    } catch (err) {
      if (!isConcurrentRace(err)) throw err;
      // Lost the race: keep the winner's tree, drop ours.
      await cleanUpStaging();
      await cleanUpOriginal(false);
      return;
    }
    await cleanUpStaging();
    await cleanUpOriginal(false);
  } catch (err) {
    await cleanUpStaging();
    await cleanUpOriginal(true);
    if (!isConcurrentRace(err)) {
      throw wrapError(err, `Failed to restore ${path.basename(source)} into workspace at ${target}`);
    }
  }
}

/**
 * Ensures the cache entry and its package-manager cache directory exist, and
 * reports whether the cache was already warm. This is the honest "hit" for
 * profiles whose speedup comes from the package manager reading its own cache
 * during the setup command, rather than from a restored `node_modules` (which
 * `npm ci` deletes before installing anyway).
 */
export async function preparePmCache(
  entryDir: string,
  fsImpl: DepCacheFs = defaultDepCacheFs,
): Promise<boolean> {
  const pmCacheDir = getPmCacheDir(entryDir);
  await runStep(
    () => fsImpl.mkdir(pmCacheDir, { recursive: true }),
    `Failed to create package-manager cache directory at ${pmCacheDir}`,
  );
  return hasEntries(fsImpl, pmCacheDir);
}

/**
 * Restores cached workspace directories into a fresh clone.
 *
 * Copies are staged into a hidden directory and atomically renamed into
 * place per directory, so a failing copy never leaves a partial directory
 * behind.
 *
 * @returns `true` when at least one cached directory was restored
 * (cache hit), `false` on cache miss or unsupported profile.
 */
export async function restoreDepCache(
  cacheDir: string,
  workspaceDir: string,
  profile: string,
  fsImpl: DepCacheFs = defaultDepCacheFs,
): Promise<boolean> {
  const dirs = getDepCacheDirs(profile);
  if (dirs.length === 0) {
    return false;
  }
  if (!(await isDirectory(fsImpl, cacheDir))) {
    return false;
  }

  let restoredAny = false;
  for (const dir of dirs) {
    const source = path.join(cacheDir, dir);
    if (!(await isDirectory(fsImpl, source))) {
      continue;
    }
    await replaceDirectory(fsImpl, source, path.join(workspaceDir, dir));
    restoredAny = true;
  }
  return restoredAny;
}

/**
 * Snapshots the profile's workspace directories into the cache entry and writes
 * a `manifest.json` describing it.
 *
 * Each directory is staged next to its target and swapped in atomically, so a
 * failing copy never leaves a partial directory behind and the previous entry is
 * preserved until the staged copy is complete. The entry itself is never
 * replaced wholesale: it is also where the package manager's cache lives (the
 * package manager writes there directly during the setup command), so a
 * full-entry swap would throw away that cache.
 *
 * Throws when the profile caches workspace dirs but none of them exist in the
 * workspace. Profiles that cache only through the package manager's cache have
 * nothing to copy, so only the manifest is written.
 */
export async function snapshotDepCache(
  cacheDir: string,
  workspaceDir: string,
  profile: string,
  manifest: DepCacheManifest,
  fsImpl: DepCacheFs = defaultDepCacheFs,
): Promise<void> {
  const dirs = getDepCacheDirs(profile);

  const manifestJson: DepCacheManifest = {
    createdAt: manifest.createdAt ?? new Date().toISOString(),
    command: manifest.command,
    profiles: [...manifest.profiles],
    lockfileHash: manifest.lockfileHash,
  };

  try {
    await runStep(
      () => fsImpl.mkdir(path.dirname(cacheDir), { recursive: true }),
      `Failed to create dependency cache parent for ${cacheDir}`,
    );
    await runStep(
      () => fsImpl.mkdir(cacheDir, { recursive: true }),
      `Failed to create dependency cache entry at ${cacheDir}`,
    );
    let snapshottedAny = false;
    for (const dir of dirs) {
      const source = path.join(workspaceDir, dir);
      if (!(await isDirectory(fsImpl, source))) {
        continue;
      }
      await runStep(
        () => replaceDirectory(fsImpl, source, path.join(cacheDir, dir)),
        `Failed to snapshot ${dir} into dependency cache entry at ${cacheDir}`,
      );
      snapshottedAny = true;
    }
    if (dirs.length > 0 && !snapshottedAny) {
      throw new Error(
        `No cacheable ${dirs.join(', ')} directories found in workspace for profile '${profile}'`,
      );
    }
    await runStep(
      () =>
        fs.promises.writeFile(
          path.join(cacheDir, 'manifest.json'),
          `${JSON.stringify(manifestJson, null, 2)}\n`,
        ),
      `Failed to write manifest.json for ${cacheDir}`,
    );
  } catch (err) {
    for (const entry of await listStagingLeftovers(fsImpl, cacheDir)) {
      await fsImpl.rm(path.join(cacheDir, entry), { recursive: true, force: true });
    }
    if (err instanceof Error) {
      throw err;
    }
    throw wrapError(err, `Failed to snapshot dependency cache at ${cacheDir}`);
  }
}

/** Staged/partial swap leftovers under a cache entry (cleaned up on failure). */
async function listStagingLeftovers(fsImpl: DepCacheFs, entryDir: string): Promise<string[]> {
  try {
    return (await fsImpl.readdir(entryDir)).filter(
      (name) => name.includes('.staging-') || name.includes('.original-'),
    );
  } catch {
    return [];
  }
}

/**
 * Listing of one dependency cache entry (a `{repoDir}/{entryDir}`
 * subdirectory) for the `GET` dep-cache API (P3-T5).
 */
export interface DepCacheEntryInfo {
  /** Cache key segment (the entry directory name under the repo dir). */
  key: string;
  /** `manifest.json` snapshot creation time, when present and valid. */
  createdAt?: string;
  /** Setup command that produced the entry, when present in the manifest. */
  command?: string;
  /** Runtime profiles active when the entry was snapshotted, when present. */
  profiles?: string[];
  /**
   * Best-effort total size of the entry in bytes; `undefined` when size
   * computation was not possible (unreadable layout or size cap reached).
   */
  sizeBytes?: number | null;
}

/** Result of listing a repo's dependency cache entries (P3-T5). */
export interface ListDepCacheEntriesResult {
  /** Whether the listing could be produced from the on-disk layout. */
  ok?: boolean;
  /** Set (with an HTTP 500) when the on-disk layout could not be inspected. */
  error?: true;
  entries: DepCacheEntryInfo[];
}

interface DepCacheEntryFs {
  existsSync: typeof fs.existsSync;
  readdirSync: typeof fs.readdirSync;
  statSync: typeof fs.statSync;
  readFileSync: typeof fs.readFileSync;
}

/**
 * Recursively stats `dir` and returns the sum of its file sizes (estimate).
 * Unreadable files or directories are skipped silently. Returns `null` when
 * the total would exceed the cap (size is estimated, capped).
 */
function sumSizeBytes(
  dir: string,
  fsImpl: DepCacheEntryFs,
  cap = Number.MAX_SAFE_INTEGER,
): number | null {
  let total = 0;
  for (const name of fsImpl.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fsImpl.statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      const sub = sumSizeBytes(p, fsImpl, cap);
      total += sub ?? 0;
    } else if (st.isFile()) {
      total += st.size;
    }
    if (total > cap) {
      return null;
    }
  }
  return total;
}

/**
 * Lists the cache entries stored under a repo directory (`{root}/{repoDir}`).
 *
 * Cache keys are arbitrary path segments written by the snapshot flow, so the
 * on-disk layout is listed rather than reconstructed; subdirectories that are
 * not safe entry names (`.staging-*` internals, `.`/`..` traversal names)
 * are skipped. `manifest.json` (if present) is a plain JSON file read with
 * `throwIfNoEntry: false`; malformed manifests are reported as empty
 * (`createdAt` and `command` omitted) instead of failing the listing.
 */
export function listDepCacheEntries(
  root: string,
  repoDir: string,
  fsImpl: DepCacheEntryFs = fs,
): ListDepCacheEntriesResult {
  const repoPath = path.join(root, repoDir);

  let existing: boolean;
  try {
    existing = fsImpl.existsSync(repoPath);
  } catch {
    return { ok: false, error: true, entries: [] };
  }
  // Mirror `isDirectory` for entries below: a repo directory that does not
  // exist or is not a directory has no entries to list.
  if (
    !existing ||
    fsImpl.statSync(repoPath, { throwIfNoEntry: false })?.isDirectory() !== true
  ) {
    return { ok: true, entries: [] };
  }

  let rawNames: string[];
  try {
    rawNames = fsImpl.readdirSync(repoPath);
  } catch {
    return { ok: false, error: true, entries: [] };
  }

  const entries: DepCacheEntryInfo[] = [];
  for (const entryName of rawNames) {
    // Skip dots and hidden/special internals (e.g. `.staging-*` leftovers).
    if (entryName === '.' || entryName === '..' || entryName.startsWith('.')) {
      continue;
    }
    const entryPath = path.join(repoPath, entryName);
    let isDir: boolean;
    try {
      isDir = fsImpl.statSync(entryPath, { throwIfNoEntry: false })?.isDirectory() ?? false;
    } catch {
      continue;
    }
    if (!isDir) {
      continue;
    }
    let sizeBytes: number | null;
    try {
      sizeBytes = sumSizeBytes(entryPath, fsImpl);
    } catch {
      sizeBytes = null;
    }

    const manifestPath = path.join(entryPath, 'manifest.json');
    let manifest: { createdAt?: string; command?: string; profiles?: string[] } | undefined;
    try {
      const manifestStat = fsImpl.statSync(manifestPath, { throwIfNoEntry: false });
      if (manifestStat && manifestStat.isFile()) {
        const manifestRaw = fsImpl.readFileSync(manifestPath);
        const parsed = JSON.parse(manifestRaw.toString()) as unknown;
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          const record = parsed as Record<string, unknown>;
          if (typeof record.createdAt === 'string') {
            manifest = { createdAt: record.createdAt };
          }
          if (typeof record.command === 'string') {
            manifest = { ...manifest, command: record.command };
          }
          if (
            Array.isArray(record.profiles) &&
            record.profiles.every((v) => typeof v === 'string')
          ) {
            manifest = { ...manifest, profiles: record.profiles as string[] };
          }
        }
      }
    } catch {
      manifest = undefined;
    }

    entries.push({
      key: entryName,
      createdAt: manifest?.createdAt,
      command: manifest?.command,
      profiles: manifest?.profiles,
      sizeBytes,
    });
  }
  return { ok: true, entries };
}

export interface PurgeDepCacheResult {
  /** `true` when the repo directory existed under the cache root. */
  existed: boolean;
  /** Number of entries actually removed. */
  removed: number;
}

/**
 * Removes the repo's dependency cache directory (`{root}/{repoDir}`) entirely,
 * or, when `key` is given, only the single entry `{root}/{repoDir}/{key}`.
 * `key` is resolved and verified to stay inside the repository cache
 * directory, so a malicious key (e.g. `..`) can never escape it. An
 * escaping or otherwise invalid key throws.
 * Removing a key that does not exist is not an error (idempotent).
 */
export function purgeDepCacheEntries(
  root: string,
  repoDir: string,
  key?: string,
  fsImpl: Pick<typeof fs, 'readdirSync' | 'statSync' | 'rmSync'> = fs,
): PurgeDepCacheResult {
  const repoPath = path.join(root, repoDir);
  const isRepoDir =
    fsImpl.statSync(repoPath, { throwIfNoEntry: false })?.isDirectory() ?? false;
  if (!isRepoDir) {
    return { existed: false, removed: 0 };
  }
  if (key !== undefined) {
    const repoPathResolved = path.resolve(repoPath);
    const keyPath = path.join(repoPath, key);
    const keyPathResolved = path.resolve(keyPath);
    if (!keyPathResolved.startsWith(repoPathResolved + path.sep)) {
      throw new Error(`cache key escapes repo cache directory: ${key}`);
    }
    fsImpl.rmSync(keyPath, { recursive: true, force: true });
    return { existed: true, removed: 1 };
  }
  const names = fsImpl
    .readdirSync(repoPath)
    .filter((name) => (name === '.' || name === '..' || name.startsWith('.')) !== true);
  fsImpl.rmSync(repoPath, { recursive: true, force: true });
  return { existed: true, removed: names.length };
}
