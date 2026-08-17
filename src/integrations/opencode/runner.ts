import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getServerEnv } from '../../config/env';
import type { AppConfig, RepoPromptOverrides } from '../../types';

export const DEFAULT_TIMEOUT_MS = 3600000;
export const INIT_TIMEOUT_MS = 600000;
export const OUTPUT_TAIL_CHARS = 4000;

export function getOpencodeBin(): string {
  return getServerEnv().opencodeBin;
}

export function generateOpenCodeMessageId(): string {
  return `msg_${crypto.randomUUID()}`;
}

export function collectOpenCodeSpawnDebug(options: {
  opencodeBin?: string;
  cwd: string;
  args?: string[];
  extraEnv?: Record<string, string>;
}): string[] {
  const bin = options.opencodeBin || getOpencodeBin();
  const args = options.args || [];
  const lines: string[] = [
    `OpenCode spawn debug: platform=${process.platform} arch=${process.arch} node=${process.version}`,
    `OpenCode spawn debug: OPENCODE_BIN env=${process.env.OPENCODE_BIN ?? '(unset)'}`,
    `OpenCode spawn debug: resolved binary=${bin}`,
    `OpenCode spawn debug: command=${bin} ${args.join(' ')}`,
    `OpenCode spawn debug: cwd=${options.cwd} cwdExists=${fs.existsSync(options.cwd)}`,
    `OpenCode spawn debug: PATH=${process.env.PATH ?? '(unset)'}`,
  ];

  const hasPathSep = bin.includes('/') || bin.includes('\\');
  if (path.isAbsolute(bin) || hasPathSep) {
    lines.push(
      `OpenCode spawn debug: binary exists=${fs.existsSync(bin)} isFile=${fs.existsSync(bin) && fs.statSync(bin).isFile()}`,
    );
  }

  if (process.platform === 'win32' && !hasPathSep) {
    const npmRoot = path.join(process.env.APPDATA || '', 'npm');
    const candidates = [
      path.join(npmRoot, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
      path.join(npmRoot, 'opencode.cmd'),
      path.join(npmRoot, 'opencode'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        lines.push(`OpenCode spawn debug: Windows candidate found: ${candidate}`);
      }
    }
    lines.push(
      'OpenCode spawn debug: hint: on Windows, spawn("opencode") often fails with ENOENT; set OPENCODE_BIN to opencode.exe',
    );
  } else if (process.platform !== 'win32' && !hasPathSep) {
    for (const candidate of ['/usr/local/bin/opencode', '/usr/bin/opencode']) {
      lines.push(`OpenCode spawn debug: ${candidate} exists=${fs.existsSync(candidate)}`);
    }
  }

  if (options.extraEnv) {
    for (const [key, value] of Object.entries(options.extraEnv)) {
      lines.push(`OpenCode spawn debug: env ${key}=${value}`);
      if (key === 'XDG_DATA_HOME') {
        const opencodeBinDir = path.join(value, 'opencode', 'bin');
        lines.push(
          `OpenCode spawn debug: isolated opencode bin dir=${opencodeBinDir} exists=${fs.existsSync(opencodeBinDir)}`,
        );
      }
    }
  }

  const defaultOpencodeData = path.join(os.homedir(), '.local', 'share', 'opencode');
  lines.push(
    `OpenCode spawn debug: default data dir=${defaultOpencodeData} exists=${fs.existsSync(defaultOpencodeData)}`,
  );

  return lines;
}

export interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

export function parseTimeoutMs(value: unknown, fallback = DEFAULT_TIMEOUT_MS): number {
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Worker start time (`startedAt`). Never `createdAt` — queue wait must not consume AGENT_TIMEOUT. */
export function resolveAgentRunStartedAtMs(
  startedAt: string | null | undefined,
  fallbackMs = Date.now(),
): number {
  if (!startedAt) {
    return fallbackMs;
  }
  const ms = Date.parse(startedAt);
  return Number.isFinite(ms) ? ms : fallbackMs;
}

export function isAgentRunTimedOut(
  runStartedAtMs: number,
  timeoutMs: number,
  nowMs = Date.now(),
): boolean {
  return nowMs - runStartedAtMs > timeoutMs;
}

export function buildModelRef(config: AppConfig): OpenCodeModelRef | null {
  return buildModelRefFromId(config, config.opencodeModel);
}

export function buildModelRefFromId(
  config: AppConfig,
  modelId: string | null | undefined,
): OpenCodeModelRef | null {
  if (!modelId) {
    return null;
  }
  return {
    providerID: config.opencodeProvider || 'ollama',
    modelID: modelId,
  };
}

export function buildModelFlag(config: AppConfig): string | null {
  const model = buildModelRef(config);
  if (!model) {
    return null;
  }
  return `${model.providerID}/${model.modelID}`;
}

/** Brief framing only — the user's task prompt is the primary instruction. */
export const SENIOR_ENGINEER_SYSTEM_PROMPT =
  'Coding agent in an isolated clone on a dedicated branch. Implement only the task; minimal scoped diff; no secrets or unrelated edits.';

export const BATCH_RUN_CONTEXT_PROMPT =
  'Batch: one unattended run — implement the task in this session (edit files, run checks). Do not stop at a plan or overview; the host fails the run if there are no file changes when you go idle.';

export const INTERACTIVE_RUN_CONTEXT_PROMPT =
  'Interactive: follow-ups are allowed; the host commits only when the user finishes the session.';

export const LOOP_RUN_CONTEXT_PROMPT =
  'Loop: unattended multi-step harness — each step is a directive toward the goal. The host fails on zero file changes at end (like batch). Emit {{completionMarker}}: true when the goal is fully achieved — on REFLECT, or on the first step of an iteration if it was already complete before you started. Do not stop after plans or overviews — ACT steps must produce file edits.';

export type OpenCodeRunMode = 'batch' | 'interactive' | 'loop';

function resolveRunModeContext(
  runMode?: OpenCodeRunMode,
  repoOverrides?: RepoPromptOverrides,
): string | null {
  if (runMode === 'batch') {
    return !repoOverrides?.batchContextPrompt ? BATCH_RUN_CONTEXT_PROMPT : repoOverrides.batchContextPrompt;
  }
  if (runMode === 'interactive') {
    return !repoOverrides?.interactiveContextPrompt ? INTERACTIVE_RUN_CONTEXT_PROMPT : repoOverrides.interactiveContextPrompt;
  }
  if (runMode === 'loop') {
    return !repoOverrides?.loopContextPrompt ? LOOP_RUN_CONTEXT_PROMPT : repoOverrides.loopContextPrompt;
  }
  return null;
}

export interface BuildOpenCodePromptOptions {
  /**
   * Prepend the static `## Context` framing (system prompt + mode context).
   * Set false for follow-up turns in an existing session, where the framing was
   * already sent on the first turn and replaying it only wastes input tokens.
   * Defaults to true.
   */
  includeFraming?: boolean;
}

export function buildOpenCodePrompt(
  userPrompt: string,
  jobSystemPrompt?: string,
  runMode?: OpenCodeRunMode,
  completionMarker?: string,
  repoOverrides?: RepoPromptOverrides,
  serverSystemPrompt?: string,
  options?: BuildOpenCodePromptOptions,
): string {
  const trimmed = typeof userPrompt === 'string' ? userPrompt.trim() : '';
  if (!trimmed) {
    throw new Error('Prompt cannot be empty');
  }

  // Follow-up turns in a live session already carry the framing in history —
  // send only the directive.
  if (options?.includeFraming === false) {
    return trimmed;
  }

  const system =
    typeof jobSystemPrompt === 'string' && jobSystemPrompt.trim()
      ? jobSystemPrompt.trim()
      : repoOverrides?.systemPrompt?.trim()
        ? repoOverrides.systemPrompt.trim()
        : typeof serverSystemPrompt === 'string' && serverSystemPrompt.trim()
          ? serverSystemPrompt.trim()
          : SENIOR_ENGINEER_SYSTEM_PROMPT;

  let modeContext = resolveRunModeContext(runMode, repoOverrides);
  if (modeContext && runMode === 'loop' && completionMarker) {
    modeContext = modeContext.replaceAll('{{completionMarker}}', completionMarker);
  }
  const contextLines = [system];
  if (modeContext) {
    contextLines.push(modeContext);
  }

  // Static `## Context` first, changing `## Task` last: keeps the prompt prefix
  // stable across turns so Ollama can reuse its KV cache.
  return ['## Context', contextLines.join('\n'), '## Task', trimmed].join('\n\n');
}
