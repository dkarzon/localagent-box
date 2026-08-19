import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { parseNonNegativeInt, parsePositiveInt } from '../../lib/parse';
import { normalizeOpenCodeBaseUrl } from '../../services/opencode-config';
import type { AppConfig, SpawnFn } from '../../types';
import type { OcrReviewEnvelope } from './types';

/** Per-file OCR review deadline in minutes. OCR's own default is 10. `0` disables. */
export const DEFAULT_OCR_FILE_TIMEOUT_MINUTES = 30;

/** Per-request LLM HTTP timeout in seconds. OCR's own default is 300. */
export const DEFAULT_OCR_LLM_TIMEOUT_SECONDS = 600;

export interface OcrConfig {
  llm: {
    url: string;
    auth_token: string;
    model: string;
    use_anthropic: boolean;
  };
}

export function getOcrConfigPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.ocr', 'config.json');
}

export function getOcrBinary(): string {
  return process.env.OCR_BIN || 'ocr';
}

/** Per-file `--timeout` in minutes. Override with `OCR_REVIEW_TIMEOUT` (`0` disables). */
export function getOcrFileTimeoutMinutes(): number {
  return parseNonNegativeInt(process.env.OCR_REVIEW_TIMEOUT, DEFAULT_OCR_FILE_TIMEOUT_MINUTES);
}

/** Per-request HTTP timeout in seconds. Override with `OCR_LLM_TIMEOUT`. */
export function getOcrLlmTimeoutSeconds(): number {
  return parsePositiveInt(process.env.OCR_LLM_TIMEOUT, DEFAULT_OCR_LLM_TIMEOUT_SECONDS);
}

export function buildOcrLlmSettings(config: AppConfig): OcrConfig['llm'] {
  if (!config.ollamaBaseUrl?.trim()) {
    throw new Error('Ollama is not configured (ollamaBaseUrl is empty)');
  }

  const effectiveModel = config.reviewModel || config.opencodeModel || 'llama3.2';
  const baseUrl = normalizeOpenCodeBaseUrl(config.ollamaBaseUrl);
  return {
    url: `${baseUrl}/chat/completions`,
    auth_token: 'ollama',
    model: effectiveModel,
    use_anthropic: false,
  };
}

/** OCR review ignores OCR_CONFIG_PATH; it resolves LLM settings from OCR_LLM_* env vars. */
export function buildOcrLlmEnv(config: AppConfig): NodeJS.ProcessEnv {
  const llm = buildOcrLlmSettings(config);
  return {
    OCR_LLM_URL: llm.url,
    OCR_LLM_TOKEN: llm.auth_token,
    OCR_LLM_MODEL: llm.model,
    OCR_LLM_TIMEOUT: String(getOcrLlmTimeoutSeconds()),
    OCR_USE_ANTHROPIC: 'false',
  };
}

export function writeOcrConfig(config: AppConfig, workspaceDir: string): void {
  const ocrCfg: OcrConfig = {
    llm: buildOcrLlmSettings(config),
  };

  const ocrDir = path.join(workspaceDir, '.ocr');
  fs.mkdirSync(ocrDir, { recursive: true });
  fs.writeFileSync(getOcrConfigPath(workspaceDir), JSON.stringify(ocrCfg, null, 2), 'utf8');
}

export type OcrReviewResult = OcrReviewEnvelope;

function isOcrReviewEnvelope(value: unknown): value is OcrReviewEnvelope {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as OcrReviewEnvelope;
  return (
    typeof candidate.status === 'string' ||
    typeof candidate.message === 'string' ||
    Array.isArray(candidate.comments) ||
    Array.isArray(candidate.issues) ||
    typeof candidate.summary === 'string' ||
    (typeof candidate.summary === 'object' && candidate.summary !== null)
  );
}

export function parseOcrJsonStdout(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  for (const line of trimmed.split('\n').reverse()) {
    const candidate = line.trim();
    if (!candidate) continue;
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object') {
        return obj as Record<string, unknown>;
      }
    } catch {}
  }

  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object') {
      return obj as Record<string, unknown>;
    }
  } catch {}

  return null;
}

export function runOcrSessionShow(options: {
  workspaceDir: string;
  sessionId: string;
  spawnFn?: SpawnFn;
}): Promise<Record<string, unknown> | null> {
  const ocrBin = getOcrBinary();
  const args = [
    'session',
    'show',
    '--json',
    '--repo',
    options.workspaceDir,
    options.sessionId,
  ];

  return new Promise((resolve, reject) => {
    const proc = (options.spawnFn || spawn)(ocrBin, args, {
      cwd: options.workspaceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`OCR session show spawn error: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      if (signal || code !== 0) {
        reject(new Error(stderr.trim() || `ocr session show exited with code=${code} signal=${signal}`));
        return;
      }

      resolve(parseOcrJsonStdout(stdout));
    });
  });
}

export function runOcrReview(options: {
  config: AppConfig;
  workspaceDir: string;
  baseBranch: string;
  headBranch: string;
  background?: string;
  spawnFn?: SpawnFn;
}): Promise<OcrReviewResult> {
  const ocrBin = getOcrBinary();
  const fileTimeoutMinutes = getOcrFileTimeoutMinutes();
  const args = [
    'review',
    '--repo', options.workspaceDir,
    '--from', options.baseBranch,
    '--to', options.headBranch,
    '--format', 'json',
    '--audience', 'agent',
    '--timeout', String(fileTimeoutMinutes),
  ];

  if (options.background) {
    args.push('-b', options.background);
  }

  const ocrLlmEnv = buildOcrLlmEnv(options.config);

  return new Promise((resolve, reject) => {
    const proc = (options.spawnFn || spawn)(ocrBin, args, {
      cwd: options.workspaceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...ocrLlmEnv,
      },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`OCR spawn error: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      if (signal || code !== 0) {
        const message = stderr.trim() || `ocr exited with code=${code} signal=${signal}`;
        reject(new Error(message));
        return;
      }
      try {
        let parsed: OcrReviewResult | undefined;
        const envelope = parseOcrJsonStdout(stdout);
        if (envelope && isOcrReviewEnvelope(envelope)) {
          parsed = envelope;
        }

        if (parsed) {
          resolve(parsed);
        } else {
          // If no JSON, treat stdout as plain summary
          resolve({ message: stdout.trim() || 'OCR completed with no structured output' });
        }
      } catch (err) {
        reject(new Error(`Failed to parse OCR output: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  });
}
