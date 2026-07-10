import fs from 'fs';
import path from 'path';
import type { LoopStepConfig, LoopVerb } from '../../../types';

export const LOOP_VERBS: readonly LoopVerb[] = ['OBSERVE', 'PLAN', 'ACT', 'REFLECT'];

export interface LoopConfig {
  version: number;
  maxIterations: number;
  completionMarker: string;
  /** One-time kickoff prompt before the first iteration; optional for repo overrides. */
  initialPlanPrompt?: string;
  steps: LoopStepConfig[];
}

export interface LoadedLoopConfig {
  config: LoopConfig;
  configSource: 'server-default' | 'repo-override';
}

export interface InterpolateVars {
  goal: string;
  iteration: number;
  completionMarker: string;
}

const bundledDefaultPath = path.join(__dirname, '..', '..', '..', '..', 'config', 'loop.default.json');
const repoConfigRelative = path.join('.localagent-box', 'loop.json');

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as unknown;
}

export function validateLoopConfig(raw: unknown): LoopConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('loop.json must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new Error(`loop.json version must be 1, got ${String(obj.version)}`);
  }

  if (typeof obj.maxIterations !== 'number' || !Number.isFinite(obj.maxIterations) || obj.maxIterations < 1) {
    throw new Error('loop.json maxIterations must be a positive number');
  }

  if (typeof obj.completionMarker !== 'string' || !obj.completionMarker.trim()) {
    throw new Error('loop.json completionMarker must be a non-empty string');
  }

  let initialPlanPrompt: string | undefined;
  if (obj.initialPlanPrompt !== undefined) {
    if (typeof obj.initialPlanPrompt !== 'string' || !obj.initialPlanPrompt.trim()) {
      throw new Error('loop.json initialPlanPrompt must be a non-empty string when provided');
    }
    initialPlanPrompt = obj.initialPlanPrompt;
  }

  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new Error('loop.json steps must be a non-empty array');
  }

  const steps: LoopStepConfig[] = obj.steps.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`loop.json steps[${index}] must be an object`);
    }
    const step = entry as Record<string, unknown>;
    if (typeof step.verb !== 'string' || !LOOP_VERBS.includes(step.verb as LoopVerb)) {
      throw new Error(
        `loop.json steps[${index}].verb must be one of ${LOOP_VERBS.join(', ')}, got ${String(step.verb)}`,
      );
    }
    if (typeof step.prompt !== 'string' || !step.prompt.trim()) {
      throw new Error(`loop.json steps[${index}].prompt must be a non-empty string`);
    }
    return { verb: step.verb as LoopVerb, prompt: step.prompt };
  });

  return {
    version: 1,
    maxIterations: obj.maxIterations,
    completionMarker: obj.completionMarker.trim(),
    initialPlanPrompt,
    steps,
  };
}

export function loadServerDefaultLoopConfig(
  fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs,
): LoopConfig {
  if (!fsImpl.existsSync(bundledDefaultPath)) {
    throw new Error(`Server default loop config not found at ${bundledDefaultPath}`);
  }
  return validateLoopConfig(readJsonFile(bundledDefaultPath));
}

export function loadLoopConfig(
  workspaceDir: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs,
  pathImpl: typeof path = path,
): LoadedLoopConfig {
  const repoPath = pathImpl.join(workspaceDir, repoConfigRelative);
  if (fsImpl.existsSync(repoPath)) {
    return {
      config: validateLoopConfig(readJsonFile(repoPath)),
      configSource: 'repo-override',
    };
  }
  return {
    config: loadServerDefaultLoopConfig(fsImpl),
    configSource: 'server-default',
  };
}

export function interpolateStepPrompt(template: string, vars: InterpolateVars): string {
  return template
    .replaceAll('{{goal}}', vars.goal)
    .replaceAll('{{iteration}}', String(vars.iteration))
    .replaceAll('{{completionMarker}}', vars.completionMarker);
}

function normalizeForEchoComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAssistantEchoingPrompt(assistantText: string, stepPromptText: string): boolean {
  const assistant = normalizeForEchoComparison(assistantText);
  const prompt = normalizeForEchoComparison(stepPromptText);
  if (!assistant || !prompt) {
    return false;
  }
  if (assistant === prompt) {
    return true;
  }
  // Agent restated the step prompt (or most of it) instead of answering.
  return prompt.includes(assistant) && assistant.length >= prompt.length * 0.5;
}

function stripMarkdownLineDecorations(line: string): string {
  return line
    .trim()
    .replace(/^>\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[`*_~]+|[`*_~]+$/g, '')
    .trim();
}

function isInstructionReferenceLine(line: string): boolean {
  const normalized = line.toLowerCase();
  return (
    /\boutput a line exactly\b/.test(normalized) ||
    /\bif the goal is fully achieved\b/.test(normalized) ||
    /\bemit\b.*\bwhen\b/.test(normalized) ||
    /\bfollowing the instructions\b/.test(normalized)
  );
}

function isNegatedCompletionLine(line: string, completionMarker: string): boolean {
  const normalized = line.toLowerCase();
  const markerToken = `${completionMarker.toLowerCase()}: true`;
  const markerIdx = normalized.indexOf(markerToken);
  if (markerIdx <= 0) {
    return false;
  }
  const prefix = normalized.slice(0, markerIdx);
  return /\b(not|n't|without|unless|until|before|almost|nearly|still|yet|need|remaining|don't|do not)\b/.test(
    prefix,
  );
}

function lineHasCompletionMarker(line: string, completionMarker: string): boolean {
  const stripped = stripMarkdownLineDecorations(line);
  if (!stripped || isInstructionReferenceLine(stripped) || isNegatedCompletionLine(stripped, completionMarker)) {
    return false;
  }

  const escaped = completionMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[.!?—–-]\\s+|\\b)${escaped}\\s*:\\s*true\\s*\\.?!?\\s*$`, 'i');
  return pattern.test(stripped);
}

export function parseCompletionSignal(
  assistantText: string | null | undefined,
  completionMarker: string,
  stepPromptText?: string,
): boolean {
  if (!assistantText) {
    return false;
  }
  if (stepPromptText && isAssistantEchoingPrompt(assistantText, stepPromptText)) {
    return false;
  }

  for (const line of assistantText.split(/\r?\n/)) {
    if (lineHasCompletionMarker(line, completionMarker)) {
      return true;
    }
  }
  return false;
}
