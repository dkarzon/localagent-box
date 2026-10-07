import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatBootstrapSummaryBlock,
  isAgentRunTimedOut,
  parseTimeoutMs,
  resolveAgentRunStartedAtMs,
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
