import fs from 'fs';
import path from 'path';

/** Repo-relative path to the loop plan ledger (gitignored under `.localagent-box/`). */
export const LOOP_PLAN_RELATIVE_PATH = path.join('.localagent-box', 'loop-plan.md');

/** Structured loop handoff state (gitignored under `.localagent-box/`). */
export const LOOP_STATE_RELATIVE_PATH = path.join('.localagent-box', 'loop-state.json');

export const LOOP_STATE_VERSION = 1 as const;

export interface LoopMilestone {
  id: string;
  text: string;
  done: boolean;
  verify?: string;
}

export interface LoopState {
  version: typeof LOOP_STATE_VERSION;
  goal: string;
  milestones: LoopMilestone[];
  next: string | null;
  lastFiles: string[];
  iteration: number;
}

type LoopFsRead = Pick<typeof fs, 'existsSync' | 'readFileSync'>;
type LoopFsWrite = Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'readFileSync' | 'writeFileSync'>;

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
  fsImpl: LoopFsWrite = fs,
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
  syncLoopStateFromPlanFile(workspaceDir, goal, { fsImpl });
}

export function getLoopStateFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, LOOP_STATE_RELATIVE_PATH);
}

function ensureLocalagentBoxDir(
  workspaceDir: string,
  fsImpl: Pick<typeof fs, 'existsSync' | 'mkdirSync'>,
): void {
  const dir = path.join(workspaceDir, '.localagent-box');
  if (!fsImpl.existsSync(dir)) {
    fsImpl.mkdirSync(dir, { recursive: true });
  }
}

export function validateLoopState(raw: unknown): LoopState {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('loop-state.json must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== LOOP_STATE_VERSION) {
    throw new Error(`loop-state.json version must be ${LOOP_STATE_VERSION}`);
  }
  if (typeof obj.goal !== 'string' || !obj.goal.trim()) {
    throw new Error('loop-state.json goal must be a non-empty string');
  }
  if (!Array.isArray(obj.milestones)) {
    throw new Error('loop-state.json milestones must be an array');
  }
  const milestones: LoopMilestone[] = obj.milestones.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`loop-state.json milestones[${index}] must be an object`);
    }
    const milestone = entry as Record<string, unknown>;
    if (typeof milestone.id !== 'string' || !milestone.id.trim()) {
      throw new Error(`loop-state.json milestones[${index}].id must be a non-empty string`);
    }
    if (typeof milestone.text !== 'string' || !milestone.text.trim()) {
      throw new Error(`loop-state.json milestones[${index}].text must be a non-empty string`);
    }
    if (typeof milestone.done !== 'boolean') {
      throw new Error(`loop-state.json milestones[${index}].done must be a boolean`);
    }
    let verify: string | undefined;
    if (milestone.verify !== undefined) {
      if (typeof milestone.verify !== 'string' || !milestone.verify.trim()) {
        throw new Error(`loop-state.json milestones[${index}].verify must be a non-empty string when provided`);
      }
      verify = milestone.verify.trim();
    }
    return {
      id: milestone.id.trim(),
      text: milestone.text.trim(),
      done: milestone.done,
      ...(verify ? { verify } : {}),
    };
  });
  if (typeof obj.iteration !== 'number' || !Number.isFinite(obj.iteration) || obj.iteration < 0) {
    throw new Error('loop-state.json iteration must be a non-negative number');
  }
  const next = obj.next === null || obj.next === undefined
    ? null
    : typeof obj.next === 'string'
      ? obj.next.trim() || null
      : (() => {
          throw new Error('loop-state.json next must be a string or null');
        })();
  if (!Array.isArray(obj.lastFiles)) {
    throw new Error('loop-state.json lastFiles must be an array');
  }
  const lastFiles = obj.lastFiles.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`loop-state.json lastFiles[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
  return {
    version: LOOP_STATE_VERSION,
    goal: obj.goal.trim(),
    milestones,
    next,
    lastFiles,
    iteration: obj.iteration,
  };
}

export function readLoopState(
  workspaceDir: string,
  fsImpl: LoopFsRead = fs,
): LoopState | null {
  const filePath = getLoopStateFilePath(workspaceDir);
  if (!fsImpl.existsSync(filePath)) {
    return null;
  }
  const raw = JSON.parse(fsImpl.readFileSync(filePath, 'utf8')) as unknown;
  return validateLoopState(raw);
}

export function writeLoopState(
  workspaceDir: string,
  state: LoopState,
  fsImpl: LoopFsWrite = fs,
): void {
  ensureLocalagentBoxDir(workspaceDir, fsImpl);
  const body = `${JSON.stringify(validateLoopState(state), null, 2)}\n`;
  fsImpl.writeFileSync(getLoopStateFilePath(workspaceDir), body, 'utf8');
}

function parseMilestoneVerify(text: string): { text: string; verify?: string } {
  const match = text.match(/^(.+?)\s*(?:—|-)\s*verify:\s*(.+)$/i);
  if (!match) {
    return { text: text.trim() };
  }
  return { text: match[1].trim(), verify: match[2].trim() };
}

function milestoneLabelFromLine(line: string): string {
  const match = line.match(CHECKBOX_LINE_RE);
  return match ? match[3] : line;
}

function milestonesFromChecklistItems(items: ChecklistItem[]): LoopMilestone[] {
  return items.map((item, index) => {
    const parsed = parseMilestoneVerify(milestoneLabelFromLine(item.line));
    return {
      id: `m${index + 1}`,
      text: parsed.text,
      done: item.checked,
      ...(parsed.verify ? { verify: parsed.verify } : {}),
    };
  });
}

/**
 * Build or refresh loop-state.json from the markdown plan checklist.
 */
export function syncLoopStateFromPlanFile(
  workspaceDir: string,
  goal: string,
  options: {
    iteration?: number;
    next?: string | null;
    lastFiles?: string[];
    fsImpl?: LoopFsWrite;
  } = {},
): LoopState | null {
  const fsImpl = options.fsImpl ?? fs;
  const raw = readLoopPlanRawContent(workspaceDir, fsImpl);
  if (!raw) {
    return null;
  }
  const items = parseChecklistItems(raw);
  if (items.length === 0) {
    return null;
  }

  const existing = readLoopState(workspaceDir, fsImpl);
  const milestones = milestonesFromChecklistItems(items);
  const state: LoopState = {
    version: LOOP_STATE_VERSION,
    goal: goal.trim() || existing?.goal || 'Complete the goal',
    milestones,
    next: options.next ?? existing?.next ?? null,
    lastFiles: options.lastFiles ?? existing?.lastFiles ?? [],
    iteration: options.iteration ?? existing?.iteration ?? 0,
  };
  writeLoopState(workspaceDir, state, fsImpl);
  return state;
}

/**
 * Compact injection slice: next unfinished milestone + NEXT line only.
 */
export function formatLoopStateInjectionSlice(state: LoopState): string | null {
  const nextMilestone = state.milestones.find((milestone) => !milestone.done);
  const lines: string[] = [];
  if (nextMilestone) {
    const verify = nextMilestone.verify ? ` (verify: ${nextMilestone.verify})` : '';
    lines.push(`Milestone: ${nextMilestone.text}${verify}`);
  }
  if (state.next) {
    lines.push(`NEXT: ${state.next}`);
  }
  const remaining = state.milestones.filter((milestone) => !milestone.done).length;
  if (remaining > 1) {
    lines.push(`(${remaining} milestones remaining)`);
  }
  if (lines.length === 0) {
    return null;
  }
  return lines.join('\n');
}

function applyReflectToLoopState(
  workspaceDir: string,
  parsed: ParsedReflectOutput,
  options: { goal?: string; iteration?: number; fsImpl?: LoopFsWrite },
): boolean {
  const fsImpl = options.fsImpl ?? fs;
  let state = readLoopState(workspaceDir, fsImpl);
  if (!state && options.goal) {
    state = syncLoopStateFromPlanFile(workspaceDir, options.goal, {
      iteration: options.iteration,
      fsImpl,
    });
  }
  if (!state) {
    return false;
  }

  const updated: LoopState = {
    ...state,
    milestones: state.milestones.map((milestone) => {
      if (milestone.done || !parsed.done) {
        return milestone;
      }
      return shouldTickMilestone(milestone.text, parsed.done)
        ? { ...milestone, done: true }
        : milestone;
    }),
    next: parsed.next ?? state.next,
    lastFiles: parsed.filesTouched.length > 0 ? parsed.filesTouched : state.lastFiles,
    iteration: options.iteration ?? state.iteration,
  };

  const changed = JSON.stringify(updated) !== JSON.stringify(state);
  if (changed) {
    writeLoopState(workspaceDir, updated, fsImpl);
  }
  return changed;
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
  options: {
    goal?: string;
    iteration?: number;
    fsImpl?: LoopFsWrite;
  } = {},
): ApplyLedgerUpdateResult {
  const fsImpl = options.fsImpl ?? fs;
  const parsed = parseReflectOutput(reflectText);
  let ledgerUpdated = false;

  if (parsed.done?.trim() && isLoopPlanFilePresent(workspaceDir, fsImpl)) {
    const filePath = getLoopPlanFilePath(workspaceDir);
    const content = fsImpl.readFileSync(filePath, 'utf8');
    const updated = applyTicksToPlanContent(content, parsed.done);
    if (updated !== content) {
      writeLoopPlanFile(workspaceDir, updated, fsImpl);
      ledgerUpdated = true;
    }
  }

  if (options.goal && isLoopPlanFilePresent(workspaceDir, fsImpl)) {
    syncLoopStateFromPlanFile(workspaceDir, options.goal, {
      iteration: options.iteration,
      next: parsed.next,
      lastFiles: parsed.filesTouched.length > 0 ? parsed.filesTouched : undefined,
      fsImpl,
    });
    ledgerUpdated = true;
  } else if (applyReflectToLoopState(workspaceDir, parsed, options)) {
    ledgerUpdated = true;
  }

  return { parsed, ledgerUpdated };
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
  fsImpl?: LoopFsRead,
): string | null {
  const impl = fsImpl ?? fs;
  try {
    const state = readLoopState(workspaceDir, impl);
    if (state) {
      const stateSlice = formatLoopStateInjectionSlice(state);
      if (stateSlice) {
        return stateSlice;
      }
    }
  } catch {
    // Corrupt state file — fall back to markdown plan slice.
  }

  const planSlice = readLoopPlanSlice(workspaceDir, impl);
  if (planSlice) {
    return planSlice;
  }

  const raw = readLoopPlanRawContent(workspaceDir, impl);
  if (!raw) {
    return null;
  }

  return raw.length > MAX_RAW_PLAN_INJECTION_CHARS
    ? `${raw.slice(0, MAX_RAW_PLAN_INJECTION_CHARS)}…`
    : raw;
}

export function buildIterationHandoffBlock(params: BuildIterationHandoffParams): string | null {
  const impl = params.fsImpl ?? fs;
  const planBody = resolvePlanInjectionBody(params.workspaceDir, impl);
  const stateHasNext = (() => {
    try {
      return Boolean(readLoopState(params.workspaceDir, impl)?.next);
    } catch {
      return false;
    }
  })();
  const nextLine =
    !stateHasNext &&
    (params.previousReflectNext ??
      (params.previousReflectText ? parseReflectNextLine(params.previousReflectText) : null));

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
