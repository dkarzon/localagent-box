import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { AppConfig, SpawnFn } from '../../types';

export interface OcrConfig {
  ollamaBaseUrl: string;
  model: string;
}

export function getOcrBinary(): string {
  return process.env.OCR_BIN || 'open-code-review';
}

export function writeOcrConfig(config: AppConfig, workspaceDir: string): void {
  const effectiveModel = config.reviewModel || config.opencodeModel;
  const ocrCfg: OcrConfig = {
    ollamaBaseUrl: config.ollamaBaseUrl,
    model: effectiveModel,
  };

  const ocrDir = path.join(workspaceDir, '.ocr');
  fs.mkdirSync(ocrDir, { recursive: true });
  const ocrConfigPath = path.join(ocrDir, 'config.json');
  fs.writeFileSync(ocrConfigPath, JSON.stringify(ocrCfg, null, 2), 'utf8');
}

export interface OcrReviewResult {
  summary: string;
  issues?: Array<{ file: string; line: number; message: string }>;
}

export function runOcrReview(options: {
  workspaceDir: string;
  baseBranch: string;
  headBranch: string;
  background?: string;
  spawnFn?: SpawnFn;
}): Promise<OcrReviewResult> {
  const ocrBin = getOcrBinary();
  const args = [
    'review',
    '--repo', options.workspaceDir,
    '--from', options.baseBranch,
    '--to', options.headBranch,
    '--format', 'json',
    '--audience', 'agent',
  ];

  if (options.background) {
    args.push('-b', options.background);
  }

  return new Promise((resolve, reject) => {
    const proc = (options.spawnFn || spawn)(ocrBin, args, {
      cwd: options.workspaceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
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
        // Try to parse streaming JSON lines — look for the last valid object with a summary
        const trimmed = stdout.trim();
        for (const line of trimmed.split('\n').reverse()) {
          const candidate = line.trim();
          if (!candidate) continue;
          try {
            const obj = JSON.parse(candidate);
            if (obj.summary || obj.issues !== undefined) {
              parsed = obj as OcrReviewResult;
              break;
            }
          } catch {}
        }

        if (parsed) {
          resolve(parsed);
        } else {
          // If no JSON, treat stdout as plain summary
          resolve({ summary: trimmed || 'OCR completed with no structured output' });
        }
      } catch (err) {
        reject(new Error(`Failed to parse OCR output: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  });
}
