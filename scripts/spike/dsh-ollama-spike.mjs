#!/usr/bin/env node
/**
 * Phase 0 spike: prove DeepSeek Harness can drive Ollama from a disposable workspace
 * using `dsh --profile sdk` (stdio JSON-RPC) and complete a tool-using turn.
 *
 * Env:
 *   OLLAMA_BASE_URL  — default http://127.0.0.1:11434
 *   DSH_MODEL        — Ollama model id (default llama3.2)
 *   DSH_HOME         — optional; defaults to ./spike-runs/<timestamp>
 *   SPIKE_SKIP_OLLAMA_PROBE — set to 1 to skip preflight GET /api/tags
 *   SPIKE_TIMEOUT_MS — overall run timeout (default 600000)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { bootstrapDshProfile } from './lib/bootstrap-dsh-profile.mjs';
import { resolveDshBin } from './lib/resolve-dsh-bin.mjs';
import { writeDshCredentialsFile } from './lib/write-dsh-credentials.mjs';
import { buildDshSettingsYaml, normalizeOllamaBaseUrl } from './lib/write-dsh-settings.mjs';
import { warmupDshHome } from './lib/warmup-dsh-home.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPIKE_ROOT = path.resolve(__dirname);
const RUNS_DIR = path.join(SPIKE_ROOT, 'spike-runs');
const FIXTURES_DIR = path.join(SPIKE_ROOT, 'fixtures');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const DSH_MODEL = process.env.DSH_MODEL || 'llama3.2:3b';
const SPIKE_TIMEOUT_MS = Number(process.env.SPIKE_TIMEOUT_MS || 600_000);
const DSH_INIT_TIMEOUT_MS = Number(process.env.DSH_INIT_TIMEOUT_MS || 120_000);
const DSH_REQUEST_TIMEOUT_MS = Number(process.env.DSH_REQUEST_TIMEOUT_MS || 300_000);

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function fail(message) {
  console.error(`SPIKE FAILED: ${message}`);
  process.exit(1);
}

async function probeOllama(baseUrl) {
  if (process.env.SPIKE_SKIP_OLLAMA_PROBE === '1') {
    log('Skipping Ollama probe (SPIKE_SKIP_OLLAMA_PROBE=1)');
    return;
  }

  const tagsUrl = `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/tags`;
  log(`Probing Ollama at ${tagsUrl}`);
  const res = await fetch(tagsUrl, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    fail(`Ollama probe failed: HTTP ${res.status} from ${tagsUrl}`);
  }
  const body = await res.json();
  const names = (body.models || []).map((m) => m.name || m.model).filter(Boolean);
  log(`Ollama reachable; ${names.length} model(s) listed: ${names.slice(0, 5).join(', ') || '(none)'}`);
  const hasModel = names.some((n) => n === DSH_MODEL || n.startsWith(`${DSH_MODEL}:`));
  if (!hasModel) {
    const msg =
      `Model ${JSON.stringify(DSH_MODEL)} not found in Ollama tags. ` +
      `Available: ${names.slice(0, 8).join(', ') || '(none)'}. ` +
      'Set DSH_MODEL to a pulled model or run: ollama pull <model>';
    if (process.env.SPIKE_ALLOW_MISSING_MODEL === '1') {
      log(`Warning: ${msg}`);
    } else {
      fail(msg);
    }
  }
}

function prepareRunDirs() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dshHome = process.env.DSH_HOME
    ? path.resolve(process.env.DSH_HOME)
    : path.join(RUNS_DIR, '_dsh-home');
  const workspaceDir = process.env.SPIKE_WORKSPACE
    ? path.resolve(process.env.SPIKE_WORKSPACE)
    : path.join(RUNS_DIR, stamp, 'workspace');

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  return { dshHome, workspaceDir };
}

function writeDshHomeConfig(dshHome) {
  const settingsYaml = buildDshSettingsYaml(OLLAMA_BASE_URL, DSH_MODEL, { unattended: true });
  fs.writeFileSync(path.join(dshHome, 'settings.yaml'), settingsYaml, 'utf8');
  writeDshCredentialsFile(dshHome);
}

function summarizeEvents(events) {
  const counts = {};
  for (const event of events) {
    const type = event?.type || 'unknown';
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function findTurnEnd(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'turn/end') {
      return event;
    }
  }
  return null;
}

function findToolCalls(events) {
  return events.filter((e) => e?.type === 'tool/call');
}

function writeFixtureSample(notifications, events) {
  const fixturePath = path.join(FIXTURES_DIR, 'sample-notifications.jsonl');
  const toolNotifications = notifications.filter((n) => {
    if (n.method !== 'session.event') {
      return false;
    }
    const eventType = n.params?.event?.type;
    return eventType === 'tool/call' || eventType === 'tool/result' || eventType === 'turn/end';
  });

  const lines = toolNotifications.slice(0, 20).map((n) => JSON.stringify(n));
  fs.writeFileSync(fixturePath, `${lines.join('\n')}\n`, 'utf8');
  log(`Wrote fixture sample (${lines.length} lines) to ${fixturePath}`);

  const reportPath = path.join(FIXTURES_DIR, 'last-run-summary.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        eventCounts: summarizeEvents(events),
        turnEnd: findTurnEnd(events),
        toolCallCount: findToolCalls(events).length,
        notificationCount: notifications.length,
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function main() {
  const startedAt = Date.now();
  log('DSH + Ollama spike starting');
  log(`Packages: @deepseek-ai/dsh + @deepseek-ai/dsh-sdk-client (see package.json)`);
  log(`OLLAMA_BASE_URL=${OLLAMA_BASE_URL} DSH_MODEL=${DSH_MODEL}`);

  await probeOllama(OLLAMA_BASE_URL);

  const dshBin = resolveDshBin();
  log(`Resolved dsh binary: ${dshBin}`);

  const { dshHome, workspaceDir } = prepareRunDirs();
  log(`DSH_HOME=${dshHome}`);
  log(`Workspace=${workspaceDir}`);

  await bootstrapDshProfile({ dshBin, dshHome, log });
  writeDshHomeConfig(dshHome);
  await warmupDshHome({ dshBin, dshHome, cwd: workspaceDir, log });

  const childEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || 'ollama',
  };

  const notifications = [];
  const sessionId = process.env.SPIKE_SESSION_ID || `spike-${Date.now()}`;
  const prompt =
    process.env.SPIKE_PROMPT ||
    'Create a file named exactly spike.txt (no spaces in the filename) in the workspace root with exactly the single word hello. Use your file write tool; do not ask questions.';

  const initStartedAt = Date.now();
  /** @type {import('@deepseek-ai/dsh-sdk-client').DeepSeekHarness | null} */
  let harness = null;

  const timeout = setTimeout(() => {
    fail(`Timed out after ${SPIKE_TIMEOUT_MS}ms`);
  }, SPIKE_TIMEOUT_MS);

  const initTimeout = setTimeout(() => {
    fail(
      `DSH initialize did not complete within ${DSH_INIT_TIMEOUT_MS}ms. ` +
        'Common causes: broken sdk profile (delete spike-runs/_dsh-home/profiles/sdk), ' +
        'pnpm missing for bootstrap, or DSH hanging on Windows (try docker compose).',
    );
  }, DSH_INIT_TIMEOUT_MS);

  try {
    harness = new DeepSeekHarness({
      launch: {
        command: process.execPath,
        args: [dshBin, '--profile', 'sdk'],
        cwd: workspaceDir,
        env: childEnv,
        requestTimeoutMs: DSH_REQUEST_TIMEOUT_MS,
      },
      cwd: workspaceDir,
      provider: 'ollama',
      model: DSH_MODEL,
      maxTokens: 8192,
    });

    log('Starting DSH runtime (profile=sdk)…');
    const maxInitAttempts = Number(process.env.DSH_INIT_ATTEMPTS || 5);
    let initError = null;
    for (let attempt = 1; attempt <= maxInitAttempts; attempt += 1) {
      try {
        await harness.start();
        initError = null;
        break;
      } catch (err) {
        initError = err;
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('no adapter registered') || attempt === maxInitAttempts) {
          throw err;
        }
        log(
          `DSH initialize attempt ${attempt}/${maxInitAttempts} failed (settings not ready); retrying in 2s…`,
        );
        await harness.close().catch(() => {});
        harness = new DeepSeekHarness({
          launch: {
            command: process.execPath,
            args: [dshBin, '--profile', 'sdk'],
            cwd: workspaceDir,
            env: childEnv,
            requestTimeoutMs: DSH_REQUEST_TIMEOUT_MS,
          },
          cwd: workspaceDir,
          provider: 'ollama',
          model: DSH_MODEL,
          maxTokens: 8192,
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    if (initError) {
      throw initError;
    }
    clearTimeout(initTimeout);
    const initMs = Date.now() - initStartedAt;
    log(`DSH initialize complete in ${initMs}ms`);

    log('Sending spike prompt…');
    const runStartedAt = Date.now();
    const result = await harness.run(prompt, {
      sessionId,
      onNotification: (notification) => {
        notifications.push(notification);
        if (notification.method === 'session.status') {
          const status = notification.params?.status;
          if (status) {
            log(`session.status: ${status}`);
          }
        }
      },
    });
    const runMs = Date.now() - runStartedAt;
    log(`Run settled in ${runMs}ms; sessionId=${result.sessionId}`);

    const eventCounts = summarizeEvents(result.events);
    log(`Event counts: ${JSON.stringify(eventCounts)}`);

    const turnEnd = findTurnEnd(result.events);
    if (!turnEnd) {
      fail('No turn/end event in session log');
    }
    const reason = turnEnd.data?.reason;
    const reasonKind = reason && typeof reason === 'object' ? reason.kind : String(reason);
    log(`turn/end reason: ${JSON.stringify(reason)}`);
    if (reasonKind !== 'completed') {
      fail(`Expected turn/end reason completed, got ${reasonKind}`);
    }

    const toolCalls = findToolCalls(result.events);
    if (toolCalls.length === 0) {
      fail('No tool/call events — model did not invoke tools');
    }
    log(`tool/call count: ${toolCalls.length}`);
    log(`First tool call: ${JSON.stringify(toolCalls[0]).slice(0, 400)}`);

    const targetFile = path.join(workspaceDir, 'spike.txt');
    let content = '';
    if (fs.existsSync(targetFile)) {
      content = fs.readFileSync(targetFile, 'utf8').trim();
    } else {
      const candidates = fs
        .readdirSync(workspaceDir)
        .filter((name) => /spike\.txt$/i.test(name.trim()));
      if (candidates.length === 0) {
        fail(`Expected spike.txt in ${workspaceDir} after run`);
      }
      const found = candidates[0];
      log(`Warning: model wrote ${JSON.stringify(found)} instead of spike.txt`);
      content = fs.readFileSync(path.join(workspaceDir, found), 'utf8').trim();
    }
    log(`spike.txt content: "${content}"`);
    if (!content.toLowerCase().includes('hello')) {
      fail(`spike.txt does not contain "hello" (got: ${JSON.stringify(content)})`);
    }

    writeFixtureSample(notifications, result.events);

    log('---');
    log('SPIKE PASSED');
    log(`Final response (truncated): ${result.finalResponse.slice(0, 500)}`);
    log(`Total elapsed: ${Date.now() - startedAt}ms (init=${initMs}ms run=${runMs}ms)`);
    log(`danger-full-access preset: required for unattended tool execution in container`);
    log(`Ollama base URL used: ${normalizeOllamaBaseUrl(OLLAMA_BASE_URL)}`);
  } catch (err) {
    clearTimeout(initTimeout);
    const message = err instanceof Error ? err.message : String(err);
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr) : '';
    fail(`${message}${stderr ? `\nstderr: ${stderr.slice(-2000)}` : ''}`);
  } finally {
    clearTimeout(initTimeout);
    clearTimeout(timeout);
    if (harness) {
      await harness.close().catch(() => {});
    }
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack || err.message : String(err));
});
