import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { buildOcrLlmEnv, writeOcrConfig, runOcrReview } from './runner';

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
    const parsed = JSON.parse(raw) as {
      llm: { model: string; url: string; auth_token: string; use_anthropic: boolean };
    };
    assert.equal(parsed.llm.model, 'llama3.2');
    assert.equal(parsed.llm.url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(parsed.llm.auth_token, 'ollama');
    assert.equal(parsed.llm.use_anthropic, false);
  });
});

describe('buildOcrLlmEnv', () => {
  it('maps Ollama settings to OCR_LLM_* env vars', () => {
    const env = buildOcrLlmEnv({
      ollamaBaseUrl: 'http://localhost:11434',
      opencodeModel: 'qwen2.5-coder:7b',
      reviewModel: 'llama3.2',
    } as import('../../types').AppConfig);

    assert.equal(env.OCR_LLM_URL, 'http://localhost:11434/v1/chat/completions');
    assert.equal(env.OCR_LLM_TOKEN, 'ollama');
    assert.equal(env.OCR_LLM_MODEL, 'llama3.2');
    assert.equal(env.OCR_USE_ANTHROPIC, 'false');
  });
});

describe('runOcrReview', () => {
  const appConfig = {
    ollamaBaseUrl: 'http://localhost:11434',
    opencodeModel: 'llama3.2',
    reviewModel: '',
  } as import('../../types').AppConfig;

  it('parses json summary from stdout', async () => {
    const result = await runOcrReview({
      config: appConfig,
      workspaceDir: os.tmpdir(),
      baseBranch: 'main',
      headBranch: 'feature/foo',
      spawnFn: () => mockChildProcess('{"summary":"Looks good"}\n'),
    });
    assert.equal(result.summary, 'Looks good');
  });

  it('passes OCR_LLM_* env vars to the spawned process', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-review-'));
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    await runOcrReview({
      config: appConfig,
      workspaceDir,
      baseBranch: 'main',
      headBranch: 'feature/foo',
      spawnFn: (_cmd, _args, options) => {
        capturedEnv = options?.env;
        return mockChildProcess('{"summary":"ok"}\n');
      },
    });
    assert.equal(capturedEnv?.OCR_LLM_URL, 'http://localhost:11434/v1/chat/completions');
    assert.equal(capturedEnv?.OCR_LLM_TOKEN, 'ollama');
    assert.equal(capturedEnv?.OCR_LLM_MODEL, 'llama3.2');
    assert.equal(capturedEnv?.OCR_USE_ANTHROPIC, 'false');
    assert.equal(capturedEnv?.OCR_CONFIG_PATH, undefined);
  });
});
