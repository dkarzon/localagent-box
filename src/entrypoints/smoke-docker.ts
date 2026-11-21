/**
 * Harness smoke test inside Docker: `npm run smoke:docker [-- options]`.
 *
 * Default: build the image from this checkout and run the smoke test in a throwaway
 * container, so it exercises what ships (Linux build, the image's @opencode/cli,
 * container networking to the provider). `--container <name>` runs it in an existing
 * container instead, using that container's own Settings.
 *
 * Unrecognised options are forwarded to the smoke test (e.g. --model, --server-only, --json).
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { loadDotenv } from '../config/env';

const SMOKE_ENTRY = '/app/dist/entrypoints/smoke.js';
const DEFAULT_IMAGE = 'localagent-box:smoke';

/** Provider settings the smoke test reads from env — forwarded into a fresh container. */
export const FORWARDED_ENV_KEYS = [
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'OLLAMA_BASE_URL',
  'OLLAMA_CLOUD_BASE_URL',
  'OLLAMA_CLOUD_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_API_KEY',
  'ENABLE_CODEGRAPH',
] as const;

const USAGE = `Usage: smoke:docker [options] [smoke options]

  --container <name>    Run inside an existing container (uses its Settings; no build)
  --image <tag>         Image to build/run (default: ${DEFAULT_IMAGE})
  --no-build            Skip docker build and run the existing image
  --data <path|volume>  Mount a data dir or volume read-only at /data, to use its config.json
  -h, --help            Show this help

Smoke options (forwarded): --model <id>, --provider <id>, --server-only, --timeout <sec>,
  --codegraph, --keep, --json. Provider env (${FORWARDED_ENV_KEYS.join(', ')}) is passed
  from your shell or .env into a fresh container.
`;

export interface DockerSmokeArgs {
  container?: string;
  image: string;
  build: boolean;
  data?: string;
  forwarded: string[];
}

export function parseDockerSmokeArgs(argv: string[]): DockerSmokeArgs | 'help' | { error: string } {
  const args: DockerSmokeArgs = { image: DEFAULT_IMAGE, build: true, forwarded: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string | null => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return null;
      i += 1;
      return next;
    };
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '--container':
      case '--image':
      case '--data': {
        const v = value();
        if (v === null) return { error: `${arg} needs a value` };
        if (arg === '--container') args.container = v;
        else if (arg === '--image') args.image = v;
        else args.data = v;
        break;
      }
      case '--no-build':
        args.build = false;
        break;
      default:
        args.forwarded.push(arg);
    }
  }
  if (args.container && args.data) {
    return { error: '--data only applies to a fresh container (not with --container)' };
  }
  return args;
}

/** Provider env for the container: shell env wins over .env, matching the server. */
export function collectForwardedEnv(
  processEnv: NodeJS.ProcessEnv,
  dotenv: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FORWARDED_ENV_KEYS) {
    const value = processEnv[key] || dotenv[key];
    if (value) out[key] = value;
  }
  return out;
}

/** `localhost` inside the container is the container itself, not your machine. */
export function findLoopbackUrls(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([key, value]) => key.endsWith('_URL') && /\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(value))
    .map(([key]) => key);
}

export function buildDockerRunArgs(args: DockerSmokeArgs, envKeys: string[]): string[] {
  return [
    'run',
    '--rm',
    '--add-host=host.docker.internal:host-gateway',
    // Values come from the child process env (`-e KEY`), keeping secrets off the command line.
    ...envKeys.flatMap((key) => ['-e', key]),
    ...(args.data ? ['-v', `${args.data.includes('/') || args.data.includes('\\') ? path.resolve(args.data) : args.data}:/data:ro`] : []),
    '--entrypoint',
    'node',
    args.image,
    SMOKE_ENTRY,
    ...args.forwarded,
  ];
}

function run(cmd: string, cmdArgs: string[], env?: NodeJS.ProcessEnv): number {
  const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit', env: env ?? process.env });
  if (result.error) {
    process.stderr.write(`Failed to run ${cmd}: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function main(): number {
  const parsed = parseDockerSmokeArgs(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }

  if (parsed.container) {
    process.stdout.write(`Running smoke test in container "${parsed.container}"…\n`);
    return run('docker', ['exec', parsed.container, 'node', SMOKE_ENTRY, ...parsed.forwarded]);
  }

  if (parsed.build) {
    process.stdout.write(`Building ${parsed.image} from ${process.cwd()}…\n`);
    const code = run('docker', ['build', '-t', parsed.image, '.']);
    if (code !== 0) {
      process.stderr.write(`docker build failed (exit ${code})\n`);
      return 1;
    }
  }

  const env = collectForwardedEnv(process.env, loadDotenv());
  for (const key of findLoopbackUrls(env)) {
    process.stderr.write(
      `Warning: ${key} points at localhost — inside the container use host.docker.internal or a LAN address.\n`,
    );
  }
  process.stdout.write(
    `Running smoke test in a fresh ${parsed.image} container (env: ${Object.keys(env).join(', ') || 'none'}${parsed.data ? `, data: ${parsed.data}` : ''})…\n`,
  );
  return run('docker', buildDockerRunArgs(parsed, Object.keys(env)), { ...process.env, ...env });
}

if (require.main === module) {
  process.exit(main());
}
