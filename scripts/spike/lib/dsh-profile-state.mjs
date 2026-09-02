import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const SPIKE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Bundles that turn a blank profile into the JSON-RPC SDK server composition. */
export const SDK_PROFILE_BUNDLE = '@deepseek-ai/dsh-sdk-app';

/**
 * @param {string} profileDir $DSH_HOME/profiles/<name>
 * @returns {Record<string, unknown> | null}
 */
export function readProfileManifest(profileDir) {
  const pkgPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}

/**
 * True when package.json exists. A failed `dsh plugin add` can leave only dsh-base.
 * @param {string} profileDir
 * @returns {boolean}
 */
export function isProfileInitialized(profileDir) {
  return fs.existsSync(path.join(profileDir, 'package.json'));
}

/**
 * True when the sdk-app bundle is declared and installed under node_modules.
 * @param {string} profileDir
 * @returns {boolean}
 */
export function isProfileReady(profileDir) {
  const manifest = readProfileManifest(profileDir);
  if (!manifest) {
    return false;
  }
  const bundles = manifest?.dsh?.profile?.bundles;
  const bundleList = Array.isArray(bundles) ? bundles : [];
  const hasSdkApp = bundleList.some(
    (name) => typeof name === 'string' && name.includes('dsh-sdk-app'),
  );
  const installed = fs.existsSync(
    path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-app'),
  );
  return hasSdkApp && installed;
}

/**
 * Resolve @deepseek-ai/dsh-sdk-app version for `dsh plugin add`.
 * Prefers DSH_SDK_APP_VERSION, then the version pinned in scripts/spike/package.json.
 * @returns {string}
 */
export function resolveSdkAppVersion() {
  if (process.env.DSH_SDK_APP_VERSION) {
    return process.env.DSH_SDK_APP_VERSION;
  }
  try {
    const spikePkg = JSON.parse(fs.readFileSync(path.join(SPIKE_ROOT, 'package.json'), 'utf8'));
    const pinned = spikePkg.dependencies?.['@deepseek-ai/dsh'];
    if (typeof pinned === 'string') {
      const cleaned = pinned.replace(/^[\^~>=< ]+/, '');
      if (cleaned.length > 0) {
        return cleaned;
      }
    }
  } catch {
    // fall through
  }
  return '0.1.2-alpha.2';
}

/**
 * @param {string} bundle
 * @returns {string}
 */
export function bundleWithVersion(bundle) {
  if (bundle.includes('@') && bundle.lastIndexOf('@') > bundle.indexOf('/')) {
    return bundle;
  }
  return `${bundle}@${resolveSdkAppVersion()}`;
}

/**
 * @param {string} profileDir
 */
export function removeProfileDir(profileDir) {
  fs.rmSync(profileDir, { recursive: true, force: true });
}
