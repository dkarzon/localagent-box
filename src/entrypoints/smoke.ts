/**
 * Harness smoke test: `npm run smoke [-- options]` (dev) or `node dist/entrypoints/smoke.js`
 * (Docker: `docker exec localagent-box node /app/dist/entrypoints/smoke.js`).
 *
 * Uses the provider/model from DATA_DIR/config.json (Settings) unless overridden.
 * Exit codes: 0 = all checks passed (warnings allowed), 1 = a check failed, 2 = bad usage.
 */
import fs from 'fs';
import path from 'path';
import { getServerEnv } from '../config/env';
import { createConfigRepository } from '../domains/config/config.repository';
import { buildEnvConfigDefaults } from '../domains/config/env-config-defaults';
import type { AppConfig } from '../types';
import { isLlmProviderId } from '../lib/llm-provider';
import { runSmokeTest, type SmokeCheck } from '../integrations/opencode/smoke-test';

const USAGE = `Usage: smoke [options]

Runs one real OpenCode turn through the localagent-box harness and checks every stage.

Options:
  --model <id>        Model to use (default: Settings model)
  --provider <id>     Provider id: ollama | ollama-cloud | openai-compatible (default: Settings)
  --server-only       Only check config, server start, auth, events and session (no model turn)
  --timeout <sec>     Model turn timeout in seconds (default: 300)
  --codegraph         Enable the codegraph MCP server (default: on when ENABLE_CODEGRAPH is set)
  --keep              Keep the temp workspace and debug log (always kept on failure)
  --json              Print the result as JSON
  -h, --help          Show this help
`;

interface Args {
  model?: string;
  provider?: string;
  serverOnly: boolean;
  timeoutSec: number;
  codegraph: boolean;
  keep: boolean;
  json: boolean;
}

export function parseSmokeArgs(argv: string[]): Args | { error: string } | 'help' {
  const args: Args = { serverOnly: false, timeoutSec: 300, codegraph: false, keep: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      switch (arg) {
        case '-h':
        case '--help':
          return 'help';
        case '--model':
          args.model = value();
          break;
        case '--provider':
          args.provider = value();
          break;
        case '--server-only':
          args.serverOnly = true;
          break;
        case '--timeout': {
          const n = Number(value());
          if (!Number.isFinite(n) || n <= 0) return { error: '--timeout must be a positive number of seconds' };
          args.timeoutSec = n;
          break;
        }
        case '--codegraph':
          args.codegraph = true;
          break;
        case '--keep':
          args.keep = true;
          break;
        case '--json':
          args.json = true;
          break;
        default:
          return { error: `Unknown option: ${arg}` };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (args.provider && !isLlmProviderId(args.provider)) {
    return { error: `Unknown provider: ${args.provider}` };
  }
  return args;
}

const ICON: Record<SmokeCheck['status'], string> = { pass: '✔', fail: '✖', warn: '!', skip: '-' };

function formatCheck(check: SmokeCheck): string {
  const time = check.durationMs !== undefined ? ` (${(check.durationMs / 1000).toFixed(1)}s)` : '';
  const detail = check.detail ? ` — ${check.detail}` : '';
  return `  ${ICON[check.status]} ${check.label}${time}${detail}`;
}

async function main(): Promise<number> {
  const parsed = parseSmokeArgs(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }

  const env = getServerEnv();
  const configPath = path.resolve(env.dataDir, 'config.json');
  const stored = createConfigRepository(env.dataDir, fs).load();
  // Same env / .env seeding the server applies on startup, but in memory only.
  const config: AppConfig = { ...stored, ...buildEnvConfigDefaults(stored, env) };
  if (parsed.provider && isLlmProviderId(parsed.provider)) {
    config.opencodeProvider = parsed.provider;
  }

  if (!parsed.json) {
    const model = parsed.model || config.opencodeModel || '(none)';
    const source = fs.existsSync(configPath) ? configPath : `${configPath} (not found — defaults + env only)`;
    process.stdout.write(
      `localagent-box harness smoke test — provider=${config.opencodeProvider ?? 'ollama'} model=${model}${parsed.serverOnly ? ' (server only)' : ''}\n  settings: ${source}\n`,
    );
  }

  const result = await runSmokeTest({
    config,
    model: parsed.model,
    serverOnly: parsed.serverOnly,
    timeoutMs: parsed.timeoutSec * 1000,
    // Match agent runs: codegraph follows ENABLE_CODEGRAPH unless --codegraph forces it on.
    codegraph: parsed.codegraph || env.enableCodegraph,
    keep: parsed.keep,
    opencodeBin: env.opencodeBin,
    onProgress: parsed.json ? undefined : (check) => process.stdout.write(`${formatCheck(check)}\n`),
  });

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  if (!result.ok && result.serverOutputTail.length > 0) {
    process.stdout.write('\nLast opencode serve output:\n');
    for (const line of result.serverOutputTail) process.stdout.write(`  serve> ${line}\n`);
  }
  if (result.kept) {
    process.stdout.write(`\nTemp workspace and debug.log kept at: ${result.tempDir}\n`);
  }
  const counts = result.checks.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {});
  process.stdout.write(
    `\n${result.ok ? 'PASS' : 'FAIL'} — ${counts.pass ?? 0} passed, ${counts.warn ?? 0} warning(s), ${counts.fail ?? 0} failed\n`,
  );
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`Smoke test crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
