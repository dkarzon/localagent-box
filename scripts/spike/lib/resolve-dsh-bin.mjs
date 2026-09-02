import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the `dsh` CLI entrypoint from the installed @deepseek-ai/dsh package.
 * @returns {string}
 */
export function resolveDshBin() {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) {
    return process.env.DSH_BIN;
  }

  const globalCandidates = [
    '/usr/local/bin/dsh',
    path.join(process.env.APPDATA || '', 'npm', 'dsh.cmd'),
    path.join(process.env.APPDATA || '', 'npm', 'dsh'),
  ];
  for (const candidate of globalCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const pkgJson = require.resolve('@deepseek-ai/dsh/package.json');
    const pkgDir = path.dirname(pkgJson);
    const localBin = path.join(pkgDir, 'lib', 'bin.js');
    if (fs.existsSync(localBin)) {
      return localBin;
    }
  } catch {
    // fall through
  }

  throw new Error(
    'Could not resolve dsh binary. Install @deepseek-ai/dsh globally or in scripts/spike/node_modules.',
  );
}
