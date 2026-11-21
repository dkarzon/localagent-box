import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSmokeArgs } from '../../entrypoints/smoke';
import {
  SMOKE_TOKEN,
  emptyObservations,
  evaluateTurnChecks,
  observeSmokeEvent,
  type SmokeCheck,
} from './smoke-test';
import { createOpenCodeV2EventAdapter, type OpenCodeV2Event } from './v2-event-adapter';

const SID = 'ses_smoke';
const MSG = 'msg_1';
const ev = (type: string, data: Record<string, unknown>): OpenCodeV2Event => ({ type, data, created: 1 });

const goodTurn: OpenCodeV2Event[] = [
  ev('session.execution.started', { sessionID: SID }),
  ev('session.step.started', { sessionID: SID, assistantMessageID: MSG, agent: 'build', model: { id: 'm', providerID: 'ollama' } }),
  ev('session.tool.input.started', { sessionID: SID, assistantMessageID: MSG, id: 't1', name: 'write' }),
  ev('session.tool.called', { sessionID: SID, assistantMessageID: MSG, id: 't1', input: {}, executed: true }),
  ev('session.tool.success', { sessionID: SID, assistantMessageID: MSG, id: 't1', content: [], executed: true }),
  ev('session.text.delta', { sessionID: SID, assistantMessageID: MSG, ordinal: 0, delta: 'DONE' }),
  ev('session.text.ended', { sessionID: SID, assistantMessageID: MSG, ordinal: 0, text: 'DONE' }),
  ev('session.step.ended', { sessionID: SID, assistantMessageID: MSG, finish: 'stop', cost: 0, tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ev('session.execution.succeeded', { sessionID: SID }),
];

function observe(events: OpenCodeV2Event[]) {
  const adapter = createOpenCodeV2EventAdapter();
  const obs = emptyObservations();
  for (const e of events) for (const internal of adapter.translate(e)) observeSmokeEvent(obs, internal);
  return obs;
}

const statusOf = (checks: SmokeCheck[], id: string) => checks.find((c) => c.id === id)?.status;

describe('smoke test turn evaluation', () => {
  it('passes every check for a good turn that wrote the file', () => {
    const obs = observe(goodTurn);
    assert.equal(obs.finished, true);
    assert.deepEqual(obs.toolsCompleted, ['write']);
    assert.equal(obs.replyText, 'DONE');
    assert.deepEqual(obs.tokens, { input: 50, output: 5 });
    const checks = evaluateTurnChecks(obs, `${SMOKE_TOKEN}\n`, false);
    assert.deepEqual(
      checks.filter((c) => c.status !== 'pass').map((c) => c.id),
      [],
    );
  });

  it('fails when the file is missing or wrong even if the turn finished', () => {
    const obs = observe(goodTurn);
    assert.equal(statusOf(evaluateTurnChecks(obs, null, false), 'workspace-file'), 'fail');
    assert.equal(statusOf(evaluateTurnChecks(obs, 'nope', false), 'workspace-file'), 'fail');
  });

  it('fails the turn on a provider error and reports the message', () => {
    const obs = observe([
      ev('session.execution.started', { sessionID: SID }),
      ev('session.execution.failed', { sessionID: SID, error: { type: 'provider.auth', message: 'invalid api key' } }),
    ]);
    const checks = evaluateTurnChecks(obs, null, false);
    const finished = checks.find((c) => c.id === 'turn-finished');
    assert.equal(finished?.status, 'fail');
    assert.equal(finished?.detail, 'invalid api key');
    assert.equal(statusOf(checks, 'tool-call'), 'fail');
  });

  it('fails on timeout and only warns for missing usage / reply text', () => {
    const obs = observe([ev('session.execution.started', { sessionID: SID })]);
    const checks = evaluateTurnChecks(obs, null, true);
    assert.equal(checks.find((c) => c.id === 'turn-finished')?.detail, 'timed out');
    assert.equal(statusOf(checks, 'token-usage'), 'warn');
    assert.equal(statusOf(checks, 'reply-text'), 'warn');
  });

  it('ignores an idle status before the turn has started', () => {
    const obs = emptyObservations();
    observeSmokeEvent(obs, { type: 'session.idle', properties: { sessionID: SID } });
    assert.equal(obs.finished, false);
  });
});

describe('parseSmokeArgs', () => {
  it('parses options', () => {
    assert.deepEqual(parseSmokeArgs(['--model', 'qwen3', '--provider', 'openai-compatible', '--timeout', '60', '--keep', '--json']), {
      model: 'qwen3',
      provider: 'openai-compatible',
      serverOnly: false,
      timeoutSec: 60,
      codegraph: false,
      keep: true,
      json: true,
    });
    assert.equal((parseSmokeArgs(['--server-only']) as { serverOnly: boolean }).serverOnly, true);
  });

  it('rejects bad input', () => {
    assert.ok('error' in (parseSmokeArgs(['--model']) as object));
    assert.ok('error' in (parseSmokeArgs(['--timeout', '0']) as object));
    assert.ok('error' in (parseSmokeArgs(['--provider', 'nope']) as object));
    assert.ok('error' in (parseSmokeArgs(['--bogus']) as object));
    assert.equal(parseSmokeArgs(['-h']), 'help');
  });
});
