import path from 'path';
import type { Agent, AgentBootstrapState, AppConfig } from '../../../types';
import type { JsonStore } from '../../../lib/json-store';
import { appendLog, appendLogBlock, updateAgentRecord } from './agent-state-writer';
import { computeCacheKey, type DepCacheKey } from './dep-cache-key';
import { getDepCacheDirs, restoreDepCache, snapshotDepCache } from './dep-cache';
import { environmentConfigRelative, loadEnvironmentConfig } from './environment-config';
import { detectProfiles, detectSetupScript, resolveSetupCommand } from './environment-detect';
import { loadRuntimeProfiles } from './runtime-profiles';
import { runWorkspaceCommand } from './workspace-command';

/** Default timeout applied to a repo's setup command (10 min). */
export const DEFAULT_SETUP_TIMEOUT_MS = 600_000;

export interface RunWorkspaceBootstrapOptions {
  workspaceDir: string;
  logPath: string;
  agentId: string;
  agentsStore: JsonStore<{ agents: Agent[] }>;
  /**
   * Server config used for the profile gate (P2-T4): `enabledRuntimeProfiles`
   * (undefined or empty = all catalog profiles allowed), `bootstrapAutoDetect`
   * for file-less auto-detect, and `globalSetupTimeoutMs` to override
   * `setup.timeoutMs`.
   */
  config?: Pick<
    AppConfig,
    'enabledRuntimeProfiles' | 'bootstrapAutoDetect' | 'globalSetupTimeoutMs'
  >;
  /**
   * Persistent dependency cache (P3-T4). When provided and backed by a
   * cacheable profile, the workspace `node_modules` is restored from the
   * cache before the setup command runs and re-snapshotted after it succeeds,
   * so repeat runs skip the full install. Omit to leave caching disabled.
   */
  depCache?: {
    /** Root directory holding `{repoId}/{cacheKey}` entries. */
    root: string;
    /** Repo id used as the first cache path segment. */
    repoId: string;
  };
  /** Injectable for tests; defaults to the shared `runWorkspaceCommand`. */
  runCommand?: typeof runWorkspaceCommand;
  /** Injectable for tests; defaults to the bundled runtime profile catalog. */
  loadProfiles?: () => Record<string, import('./runtime-profiles').RuntimeProfile>;
  /** Injectable for tests; defaults to `restoreDepCache`. */
  restoreCache?: typeof restoreDepCache;
  /** Injectable for tests; defaults to `snapshotDepCache`. */
  snapshotCache?: typeof snapshotDepCache;
}

/**
 * Host-run workspace bootstrap: resolve the repo's setup command
 * (committed `.localagent-box/setup.sh` → explicit `setup.command` →
 * `profiles` → lockfile auto-detect), run it before the agent starts, and
 * record the outcome on the agent record plus in the worker log.
 *
 * Resolution:
 * - `.localagent-box/setup.sh` committed in the repo → run via `bash`
 *   (P4-T1), before any other source is considered.
 * - No `.localagent-box/environment.json` → skipped, unless the server config
 *   sets `bootstrapAutoDetect: true` (`BOOTSTRAP_AUTO_DETECT`), which enables
 *   lockfile-only auto-detect for unconfigured repos (P2-T4).
 * - `environment.json` present → `resolveSetupCommand` runs; `source: 'none'`
 *   (no usable config entry) → skipped.
 *
 * Profile gate (P2-T4): requested and detected profiles are filtered against
 * `config.enabledRuntimeProfiles` (undefined or empty = all catalog profiles
 * enabled); disabled profiles are skipped with a warning in the worker log.
 *
 * Throws when the setup command fails with `failOnError` left at its
 * default (`true`); caller is expected to fail the agent start.
 */
export async function runWorkspaceBootstrap(
  options: RunWorkspaceBootstrapOptions,
): Promise<AgentBootstrapState> {
  const { workspaceDir, logPath, agentId, agentsStore } = options;
  const runCommand = options.runCommand ?? runWorkspaceCommand;
  const loadProfiles = options.loadProfiles ?? loadRuntimeProfiles;
  const restore = options.restoreCache ?? restoreDepCache;
  const snapshot = options.snapshotCache ?? snapshotDepCache;
  const config = options.config;
  const profileCatalog = loadProfiles();
  const enabledProfiles = config?.enabledRuntimeProfiles;
  const enabledProfileNames =
    enabledProfiles === undefined || enabledProfiles.length === 0
      ? undefined
      : enabledProfiles;

  const envConfig = loadEnvironmentConfig(workspaceDir);
  const setupScript = detectSetupScript(workspaceDir);
  if (envConfig === null && setupScript === null && config?.bootstrapAutoDetect !== true) {
    return { status: 'skipped' };
  }

  const resolved = resolveSetupCommand(
    envConfig ?? { version: 1 },
    workspaceDir,
    profileCatalog,
    enabledProfileNames,
    (profile) => {
      appendLog(logPath, `Bootstrap: skipping disabled runtime profile '${profile}'`);
    },
  );
  if (resolved.source === 'none' || resolved.command === '') {
    return { status: 'skipped' };
  }
  const { command, source } = resolved;
  const profiles = resolved.profiles;
  const failOnError = envConfig?.setup?.failOnError;

  appendLog(
    logPath,
    `Bootstrap: source=${source} profiles=[${profiles.join(', ')}] command=${command}`,
  );

  // Dependency cache (P3-T4): restore cached node_modules into the fresh
  // clone before setup so repeat runs skip the full install; the workspace is
  // snapshotted back into the cache after a successful run. No-op when no
  // cache is configured or no profile caches its workspace dirs (phase 3
  // caches nodejs / nodejs-pnpm only).
  const depCache = options.depCache;
  const cacheableProfile: string | undefined =
    depCache !== undefined
      ? (profiles.find((name) => getDepCacheDirs(name).length > 0) ??
        detectProfiles(workspaceDir, profileCatalog).find(
          (name) => getDepCacheDirs(name).length > 0,
        ))
      : undefined;
  let cacheDir: string | null = null;
  let cacheKey: DepCacheKey | null = null;
  if (depCache !== undefined && cacheableProfile !== undefined) {
    try {
      cacheKey = computeCacheKey({
        repoId: depCache.repoId,
        workspaceDir,
        profiles,
        catalog: profileCatalog,
        explicitCacheKey: envConfig?.cacheKey,
      });
      cacheDir = path.join(depCache.root, cacheKey.relativePath);
      appendLog(
        logPath,
        `Dependency cache key: ${cacheKey.relativePath} (method=${cacheKey.method})`,
      );
    } catch (err) {
      appendLog(
        logPath,
        `Dependency cache: unable to compute key — continuing without cache (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  let cacheHit = false;
  if (cacheDir !== null && cacheableProfile !== undefined) {
    try {
      cacheHit = await restore(cacheDir, workspaceDir, cacheableProfile);
      appendLog(
        logPath,
        cacheHit
          ? `Dependency cache hit: ${cacheableProfile} restored at ${cacheDir}`
          : `Dependency cache miss: no cached data at ${cacheDir}`,
      );
    } catch (err) {
      cacheHit = false;
      appendLog(
        logPath,
        `Dependency cache restore failed — continuing without cache (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  appendLog(logPath, 'Running workspace bootstrap…');
  if (source === 'script') {
    appendLog(logPath, `setup script command: ${command}`);
  } else {
    appendLog(logPath, `${environmentConfigRelative} command: ${command}`);
  }
  updateAgentRecord(agentsStore, agentId, {
    bootstrap: { status: 'running', command, profiles, source, cacheHit },
  });

  const serverTimeoutMs = config?.globalSetupTimeoutMs;
  const repoTimeoutMs = envConfig?.setup?.timeoutMs;
  const timeoutMsToUse =
    typeof serverTimeoutMs === 'number' && serverTimeoutMs > 0
      ? serverTimeoutMs
      : repoTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
  const startedAt = Date.now();
  const result = await runCommand(workspaceDir, command, { timeoutMs: timeoutMsToUse });
  const durationMs = Date.now() - startedAt;

  if (result.success) {
    if (cacheDir !== null && cacheableProfile !== undefined) {
      try {
        await snapshot(
          cacheDir,
          workspaceDir,
          cacheableProfile,
          {
            command,
            profiles,
            lockfileHash: cacheKey?.lockfileHash,
          },
        );
        appendLog(logPath, `Dependency cache snapshot updated at ${cacheDir}`);
      } catch (err) {
        appendLog(
          logPath,
          `Dependency cache snapshot failed — continuing (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    appendLog(logPath, `Workspace bootstrap completed in ${durationMs}ms (exit code ${result.exitCode})`);
    appendLogBlock(logPath, 'Workspace bootstrap output:', result.outputTail);
    const state: AgentBootstrapState = {
      status: 'completed',
      command,
      profiles,
      source,
      durationMs,
      exitCode: result.exitCode,
      outputTail: result.outputTail,
      cacheHit,
    };
    updateAgentRecord(agentsStore, agentId, { bootstrap: state });
    return state;
  }

  const exitCode = result.exitCode;
  const outputTail = result.outputTail;
  if (result.timedOut) {
    appendLog(logPath, `Workspace bootstrap timed out after ${durationMs}ms (exit code ${exitCode})`);
  } else {
    appendLog(logPath, `Workspace bootstrap failed with exit code ${exitCode} after ${durationMs}ms`);
  }
  appendLogBlock(logPath, 'Workspace bootstrap output:', outputTail);

  const error = result.timedOut
    ? `Bootstrap timed out: \`${command}\` (timeout ${timeoutMsToUse}ms)`
    : `Bootstrap failed: \`${command}\` exited ${exitCode}`;
  const failedState: AgentBootstrapState = {
    status: 'failed',
    command,
    profiles,
    source,
    durationMs,
    exitCode,
    outputTail,
    error,
    cacheHit,
  };

  if (failOnError === false) {
    appendLog(logPath, 'Workspace bootstrap failed but failOnError=false — continuing');
    updateAgentRecord(agentsStore, agentId, { bootstrap: failedState });
    return failedState;
  }

  updateAgentRecord(agentsStore, agentId, { bootstrap: failedState });
  throw new Error(`${error}\n${outputTail}`);
}