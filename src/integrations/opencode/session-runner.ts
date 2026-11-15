import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import type { ChildProcess } from 'child_process';
import type { SpawnFn } from '../../types';
import { collectOpenCodeSpawnDebug, getOpencodeBin, type OpenCodeModelRef } from './runner';
import { getServerEnv } from '../../config/env';
import { registerChildCleanup } from '../../lib/child-cleanup';
import { createOpenCodeV2EventAdapter, parseV2SseDataLine } from './v2-event-adapter';

/** OpenCode v2 server API (`@opencode/cli` 2.x) — schemas in docs/opencodeapi.v2.json. */

export interface OpenCodeSession {
  id: string;
  projectID?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  location?: { directory?: string };
  title?: string;
  time?: { created: number; updated: number };
}

export interface OpenCodeTextPartInput {
  type: 'text';
  text: string;
}

export interface OpenCodePromptBody {
  parts: OpenCodeTextPartInput[];
  agent?: string;
  model?: OpenCodeModelRef | null;
  messageID?: string;
}

/** Internal (v1-shaped) event — v2 events are translated by `v2-event-adapter.ts`. */
export interface OpenCodeServerEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface OpenCodeEventSubscription {
  unsubscribe: () => void;
  /** Resolves after SSE `server.connected` (or rejects on connection failure). */
  ready: Promise<void>;
}

export type OpenCodePermissionReply = 'once' | 'always' | 'reject';

export interface OpenCodeSessionRunner {
  port: number;
  baseUrl: string;
  startServer: () => Promise<void>;
  /** Wait until authenticated `GET /api/info` succeeds. */
  waitForServerReady: (timeoutMs?: number) => Promise<void>;
  createSession: (
    title?: string,
    options?: { model?: OpenCodeModelRef | null; agent?: string },
  ) => Promise<OpenCodeSession>;
  sendPromptAsync: (sessionId: string, body: OpenCodePromptBody) => Promise<void>;
  replyPermission: (
    sessionId: string,
    requestId: string,
    reply?: OpenCodePermissionReply,
  ) => Promise<void>;
  /** Cancel a pending form (v2 replacement for the question tool). */
  cancelForm: (sessionId: string, formId: string, message?: string) => Promise<void>;
  /** Status map in the shape `isBatchTurnComplete` expects; idle sessions are omitted. */
  getSessionStatusMap: () => Promise<Record<string, { type?: string }>>;
  abort: (sessionId: string) => Promise<void>;
  subscribeEvents: (onEvent: (event: OpenCodeServerEvent) => void) => OpenCodeEventSubscription;
  dispose: () => Promise<void>;
}

/** v2 server HTTP Basic username is fixed. */
export const OPENCODE_SERVER_USERNAME = 'opencode';

export function generateServerPassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function buildBasicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`${OPENCODE_SERVER_USERNAME}:${password}`).toString('base64')}`;
}

export function toV2ModelRef(model: OpenCodeModelRef): { id: string; providerID: string } {
  return { id: model.modelID, providerID: model.providerID };
}

/** `GET /api/session/active` lists running sessions only; map to the legacy busy/idle shape. */
export function toSessionStatusMap(
  active: Record<string, { type?: string } | undefined>,
): Record<string, { type?: string }> {
  const out: Record<string, { type?: string }> = {};
  for (const [id, status] of Object.entries(active)) {
    out[id] = { type: status?.type === 'running' ? 'busy' : status?.type };
  }
  return out;
}

/**
 * Per-agent `opencode.json` dir. Sits at `$XDG_CONFIG_HOME/opencode` so OpenCode finds it
 * via its default config location as well as `OPENCODE_CONFIG_DIR` (undocumented in v2).
 */
export function getAgentOpenCodeConfigDir(agentDir: string): string {
  return path.join(agentDir, 'xdg', 'config', 'opencode');
}

export function buildIsolationEnv(agentDir: string): Record<string, string> {
  const xdgShare = path.join(agentDir, 'xdg', 'share');
  const xdgState = path.join(agentDir, 'xdg', 'state');
  const xdgConfig = path.join(agentDir, 'xdg', 'config');
  const opencodeConfigDir = getAgentOpenCodeConfigDir(agentDir);

  return {
    XDG_DATA_HOME: xdgShare,
    XDG_STATE_HOME: xdgState,
    XDG_CONFIG_HOME: xdgConfig,
    OPENCODE_CONFIG_DIR: opencodeConfigDir,
  };
}

/** Create per-agent XDG dirs before spawning `opencode serve` (v2 bootstraps its DB in ms). */
export function ensureIsolationDirs(agentDir: string): Record<string, string> {
  const env = buildIsolationEnv(agentDir);
  for (const dir of Object.values(env)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return env;
}

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

/** Batch turn done after task prompt was busy; idle sessions are omitted from the status map. */
export function isBatchTurnComplete(
  statusMap: Record<string, { type?: string } | undefined>,
  sessionId: string,
  taskPromptBusySeen: boolean,
): boolean {
  return taskPromptBusySeen && isSessionIdle(statusMap, sessionId);
}

function sameModel(a: OpenCodeModelRef | null | undefined, b: OpenCodeModelRef | null | undefined): boolean {
  return a?.providerID === b?.providerID && a?.modelID === b?.modelID;
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
  /** Override for tests; a random per-run password is generated otherwise. */
  password?: string;
  fetch?: typeof fetch;
}): OpenCodeSessionRunner {
  const spawnImpl = options.spawn || spawn;
  const fetchImpl = options.fetch || fetch;
  const opencodeBin = options.opencodeBin || getOpencodeBin();
  const isolationEnv = ensureIsolationDirs(options.agentDir);
  const password = options.password || generateServerPassword();
  const authHeader = buildBasicAuthHeader(password);
  let port = options.port || 0;
  let baseUrl = '';
  let child: ChildProcess | null = null;
  let unregisterCleanup: (() => void) | null = null;
  let sseAbort: AbortController | null = null;
  let ssePromise: Promise<void> | null = null;
  const serverOutputTail: string[] = [];
  const SERVER_OUTPUT_TAIL_LINES = 40;
  /** Model/agent currently selected on each session, to switch only when a prompt changes them. */
  const sessionSelection = new Map<string, { model?: OpenCodeModelRef | null; agent?: string }>();

  function api(pathname: string, init: RequestInit = {}): Promise<Response> {
    return fetchImpl(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: authHeader,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  async function apiOrThrow(label: string, pathname: string, init: RequestInit = {}): Promise<Response> {
    const res = await api(pathname, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      debugLog(`OpenCode ${label} failed status=${res.status} body=${text.slice(0, 500)}`);
      throw new Error(`OpenCode ${label} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res;
  }

  function recordServerOutput(chunk: string): void {
    // Never surface the server password if OpenCode echoes it.
    const safe = chunk.split(password).join('***');
    options.onServerOutput?.(safe);
    for (const line of safe.split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (!trimmed) {
        continue;
      }
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
    const serverEnv = { ...process.env, ...isolationEnv, OPENCODE_PASSWORD: password };

    for (const [key, value] of Object.entries(isolationEnv)) {
      debugLog(
        `OpenCode isolation: ${key}=${value} exists=${fs.existsSync(value)} writable=${dirWritable(value)}`,
      );
    }

    try {
      const versionProc = spawnImpl(opencodeBin, ['--version'], {
        env: serverEnv,
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
        env: serverEnv,
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
        unregisterCleanup?.();
        unregisterCleanup = registerChildCleanup(dispose);
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
    const deadline = Date.now() + (timeoutMs ?? envTimeout);
    const startedAt = Date.now();
    let attempts = 0;
    let lastError = 'unknown';

    debugLog(`OpenCode waiting for server ready via GET ${baseUrl}/api/info`);

    while (Date.now() < deadline) {
      attempts += 1;
      try {
        // Unauthenticated routes (`/path`, `/global/health`) are served by the web UI and
        // return 200 HTML even before the API is up — only an authed API call proves readiness.
        const res = await api('/api/info');
        if (res.ok) {
          const info = (await res.json()) as { version?: string };
          debugLog(
            `OpenCode server ready after ${attempts} attempt(s) elapsed=${Math.round((Date.now() - startedAt) / 1000)}s version=${info.version ?? 'unknown'}`,
          );
          return;
        }
        lastError = `GET /api/info HTTP ${res.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempts === 1 || attempts % 20 === 0) {
        debugLog(`OpenCode server ready pending: attempt=${attempts} lastError=${lastError}`);
      }
      await sleep(250);
    }

    dumpServerOutput('server ready failed');
    throw new Error(
      `OpenCode server did not become ready within ${Math.round((deadline - startedAt) / 1000)}s (last error: ${lastError})`,
    );
  }

  async function createSession(
    title?: string,
    sessionOptions: { model?: OpenCodeModelRef | null; agent?: string } = {},
  ): Promise<OpenCodeSession> {
    debugLog(`OpenCode creating session title=${title ?? '(none)'} directory=${options.cwd}`);
    let res: Response;
    try {
      res = await apiOrThrow('create session', '/api/session', {
        method: 'POST',
        body: JSON.stringify({
          ...(title ? { title } : {}),
          location: { directory: path.resolve(options.cwd) },
          ...(sessionOptions.model ? { model: toV2ModelRef(sessionOptions.model) } : {}),
          ...(sessionOptions.agent ? { agent: sessionOptions.agent } : {}),
        }),
      });
    } catch (err) {
      dumpServerOutput('create session failed');
      throw err;
    }
    const session = ((await res.json()) as { data: OpenCodeSession }).data;
    sessionSelection.set(session.id, { model: sessionOptions.model, agent: sessionOptions.agent });
    debugLog(
      `OpenCode session ready id=${session.id} directory=${session.location?.directory ?? '(unknown)'} agent=${session.agent ?? '(default)'} model=${session.model ? `${session.model.providerID}/${session.model.id}` : '(default)'}`,
    );
    return session;
  }

  /** v2 prompts carry no model/agent — switch the session first when a prompt asks for another. */
  async function applySelection(sessionId: string, body: OpenCodePromptBody): Promise<void> {
    const current = sessionSelection.get(sessionId) ?? {};
    const sid = encodeURIComponent(sessionId);
    if (body.model && !sameModel(body.model, current.model)) {
      await apiOrThrow('switch model', `/api/session/${sid}/model`, {
        method: 'POST',
        body: JSON.stringify({ model: toV2ModelRef(body.model) }),
      });
      debugLog(`OpenCode session model switched to ${body.model.providerID}/${body.model.modelID}`);
      current.model = body.model;
    }
    if (body.agent && body.agent !== current.agent) {
      await apiOrThrow('switch agent', `/api/session/${sid}/agent`, {
        method: 'POST',
        body: JSON.stringify({ agent: body.agent }),
      });
      debugLog(`OpenCode session agent switched to ${body.agent}`);
      current.agent = body.agent;
    }
    sessionSelection.set(sessionId, current);
  }

  async function sendPromptAsync(sessionId: string, body: OpenCodePromptBody): Promise<void> {
    const text = body.parts.map((part) => part.text).join('\n\n');
    const preview = text.slice(0, 80);
    debugLog(
      `OpenCode prompt session=${sessionId} agent=${body.agent ?? '(default)'} model=${
        body.model ? `${body.model.providerID}/${body.model.modelID}` : '(default)'
      } textPreview=${preview}${preview.length >= 80 ? '…' : ''}`,
    );
    await applySelection(sessionId, body);
    // Returns immediately with the queued user message; the turn streams over SSE.
    const res = await apiOrThrow('prompt', `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text, ...(body.messageID ? { id: body.messageID } : {}) }),
    });
    debugLog(`OpenCode prompt accepted session=${sessionId} status=${res.status}`);
  }

  async function replyPermission(
    sessionId: string,
    requestId: string,
    reply: OpenCodePermissionReply = 'once',
  ): Promise<void> {
    await apiOrThrow(
      'permission reply',
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { method: 'POST', body: JSON.stringify({ decision: reply }) },
    );
    debugLog(`OpenCode permission replied requestId=${requestId} decision=${reply}`);
  }

  async function cancelForm(sessionId: string, formId: string, message?: string): Promise<void> {
    const query = message ? `?message=${encodeURIComponent(message)}` : '';
    await apiOrThrow(
      'form cancel',
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}${query}`,
      { method: 'DELETE' },
    );
    debugLog(`OpenCode form cancelled formId=${formId}`);
  }

  async function getSessionStatusMap(): Promise<Record<string, { type?: string }>> {
    const res = await apiOrThrow('active sessions', '/api/session/active');
    const body = (await res.json()) as { data?: Record<string, { type?: string }> };
    return toSessionStatusMap(body.data ?? {});
  }

  async function abort(sessionId: string): Promise<void> {
    try {
      await api(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST' });
    } catch {
      // best effort
    }
  }

  function subscribeEvents(onEvent: (event: OpenCodeServerEvent) => void): OpenCodeEventSubscription {
    sseAbort = new AbortController();
    const signal = sseAbort.signal;
    const adapter = createOpenCodeV2EventAdapter();
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((err: Error) => void) | undefined;

    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    ssePromise = (async () => {
      debugLog(`OpenCode SSE connecting url=${baseUrl}/api/event`);
      const res = await api('/api/event', {
        headers: { Accept: 'text/event-stream' },
        signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        debugLog(`OpenCode SSE connection failed status=${res.status} body=${body.slice(0, 500)}`);
        dumpServerOutput(`SSE connection failed (${res.status})`);
        const err = new Error(
          body
            ? `SSE connection failed (${res.status}): ${body.slice(0, 200)}`
            : `SSE connection failed (${res.status})`,
        );
        rejectReady?.(err);
        throw err;
      }

      debugLog(`OpenCode SSE connected url=${baseUrl}/api/event`);

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
          const parsed = parseV2SseDataLine(line);
          if (!parsed) {
            continue;
          }
          for (const event of adapter.translate(parsed)) {
            if (!connected && event.type === 'server.connected') {
              connected = true;
              debugLog('OpenCode SSE received server.connected');
              resolveReady?.();
            }
            onEvent(event);
          }
        }
      }

      if (!connected && !signal.aborted) {
        const err = new Error('SSE stream ended before server.connected');
        rejectReady?.(err);
        throw err;
      }
      if (!signal.aborted) {
        // v2's event stream is volatile: events published while disconnected are lost.
        debugLog('OpenCode SSE stream ended unexpectedly');
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

    unregisterCleanup?.();
    unregisterCleanup = null;

    // `child.killed` only means a signal was sent, not that the process
    // exited — use exitCode/signalCode so the SIGKILL fallback actually fires.
    const proc = child;
    const hasExited = (p: ChildProcess) => p.exitCode != null || p.signalCode != null;
    if (proc && !hasExited(proc)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!hasExited(proc)) {
            proc.kill('SIGKILL');
          }
          resolve();
        }, 5000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        proc.kill('SIGTERM');
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
    cancelForm,
    getSessionStatusMap,
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
