import fs from 'node:fs';
import path from 'path';
import { DEFAULT_API_TOKEN } from '../lib/auth-constants';
import { parseNonNegativeInt, parsePositiveInt } from '../lib/parse';

export interface ServerEnv {
  port: number;
  dataDir: string;
  agentWorkspace: string;
  maxConcurrentAgents: number;
  agentTimeoutSeconds: number;
  agentTimeoutMs: number;
  apiToken: string;
  publicDir: string;
  isProduction: boolean;
  logLevel: string;
  maxBodyBytes: number;
  shutdownTimeoutMs: number;
  ollamaBaseUrl: string | undefined;
  opencodeModel: string | undefined;
  opencodeProvider: string | undefined;
  opencodeBin: string;
  opencodePortBase: number;
  /** Max wait for `opencode serve` to accept `/path` (includes first-run DB migration). */
  opencodeStartupTimeoutMs: number;
  /** Expose the codegraph MCP server to agents (requires the binary in the image). */
  enableCodegraph: boolean;
  /** Run lockfile auto-detect bootstrap even without `.localagent-box/environment.json` (default false). */
  bootstrapAutoDetect: boolean;
  /** Global override for `setup.timeoutMs` in ms; 0 disables the override. */
  bootstrapGlobalSetupTimeoutMs: number;
}

let cachedEnv: ServerEnv | null = null;

function parsePort(value: string | undefined): number {
  const port = parsePositiveInt(value, 8080);
  if (port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

function parseBool(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value || '').trim());
}

function resolveAgentWorkspace(dataDir: string): string {
  if (process.env.AGENT_WORKSPACE) {
    return process.env.AGENT_WORKSPACE;
  }
  if (process.platform === 'win32') {
    return path.join(dataDir, 'workspace', 'agents');
  }
  return '/workspace/agents';
}

function loadDotenv(): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const dotfile = path.join(process.cwd(), '.env');
    if (fs.existsSync(dotfile)) {
      for (const line of fs.readFileSync(dotfile, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const idx = trimmed.indexOf('=');
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        result[key] = val;
      }
    }
  } catch {}
  return result;
}

export function loadServerEnv(): ServerEnv {
  const fileVars = loadDotenv();
  const isProduction = process.env.NODE_ENV === 'production';
  const apiToken = process.env.API_TOKEN || DEFAULT_API_TOKEN;

  if (isProduction && apiToken === DEFAULT_API_TOKEN) {
    throw new Error(
      'API_TOKEN must be set to a non-default value when NODE_ENV=production',
    );
  }

  const dataDir = process.env.DATA_DIR || fileVars.DATA_DIR || '/data';
  const agentTimeoutSeconds = parsePositiveInt(process.env.AGENT_TIMEOUT ?? fileVars.AGENT_TIMEOUT, 3600);

  return {
    port: parsePort(process.env.PORT ?? fileVars.PORT),
    dataDir,
    agentWorkspace: resolveAgentWorkspace(dataDir),
    maxConcurrentAgents: parsePositiveInt(process.env.MAX_CONCURRENT_AGENTS ?? fileVars.MAX_CONCURRENT_AGENTS, 3),
    agentTimeoutSeconds,
    agentTimeoutMs: agentTimeoutSeconds * 1000,
    apiToken,
    publicDir: path.join(__dirname, '..', '..', 'public'),
    isProduction,
    logLevel: (process.env.LOG_LEVEL ?? fileVars.LOG_LEVEL) || (isProduction ? 'info' : 'debug'),
    maxBodyBytes: parsePositiveInt(process.env.MAX_BODY_BYTES ?? fileVars.MAX_BODY_BYTES, 5 * 1024 * 1024),
    shutdownTimeoutMs: parsePositiveInt(process.env.SHUTDOWN_TIMEOUT_MS ?? fileVars.SHUTDOWN_TIMEOUT_MS, 30_000),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || fileVars.OLLAMA_BASE_URL || undefined,
    opencodeModel: process.env.OPENCODE_MODEL || fileVars.OPENCODE_MODEL || undefined,
    opencodeProvider: process.env.OPENCODE_PROVIDER || fileVars.OPENCODE_PROVIDER || undefined,
    opencodeBin: process.env.OPENCODE_BIN || fileVars.OPENCODE_BIN || 'opencode',
    opencodePortBase: parsePositiveInt(process.env.OPENCODE_PORT_BASE ?? fileVars.OPENCODE_PORT_BASE, 4100),
    opencodeStartupTimeoutMs: parsePositiveInt(process.env.OPENCODE_STARTUP_TIMEOUT_MS ?? fileVars.OPENCODE_STARTUP_TIMEOUT_MS, 900_000),
    enableCodegraph: parseBool(process.env.ENABLE_CODEGRAPH ?? fileVars.ENABLE_CODEGRAPH),
    bootstrapAutoDetect: parseBool(process.env.BOOTSTRAP_AUTO_DETECT ?? fileVars.BOOTSTRAP_AUTO_DETECT),
    bootstrapGlobalSetupTimeoutMs: parseNonNegativeInt(
      process.env.BOOTSTRAP_SETUP_TIMEOUT_MS ?? fileVars.BOOTSTRAP_SETUP_TIMEOUT_MS,
      0,
    ),
  };
}

export function getServerEnv(): ServerEnv {
  if (!cachedEnv) {
    cachedEnv = loadServerEnv();
  }
  return cachedEnv;
}

/** @internal Test helper */
export function resetServerEnvCache(): void {
  cachedEnv = null;
}

