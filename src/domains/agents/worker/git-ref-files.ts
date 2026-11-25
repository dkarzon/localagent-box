import { execFile } from 'child_process';
import { promisify } from 'util';
import { ENVIRONMENT_CONFIG_REPOSITORY_PATH, parseEnvironmentConfig } from './environment-config';
import type { RepoEnvironmentConfig } from '../../../types';

const execFileAsync = promisify(execFile);

/**
 * Resolves a branch to a commit-ish in the workspace. The clone is made at the
 * branch for review runs, so the local branch normally exists; the remote ref is
 * preferred when present (a batch clone is `--single-branch`, so the base branch
 * only exists as `refs/remotes/origin/<branch>` after a fetch).
 */
export async function resolveBaseRef(
  workspaceDir: string,
  branchName: string,
): Promise<string | null> {
  for (const candidate of [`refs/remotes/origin/${branchName}`, `refs/heads/${branchName}`]) {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], {
        cwd: workspaceDir,
      });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** File contents at `ref`, or null when the file does not exist there. */
export async function readFileAtRef(
  workspaceDir: string,
  ref: string,
  relativePath: string,
): Promise<string | null> {
  const spec = `${ref}:${relativePath}`;
  try {
    await execFileAsync('git', ['cat-file', '-e', spec], { cwd: workspaceDir });
  } catch {
    return null;
  }
  const { stdout } = await execFileAsync('git', ['show', spec], {
    cwd: workspaceDir,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export interface EnvironmentConfigFromBaseResult {
  config: RepoEnvironmentConfig | null;
  /** Human-readable notes for the worker log. */
  notes: string[];
}

/**
 * Loads `environment.json` from the base branch, never from the working tree, so
 * a run cannot change the checks it is verified under.
 *
 * Fails closed: when the base branch cannot be read, no config is used and the
 * caller reports the run as unverified. An invalid file on the base branch throws,
 * the same as an invalid file for coding agents.
 */
export async function loadEnvironmentConfigFromBase(
  workspaceDir: string,
  baseBranch: string,
): Promise<EnvironmentConfigFromBaseResult> {
  const notes: string[] = [];
  const baseRef = await resolveBaseRef(workspaceDir, baseBranch);

  if (!baseRef) {
    notes.push(
      `Warning: base branch ${baseBranch} is not available in the workspace; running checks without repository config`,
    );
    return { config: null, notes };
  }

  const configText = await readFileAtRef(workspaceDir, baseRef, ENVIRONMENT_CONFIG_REPOSITORY_PATH);
  if (configText === null) {
    return { config: null, notes };
  }

  const parsed = parseEnvironmentConfig(configText);
  notes.push(`Loaded ${ENVIRONMENT_CONFIG_REPOSITORY_PATH} from base branch ${baseBranch}`);
  return { config: parsed.config, notes: [...notes, ...parsed.notes] };
}
