import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import type { ChildProcess } from 'child_process';
import type { SpawnFn } from '../../types';
import { collectOpenCodeSpawnDebug, getOpencodeBin, type OpenCodeModelRef } from './runner';
import { getServerEnv } from '../../config/env';

/** OpenCode 1.0.218 — minimal types; refine against GET /doc OpenAPI when bumped */

export interface OpenCodeSession {
  id: string;
  version: string;
  projectID: string;
  directory: string;
  title?: string;
  time: { created: number; updated: number };
}

export interface OpenCodeTextPartInput {
  type: 'text';
  text: string;
  id?: string;
  synthetic?: boolean;
  ignored?: boolean;
}

export interface OpenCodePromptBody {
  parts: OpenCodeTextPartInput[];
  agent?: string;
  model?: OpenCodeModelRef | null;
  system?: string;
  messageID?: string;
  noReply?: boolean;
}

export interface OpenCodeServerEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface OpenCodeEventSubscription {
  unsubscribe: () => void;
  /** Resolves after SSE `server.connected` (or rejects on connection failure). */
  ready: Promise<void>;
}

export interface OpenCodeSessionRunner {
  port: number;
  baseUrl: string;
  startServer: () => Promise<void>;
  /** Wait until `/path` succeeds (health alone is insufficient during DB migration). */
  waitForServerReady: (timeoutMs?: number) => Promise<void>;
  createSession: (title?: string) => Promise<OpenCodeSession>;
  sendPromptAsync: (sessionId: string, body: OpenCodePromptBody) => Promise<void>;
  replyPermission: (requestId: string, reply?: 'once' | 'always' | 'reject') => Promise<void>;
  abort: (sessionId: string) => Promise<void>;
  subscribeEvents: (onEvent: (event: OpenCodeServerEvent) => void) => OpenCodeEventSubscription;
  dispose: () => Promise<void>;
}

export function parseSseDataLine(line: string): OpenCodeServerEvent | null {
  const prefix = 'data: ';
  const trimmed = line.trim();
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  try {
    return JSON.parse(trimmed.slice(prefix.length)) as OpenCodeServerEvent;
  } catch {
    return null;
  }
}

export function buildIsolationEnv(agentDir: string): Record<string, string> {
  const xdgShare = path.join(agentDir, 'xdg', 'share');
  const xdgState = path.join(agentDir, 'xdg', 'state');
  const xdgConfig = path.join(agentDir, 'xdg', 'config');
  const opencodeConfigDir = path.join(agentDir, 'opencode-config');

  return {
    XDG_DATA_HOME: xdgShare,
    XDG_STATE_HOME: xdgState,
    XDG_CONFIG_HOME: xdgConfig,
    OPENCODE_CONFIG_DIR: opencodeConfigDir,
  };
}

/** Create per-agent XDG dirs before spawning `opencode serve` (required for session storage). */
export function ensureIsolationDirs(agentDir: string, dataDir?: string): Record<string, string> {
  const env = buildIsolationEnv(agentDir);
  for (const dir of Object.values(env)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  seedOpenCodeDataFromTemplate(env.XDG_DATA_HOME, dataDir ?? getServerEnv().dataDir);
  return env;
}

/** Copy pre-migrated OpenCode data tree from container template (see entrypoint.sh). */
export function seedOpenCodeDataFromTemplate(xdgDataHome: string, dataDir: string): boolean {
  const templateDir = path.join(dataDir, 'opencode-template', 'share-opencode');
  const targetDir = path.join(xdgDataHome, 'opencode');
  if (fs.existsSync(targetDir)) {
    try {
      if (fs.readdirSync(targetDir).length > 0) {
        return false;
      }
    } catch {
      return false;
    }
  }
  if (!fs.existsSync(templateDir)) {
    return false;
  }
  fs.cpSync(templateDir, targetDir, { recursive: true });
  return true;
}

type OpenCodeServerPhase = 'spawned' | 'migrating' | 'listening' | 'ready';

export async function findFreePort(basePort = 4100, maxAttempts = 100): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = basePort + i;
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`No free port found starting from ${basePort}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isSessionIdle(
  statusMap: Record<string, { type?: string } | undefined>,
  sessionId: string,
): boolean {
  const status = statusMap[sessionId];
  if (!status) {
    return true;
  }
  return status.type !== 'busy' && status.type !== 'retry';
}

/** Batch turn done after task prompt was busy; idle sessions are omitted from GET /session/status. */
export function isBatchTurnComplete(
  statusMap: Record<string, { type?: string } | undefined>,
  sessionId: string,
  taskPromptBusySeen: boolean,
): boolean {
  return taskPromptBusySeen && isSessionIdle(statusMap, sessionId);
}

export function createOpenCodeSessionRunner(options: {
  cwd: string;
  agentDir: string;
  port?: number;
  spawn?: SpawnFn;
  opencodeBin?: string;
  onServerOutput?: (chunk: string) => void;
  onDebugLog?: (line: string) => void;
  portBase?: number;
}): OpenCodeSessionRunner {
  const spawnImpl = options.spawn || spawn;
  const opencodeBin = options.opencodeBin || getOpencodeBin();
  const isolationEnv = ensureIsolationDirs(options.agentDir);
  let port = options.port || 0;
  let baseUrl = '';
  let child: ChildProcess | null = null;
  let sseAbort: AbortController | null = null;
  let ssePromise: Promise<void> | null = null;
  const serverOutputTail: string[] = [];
  const SERVER_OUTPUT_TAIL_LINES = 40;
  let serverPhase: OpenCodeServerPhase = 'spawned';
  let migrationLogged = false;
  let dataSeededFromTemplate = false;

  function updateServerPhaseFromLine(line: string): void {
    const lower = line.toLowerCase();
    if (
      lower.includes('database migration') ||
      lower.includes('sqlite-migration') ||
      lower.includes('performing one time')
    ) {
      if (serverPhase === 'spawned') {
        serverPhase = 'migrating';
      }
      if (!migrationLogged) {
        migrationLogged = true;
        debugLog(
          'OpenCode serve phase=migrating (first-run SQLite migration in isolated data dir; may take several minutes)',
        );
      }
    }
    if (lower.includes('database migration complete')) {
      debugLog('OpenCode serve: database migration finished (waiting for HTTP endpoints)');
    }
    if (lower.includes('server listening on')) {
      serverPhase = 'listening';
      debugLog(`OpenCode serve phase=listening line=${line.trim()}`);
    }
  }

  function recordServerOutput(chunk: string): void {
    options.onServerOutput?.(chunk);
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (!trimmed) {
        continue;
      }
      updateServerPhaseFromLine(trimmed);
      serverOutputTail.push(trimmed);
      if (serverOutputTail.length > SERVER_OUTPUT_TAIL_LINES) {
        serverOutputTail.shift();
      }
    }
  }

  function dumpServerOutput(context: string): void {
    if (serverOutputTail.length === 0) {
      debugLog(`OpenCode serve output (${context}): (empty)`);
      return;
    }
    debugLog(`OpenCode serve output (${context}, last ${serverOutputTail.length} line(s)):`);
    for (const line of serverOutputTail) {
      debugLog(`  serve> ${line}`);
    }
  }

  async function resolvePort(): Promise<number> {
    if (port > 0) {
      return port;
    }
    const base = options.portBase ?? getServerEnv().opencodePortBase;
    port = await findFreePort(Number.isFinite(base) ? base : 4100);
    return port;
  }

  function debugLog(line: string): void {
    options.onDebugLog?.(line);
  }

  async function startServer(): Promise<void> {
    const resolvedPort = await resolvePort();
    baseUrl = `http://127.0.0.1:${resolvedPort}`;
    const serveArgs = ['serve', '--hostname', '127.0.0.1', '--port', String(resolvedPort)];

    const templateDir = path.join(getServerEnv().dataDir, 'opencode-template', 'share-opencode');
    dataSeededFromTemplate = fs.existsSync(path.join(isolationEnv.XDG_DATA_HOME, 'opencode'));
    debugLog(
      `OpenCode template available=${fs.existsSync(templateDir)} dataSeeded=${dataSeededFromTemplate} xdgDataHome=${isolationEnv.XDG_DATA_HOME}`,
    );

    for (const [key, value] of Object.entries(isolationEnv)) {
      debugLog(
        `OpenCode isolation: ${key}=${value} exists=${fs.existsSync(value)} writable=${dirWritable(value)}`,
      );
    }

    try {
      const versionProc = spawnImpl(opencodeBin, ['--version'], {
        env: { ...process.env, ...isolationEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const version = await new Promise<string>((resolve) => {
        let out = '';
        versionProc.stdout?.on('data', (chunk: Buffer) => {
          out += chunk.toString();
        });
        versionProc.on('close', () => resolve(out.trim() || '(unknown)'));
        versionProc.on('error', () => resolve('(version check failed)'));
      });
      debugLog(`OpenCode CLI version: ${version}`);
    } catch {
      debugLog('OpenCode CLI version: (check failed)');
    }

    for (const line of collectOpenCodeSpawnDebug({
      opencodeBin,
      cwd: options.cwd,
      args: serveArgs,
      extraEnv: isolationEnv,
    })) {
      debugLog(line);
    }

    await new Promise<void>((resolve, reject) => {
      child = spawnImpl(opencodeBin, serveArgs, {
        cwd: options.cwd,
        env: { ...process.env, ...isolationEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        recordServerOutput(chunk.toString());
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        recordServerOutput(chunk.toString());
      });

      child.on('spawn', () => {
        debugLog(`OpenCode serve process spawned pid=${child?.pid ?? 'unknown'}`);
        resolve();
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        const code = err.code ? ` code=${err.code}` : '';
        debugLog(`OpenCode serve spawn failed: ${err.message}${code}`);
        options.onServerOutput?.(`OpenCode serve error: ${err.message}\n`);
        reject(err);
      });

      child.on('exit', (code, signal) => {
        if (code !== 0 || signal) {
          debugLog(
            `OpenCode serve process exited code=${code ?? 'null'} signal=${signal ?? 'null'}`,
          );
        }
      });
    });
  }

  async function waitForServerReady(timeoutMs?: number): Promise<void> {
    const envTimeout = getServerEnv().opencodeStartupTimeoutMs;
    let deadline = Date.now() + (timeoutMs ?? envTimeout);
    let attempts = 0;
    let lastError = 'unknown';
    let lastHealth: string | undefined;
    const startedAt = Date.now();

    debugLog(
      `OpenCode waiting for server ready via GET /path url=${baseUrl}/path timeoutMs=${timeoutMs ?? envTimeout} seeded=${dataSeededFromTemplate}`,
    );

    while (Date.now() < deadline) {
      attempts += 1;
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

      if (serverPhase === 'migrating' && deadline - Date.now() < 120_000) {
        deadline += 300_000;
        debugLog(
          `OpenCode extending startup timeout by 300s (DB migration still in progress, elapsed=${elapsedSec}s)`,
        );
      }

      try {
        const pathRes = await fetch(`${baseUrl}/path`);
        const pathText = await pathRes.text();
        if (pathRes.ok) {
          serverPhase = 'ready';
          debugLog(
            `OpenCode server ready after ${attempts} attempt(s) elapsed=${elapsedSec}s phase=${serverPhase} path=${pathText.slice(0, 400)}`,
          );
          return;
        }
        lastError = `GET /path HTTP ${pathRes.status} body=${pathText.slice(0, 200)}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      try {
        const healthRes = await fetch(`${baseUrl}/global/health`);
        if (healthRes.ok) {
          const body = (await healthRes.json()) as { healthy?: boolean; version?: string };
          lastHealth = `healthy=${String(body.healthy)} version=${body.version ?? 'unknown'}`;
        } else {
          lastHealth = `HTTP ${healthRes.status}`;
        }
      } catch (err) {
        lastHealth = err instanceof Error ? err.message : String(err);
      }

      const shouldLog =
        attempts === 1 ||
        attempts % 10 === 0 ||
        (serverPhase === 'migrating' && attempts % 20 === 0);
      if (shouldLog) {
        debugLog(
          `OpenCode server ready pending: attempt=${attempts} elapsed=${elapsedSec}s phase=${serverPhase} lastPathError=${lastError} health=${lastHealth ?? 'unknown'}`,
        );
      }

      await sleep(serverPhase === 'migrating' ? 2000 : 500);
    }

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    debugLog(
      `OpenCode server ready failed after ${attempts} attempt(s) elapsed=${elapsedSec}s phase=${serverPhase} lastError=${lastError}`,
    );
    dumpServerOutput('server ready failed');
    throw new Error(
      `OpenCode server did not become ready within ${Math.round((deadline - startedAt) / 1000)}s (phase=${serverPhase}, last error: ${lastError})`,
    );
  }

  async function createSession(title?: string): Promise<OpenCodeSession> {
    debugLog(`OpenCode creating session title=${title ?? '(none)'} url=${baseUrl}/session`);
    const res = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(title ? { title } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      debugLog(`OpenCode create session failed status=${res.status} body=${text.slice(0, 500)}`);
      dumpServerOutput(`create session failed (${res.status})`);
      throw new Error(`Failed to create OpenCode session (${res.status}): ${text}`);
    }
    const session = (await res.json()) as OpenCodeSession;
    debugLog(
      `OpenCode session ready id=${session.id} directory=${session.directory} version=${session.version}`,
    );
    return session;
  }

  async function sendPromptAsync(sessionId: string, body: OpenCodePromptBody): Promise<void> {
    const textPart = body.parts.find((part) => part.type === 'text');
    const preview = textPart?.text?.slice(0, 80) ?? '';
    debugLog(
      `OpenCode prompt_async session=${sessionId} agent=${body.agent ?? '(default)'} model=${
        body.model ? `${body.model.providerID}/${body.model.modelID}` : '(default)'
      } textPreview=${preview}${preview.length >= 80 ? '…' : ''}`,
    );
    const res = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 204 && !res.ok) {
      const text = await res.text();
      debugLog(`OpenCode prompt_async failed status=${res.status} body=${text.slice(0, 500)}`);
      throw new Error(`Failed to send prompt (${res.status}): ${text}`);
    }
    debugLog(`OpenCode prompt_async accepted session=${sessionId} status=${res.status}`);
  }

  async function replyPermission(
    requestId: string,
    reply: 'once' | 'always' | 'reject' = 'once',
  ): Promise<void> {
    const res = await fetch(`${baseUrl}/permission/${encodeURIComponent(requestId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply }),
    });
    if (!res.ok) {
      const text = await res.text();
      debugLog(
        `OpenCode permission reply failed requestId=${requestId} status=${res.status} body=${text.slice(0, 500)}`,
      );
      throw new Error(`Failed to reply to permission (${res.status}): ${text}`);
    }
    debugLog(`OpenCode permission replied requestId=${requestId} reply=${reply}`);
  }

  async function abort(sessionId: string): Promise<void> {
    try {
      await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/abort`, {
        method: 'POST',
      });
    } catch {
      // best effort
    }
  }

  function subscribeEvents(onEvent: (event: OpenCodeServerEvent) => void): OpenCodeEventSubscription {
    sseAbort = new AbortController();
    const signal = sseAbort.signal;
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((err: Error) => void) | undefined;

    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    ssePromise = (async () => {
      debugLog(`OpenCode SSE connecting url=${baseUrl}/event`);
      const res = await fetch(`${baseUrl}/event`, {
        headers: { Accept: 'text/event-stream' },
        signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        debugLog(
          `OpenCode SSE connection failed status=${res.status} body=${body.slice(0, 500)}`,
        );
        dumpServerOutput(`SSE connection failed (${res.status})`);
        const err = new Error(
          body
            ? `SSE connection failed (${res.status}): ${body.slice(0, 200)}`
            : `SSE connection failed (${res.status})`,
        );
        rejectReady?.(err);
        throw err;
      }

      debugLog(`OpenCode SSE connected url=${baseUrl}/event`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let connected = false;

      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const parsed = parseSseDataLine(line);
          if (parsed) {
            if (!connected && parsed.type === 'server.connected') {
              connected = true;
              debugLog('OpenCode SSE received server.connected');
              resolveReady?.();
            }
            onEvent(parsed);
          }
        }
      }

      if (!connected && !signal.aborted) {
        const err = new Error('SSE stream ended before server.connected');
        rejectReady?.(err);
        throw err;
      }
    })().catch((err) => {
      if (!signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog(`OpenCode SSE error: ${message}`);
        recordServerOutput(`SSE error: ${message}\n`);
        rejectReady?.(err instanceof Error ? err : new Error(message));
      }
    });

    return {
      ready,
      unsubscribe: () => {
        sseAbort?.abort();
      },
    };
  }

  async function dispose(): Promise<void> {
    debugLog('OpenCode serve disposing');
    sseAbort?.abort();
    if (ssePromise) {
      await ssePromise.catch(() => undefined);
    }

    if (child && !child.killed) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child && !child.killed) {
            child.kill('SIGKILL');
          }
          resolve();
        }, 5000);
        child?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    child = null;
  }

  return {
    get port() {
      return port;
    },
    get baseUrl() {
      return baseUrl;
    },
    startServer,
    waitForServerReady,
    createSession,
    sendPromptAsync,
    replyPermission,
    abort,
    subscribeEvents,
    dispose,
  };
}

function dirWritable(dirPath: string): boolean {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
