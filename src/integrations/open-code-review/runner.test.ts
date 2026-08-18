import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import {
  DEFAULT_OCR_FILE_TIMEOUT_MINUTES,
  DEFAULT_OCR_LLM_TIMEOUT_SECONDS,
  buildOcrLlmEnv,
  getOcrFileTimeoutMinutes,
  getOcrLlmTimeoutSeconds,
  writeOcrConfig,
  runOcrReview,
} from './runner';

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
    },
    kill: () => true,
  };
  return proc as unknown as ChildProcess;
}

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous = Object.entries(overrides).map(([key, _]) => [key, process.env[key]] as const);
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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

describe('OCR timeouts', () => {
  it('defaults per-file timeout to 30 minutes and LLM timeout to 600 seconds', () => {
    withEnv({ OCR_REVIEW_TIMEOUT: undefined, OCR_LLM_TIMEOUT: undefined }, () => {
      assert.equal(getOcrFileTimeoutMinutes(), DEFAULT_OCR_FILE_TIMEOUT_MINUTES);
      assert.equal(getOcrLlmTimeoutSeconds(), DEFAULT_OCR_LLM_TIMEOUT_SECONDS);
    });
  });

  it('honors OCR_REVIEW_TIMEOUT including 0 to disable', () => {
    withEnv({ OCR_REVIEW_TIMEOUT: '45' }, () => {
      assert.equal(getOcrFileTimeoutMinutes(), 45);
    });
    withEnv({ OCR_REVIEW_TIMEOUT: '0' }, () => {
      assert.equal(getOcrFileTimeoutMinutes(), 0);
    });
  });

  it('honors OCR_LLM_TIMEOUT', () => {
    withEnv({ OCR_LLM_TIMEOUT: '900' }, () => {
      assert.equal(getOcrLlmTimeoutSeconds(), 900);
    });
  });
});

describe('buildOcrLlmEnv', () => {
  it('maps Ollama settings to OCR_LLM_* env vars', () => {
    const env = withEnv({ OCR_LLM_TIMEOUT: undefined }, () =>
      buildOcrLlmEnv({
        ollamaBaseUrl: 'http://localhost:11434',
        opencodeModel: 'qwen2.5-coder:7b',
        reviewModel: 'llama3.2',
      } as import('../../types').AppConfig),
    );

    assert.equal(env.OCR_LLM_URL, 'http://localhost:11434/v1/chat/completions');
    assert.equal(env.OCR_LLM_TOKEN, 'ollama');
    assert.equal(env.OCR_LLM_MODEL, 'llama3.2');
    assert.equal(env.OCR_LLM_TIMEOUT, String(DEFAULT_OCR_LLM_TIMEOUT_SECONDS));
    assert.equal(env.OCR_USE_ANTHROPIC, 'false');
  });
});

describe('runOcrReview', () => {
  const appConfig = {
    ollamaBaseUrl: 'http://localhost:11434',
    opencodeModel: 'llama3.2',
    reviewModel: '',
  } as import('../../types').AppConfig;

  it('parses legacy string summary from stdout', async () => {
    const result = await runOcrReview({
      config: appConfig,
      workspaceDir: os.tmpdir(),
      baseBranch: 'main',
      headBranch: 'feature/foo',
      spawnFn: () => mockChildProcess('{"summary":"Looks good"}\n'),
    });
    assert.equal(result.summary, 'Looks good');
  });

  it('parses OCR envelope from stdout', async () => {
    const result = await runOcrReview({
      config: appConfig,
      workspaceDir: os.tmpdir(),
      baseBranch: 'main',
      headBranch: 'feature/foo',
      spawnFn: () =>
        mockChildProcess(
          '{"status":"complete","message":"Review complete: 1 finding(s).","summary":{"files_reviewed":2,"comments":1},"comments":[{"path":"src/a.ts","content":"Fix this","start_line":1}]}\n',
        ),
    });
    assert.equal(result.status, 'complete');
    assert.equal(result.message, 'Review complete: 1 finding(s).');
    assert.equal(result.comments?.length, 1);
    assert.equal(result.comments?.[0]?.path, 'src/a.ts');
  });

  it('passes OCR_LLM_* env vars and --timeout to the spawned process', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-review-'));
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedArgs: readonly string[] | undefined;
    await withEnv({ OCR_REVIEW_TIMEOUT: undefined, OCR_LLM_TIMEOUT: undefined }, () =>
      runOcrReview({
        config: appConfig,
        workspaceDir,
        baseBranch: 'main',
        headBranch: 'feature/foo',
        spawnFn: (_cmd, args, options) => {
          capturedArgs = args;
          capturedEnv = options?.env;
          return mockChildProcess('{"summary":"ok"}\n');
        },
      }),
    );
    assert.equal(capturedEnv?.OCR_LLM_URL, 'http://localhost:11434/v1/chat/completions');
    assert.equal(capturedEnv?.OCR_LLM_TOKEN, 'ollama');
    assert.equal(capturedEnv?.OCR_LLM_MODEL, 'llama3.2');
    assert.equal(capturedEnv?.OCR_LLM_TIMEOUT, String(DEFAULT_OCR_LLM_TIMEOUT_SECONDS));
    assert.equal(capturedEnv?.OCR_USE_ANTHROPIC, 'false');
    assert.equal(capturedEnv?.OCR_CONFIG_PATH, undefined);
    const timeoutIdx = capturedArgs?.indexOf('--timeout') ?? -1;
    assert.ok(timeoutIdx >= 0);
    assert.equal(capturedArgs?.[timeoutIdx + 1], String(DEFAULT_OCR_FILE_TIMEOUT_MINUTES));
  });
});
