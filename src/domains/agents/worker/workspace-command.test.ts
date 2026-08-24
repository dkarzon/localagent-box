import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'child_process';
import { describe, it } from 'node:test';
import {
  runWorkspaceCommand,
  tailOutputLines,
} from './workspace-command';

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
  pid?: number;
};

function makeFakeChild(overrides: { killEmitsClose?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  if (overrides.killEmitsClose) {
    child.kill = () => {
      child.emit('close', null);
    };
  } else {
    child.kill = () => undefined;
  }
  return child;
}

function makeStub(child: FakeChild) {
  const calls: unknown[][] = [];
  const spawnImpl = ((...args: unknown[]) => {
    calls.push(args);
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, calls };
}

describe('tailOutputLines', () => {
  it('returns the full output (trimmed) when it fits in the cap', () => {
    assert.equal(tailOutputLines('line1\nline2\n', 5), 'line1\nline2');
  });

  it('returns the last N lines of output', () => {
    const output = ['line1', 'line2', 'line3', 'line4'].join('\n');
    assert.equal(tailOutputLines(output, 2), 'line3\nline4');
  });
});

describe('runWorkspaceCommand', () => {
  it('resolves with success when the command exits 0', async () => {
    const child = makeFakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', 'ok\n');
      child.emit('close', 0);
    });

    const { spawnImpl, calls } = makeStub(child);
    const result = await runWorkspaceCommand('/tmp/workspace', 'echo ok', {
      spawnImpl,
    });
    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.outputTail, 'ok');
    assert.equal(result.command, 'echo ok');

    const [, , options] = calls[0] as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv },
    ];
    assert.equal(options.cwd, '/tmp/workspace');
    assert.equal(options.env.PATH, process.env.PATH);
  });

  it('merges the env override with the process environment', async () => {
    const child = makeFakeChild();
    queueMicrotask(() => {
      child.emit('close', 0);
    });

    const { spawnImpl, calls } = makeStub(child);
    await runWorkspaceCommand('/tmp/workspace', 'true', {
      spawnImpl,
      env: { BOOTSTRAP_TEST_VAR: '1' },
    });

    const [, , options] = calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    assert.equal(options.env.BOOTSTRAP_TEST_VAR, '1');
    assert.equal(options.env.PATH, process.env.PATH);
  });

  it('resolves with success false when the command exits non-zero', async () => {
    const child = makeFakeChild();
    queueMicrotask(() => {
      child.stderr.emit('data', 'boom\n');
      child.emit('close', 2);
    });

    const result = await runWorkspaceCommand('/tmp/workspace', 'exit 2', {
      spawnImpl: (() => child) as unknown as typeof spawn,
    });
    assert.equal(result.success, false);
    assert.equal(result.exitCode, 2);
    assert.equal(result.timedOut, false);
    assert.equal(result.outputTail, 'boom');
  });

  it('treats a null close code as a failure with exit 1', async () => {
    const child = makeFakeChild();
    queueMicrotask(() => {
      child.emit('close', null);
    });

    const result = await runWorkspaceCommand('/tmp/workspace', 'true', {
      spawnImpl: (() => child) as unknown as typeof spawn,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.success, false);
    assert.equal(result.timedOut, false);
  });

  it('marks timed out commands as failed with exit 124', async () => {
    const child = makeFakeChild({ killEmitsClose: true });

    const result = await runWorkspaceCommand('/tmp/workspace', 'sleep 10', {
      timeoutMs: 5,
      spawnImpl: (() => child) as unknown as typeof spawn,
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
    assert.equal(result.success, false);
  });

  it('caps the output tail to the configured number of lines', async () => {
    const child = makeFakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', 'l1\nl2\nl3\nl4');
      child.emit('close', 0);
    });

    const result = await runWorkspaceCommand('/tmp/workspace', 'seq 4', {
      maxOutputLines: 2,
      spawnImpl: (() => child) as unknown as typeof spawn,
    });
    assert.equal(result.outputTail, 'l3\nl4');
  });

  it('resolves with a failure result when spawn emits an error', async () => {
    const child = makeFakeChild();
    queueMicrotask(() => {
      child.emit('error', new Error('spawn sh ENOENT'));
    });

    const result = await runWorkspaceCommand('/tmp/workspace', 'no-env-shell', {
      spawnImpl: (() => child) as unknown as typeof spawn,
    });
    assert.equal(result.success, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, false);
    assert.equal(result.outputTail, 'spawn sh ENOENT');
  });
});
