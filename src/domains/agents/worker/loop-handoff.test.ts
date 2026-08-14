import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  applyLedgerUpdateFromReflect,
  applyTicksToPlanContent,
  buildIterationHandoffBlock,
  formatPlanSlice,
  INITIAL_PLAN_RETRY_PROMPT,
  isLoopPlanFilePresent,
  parseReflectNextLine,
  parseReflectOutput,
  readLoopPlanSlice,
  seedLoopPlanFromAssistantText,
  writeLoopPlanFile,
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-ledger-update-'));
    try {
      writePlan(dir, '- [ ] Add validation\n- [ ] Wire API');
      const result = applyLedgerUpdateFromReflect(
        dir,
        'DONE: completed Add validation\nNEXT: Wire API route',
      );
      assert.equal(result.ledgerUpdated, true);
      assert.equal(result.parsed.next, 'Wire API route');
      const content = fs.readFileSync(path.join(dir, '.localagent-box', 'loop-plan.md'), 'utf8');
      assert.match(content, /- \[x\] Add validation/);
      assert.match(content, /- \[ \] Wire API/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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
  it('reads and slices a plan file from the workspace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-plan-read-'));
    try {
      const planDir = path.join(dir, '.localagent-box');
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(
        path.join(planDir, 'loop-plan.md'),
        ['# Plan', '- [x] done', '- [ ] todo'].join('\n'),
        'utf8',
      );
      assert.equal(readLoopPlanSlice(dir), '- [x] done\n- [ ] todo');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the plan file is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-plan-missing-'));
    try {
      assert.equal(readLoopPlanSlice(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the plan has no checklist items', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-plan-prose-'));
    try {
      const planDir = path.join(dir, '.localagent-box');
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(path.join(planDir, 'loop-plan.md'), 'Just some prose.', 'utf8');
      assert.equal(readLoopPlanSlice(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildIterationHandoffBlock', () => {
  function writePlan(dir: string, content: string): void {
    const planDir = path.join(dir, '.localagent-box');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, 'loop-plan.md'), content, 'utf8');
  }

  it('injects host-read plan slice and NEXT line when plan exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-handoff-plan-'));
    try {
      writePlan(dir, '- [x] m1\n- [ ] m2\n- [ ] m3');
      const block = buildIterationHandoffBlock({
        workspaceDir: dir,
        previousReflectNext: 'implement m2',
      });
      assert.match(block ?? '', /^## Plan \(host-read\)/);
      assert.match(block ?? '', /- \[x\] m1/);
      assert.match(block ?? '', /- \[ \] m2/);
      assert.match(block ?? '', /NEXT \(from last iteration\): implement m2/);
      assert.doesNotMatch(block ?? '', /## Previous iteration summary/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injects plan slice without NEXT on the first iteration after INITIAL_PLAN', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-handoff-first-'));
    try {
      writePlan(dir, '- [ ] m1\n- [ ] m2');
      const block = buildIterationHandoffBlock({ workspaceDir: dir });
      assert.equal(block, '## Plan (host-read)\n- [ ] m1\n- [ ] m2');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to capped REFLECT replay when no plan file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-handoff-fallback-'));
    try {
      const reflect = 'DONE: something\n'.repeat(300);
      const block = buildIterationHandoffBlock({
        workspaceDir: dir,
        previousReflectText: reflect,
        maxFallbackSummaryChars: 100,
      });
      assert.match(block ?? '', /^## Previous iteration summary/);
      assert.equal(block?.length, '## Previous iteration summary\n'.length + 100);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when there is no plan and no previous REFLECT output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-handoff-empty-'));
    try {
      assert.equal(buildIterationHandoffBlock({ workspaceDir: dir }), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injects raw plan prose when the file has no checklist items', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-handoff-prose-'));
    try {
      writePlan(dir, 'High-level plan without checkboxes.');
      const block = buildIterationHandoffBlock({ workspaceDir: dir });
      assert.equal(block, '## Plan (host-read)\nHigh-level plan without checkboxes.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isLoopPlanFilePresent', () => {
  it('returns true for a non-empty plan file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-plan-present-'));
    try {
      writePlan(dir, '- [ ] todo');
      assert.equal(isLoopPlanFilePresent(dir), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when missing or whitespace-only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-plan-absent-'));
    try {
      assert.equal(isLoopPlanFilePresent(dir), false);
      writePlan(dir, '   \n');
      assert.equal(isLoopPlanFilePresent(dir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('seedLoopPlanFromAssistantText', () => {
  function planPath(dir: string): string {
    return path.join(dir, '.localagent-box', 'loop-plan.md');
  }

  it('extracts checklist lines from assistant output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-seed-checklist-'));
    try {
      seedLoopPlanFromAssistantText(
        dir,
        'Here is the plan:\n- [ ] first\n- [ ] second\nDone.',
        'ignored',
      );
      const content = fs.readFileSync(planPath(dir), 'utf8');
      assert.equal(content, '- [ ] first\n- [ ] second\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes raw assistant text when no checklist lines exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-seed-raw-'));
    try {
      seedLoopPlanFromAssistantText(dir, 'Step one: do the thing.', 'goal');
      assert.equal(fs.readFileSync(planPath(dir), 'utf8'), 'Step one: do the thing.\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to a single goal milestone when assistant output is empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-seed-goal-'));
    try {
      seedLoopPlanFromAssistantText(dir, '   ', 'Ship feature X');
      assert.equal(fs.readFileSync(planPath(dir), 'utf8'), '- [ ] Ship feature X\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeLoopPlanFile', () => {
  it('creates .localagent-box and writes the plan file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-write-plan-'));
    try {
      writeLoopPlanFile(dir, '- [ ] one');
      assert.equal(
        fs.readFileSync(path.join(dir, '.localagent-box', 'loop-plan.md'), 'utf8'),
        '- [ ] one\n',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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
    assert.match(prompt, /loop-plan\.md/);
  });
});

function writePlan(dir: string, content: string): void {
  const planDir = path.join(dir, '.localagent-box');
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, 'loop-plan.md'), content, 'utf8');
}
