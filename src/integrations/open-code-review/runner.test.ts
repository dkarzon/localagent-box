import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { writeOcrConfig, runOcrReview } from './runner';

function mockChildProcess(stdout: string, exitCode = 0): ChildProcess {
  const proc = {
    stdout: { on: (_event: string, handler: (chunk: Buffer) => void) => {
      handler(Buffer.from(stdout));
      return proc.stdout;
    } },
    stderr: { on: () => proc.stderr },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'close') {
        handler(exitCode, null);
      }
      return proc;
    },
    kill: () => true,
  };
  return proc as unknown as ChildProcess;
}

describe('writeOcrConfig', () => {
  it('writes review model fallback to workspace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-config-'));
    writeOcrConfig(
      {
        ollamaBaseUrl: 'http://localhost:11434',
        opencodeModel: 'qwen2.5-coder:7b',
        reviewModel: 'llama3.2',
      } as import('../../types').AppConfig,
      dir,
    );
    const raw = fs.readFileSync(path.join(dir, '.ocr', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { model: string; ollamaBaseUrl: string };
    assert.equal(parsed.model, 'llama3.2');
    assert.equal(parsed.ollamaBaseUrl, 'http://localhost:11434');
  });
});

describe('runOcrReview', () => {
  it('parses json summary from stdout', async () => {
    const result = await runOcrReview({
      workspaceDir: os.tmpdir(),
      baseBranch: 'main',
      headBranch: 'feature/foo',
      spawnFn: () => mockChildProcess('{"summary":"Looks good"}\n'),
    });
    assert.equal(result.summary, 'Looks good');
  });
});
