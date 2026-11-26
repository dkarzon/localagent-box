import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { CodedError } from '../types';
import { SAFE_READ_MAX_BYTES, readFileWithin } from './safe-read';

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function unsafeCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof CodedError ? err.code : `unexpected ${String(err)}`;
  }
}

afterEach(() => {
  while (roots.length) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('readFileWithin', () => {
  it('reads a normal file inside the workspace', () => {
    const root = tempDir('safe-read-');
    fs.mkdirSync(path.join(root, '.localagent-box', 'artefacts'), { recursive: true });
    fs.writeFileSync(path.join(root, '.localagent-box', 'artefacts', 'no-change.json'), '{"ok":true}\n');

    assert.equal(readFileWithin(root, '.localagent-box/artefacts/no-change.json'), '{"ok":true}\n');
  });

  it('returns null for a missing file', () => {
    const root = tempDir('safe-read-');
    assert.equal(readFileWithin(root, '.localagent-box/artefacts/no-change.json'), null);
  });

  it('rejects a path that escapes the workspace with ../', () => {
    const root = tempDir('safe-read-');
    const outside = tempDir('safe-read-outside-');
    fs.writeFileSync(path.join(outside, 'escape.txt'), 'outside\n');
    const relative = path.relative(root, path.join(outside, 'escape.txt'));

    assert.match(relative, /^\.\./);
    assert.equal(unsafeCode(() => readFileWithin(root, relative)), 'UNSAFE_PATH');
  });

  it('rejects a symlinked file', () => {
    const root = tempDir('safe-read-');
    const outside = tempDir('safe-read-outside-');
    const target = path.join(outside, 'target.txt');
    fs.writeFileSync(target, 'outside\n');
    try {
      fs.symlinkSync(target, path.join(root, 'link.txt'));
    } catch {
      return; // Symlink creation may be unavailable; the escape test above covers the guard.
    }

    assert.equal(unsafeCode(() => readFileWithin(root, 'link.txt')), 'UNSAFE_PATH');
  });

  it('rejects a symlinked parent directory', () => {
    const root = tempDir('safe-read-');
    const outside = tempDir('safe-read-outside-');
    fs.writeFileSync(path.join(outside, 'no-change.json'), 'outside\n');
    try {
      fs.symlinkSync(outside, path.join(root, 'artefacts'));
    } catch {
      return;
    }

    assert.equal(unsafeCode(() => readFileWithin(root, 'artefacts/no-change.json')), 'UNSAFE_PATH');
  });

  it('rejects a non-regular file and a file above the size limit', () => {
    const root = tempDir('safe-read-');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    assert.equal(unsafeCode(() => readFileWithin(root, 'sub')), 'UNSAFE_PATH');

    fs.writeFileSync(path.join(root, 'big.json'), 'x'.repeat(SAFE_READ_MAX_BYTES + 1));
    assert.equal(unsafeCode(() => readFileWithin(root, 'big.json')), 'UNSAFE_PATH');
    assert.equal(unsafeCode(() => readFileWithin(root, 'big.json', { maxBytes: 10 })), 'UNSAFE_PATH');
  });
});
