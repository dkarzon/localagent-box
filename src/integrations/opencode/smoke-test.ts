/**
 * End-to-end smoke test of the OpenCode harness: generated config → `opencode serve` →
 * auth/readiness → SSE + v2 event adapter → session → one real model turn that must write
 * a file. Uses the same runner and config builder as agent runs, in throwaway dirs.
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AppConfig } from '../../types';
import { createOpenCodeConfigService } from '../../services/opencode-config';
import { resolveModelContextLengths } from '../../services/ollama-probe';
import { buildModelRef } from './runner';
import {
  createOpenCodeSessionRunner,
  getAgentOpenCodeConfigDir,
  type OpenCodeServerEvent,
  type OpenCodeSessionRunner,
} from './session-runner';

export const SMOKE_FILE = 'SMOKE.txt';
export const SMOKE_TOKEN = 'localagent-smoke-ok';
export const SMOKE_PROMPT = [
  `Create a file named ${SMOKE_FILE} in the current directory containing exactly this single line: ${SMOKE_TOKEN}`,
  'Use your file writing tool. Do not ask questions. When the file exists, reply with the word DONE.',
].join('\n');

export type SmokeCheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface SmokeCheck {
  id: string;
  label: string;
  status: SmokeCheckStatus;
  detail?: string;
  durationMs?: number;
}

export interface SmokeTestOptions {
  config: AppConfig;
  /** Override `config.opencodeModel`. */
  model?: string;
  /** Stop after the server/session checks — no model turn (no provider needed). */
  serverOnly?: boolean;
  timeoutMs?: number;
  codegraph?: boolean;
  /** Keep the temp workspace / agent dir for inspection. */
  keep?: boolean;
  opencodeBin?: string;
  onProgress?: (check: SmokeCheck) => void;
}

export interface SmokeTestResult {
  ok: boolean;
  checks: SmokeCheck[];
  tempDir: string;
  kept: boolean;
  /** Last lines of `opencode serve` output (for diagnosing failures). */
  serverOutputTail: string[];
}

/** What the event stream told us about the turn. */
export interface SmokeTurnObservations {
  busySeen: boolean;
  finished: boolean;
  errorMessage?: string;
  replyText: string;
  toolsCompleted: string[];
  toolsFailed: string[];
  tokens?: { input: number; output: number };
  permissionsAsked: number;
  formsCancelled: number;
}

export function emptyObservations(): SmokeTurnObservations {
  return {
    busySeen: false,
    finished: false,
    replyText: '',
    toolsCompleted: [],
    toolsFailed: [],
    permissionsAsked: 0,
    formsCancelled: 0,
  };
}

/** Fold one internal (adapter-translated) event into the observations. */
export function observeSmokeEvent(obs: SmokeTurnObservations, event: OpenCodeServerEvent): void {
  const p = event.properties;
  switch (event.type) {
    case 'session.status': {
      const type = (p.status as { type?: string } | undefined)?.type;
      if (type === 'busy' || type === 'retry') obs.busySeen = true;
      if (type === 'idle' && obs.busySeen) obs.finished = true;
      return;
    }
    case 'session.idle':
      if (obs.busySeen) obs.finished = true;
      return;
    case 'session.error': {
      const error = p.error as { message?: string; name?: string } | undefined;
      obs.errorMessage = error?.message ?? error?.name ?? 'session error';
      return;
    }
    case 'message.part.delta':
      if (p.field === 'text' && typeof p.delta === 'string') obs.replyText += p.delta;
      return;
    case 'message.part.updated': {
      const part = p.part as
        | { type?: string; tool?: string; text?: string; state?: { status?: string } }
        | undefined;
      if (part?.type === 'tool') {
        if (part.state?.status === 'completed') obs.toolsCompleted.push(part.tool ?? 'tool');
        if (part.state?.status === 'error') obs.toolsFailed.push(part.tool ?? 'tool');
      } else if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > obs.replyText.length) {
        obs.replyText = part.text;
      }
      return;
    }
    case 'message.updated': {
      const tokens = (p.info as { tokens?: { input?: number; output?: number } } | undefined)?.tokens;
      if (tokens) {
        obs.tokens = {
          input: (obs.tokens?.input ?? 0) + (tokens.input ?? 0),
          output: (obs.tokens?.output ?? 0) + (tokens.output ?? 0),
        };
      }
      return;
    }
    case 'permission.asked':
      obs.permissionsAsked += 1;
      return;
    default:
      return;
  }
}

/** Turn-level checks from the observations plus the file the model was asked to write. */
export function evaluateTurnChecks(
  obs: SmokeTurnObservations,
  fileContent: string | null,
  timedOut: boolean,
): SmokeCheck[] {
  const checks: SmokeCheck[] = [];
  checks.push({
    id: 'turn-started',
    label: 'Turn started (session busy)',
    status: obs.busySeen ? 'pass' : 'fail',
  });
  const uniqueTools = Array.from(new Set(obs.toolsCompleted));
  checks.push({
    id: 'tool-call',
    label: 'Tool call completed',
    status: uniqueTools.length > 0 ? 'pass' : 'fail',
    detail: uniqueTools.length > 0 ? uniqueTools.join(', ') : 'no tool call reached completed',
  });
  if (obs.toolsFailed.length > 0) {
    checks.push({
      id: 'tool-errors',
      label: 'Tool errors',
      status: 'warn',
      detail: obs.toolsFailed.join(', '),
    });
  }
  const reply = obs.replyText.trim();
  checks.push({
    id: 'reply-text',
    label: 'Assistant reply text streamed',
    status: reply ? 'pass' : 'warn',
    detail: reply ? JSON.stringify(reply.slice(0, 60)) : 'no reply text (reasoning-only models can do this)',
  });
  checks.push({
    id: 'token-usage',
    label: 'Token usage reported',
    status: obs.tokens ? 'pass' : 'warn',
    detail: obs.tokens ? `input=${obs.tokens.input} output=${obs.tokens.output}` : 'provider sent no usage',
  });
  if (obs.permissionsAsked > 0 || obs.formsCancelled > 0) {
    checks.push({
      id: 'unattended',
      label: 'Unattended requests handled',
      status: 'warn',
      detail: `${obs.permissionsAsked} permission request(s) auto-approved, ${obs.formsCancelled} form(s) cancelled — config should have allowed these`,
    });
  }
  const finishedOk = obs.finished && !obs.errorMessage && !timedOut;
  checks.push({
    id: 'turn-finished',
    label: 'Turn finished without error',
    status: finishedOk ? 'pass' : 'fail',
    detail: timedOut ? 'timed out' : obs.errorMessage ?? (obs.finished ? undefined : 'session never went idle'),
  });
  const contentOk = fileContent?.trim() === SMOKE_TOKEN;
  checks.push({
    id: 'workspace-file',
    label: `Model wrote ${SMOKE_FILE}`,
    status: contentOk ? 'pass' : 'fail',
    detail:
      fileContent === null
        ? 'file not created'
        : contentOk
          ? undefined
          : `unexpected content ${JSON.stringify(fileContent.slice(0, 60))}`,
  });
  return checks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runSmokeTest(options: SmokeTestOptions): Promise<SmokeTestResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const config: AppConfig = options.model ? { ...options.config, opencodeModel: options.model } : options.config;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `localagent-smoke-${crypto.randomBytes(3).toString('hex')}-`));
  const agentDir = path.join(tempDir, 'agent');
  const workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const checks: SmokeCheck[] = [];
  const serverOutput: string[] = [];
  const debugLines: string[] = [];
  const record = (check: SmokeCheck) => {
    checks.push(check);
    options.onProgress?.(check);
  };
  const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
    const start = Date.now();
    const value = await fn();
    return { value, ms: Date.now() - start };
  };

  let runner: OpenCodeSessionRunner | null = null;
  try {
    // Workspace: a tiny git repo, like a real agent clone.
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# localagent-box smoke test\n');
    try {
      execFileSync('git', ['init', '-q'], { cwd: workspaceDir, stdio: 'ignore' });
    } catch {
      // git missing is not a harness failure; OpenCode works in a plain dir.
    }

    // 1. Config — same builder agent runs use.
    if (!config.opencodeModel?.trim()) {
      record({
        id: 'config',
        label: 'OpenCode config generated',
        status: 'fail',
        detail: 'no model set — pass --model <id>, set OPENCODE_MODEL, or pick a model in Settings',
      });
      return finish();
    }
    const modelRef = buildModelRef(config);
    const configService = createOpenCodeConfigService({ configDir: getAgentOpenCodeConfigDir(agentDir) });
    const written = configService.writeOpenCodeConfig(config, {
      autoApprovePermissions: true,
      disableQuestionTool: true,
      codegraph: options.codegraph ?? false,
      modelContextLengths: await resolveModelContextLengths(config).catch(() => ({})),
    });
    if (!written) {
      record({
        id: 'config',
        label: 'OpenCode config generated',
        status: 'fail',
        detail: `provider "${config.opencodeProvider ?? 'ollama'}" is not configured (set its base URL / API key in Settings)`,
      });
      return finish();
    }
    record({
      id: 'config',
      label: 'OpenCode config generated',
      status: 'pass',
      detail: `model=${written.config.model}`,
    });

    // 2. Server start + authenticated readiness.
    runner = createOpenCodeSessionRunner({
      cwd: workspaceDir,
      agentDir,
      opencodeBin: options.opencodeBin,
      onServerOutput: (chunk) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim()) serverOutput.push(line.trimEnd());
        }
        if (serverOutput.length > 40) serverOutput.splice(0, serverOutput.length - 40);
      },
      onDebugLog: (line) => debugLines.push(line),
    });
    const activeRunner = runner;
    try {
      const started = Date.now();
      await activeRunner.startServer();
      // `startServer` logs `opencode --version`; a v1 binary would never answer /api/info.
      const versionLine = debugLines.find((l) => l.startsWith('OpenCode CLI version:'));
      const version = versionLine?.replace('OpenCode CLI version:', '').trim() ?? 'unknown';
      if (!/(^|\D)2\.\d/.test(version)) {
        record({
          id: 'server',
          label: 'OpenCode v2 binary',
          status: 'fail',
          detail: `got "${version}" from ${options.opencodeBin ?? 'opencode'} — the harness needs @opencode/cli 2.x (set OPENCODE_BIN or reinstall)`,
        });
        return finish();
      }
      await activeRunner.waitForServerReady(60_000);
      record({
        id: 'server',
        label: 'OpenCode server ready (authenticated)',
        status: 'pass',
        detail: version,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      record({ id: 'server', label: 'OpenCode server ready (authenticated)', status: 'fail', detail: describe(err) });
      return finish();
    }

    // 3. Event stream.
    const obs = emptyObservations();
    const subscription = activeRunner.subscribeEvents((event) => {
      observeSmokeEvent(obs, event);
      if (event.type === 'permission.asked') {
        const p = event.properties;
        if (typeof p.id === 'string' && typeof p.sessionID === 'string') {
          void activeRunner.replyPermission(p.sessionID, p.id, 'once').catch(() => undefined);
        }
      }
      if (event.type === 'form.created') {
        const form = event.properties.form as { id?: string; sessionID?: string } | undefined;
        if (form?.id && form.sessionID) {
          obs.formsCancelled += 1;
          void activeRunner.cancelForm(form.sessionID, form.id, 'Smoke test: no user available').catch(() => undefined);
        }
      }
    });
    try {
      const { ms } = await timed(() => subscription.ready);
      record({ id: 'events', label: 'Event stream connected', status: 'pass', durationMs: ms });
    } catch (err) {
      record({ id: 'events', label: 'Event stream connected', status: 'fail', detail: describe(err) });
      return finish();
    }

    // 4. Session.
    let sessionId: string;
    try {
      const { value: session, ms } = await timed(() =>
        activeRunner.createSession('localagent-smoke', { model: modelRef, agent: 'build' }),
      );
      sessionId = session.id;
      const model = session.model ? `${session.model.providerID}/${session.model.id}` : 'default';
      record({ id: 'session', label: 'Session created', status: 'pass', detail: `${session.id} (${model})`, durationMs: ms });
    } catch (err) {
      record({ id: 'session', label: 'Session created', status: 'fail', detail: describe(err) });
      return finish();
    }

    if (options.serverOnly) {
      record({ id: 'turn', label: 'Model turn', status: 'skip', detail: '--server-only' });
      return finish();
    }

    // 5. One real model turn.
    try {
      await activeRunner.sendPromptAsync(sessionId, {
        parts: [{ type: 'text', text: SMOKE_PROMPT }],
        agent: 'build',
        ...(modelRef ? { model: modelRef } : {}),
      });
      record({ id: 'prompt', label: 'Prompt accepted', status: 'pass' });
    } catch (err) {
      record({ id: 'prompt', label: 'Prompt accepted', status: 'fail', detail: describe(err) });
      return finish();
    }

    const turnStart = Date.now();
    let timedOut = false;
    while (!obs.finished && !obs.errorMessage) {
      if (Date.now() - turnStart > timeoutMs) {
        timedOut = true;
        await activeRunner.abort(sessionId);
        break;
      }
      // Polling fallback in case the idle event was missed on the volatile stream.
      if (obs.busySeen) {
        const status = await activeRunner.getSessionStatusMap().catch(() => null);
        if (status && !status[sessionId]) obs.finished = true;
      }
      await sleep(1000);
    }
    const turnMs = Date.now() - turnStart;

    const filePath = path.join(workspaceDir, SMOKE_FILE);
    const fileContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    for (const check of evaluateTurnChecks(obs, fileContent, timedOut)) {
      record(check.id === 'turn-finished' ? { ...check, durationMs: turnMs } : check);
    }
    return finish();
  } catch (err) {
    record({ id: 'unexpected', label: 'Smoke test crashed', status: 'fail', detail: describe(err) });
    return finish();
  }

  async function finish(): Promise<SmokeTestResult> {
    const ok = checks.every((c) => c.status !== 'fail');
    // Nothing to inspect if we failed before the server started (dispose logs a line itself).
    const keep = options.keep || (!ok && debugLines.length > 0);
    await runner?.dispose().catch(() => undefined);
    if (keep) {
      fs.writeFileSync(path.join(tempDir, 'debug.log'), `${debugLines.join('\n')}\n`);
    } else {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return { ok, checks, tempDir, kept: keep, serverOutputTail: serverOutput.slice(-20) };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
