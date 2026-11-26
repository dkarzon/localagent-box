import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';
import { createJsonStore } from '../../../lib/json-store';
import type { Agent } from '../../../types';
import { updateAgentRecord } from './agent-state-writer';

function makeStore(status: Agent['status']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-state-writer-'));
  return createJsonStore<{ agents: Agent[] }>(
    path.join(dir, 'agents.json'),
    { agents: [{ agentId: 'agent1', status, turnCount: 0 } as Agent] },
    fs,
  );
}

describe('updateAgentRecord', () => {
  it('never moves a record out of cancelled, but applies the rest of the patch', () => {
    const store = makeStore('cancelled');
    updateAgentRecord(store, 'agent1', { status: 'repairing', turnCount: 2 });
    const agent = store.load().agents[0];
    assert.equal(agent.status, 'cancelled');
    assert.equal(agent.turnCount, 2);
  });

  it('applies status changes for a run that is not cancelled', () => {
    const store = makeStore('processing');
    updateAgentRecord(store, 'agent1', { status: 'verifying' });
    assert.equal(store.load().agents[0].status, 'verifying');
  });
});
