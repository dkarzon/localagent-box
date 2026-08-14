import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  applyLedgerUpdateFromReflect,
  applyTicksToPlanContent,
  buildAgentLoopHandoffSnapshot,
  buildIterationHandoffBlock,
  formatPlanSlice,
  formatLoopStateInjectionSlice,
  importLoopHandoffFromWorkspace,
  INITIAL_PLAN_RETRY_PROMPT,
  isLoopPlanFilePresent,
  parseReflectNextLine,
  parseReflectOutput,
  readLoopPlanSlice,
  readLoopState,
  seedLoopPlanFromAssistantText,
  syncLoopStateFromPlanFile,
  validateLoopState,
  writeLoopPlanFile,
  writeLoopState,
} from './loop-handoff';
import { interpolateStepPrompt } from './loop-config';

describe('parseReflectNextLine', () => {
  it('extracts NEXT from structured REFLECT output', () => {
    const text = [
      'DONE: added validation',
      'REMAINING: wire API',
      'NEXT: Add POST handler in routes/foo.ts',
      'FILES TOUCHED: src/foo.ts',
    ].join('\n');
    assert.equal(parseReflectNextLine(text), 'Add POST handler in routes/foo.ts');
  });

  it('is case-insensitive on the NEXT label', () => {
    assert.equal(parseReflectNextLine('next: fix the bug'), 'fix the bug');
  });

  it('returns null when NEXT is absent', () => {
    assert.equal(parseReflectNextLine('DONE: nothing else here'), null);
  });
});

describe('parseReflectOutput', () => {
  it('parses all structured REFLECT fields', () => {
    const text = [
      'DONE: added validation to foo.ts',
      'REMAINING: wire API route',
      'NEXT: Add POST handler',
      'FILES TOUCHED: src/foo.ts, src/bar.ts',
    ].join('\n');
    assert.deepEqual(parseReflectOutput(text), {
      done: 'added validation to foo.ts',
      remaining: 'wire API route',
      next: 'Add POST handler',
      filesTouched: ['src/foo.ts', 'src/bar.ts'],
    });
  });

  it('returns null fields when labels are missing', () => {
    assert.deepEqual(parseReflectOutput('Some unstructured text'), {
      done: null,
      remaining: null,
      next: null,
      filesTouched: [],
    });
  });
});

describe('applyTicksToPlanContent', () => {
  it('ticks milestones mentioned in DONE', () => {
    const updated = applyTicksToPlanContent(
      '- [ ] Add validation\n- [ ] Wire API',
      'Added validation to the user model',
    );
    assert.equal(updated, '- [x] Add validation\n- [ ] Wire API');
  });

  it('leaves the plan unchanged when DONE is empty', () => {
    const plan = '- [ ] Add validation';
    assert.equal(applyTicksToPlanContent(plan, ''), plan);
  });
});

describe('applyLedgerUpdateFromReflect', () => {
  it('updates loop-plan.md from REFLECT DONE text', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-ledger-update-'));
    try {
      writePlan(agentDir, '- [ ] Add validation\n- [ ] Wire API');
      const result = applyLedgerUpdateFromReflect(
        agentDir,
        'DONE: completed Add validation\nNEXT: Wire API route',
        { goal: 'Ship feature', iteration: 1 },
      );
      assert.equal(result.ledgerUpdated, true);
      assert.equal(result.parsed.next, 'Wire API route');
      const content = fs.readFileSync(planPath(agentDir), 'utf8');
      assert.match(content, /- \[x\] Add validation/);
      assert.match(content, /- \[ \] Wire API/);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('syncs loop-state.json when goal is provided', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-ledger-state-'));
    try {
      writePlan(agentDir, '- [x] Add validation\n- [ ] Wire API');
      applyLedgerUpdateFromReflect(agentDir, 'NEXT: Wire API route\nFILES TOUCHED: src/a.ts', {
        goal: 'Ship feature',
        iteration: 2,
      });
      const state = readLoopState(agentDir);
      assert.ok(state);
      assert.equal(state.goal, 'Ship feature');
      assert.equal(state.iteration, 2);
      assert.equal(state.next, 'Wire API route');
      assert.deepEqual(state.lastFiles, ['src/a.ts']);
      assert.equal(state.milestones[1]?.done, false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe('loop-state.json', () => {
  it('validates and round-trips loop state', () => {
    const state = validateLoopState({
      version: 1,
      goal: 'Ship feature',
      milestones: [{ id: 'm1', text: 'Add validation', done: false }],
      next: 'Start with models',
      lastFiles: [],
      iteration: 0,
    });
    assert.equal(state.goal, 'Ship feature');
  });

  it('syncs milestones from the markdown plan file', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-state-sync-'));
    try {
      writePlan(agentDir, '- [ ] Add validation — verify: npm test\n- [ ] Wire API');
      const state = syncLoopStateFromPlanFile(agentDir, 'Ship feature', { iteration: 0 });
      assert.ok(state);
      assert.equal(state.milestones.length, 2);
      assert.equal(state.milestones[0]?.verify, 'npm test');
      assert.equal(readLoopState(agentDir)?.goal, 'Ship feature');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('formats a compact injection slice from loop state', () => {
    const slice = formatLoopStateInjectionSlice({
      version: 1,
      goal: 'Ship',
      milestones: [
        { id: 'm1', text: 'Add validation', done: true },
        { id: 'm2', text: 'Wire API', done: false },
      ],
      next: 'Add POST handler',
      lastFiles: [],
      iteration: 2,
    });
    assert.equal(slice, 'Milestone: Wire API\nNEXT: Add POST handler');
  });

  it('prefers loop-state injection over the markdown plan slice', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-handoff-state-'));
    try {
      writePlan(agentDir, '- [ ] m1\n- [ ] m2\n- [ ] m3');
      writeLoopState(agentDir, {
        version: 1,
        goal: 'Goal',
        milestones: [
          { id: 'm1', text: 'm1', done: true },
          { id: 'm2', text: 'm2', done: false },
        ],
        next: 'do m2',
        lastFiles: [],
        iteration: 1,
      });
      const block = buildIterationHandoffBlock({ agentDir });
      assert.match(block ?? '', /Milestone: m2/);
      assert.match(block ?? '', /NEXT: do m2/);
      assert.doesNotMatch(block ?? '', /- \[ \] m3/);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe('buildAgentLoopHandoffSnapshot', () => {
  it('mirrors milestone progress for the agent record', () => {
    const snapshot = buildAgentLoopHandoffSnapshot(
      {
        version: 1,
        goal: 'Ship',
        milestones: [
          { id: 'm1', text: 'Add validation', done: true },
          { id: 'm2', text: 'Wire API', done: false },
        ],
        next: 'Add route',
        lastFiles: ['src/a.ts'],
        iteration: 2,
      },
      parseReflectOutput('REMAINING: one milestone left'),
    );
    assert.deepEqual(snapshot, {
      next: 'Add route',
      remaining: 'one milestone left',
      milestonesTotal: 2,
      milestonesDone: 1,
      currentMilestone: 'Wire API',
      lastFiles: ['src/a.ts'],
    });
  });
});

describe('importLoopHandoffFromWorkspace', () => {
  it('imports legacy workspace plan and state into the agent data directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-import-'));
    const agentDir = path.join(root, 'agent');
    const workspaceDir = path.join(root, 'workspace');
    try {
      fs.mkdirSync(path.join(workspaceDir, '.localagent-box'), { recursive: true });
      fs.writeFileSync(
        path.join(workspaceDir, '.localagent-box', 'loop-plan.md'),
        '- [ ] legacy milestone\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(workspaceDir, '.localagent-box', 'loop-state.json'),
        JSON.stringify({
          version: 1,
          goal: 'Legacy goal',
          milestones: [{ id: 'm1', text: 'legacy milestone', done: false }],
          next: null,
          lastFiles: [],
          iteration: 0,
        }),
        'utf8',
      );

      assert.equal(importLoopHandoffFromWorkspace(agentDir, workspaceDir), true);
      assert.equal(isLoopPlanFilePresent(agentDir), true);
      assert.equal(readLoopState(agentDir)?.goal, 'Legacy goal');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('formatPlanSlice', () => {
  it('includes last completed item plus all unchecked items', () => {
    const slice = formatPlanSlice([
      { checked: true, line: '- [x] milestone 1' },
      { checked: true, line: '- [x] milestone 2' },
      { checked: false, line: '- [ ] milestone 3' },
      { checked: false, line: '- [ ] milestone 4' },
    ]);
    assert.equal(
      slice,
      ['- [x] milestone 2', '- [ ] milestone 3', '- [ ] milestone 4'].join('\n'),
    );
  });

  it('returns only the last completed item when all are done', () => {
    const slice = formatPlanSlice([
      { checked: true, line: '- [x] milestone 1' },
      { checked: true, line: '- [x] milestone 2' },
    ]);
    assert.equal(slice, '- [x] milestone 2');
  });

  it('returns unchecked items when none are completed yet', () => {
    const slice = formatPlanSlice([
      { checked: false, line: '- [ ] milestone 1' },
      { checked: false, line: '- [ ] milestone 2' },
    ]);
    assert.equal(slice, '- [ ] milestone 1\n- [ ] milestone 2');
  });
});

describe('readLoopPlanSlice', () => {
  it('reads and slices a plan file from the agent data directory', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-plan-read-'));
    try {
      writePlan(agentDir, ['# Plan', '- [x] done', '- [ ] todo'].join('\n'));
      assert.equal(readLoopPlanSlice(agentDir), '- [x] done\n- [ ] todo');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('returns null when the plan file is missing', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-plan-missing-'));
    try {
      assert.equal(readLoopPlanSlice(agentDir), null);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('returns null when the plan has no checklist items', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-plan-prose-'));
    try {
      writePlan(agentDir, 'Just some prose.');
      assert.equal(readLoopPlanSlice(agentDir), null);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe('buildIterationHandoffBlock', () => {
  it('injects host-read plan slice and NEXT line when plan exists', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-handoff-plan-'));
    try {
      writePlan(agentDir, '- [x] m1\n- [ ] m2\n- [ ] m3');
      const block = buildIterationHandoffBlock({
        agentDir,
        previousReflectNext: 'implement m2',
      });
      assert.match(block ?? '', /^## Plan \(host-read\)/);
      assert.match(block ?? '', /- \[x\] m1/);
      assert.match(block ?? '', /- \[ \] m2/);
      assert.match(block ?? '', /NEXT \(from last iteration\): implement m2/);
      assert.doesNotMatch(block ?? '', /## Previous iteration summary/);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('does not duplicate NEXT when loop-state already includes it', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-handoff-state-next-'));
    try {
      writePlan(agentDir, '- [ ] m1');
      writeLoopState(agentDir, {
        version: 1,
        goal: 'Goal',
        milestones: [{ id: 'm1', text: 'm1', done: false }],
        next: 'from state',
        lastFiles: [],
        iteration: 1,
      });
      const block = buildIterationHandoffBlock({
        agentDir,
        previousReflectNext: 'from reflect',
      });
      assert.match(block ?? '', /NEXT: from state/);
      assert.doesNotMatch(block ?? '', /NEXT \(from last iteration\)/);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('injects plan slice without NEXT on the first iteration after INITIAL_PLAN', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-handoff-first-'));
    try {
      writePlan(agentDir, '- [ ] m1\n- [ ] m2');
      const block = buildIterationHandoffBlock({ agentDir });
      assert.equal(block, '## Plan (host-read)\n- [ ] m1\n- [ ] m2');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('falls back to capped REFLECT replay when no plan file exists', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-handoff-fallback-'));
    try {
      const reflect = 'DONE: something\n'.repeat(300);
      const block = buildIterationHandoffBlock({
        agentDir,
        previousReflectText: reflect,
        maxFallbackSummaryChars: 100,
      });
      assert.match(block ?? '', /^## Previous iteration summary/);
      assert.equal(block?.length, '## Previous iteration summary\n'.length + 100);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('returns null when there is no plan and no previous REFLECT output', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-handoff-empty-'));
    try {
      assert.equal(buildIterationHandoffBlock({ agentDir }), null);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('injects raw plan prose when the file has no checklist items', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-handoff-prose-'));
    try {
      writePlan(agentDir, 'High-level plan without checkboxes.');
      const block = buildIterationHandoffBlock({ agentDir });
      assert.equal(block, '## Plan (host-read)\nHigh-level plan without checkboxes.');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe('isLoopPlanFilePresent', () => {
  it('returns true for a non-empty plan file', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-plan-present-'));
    try {
      writePlan(agentDir, '- [ ] todo');
      assert.equal(isLoopPlanFilePresent(agentDir), true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('returns false when missing or whitespace-only', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-plan-absent-'));
    try {
      assert.equal(isLoopPlanFilePresent(agentDir), false);
      writePlan(agentDir, '   \n');
      assert.equal(isLoopPlanFilePresent(agentDir), false);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe('seedLoopPlanFromAssistantText', () => {
  it('extracts checklist lines from assistant output', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-seed-checklist-'));
    try {
      seedLoopPlanFromAssistantText(
        agentDir,
        'Here is the plan:\n- [ ] first\n- [ ] second\nDone.',
        'ignored',
      );
      const content = fs.readFileSync(planPath(agentDir), 'utf8');
      assert.equal(content, '- [ ] first\n- [ ] second\n');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('writes raw assistant text when no checklist lines exist', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-seed-raw-'));
    try {
      seedLoopPlanFromAssistantText(agentDir, 'Step one: do the thing.', 'goal');
      assert.equal(fs.readFileSync(planPath(agentDir), 'utf8'), 'Step one: do the thing.\n');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('falls back to a single goal milestone when assistant output is empty', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-seed-goal-'));
    try {
      seedLoopPlanFromAssistantText(agentDir, '   ', 'Ship feature X');
      assert.equal(fs.readFileSync(planPath(agentDir), 'utf8'), '- [ ] Ship feature X\n');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe('writeLoopPlanFile', () => {
  it('creates the agent directory and writes the plan file', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-write-plan-'));
    try {
      writeLoopPlanFile(agentDir, '- [ ] one');
      assert.equal(fs.readFileSync(planPath(agentDir), 'utf8'), '- [ ] one\n');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe('INITIAL_PLAN_RETRY_PROMPT', () => {
  it('interpolates the goal template variable', () => {
    const prompt = interpolateStepPrompt(INITIAL_PLAN_RETRY_PROMPT, {
      goal: 'Add caching',
      iteration: 0,
      completionMarker: 'LOOP_COMPLETE',
    });
    assert.match(prompt, /Add caching/);
    assert.match(prompt, /checklist/);
  });
});

function planPath(agentDir: string): string {
  return path.join(agentDir, 'loop-plan.md');
}

function writePlan(agentDir: string, content: string): void {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(planPath(agentDir), content, 'utf8');
}
