import fs from 'fs';
import path from 'path';

/** Repo-relative path to the loop plan ledger (gitignored under `.localagent-box/`). */
export const LOOP_PLAN_RELATIVE_PATH = path.join('.localagent-box', 'loop-plan.md');

/** Cap for full REFLECT replay when no plan file exists (phase-1 fallback). */
export const MAX_INJECTED_SUMMARY_CHARS = 2000;

/** Max chars of a non-checklist plan file to inject when slice parsing finds no items. */
export const MAX_RAW_PLAN_INJECTION_CHARS = 1500;

/** Retry prompt when INITIAL_PLAN did not produce `.localagent-box/loop-plan.md`. */
export const INITIAL_PLAN_RETRY_PROMPT =
  'You did not write `.localagent-box/loop-plan.md`. Write it now as a markdown checklist (`- [ ] …`) of ordered milestones for the goal. Output nothing except creating that file. Planning only — no implementation.\n\nGoal: {{goal}}';

const CHECKBOX_LINE_RE = /^(\s*[-*+]\s+)\[([ xX])\]\s+(.*)$/;
const REFLECT_FIELD_LINE_RE = /^(DONE|REMAINING|NEXT|FILES TOUCHED):\s*(.*)$/i;

interface ChecklistItem {
  checked: boolean;
  line: string;
}

function parseChecklistItems(content: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(CHECKBOX_LINE_RE);
    if (!match) {
      continue;
    }
    items.push({
      checked: match[2].toLowerCase() === 'x',
      line: line.trimEnd(),
    });
  }
  return items;
}

/**
 * Build a compact checklist slice: all unchecked items plus at most the last
 * completed item for context.
 */
export function formatPlanSlice(items: ChecklistItem[]): string | null {
  if (items.length === 0) {
    return null;
  }

  const unchecked = items.filter((item) => !item.checked);
  const lastCompleted = [...items].reverse().find((item) => item.checked);

  const lines: string[] = [];
  if (unchecked.length > 0) {
    if (lastCompleted) {
      lines.push(lastCompleted.line);
    }
    for (const item of unchecked) {
      lines.push(item.line);
    }
  } else if (lastCompleted) {
    lines.push(lastCompleted.line);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

export function getLoopPlanFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, LOOP_PLAN_RELATIVE_PATH);
}

/** True when the plan file exists and has non-whitespace content. */
export function isLoopPlanFilePresent(
  workspaceDir: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs,
): boolean {
  const filePath = getLoopPlanFilePath(workspaceDir);
  if (!fsImpl.existsSync(filePath)) {
    return false;
  }
  return fsImpl.readFileSync(filePath, 'utf8').trim().length > 0;
}

export function writeLoopPlanFile(
  workspaceDir: string,
  content: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'writeFileSync'> = fs,
): void {
  const dir = path.join(workspaceDir, '.localagent-box');
  if (!fsImpl.existsSync(dir)) {
    fsImpl.mkdirSync(dir, { recursive: true });
  }
  const normalized = content.trim();
  const body = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  fsImpl.writeFileSync(getLoopPlanFilePath(workspaceDir), body, 'utf8');
}

/**
 * Host fallback when INITIAL_PLAN (and retry) did not create the plan file.
 * Prefers checklist lines from assistant output, then raw text, then a single goal milestone.
 */
export function seedLoopPlanFromAssistantText(
  workspaceDir: string,
  assistantText: string,
  goal: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'writeFileSync'> = fs,
): void {
  const checkboxLines = assistantText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => CHECKBOX_LINE_RE.test(line));

  let content: string;
  if (checkboxLines.length > 0) {
    content = checkboxLines.join('\n');
  } else if (assistantText.trim()) {
    content = assistantText.trim();
  } else {
    const trimmedGoal = goal.trim() || 'Complete the goal';
    content = `- [ ] ${trimmedGoal}`;
  }

  writeLoopPlanFile(workspaceDir, content, fsImpl);
}

function readLoopPlanRawContent(
  workspaceDir: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync'>,
): string | null {
  const filePath = getLoopPlanFilePath(workspaceDir);
  if (!fsImpl.existsSync(filePath)) {
    return null;
  }
  const raw = fsImpl.readFileSync(filePath, 'utf8').trim();
  return raw || null;
}

/**
 * Read `.localagent-box/loop-plan.md` and return a compact slice for injection,
 * or null when the file is missing, empty, or has no checklist items.
 */
export function readLoopPlanSlice(
  workspaceDir: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs,
): string | null {
  const filePath = path.join(workspaceDir, LOOP_PLAN_RELATIVE_PATH);
  if (!fsImpl.existsSync(filePath)) {
    return null;
  }

  const raw = fsImpl.readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    return null;
  }

  return formatPlanSlice(parseChecklistItems(raw));
}

/**
 * Parse the `NEXT:` line from a REFLECT step's structured output.
 */
export function parseReflectNextLine(reflectText: string): string | null {
  return parseReflectOutput(reflectText).next;
}

export interface ParsedReflectOutput {
  done: string | null;
  remaining: string | null;
  next: string | null;
  filesTouched: string[];
}

/**
 * Parse structured REFLECT template fields from assistant output.
 */
export function parseReflectOutput(reflectText: string): ParsedReflectOutput {
  let done: string | null = null;
  let remaining: string | null = null;
  let next: string | null = null;
  let filesTouched: string[] = [];

  for (const line of reflectText.split(/\r?\n/)) {
    const match = line.match(REFLECT_FIELD_LINE_RE);
    if (!match) {
      continue;
    }
    const label = match[1].toUpperCase();
    const value = match[2].trim();
    if (label === 'DONE') {
      done = value || null;
    } else if (label === 'REMAINING') {
      remaining = value || null;
    } else if (label === 'NEXT') {
      next = value || null;
    } else if (label === 'FILES TOUCHED') {
      filesTouched = value
        ? value
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [];
    }
  }

  return { done, remaining, next, filesTouched };
}

function normalizeMatchText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ');
}

function shouldTickMilestone(label: string, done: string): boolean {
  const labelNorm = normalizeMatchText(label);
  const doneNorm = normalizeMatchText(done);
  if (!labelNorm || !doneNorm) {
    return false;
  }
  if (doneNorm.includes(labelNorm)) {
    return true;
  }
  const prefix = labelNorm.slice(0, Math.min(32, labelNorm.length));
  if (prefix.length >= 8 && doneNorm.includes(prefix)) {
    return true;
  }
  const significantWords = labelNorm.split(' ').filter((word) => word.length >= 4);
  return significantWords.length > 0 && significantWords.every((word) => doneNorm.includes(word));
}

/**
 * Tick checklist items in plan content when their label appears in the REFLECT `DONE` line.
 */
export function applyTicksToPlanContent(content: string, done: string): string {
  if (!done.trim()) {
    return content;
  }

  return content
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(CHECKBOX_LINE_RE);
      if (!match || match[2].toLowerCase() === 'x') {
        return line;
      }
      const label = match[3];
      if (!shouldTickMilestone(label, done)) {
        return line;
      }
      return `${match[1]}[x] ${label}`;
    })
    .join('\n');
}

export interface ApplyLedgerUpdateResult {
  parsed: ParsedReflectOutput;
  ledgerUpdated: boolean;
}

/**
 * Host-maintained ledger: parse REFLECT output and tick matching milestones in loop-plan.md.
 */
export function applyLedgerUpdateFromReflect(
  workspaceDir: string,
  reflectText: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'mkdirSync' | 'writeFileSync'> = fs,
): ApplyLedgerUpdateResult {
  const parsed = parseReflectOutput(reflectText);
  if (!parsed.done?.trim() || !isLoopPlanFilePresent(workspaceDir, fsImpl)) {
    return { parsed, ledgerUpdated: false };
  }

  const filePath = getLoopPlanFilePath(workspaceDir);
  const content = fsImpl.readFileSync(filePath, 'utf8');
  const updated = applyTicksToPlanContent(content, parsed.done);
  if (updated === content) {
    return { parsed, ledgerUpdated: false };
  }

  writeLoopPlanFile(workspaceDir, updated, fsImpl);
  return { parsed, ledgerUpdated: true };
}

export interface BuildIterationHandoffParams {
  workspaceDir: string;
  previousReflectText?: string | null;
  /** Parsed NEXT from the previous REFLECT step (preferred over re-parsing prose). */
  previousReflectNext?: string | null;
  maxFallbackSummaryChars?: number;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readFileSync'>;
}

/**
 * Build the handoff block injected into the first step of each loop iteration.
 * When a plan file exists, inject a host-read slice (and optional NEXT line) instead
 * of replaying the full REFLECT output.
 */
function resolvePlanInjectionBody(
  workspaceDir: string,
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readFileSync'>,
): string | null {
  const planSlice = readLoopPlanSlice(workspaceDir, fsImpl);
  if (planSlice) {
    return planSlice;
  }

  const raw = readLoopPlanRawContent(workspaceDir, fsImpl ?? fs);
  if (!raw) {
    return null;
  }

  return raw.length > MAX_RAW_PLAN_INJECTION_CHARS
    ? `${raw.slice(0, MAX_RAW_PLAN_INJECTION_CHARS)}…`
    : raw;
}

export function buildIterationHandoffBlock(params: BuildIterationHandoffParams): string | null {
  const planBody = resolvePlanInjectionBody(params.workspaceDir, params.fsImpl);
  const nextLine =
    params.previousReflectNext ??
    (params.previousReflectText ? parseReflectNextLine(params.previousReflectText) : null);

  if (planBody) {
    const parts = ['## Plan (host-read)', planBody];
    if (nextLine) {
      parts.push('', `NEXT (from last iteration): ${nextLine}`);
    }
    return parts.join('\n');
  }

  if (params.previousReflectText) {
    const maxChars = params.maxFallbackSummaryChars ?? MAX_INJECTED_SUMMARY_CHARS;
    const summary = params.previousReflectText.slice(0, maxChars);
    return `## Previous iteration summary\n${summary}`;
  }

  return null;
}
