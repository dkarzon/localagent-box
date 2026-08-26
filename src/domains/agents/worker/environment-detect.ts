import fs from 'fs';
import path from 'path';
import type { RepoEnvironmentConfig } from '../../../types';
import type { RuntimeProfile } from './runtime-profiles';

/** Source of a resolved setup command. */
export type SetupCommandSource = 'explicit' | 'profile' | 'detect' | 'none';

export interface ResolvedSetupCommand {
  /** The setup command to run; empty string when `source` is `'none'`. */
  command: string;
  /** Profile name(s) applied to the command; `[]` for `'explicit'` / `'none'`. */
  profiles: string[];
  source: SetupCommandSource;
}

/**
 * Workspace-root file names ordered by detection priority (lower = higher).
 *
 * When a workspace matches several profiles (e.g. `pnpm-lock.yaml` plus the
 * `package.json` of a pnpm monorepo), matched profiles are ranked by the
 * best priority of the detect files that matched:
 *
 * 1. `pnpm-lock.yaml` → `nodejs-pnpm` (before `nodejs` from `package.json`)
 * 2. `package-lock.json` → `nodejs`
 * 3. `yarn.lock` → `nodejs-yarn`
 * 4. `go.mod` → `go`
 * 5. `Cargo.toml` → `rust`
 * 6. `pyproject.toml` / `requirements.txt` → `python`
 *
 * Files not listed all share the lowest priority; ties keep catalog order,
 * so detection order is stable for a given catalog.
 */
export const DETECT_FALLBACK_PRIORITY = 99;

export const DETECTION_PRIORITY: Record<string, number> = {
  'pnpm-lock.yaml': 0,
  'package-lock.json': 1,
  'yarn.lock': 2,
  'go.mod': 3,
  'Cargo.toml': 4,
  'requirements.txt': 5,
  'pyproject.toml': 5,
  'package.json': 6,
};

function filePriority(fileName: string): number {
  return DETECTION_PRIORITY[fileName] ?? DETECT_FALLBACK_PRIORITY;
}

/**
 * Returns the names of all profiles with at least one `detect` file present
 * in the workspace root, ordered by detection priority (see
 * `DETECTION_PRIORITY`) so the first entry wins resolution.
 */
export function detectProfiles(
  workspaceDir: string,
  profiles: Record<string, RuntimeProfile>,
): string[] {
  const names = Object.keys(profiles);
  const matched: { name: string; rank: number; index: number }[] = [];

  names.forEach((name, index) => {
    const profile = profiles[name];
    if (profile === undefined) {
      return;
    }
    let bestRank = DETECT_FALLBACK_PRIORITY;
    let detected = false;
    for (const file of profile.detect) {
      if (fs.existsSync(path.join(workspaceDir, file))) {
        detected = true;
        const rank = filePriority(file);
        if (rank < bestRank) {
          bestRank = rank;
        }
      }
    }
    if (detected) {
      matched.push({ name, rank: bestRank, index });
    }
  });

  return matched
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.name);
}

/**
 * Resolves the setup command to run for a repo workspace.
 *
 * Resolution order:
 * 1. Explicit `config.setup.command` → `'explicit'`
 * 2. `config.profiles` (non-empty) → first requested profile that exists in
 *    the catalog and is still enabled (`'profile'`). Disabled or unknown
 *    entries are skipped; when none are usable, resolution stops at
 *    `'none'` (no implicit auto-detect when `profiles` was declared).
 * 3. Lockfile auto-detect via `detectProfiles` (`'detect'`), unless
 *    `config.autoDetect === false`. With no `environment.json` at all
 *    (`config === null`) auto-detection still runs: there is no explicit
 *    config to opt out of it.
 * 4. Nothing matched → `'none'`.
 *
 * When `enabledProfileNames` is provided, requested and detected profiles
 * outside the list are skipped (server-side profile gate; undefined/empty =
 * all enabled). `onProfileSkipped` is invoked for each profile skipped by
 * that gate so the caller can surface it in logs.
 */
export function resolveSetupCommand(
  config: RepoEnvironmentConfig | null,
  workspaceDir: string,
  profiles: Record<string, RuntimeProfile>,
  enabledProfileNames?: readonly string[],
  onProfileSkipped?: (profileName: string, reason: 'disabled' | 'unknown') => void,
): ResolvedSetupCommand {
  const isGated = enabledProfileNames !== undefined && enabledProfileNames.length > 0;
  const enabledSet = isGated ? new Set(enabledProfileNames) : undefined;

  if (config !== null) {
    const setup = config.setup;
    if (setup !== undefined) {
      return { command: setup.command, profiles: [], source: 'explicit' };
    }
  }

  const requested = config?.profiles;
  if (requested !== undefined && requested.length > 0) {
    for (const name of requested) {
      const profile = profiles[name];
      if (profile !== undefined && (enabledSet === undefined || enabledSet.has(name))) {
        return { command: profile.defaultSetup, profiles: [name], source: 'profile' };
      }
      onProfileSkipped?.(name, profile !== undefined ? 'disabled' : 'unknown');
    }
    return { command: '', profiles: [], source: 'none' };
  }

  if (config?.autoDetect === false) {
    return { command: '', profiles: [], source: 'none' };
  }

  for (const name of detectProfiles(workspaceDir, profiles)) {
    const profile = profiles[name];
    if (profile === undefined) {
      continue;
    }
    if (enabledSet === undefined || enabledSet.has(name)) {
      return { command: profile.defaultSetup, profiles: [name], source: 'detect' };
    }
    onProfileSkipped?.(name, 'disabled');
  }

  return { command: '', profiles: [], source: 'none' };
}
