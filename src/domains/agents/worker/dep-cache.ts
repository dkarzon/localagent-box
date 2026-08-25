import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';

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
 * Workspace directories that are cached per profile. Phase 3 scope is
 * `nodejs` and `nodejs-pnpm` only (both install into `node_modules/`);
 * unsupported profiles are no-ops for both restore and snapshot.
 */
const PROFILE_CACHE_DIRS: Record<string, readonly string[]> = {
  nodejs: ['node_modules'],
  'nodejs-pnpm': ['node_modules'],
};

/** Workspace directories cached for a profile; empty when unsupported. */
export function getDepCacheDirs(profile: string): readonly string[] {
  return PROFILE_CACHE_DIRS[profile] ?? [];
}

/** Injectable async filesystem ops for the copy/replace primitives. */
export interface DepCacheFs {
  cp: typeof fs.promises.cp;
  rm: (target: string, opts: fs.RmOptions & { recursive: true }) => Promise<void>;
  rename: (source: string, target: string) => Promise<void>;
  mkdir: (dir: string, opts?: fs.MakeDirectoryOptions) => Promise<void>;
}

const defaultDepCacheFs: DepCacheFs = {
  cp: (source, destination, opts) => fs.promises.cp(source, destination, opts),
  rm: (target, opts) => fs.promises.rm(target, opts),
  rename: (source, destination) => fs.promises.rename(source, destination),
  mkdir: (dir, opts) => fs.promises.mkdir(dir, opts).then(() => undefined),
};

function isDirectory(dir: string): boolean {
  return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function wrapError(err: unknown, message: string): Error {
  const cause = err instanceof Error ? err : new Error(String(err));
  return new Error(`${message}: ${cause.message}`, { cause });
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
 * Replaces `target` with a copy of `source` without leaving a partial copy
 * behind: the copy is staged next to the target and swapped in via renames;
 * when the swap fails the original directory is put back.
 */
async function replaceDirectory(
  fsImpl: DepCacheFs,
  source: string,
  target: string,
): Promise<void> {
  const suffix = randomUUID();
  const staging = `${target}.staging-${suffix}`;
  const original = `${target}.original-${suffix}`;
  try {
    await runStep(
      () => fsImpl.cp(source, staging, { recursive: true }),
      `Failed to stage ${path.basename(source)} for restore at ${target}`,
    );
    if (fs.existsSync(target)) {
      fs.renameSync(target, original);
    }
    await fsImpl.rename(staging, target);
    if (fs.existsSync(original)) {
      fs.rmSync(original, { recursive: true, force: true });
    }
  } catch (err) {
    if (fs.existsSync(staging)) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    if (fs.existsSync(original)) {
      fs.renameSync(original, target);
    }
    throw wrapError(err, `Failed to restore ${path.basename(source)} into workspace at ${target}`);
  }
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
  if (!isDirectory(cacheDir)) {
    return false;
  }

  let restoredAny = false;
  for (const dir of dirs) {
    const source = path.join(cacheDir, dir);
    if (!isDirectory(source)) {
      continue;
    }
    await replaceDirectory(fsImpl, source, path.join(workspaceDir, dir));
    restoredAny = true;
  }
  return restoredAny;
}

/**
 * Snapshots the profile's workspace directories into the cache directory
 * and writes a `manifest.json` describing the entry.
 *
 * The cache directory is replaced atomically (temp dir + rename), so a
 * failing copy never leaves a partial cache entry behind; the previous
 * entry is preserved untouched until the staged copy is complete.
 * No-op when the profile is unsupported; throws when none of the
 * profile's directories exist in the workspace.
 */
export async function snapshotDepCache(
  cacheDir: string,
  workspaceDir: string,
  profile: string,
  manifest: DepCacheManifest,
  fsImpl: DepCacheFs = defaultDepCacheFs,
): Promise<void> {
  const dirs = getDepCacheDirs(profile);
  if (dirs.length === 0) {
    return;
  }

  const staging = `${cacheDir}.staging-${randomUUID()}`;
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
      () => fsImpl.mkdir(staging),
      `Failed to create staging directory for ${cacheDir}`,
    );
    let snapshottedAny = false;
    for (const dir of dirs) {
      const source = path.join(workspaceDir, dir);
      if (!isDirectory(source)) {
        continue;
      }
      await runStep(
        () => fsImpl.cp(source, path.join(staging, dir), { recursive: true }),
        `Failed to copy ${dir} into dependency cache staging at ${staging}`,
      );
      snapshottedAny = true;
    }
    if (!snapshottedAny) {
      throw new Error(
        `No cacheable ${dirs.join(', ')} directories found in workspace for profile '${profile}'`,
      );
    }
    await runStep(
      () =>
        fs.promises.writeFile(
          path.join(staging, 'manifest.json'),
          `${JSON.stringify(manifestJson, null, 2)}\n`,
        ),
      `Failed to write manifest.json for ${cacheDir}`,
    );
    if (fs.existsSync(cacheDir)) {
      await runStep(
        () => fsImpl.rm(cacheDir, { recursive: true, force: true }),
        `Failed to remove existing dependency cache entry at ${cacheDir}`,
      );
    }
    await runStep(
      () => fsImpl.rename(staging, cacheDir),
      `Failed to replace dependency cache entry at ${cacheDir}`,
    );
  } catch (err) {
    if (fs.existsSync(staging)) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    if (err instanceof Error) {
      throw err;
    }
    throw wrapError(err, `Failed to snapshot dependency cache at ${cacheDir}`);
  }
}
