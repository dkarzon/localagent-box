import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { handleUnattendedRequest } from './session-orchestrator';

function fakeRunner() {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      replyPermission: async (sessionId: string, requestId: string, reply?: string) => {
        calls.push(`reply ${sessionId} ${requestId} ${reply}`);
      },
      cancelForm: async (sessionId: string, formId: string) => {
        calls.push(`cancel ${sessionId} ${formId}`);
      },
    },
  };
}

const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-orch-')), 'agent.log');
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('handleUnattendedRequest', () => {
  it('auto-approves permission requests on their session when enabled', async () => {
    const { runner, calls } = fakeRunner();
    handleUnattendedRequest(
      { type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_1', action: 'shell' } },
      runner,
      logPath,
      true,
    );
    await flush();
    assert.deepEqual(calls, ['reply ses_1 per_1 once']);
  });

  it('leaves permission requests alone when auto-approve is off', async () => {
    const { runner, calls } = fakeRunner();
    handleUnattendedRequest(
      { type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_1' } },
      runner,
      logPath,
      false,
    );
    await flush();
    assert.deepEqual(calls, []);
  });

  it('cancels forms so an unattended turn never blocks on a question', async () => {
    const { runner, calls } = fakeRunner();
    handleUnattendedRequest(
      { type: 'form.created', properties: { form: { id: 'frm_1', sessionID: 'ses_1', title: 'Pick' } } },
      runner,
      logPath,
      false,
    );
    await flush();
    assert.deepEqual(calls, ['cancel ses_1 frm_1']);
  });
});
