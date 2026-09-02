import fs from 'node:fs';
import path from 'node:path';

/**
 * Write $DSH_HOME/.credentials.yaml for unattended DSH runs.
 * DSH 0.1.2-alpha+ resolves apiKeyEnv refs through the credentials service;
 * exporting the env var alone is not enough for the sdk profile subprocess.
 *
 * @param {string} dshHome absolute or relative DSH_HOME path
 * @param {Record<string, string>} [refs] credential ref map (default OLLAMA_API_KEY)
 */
export function writeDshCredentialsFile(dshHome, refs = {}) {
  const merged = {
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || 'ollama',
    ...refs,
  };

  const lines = ['version: 1', 'refs:'];
  for (const [key, value] of Object.entries(merged)) {
    if (!value) {
      continue;
    }
    lines.push(`  ${key}: ${yamlScalar(value)}`);
  }

  const filePath = path.join(dshHome, '.credentials.yaml');
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * @param {string} value
 * @returns {string}
 */
function yamlScalar(value) {
  const str = String(value);
  if (/^[a-zA-Z0-9._:@/+-]+$/.test(str)) {
    return str;
  }
  return JSON.stringify(str);
}
