import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  formatBootstrapSummaryBlock,
  isAgentRunTimedOut,
  parseTimeoutMs,
  resolveAgentRunStartedAtMs,
  resolveOpencodeExecutable,
} from './runner';

describe('parseTimeoutMs', () => {
  it('parses a positive integer', () => {
    assert.equal(parseTimeoutMs(3600000), 3600000);
  });

  it('falls back when the value is missing or invalid', () => {
    assert.equal(parseTimeoutMs(undefined, 1000), 1000);
    assert.equal(parseTimeoutMs('nope', 1000), 1000);
  });
});

describe('resolveAgentRunStartedAtMs', () => {
  it('uses startedAt (worker start), not a create/queue timestamp', () => {
    const startedAt = '2026-08-17T02:00:00.000Z';
    assert.equal(resolveAgentRunStartedAtMs(startedAt, 0), Date.parse(startedAt));
  });

  it('falls back when startedAt is missing (still not createdAt)', () => {
    const fallback = 1_700_000_000_000;
    assert.equal(resolveAgentRunStartedAtMs(null, fallback), fallback);
    assert.equal(resolveAgentRunStartedAtMs(undefined, fallback), fallback);
    assert.equal(resolveAgentRunStartedAtMs('not-a-date', fallback), fallback);
  });
});

describe('formatBootstrapSummaryBlock', () => {
  it('returns null for skipped or missing bootstrap states', () => {
    assert.equal(formatBootstrapSummaryBlock(null), null);
    assert.equal(formatBootstrapSummaryBlock(undefined), null);
    assert.equal(formatBootstrapSummaryBlock({ status: 'skipped' }), null);
  });

  it('renders the workspace-ready block for a completed bootstrap', () => {
    const block = formatBootstrapSummaryBlock({
      status: 'completed',
      command: 'npm ci',
      profiles: ['nodejs'],
      source: 'detect',
      durationMs: 38_000,
      exitCode: 0,
      cacheHit: true,
    });
    assert.ok(block);
    assert.match(block, /^## Workspace ready \(host\)$/m);
    assert.match(block, /- Setup: npm ci \(completed in 38s, cache hit\)/);
    assert.match(block, /- Profiles: nodejs/);
  });

  it('renders a failure block with command, error, and output tail for a failed bootstrap', () => {
    const block = formatBootstrapSummaryBlock({
      status: 'failed',
      command: 'npm ci',
      source: 'explicit',
      durationMs: 5_000,
      exitCode: 1,
      outputTail: 'npm ERR! Missing script: "prepare"',
      error: 'Bootstrap failed: `npm ci` exited 1',
    });
    assert.ok(block);
    assert.match(block, /^## Workspace bootstrap failed \(host\)$/m);
    assert.match(block, /failed with exit code 1/);
    assert.match(block, /- Setup: npm ci/);
    assert.match(block, /- Error: Bootstrap failed: `npm ci` exited 1/);
    assert.match(block, /npm ERR! Missing script: "prepare"/);
    assert.match(block, /attempt to fix the workspace environment/);
    assert.doesNotMatch(block, /- Verify:/);
  });

  it('renders the failed verify command in the failure block', () => {
    const block = formatBootstrapSummaryBlock({
      status: 'failed',
      command: 'npm ci',
      verifyCommand: 'npm test',
      source: 'explicit',
      exitCode: 0,
      verifyExitCode: 2,
      outputTail: 'tests broke',
      error: 'Bootstrap verify failed: `npm test` exited 2',
    });
    assert.ok(block);
    assert.match(block, /- Verify: failed \(`npm test` exited 2\)/);
    assert.match(block, /tests broke/);
  });
});

describe('isAgentRunTimedOut', () => {
  const timeoutMs = 3600_000;

  it('ignores time spent queued before startedAt', () => {
    const createdAtMs = Date.parse('2026-08-17T00:00:00.000Z');
    const startedAtMs = Date.parse('2026-08-17T01:50:00.000Z');
    const nowMs = Date.parse('2026-08-17T01:55:00.000Z');
    assert.equal(nowMs - createdAtMs > timeoutMs, true);
    assert.equal(isAgentRunTimedOut(startedAtMs, timeoutMs, nowMs), false);
  });

  it('times out once running time exceeds AGENT_TIMEOUT', () => {
    const startedAtMs = Date.parse('2026-08-17T01:00:00.000Z');
    const nowMs = Date.parse('2026-08-17T02:00:01.000Z');
    assert.equal(isAgentRunTimedOut(startedAtMs, timeoutMs, nowMs), true);
  });
});

describe('resolveOpencodeExecutable', () => {
  const j = path.win32.join;
  const npm = j('C:', 'Users', 'me', 'AppData', 'Roaming', 'npm');
  const tools = j('C:', 'tools');
  const shim = j(npm, 'opencode.cmd');
  const v2Exe = j(npm, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
  const win = (files: string[], pathEnv = `${j('C:', 'Windows')};${npm}`) => ({
    platform: 'win32' as const,
    pathEnv,
    exists: (p: string) => files.includes(p),
  });

  it('resolves an npm .cmd shim to the v2 package exe on Windows', () => {
    assert.equal(resolveOpencodeExecutable('opencode', win([shim, v2Exe])), v2Exe);
  });

  it('prefers a real opencode.exe on PATH', () => {
    const onPath = j(tools, 'opencode.exe');
    assert.equal(resolveOpencodeExecutable('opencode', win([onPath, shim, v2Exe], `${tools};${npm}`)), onPath);
  });

  it('leaves explicit paths, unresolvable names and non-Windows hosts alone', () => {
    const explicit = j('D:', 'oc', 'opencode.exe');
    assert.equal(resolveOpencodeExecutable(explicit, win([])), explicit);
    assert.equal(resolveOpencodeExecutable('opencode', win([])), 'opencode');
    assert.equal(resolveOpencodeExecutable('opencode', { platform: 'linux', exists: () => true }), 'opencode');
  });
});
