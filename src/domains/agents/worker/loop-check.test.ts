import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  formatCheckResultBlock,
  runLoopCheckCommand,
  tailOutputLines,
} from './loop-check';

describe('tailOutputLines', () => {
  it('returns the last N lines of output', () => {
    const output = ['line1', 'line2', 'line3', 'line4'].join('\n');
    assert.equal(tailOutputLines(output, 2), 'line3\nline4');
  });
});

describe('formatCheckResultBlock', () => {
  it('formats a failed check for REFLECT injection', () => {
    const block = formatCheckResultBlock({
      command: 'npm test',
      exitCode: 1,
      outputTail: 'AssertionError: expected true',
      timedOut: false,
      success: false,
    });
    assert.match(block, /^## Check result \(host-run: `npm test`\)/);
    assert.match(block, /exit=1/);
    assert.match(block, /AssertionError/);
  });
});

describe('runLoopCheckCommand', () => {
  it('resolves with success when the command exits 0', async () => {
    const spawnStub = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      queueMicrotask(() => {
        child.stdout.emit('data', 'ok\n');
        child.emit('close', 0);
      });
      return child;
    };

    const result = await runLoopCheckCommand('/tmp/workspace', 'npm test', {
      spawnImpl: spawnStub as unknown as typeof import('child_process').spawn,
    });
    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputTail, 'ok');
  });

  it('marks timed out commands as failed with exit 124', async () => {
    const spawnStub = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        child.emit('close', null);
      };
      return child;
    };

    const result = await runLoopCheckCommand('/tmp/workspace', 'npm test', {
      timeoutMs: 5,
      spawnImpl: spawnStub as unknown as typeof import('child_process').spawn,
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
    assert.equal(result.success, false);
  });
});
