import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WARMUP_MARKER = '.spike-warmup-complete';

/**
 * Whether DSH has linked llm-pi-ai into profiles/node_modules.
 * @param {string} dshHome
 * @returns {boolean}
 */
export function isDshHomeWarmed(dshHome) {
  return fs.existsSync(
    path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai'),
  );
}

/**
 * @param {string} dshHome
 * @returns {boolean}
 */
export function isDshHomeWarmupComplete(dshHome) {
  return fs.existsSync(path.join(dshHome, WARMUP_MARKER));
}

/**
 * Run `dsh --profile <profile>` until profiles/node_modules is fully healed.
 *
 * @param {{ dshBin: string; dshHome: string; profile?: string; cwd?: string; timeoutMs?: number; settleMs?: number; log?: (...args: unknown[]) => void }} opts
 * @returns {Promise<void>}
 */
export async function warmupDshHome(opts) {
  const profile = opts.profile || 'sdk';
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const settleMs = opts.settleMs ?? 15_000;
  const markerPath = path.join(opts.dshHome, WARMUP_MARKER);
  const llmPiAiPath = path.join(
    opts.dshHome,
    'profiles',
    'node_modules',
    '@deepseek-ai',
    'dsh-llm-pi-ai',
  );

  if (isDshHomeWarmupComplete(opts.dshHome)) {
    opts.log?.('DSH home warm-up already complete');
    return;
  }

  opts.log?.(`Warming up DSH home (first-run module heal; settle ${settleMs}ms)…`);

  const startedAt = Date.now();

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [opts.dshBin, '--profile', profile], {
      cwd: opts.cwd || opts.dshHome,
      env: { ...process.env, DSH_HOME: opts.dshHome },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const finish = (ok, err) => {
      clearInterval(poll);
      clearTimeout(timer);
      if (!child.killed) {
        child.kill('SIGTERM');
      }
      if (ok) {
        resolve();
      } else {
        reject(err);
      }
    };

    const poll = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (isDshHomeWarmed(opts.dshHome) && elapsed >= settleMs) {
        finish(true);
      }
    }, 250);

    const timer = setTimeout(() => {
      if (isDshHomeWarmed(opts.dshHome)) {
        finish(true);
        return;
      }
      finish(
        false,
        new Error(
          `DSH warmup timed out after ${timeoutMs}ms before ${llmPiAiPath} was linked` +
            (stderr ? `\nstderr: ${stderr.slice(-1500)}` : ''),
        ),
      );
    }, timeoutMs);

    child.on('error', (err) => finish(false, err));
  });

  if (!isDshHomeWarmed(opts.dshHome)) {
    throw new Error(`DSH warmup finished but ${llmPiAiPath} is still missing`);
  }

  fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf8');
  opts.log?.('DSH home warm-up complete');
}

/**
 * @param {string} dshHome
 */
export function clearDshHomeWarmupMarker(dshHome) {
  fs.rmSync(path.join(dshHome, WARMUP_MARKER), { force: true });
}
