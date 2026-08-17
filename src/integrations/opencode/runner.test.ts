import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
