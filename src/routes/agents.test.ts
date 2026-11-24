import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import type { AgentMessage, ServerContext } from '../types';
import agentsRoute from './agents';

interface CapturedResponse {
  status: number;
  body: unknown;
}

function fakeRequest(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage;
}

function fakeResponse(capture: CapturedResponse): ServerResponse {
  return {
    headersSent: false,
    writeHead: (status: number) => {
      capture.status = status;
    },
    end: (payload?: unknown) => {
      capture.body = payload === undefined ? null : JSON.parse(String(payload));
    },
  } as unknown as ServerResponse;
}

function fakeContext(messages: AgentMessage[]): ServerContext {
  const agentManager = {
    readMessages: () => messages,
    getLastEventSeq: () => 0,
    readEvents: () => [],
  };
  return { agentManager } as unknown as ServerContext;
}

describe('agents route message endpoints', () => {
  it('returns 404 for POST /agents/:id/messages', async () => {
    const capture: CapturedResponse = { status: 0, body: null };
    await agentsRoute.handle(
      fakeRequest('POST', '/api/v1/agents/agent1/messages'),
      fakeResponse(capture),
      fakeContext([]),
    );
    assert.equal(capture.status, 404);
  });

  it('returns 404 for POST /agents/:id/finish', async () => {
    const capture: CapturedResponse = { status: 0, body: null };
    await agentsRoute.handle(
      fakeRequest('POST', '/api/v1/agents/agent1/finish'),
      fakeResponse(capture),
      fakeContext([]),
    );
    assert.equal(capture.status, 404);
  });

  it('returns 404 for POST /agents/:id/commit-outstanding', async () => {
    const capture: CapturedResponse = { status: 0, body: null };
    await agentsRoute.handle(
      fakeRequest('POST', '/api/v1/agents/agent1/commit-outstanding'),
      fakeResponse(capture),
      fakeContext([]),
    );
    assert.equal(capture.status, 404);
  });

  it('still serves GET /agents/:id/messages', async () => {
    const capture: CapturedResponse = { status: 0, body: null };
    const messages: AgentMessage[] = [{ ts: '2026-06-09T00:00:00.000Z', role: 'user', text: 'Refactor auth' }];
    await agentsRoute.handle(
      fakeRequest('GET', '/api/v1/agents/agent1/messages?since=0'),
      fakeResponse(capture),
      fakeContext(messages),
    );
    assert.equal(capture.status, 200);
    assert.deepEqual(capture.body, {
      agentId: 'agent1',
      messages,
      lastEventSeq: 0,
      events: [],
    });
  });
});
