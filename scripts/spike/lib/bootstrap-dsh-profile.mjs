import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  SDK_PROFILE_BUNDLE,
  bundleWithVersion,
  isProfileReady,
  removeProfileDir,
} from './dsh-profile-state.mjs';
import { clearDshHomeWarmupMarker } from './warmup-dsh-home.mjs';

/**
 * Create or repair the `sdk` profile under $DSH_HOME.
 * In @deepseek-ai/dsh@0.1.1-rc.2 only `web` and `headless` ship as templates;
 * `sdk` must be initialized via `dsh plugin --profile sdk add <bundle>`.
 *
 * A failed plugin add can leave a broken profile (package.json + dsh-base only).
 * This function detects that state and re-runs bootstrap.
 *
 * @param {{ dshBin: string; dshHome: string; profile?: string; bundle?: string; log?: (...args: unknown[]) => void }} opts
 * @returns {Promise<void>}
 */
export async function bootstrapDshProfile(opts) {
  const profile = opts.profile || 'sdk';
  const bundle = opts.bundle || SDK_PROFILE_BUNDLE;
  const log = opts.log || (() => {});
  const profileDir = path.join(opts.dshHome, 'profiles', profile);
  const bundleSpec = bundleWithVersion(bundle);

  if (isProfileReady(profileDir)) {
    log(`DSH profile "${profile}" ready at ${profileDir}`);
    return;
  }

  if (fs.existsSync(profileDir)) {
    log(
      `DSH profile "${profile}" is incomplete at ${profileDir} — removing and re-bootstrapping (need ${bundleSpec})`,
    );
    removeProfileDir(profileDir);
    clearDshHomeWarmupMarker(opts.dshHome);
  }

  fs.mkdirSync(opts.dshHome, { recursive: true });
  log(`Bootstrapping DSH profile "${profile}" (dsh plugin --profile ${profile} add ${bundleSpec})…`);

  await runDshPluginAdd({
    dshBin: opts.dshBin,
    dshHome: opts.dshHome,
    profile,
    bundle: bundleSpec,
  });

  if (!isProfileReady(profileDir)) {
    throw new Error(
      `DSH profile bootstrap failed — expected ${bundleSpec} in ${profileDir}. ` +
        'Delete spike-runs/_dsh-home/profiles/sdk and retry, or set DSH_SDK_APP_VERSION.',
    );
  }

  log(`DSH profile "${profile}" ready at ${profileDir}`);
}

/**
 * @param {{ dshBin: string; dshHome: string; profile: string; bundle: string }} opts
 * @returns {Promise<void>}
 */
function runDshPluginAdd(opts) {
  return new Promise((resolve, reject) => {
    const args = [opts.dshBin, 'plugin', '--profile', opts.profile, 'add', opts.bundle];

    const child = spawn(process.execPath, args, {
      env: { ...process.env, DSH_HOME: opts.dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `dsh plugin add exited ${code}\nstdout: ${stdout.slice(-2000)}\nstderr: ${stderr.slice(-2000)}`,
        ),
      );
    });
  });
}

// Re-export for tests and callers.
export { isProfileReady, isProfileInitialized } from './dsh-profile-state.mjs';
