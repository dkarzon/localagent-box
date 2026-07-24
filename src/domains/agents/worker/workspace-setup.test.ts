import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import os from 'os';
import { buildCodeReviewGraph, ensureLocalagentBoxIgnored } from './workspace-setup';

describe('ensureLocalagentBoxIgnored', () => {
  const base = path.join(os.tmpdir(), 'test-gitignore-');

  it('creates .gitignore when it does not exist', () => {
    const dir = fs.mkdtempSync(base);
    try {
      ensureLocalagentBoxIgnored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.equal(content, '.localagent-box/\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends entry when .gitignore exists without the entry', () => {
    const dir = fs.mkdtempSync(base);
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
      ensureLocalagentBoxIgnored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.equal(content, 'node_modules/\n.localagent-box/\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when entry already present', () => {
    const dir = fs.mkdtempSync(base);
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), '.localagent-box/\nnode_modules/\n', 'utf8');
      ensureLocalagentBoxIgnored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.equal(content, '.localagent-box/\nnode_modules/\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles .gitignore not ending with newline', () => {
    const dir = fs.mkdtempSync(base);
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/', 'utf8');
      ensureLocalagentBoxIgnored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.equal(content, 'node_modules/\n.localagent-box/\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildCodeReviewGraph', () => {
  function makeLogPath(): { dir: string; logPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-crg-'));
    return { dir, logPath: path.join(dir, 'agent.log') };
  }

  it('runs `code-review-graph build` in the workspace and reports success', async () => {
    const { dir, logPath } = makeLogPath();
    try {
      const calls: { file: string; args: string[]; cwd?: string }[] = [];
      const execStub = (async (file: string, args: string[], opts: { cwd?: string }) => {
        calls.push({ file, args, cwd: opts.cwd });
        return { stdout: '', stderr: '' };
      }) as never;

      const ok = await buildCodeReviewGraph('/workspace/agents/abc', logPath, execStub);

      assert.equal(ok, true);
      assert.deepEqual(calls, [
        { file: 'code-review-graph', args: ['build'], cwd: '/workspace/agents/abc' },
      ]);
      assert.match(fs.readFileSync(logPath, 'utf8'), /code-review-graph index built/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is non-fatal when the build fails', async () => {
    const { dir, logPath } = makeLogPath();
    try {
      const execStub = (async () => {
        throw new Error('binary not found');
      }) as never;

      const ok = await buildCodeReviewGraph('/workspace/agents/abc', logPath, execStub);

      assert.equal(ok, false);
      assert.match(
        fs.readFileSync(logPath, 'utf8'),
        /code-review-graph build failed.*binary not found/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
