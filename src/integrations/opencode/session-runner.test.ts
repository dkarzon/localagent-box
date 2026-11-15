import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { SpawnFn } from '../../types';
import {
  buildBasicAuthHeader,
  createOpenCodeSessionRunner,
  getAgentOpenCodeConfigDir,
  isBatchTurnComplete,
  isSessionIdle,
  toSessionStatusMap,
} from './session-runner';

describe('isSessionIdle', () => {
  it('treats missing session entry as idle', () => {
    assert.equal(isSessionIdle({}, 'sess-1'), true);
  });

  it('treats busy and retry as not idle', () => {
    assert.equal(isSessionIdle({ 'sess-1': { type: 'busy' } }, 'sess-1'), false);
    assert.equal(isSessionIdle({ 'sess-1': { type: 'retry' } }, 'sess-1'), false);
  });
});

describe('isBatchTurnComplete', () => {
  const sessionId = 'sess-abc';

  it('does not complete before task prompt busy', () => {
    assert.equal(isBatchTurnComplete({}, sessionId, false), false);
    assert.equal(isBatchTurnComplete({ [sessionId]: { type: 'busy' } }, sessionId, false), false);
  });

  it('completes when busy was seen and session entry is gone (OpenCode idle)', () => {
    assert.equal(isBatchTurnComplete({}, sessionId, true), true);
  });

  it('completes when busy was seen and status is idle', () => {
    assert.equal(
      isBatchTurnComplete({ [sessionId]: { type: 'idle' } }, sessionId, true),
      true,
    );
  });

  it('does not complete while still busy', () => {
    assert.equal(
      isBatchTurnComplete({ [sessionId]: { type: 'busy' } }, sessionId, true),
      false,
    );
  });
});

describe('toSessionStatusMap', () => {
  it('maps v2 running sessions to busy so isBatchTurnComplete keeps working', () => {
    const map = toSessionStatusMap({ ses_a: { type: 'running' } });
    assert.deepEqual(map, { ses_a: { type: 'busy' } });
    assert.equal(isBatchTurnComplete(map, 'ses_a', true), false);
    assert.equal(isBatchTurnComplete(toSessionStatusMap({}), 'ses_a', true), true);
  });
});

describe('getAgentOpenCodeConfigDir', () => {
  it('lives under XDG_CONFIG_HOME/opencode', () => {
    assert.equal(
      getAgentOpenCodeConfigDir(path.join('agents', 'a1')),
      path.join('agents', 'a1', 'xdg', 'config', 'opencode'),
    );
  });
});

interface Call {
  method: string;
  url: string;
  auth?: string;
  body?: unknown;
}

function fakeSpawn(spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }>): SpawnFn {
  return ((_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    spawned.push({ args, env: opts.env });
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      killed: false,
      pid: 123,
      kill() {
        child.killed = true;
        setImmediate(() => child.emit('exit', 0, null));
        return true;
      },
    });
    setImmediate(() => {
      child.emit('spawn');
      child.emit('close', 0);
    });
    return child;
  }) as unknown as SpawnFn;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function setup(routes: (call: Call) => Response | undefined) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runner-'));
  const calls: Call[] = [];
  const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init.method ?? 'GET',
      url: input.replace('http://127.0.0.1:4555', ''),
      auth: headers.Authorization,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return routes(call) ?? new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const runner = createOpenCodeSessionRunner({
    cwd: agentDir,
    agentDir,
    port: 4555,
    spawn: fakeSpawn(spawned),
    opencodeBin: 'opencode',
    password: 'pw-test',
    fetch: fetchImpl,
  });
  await runner.startServer();
  return { runner, calls, spawned, agentDir };
}

describe('createOpenCodeSessionRunner (v2 API)', () => {
  it('starts serve with OPENCODE_PASSWORD and authenticates every API call', async () => {
    const { runner, calls, spawned } = await setup((c) =>
      c.url === '/api/info' ? json({ version: '2.2.7' }) : undefined,
    );
    await runner.waitForServerReady(2000);
    const serve = spawned.find((s) => s.args[0] === 'serve');
    assert.equal(serve?.env.OPENCODE_PASSWORD, 'pw-test');
    assert.deepEqual(calls.map((c) => c.url), ['/api/info']);
    assert.equal(calls[0].auth, buildBasicAuthHeader('pw-test'));
    await runner.dispose();
  });

  it('keeps waiting while /api/info is not yet authorised/available', async () => {
    let n = 0;
    const { runner } = await setup((c) => {
      if (c.url !== '/api/info') return undefined;
      n += 1;
      return n < 3 ? json({ _tag: 'UnauthorizedError' }, 401) : json({ version: '2.2.7' });
    });
    await runner.waitForServerReady(5000);
    assert.equal(n, 3);
    await runner.dispose();
  });

  it('creates sessions bound to the workspace with a v2 model ref', async () => {
    const { runner, calls, agentDir } = await setup((c) =>
      c.url === '/api/session' ? json({ data: { id: 'ses_1', agent: 'build' } }) : undefined,
    );
    const session = await runner.createSession('agent-1', {
      model: { providerID: 'ollama', modelID: 'qwen3' },
      agent: 'build',
    });
    assert.equal(session.id, 'ses_1');
    assert.deepEqual(calls[0].body, {
      title: 'agent-1',
      location: { directory: path.resolve(agentDir) },
      model: { id: 'qwen3', providerID: 'ollama' },
      agent: 'build',
    });
    await runner.dispose();
  });

  it('switches model only when a prompt asks for a different one', async () => {
    const { runner, calls } = await setup((c) =>
      c.url === '/api/session' ? json({ data: { id: 'ses_1' } }) : c.url.endsWith('/prompt') ? json({ data: {} }) : undefined,
    );
    const qwen = { providerID: 'ollama', modelID: 'qwen3' };
    await runner.createSession('t', { model: qwen, agent: 'build' });
    await runner.sendPromptAsync('ses_1', { parts: [{ type: 'text', text: 'one' }], model: qwen, agent: 'build' });
    await runner.sendPromptAsync('ses_1', {
      parts: [{ type: 'text', text: 'two' }],
      model: { providerID: 'ollama', modelID: 'gemma4' },
      agent: 'build',
    });
    assert.deepEqual(
      calls.slice(1).map((c) => [c.method, c.url, c.body]),
      [
        ['POST', '/api/session/ses_1/prompt', { text: 'one' }],
        ['POST', '/api/session/ses_1/model', { model: { id: 'gemma4', providerID: 'ollama' } }],
        ['POST', '/api/session/ses_1/prompt', { text: 'two' }],
      ],
    );
    await runner.dispose();
  });

  it('surfaces prompt failures', async () => {
    const { runner } = await setup((c) =>
      c.url.endsWith('/prompt') ? json({ _tag: 'SessionNotFoundError' }, 404) : undefined,
    );
    await assert.rejects(
      runner.sendPromptAsync('ses_x', { parts: [{ type: 'text', text: 'hi' }] }),
      /prompt failed \(404\)/,
    );
    await runner.dispose();
  });

  it('replies to permissions, cancels forms, interrupts and reads active sessions on v2 routes', async () => {
    const { runner, calls } = await setup((c) =>
      c.url === '/api/session/active' ? json({ data: { ses_1: { type: 'running' } } }) : undefined,
    );
    await runner.replyPermission('ses_1', 'per_1', 'once');
    await runner.cancelForm('ses_1', 'frm_1', 'no user');
    await runner.abort('ses_1');
    const status = await runner.getSessionStatusMap();
    assert.deepEqual(status, { ses_1: { type: 'busy' } });
    assert.deepEqual(
      calls.map((c) => [c.method, c.url, c.body]),
      [
        ['POST', '/api/session/ses_1/permission/per_1/reply', { decision: 'once' }],
        ['DELETE', '/api/session/ses_1/form/frm_1?message=no%20user', undefined],
        ['POST', '/api/session/ses_1/interrupt', undefined],
        ['GET', '/api/session/active', undefined],
      ],
    );
    assert.ok(calls.every((c) => c.auth === buildBasicAuthHeader('pw-test')));
    await runner.dispose();
  });

  it('redacts the server password from forwarded serve output', async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runner-'));
    const output: string[] = [];
    let serveChild: EventEmitter & { stdout: EventEmitter } | undefined;
    const spawnImpl = ((_bin: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        killed: true,
        kill: () => true,
      });
      if (args[0] === 'serve') serveChild = child;
      setImmediate(() => {
        child.emit('spawn');
        child.emit('close', 0);
      });
      return child;
    }) as unknown as SpawnFn;
    const runner = createOpenCodeSessionRunner({
      cwd: agentDir,
      agentDir,
      port: 4556,
      spawn: spawnImpl,
      password: 'secret-pw',
      onServerOutput: (chunk) => output.push(chunk),
      fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    });
    await runner.startServer();
    serveChild?.stdout.emit('data', Buffer.from('server password secret-pw\n'));
    assert.equal(output.join(''), 'server password ***\n');
    await runner.dispose();
  });
});
