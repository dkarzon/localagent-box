import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildIterationHandoffBlock,
  formatPlanSlice,
  parseReflectNextLine,
  readLoopPlanSlice,
} from './loop-handoff';

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
        previousReflectText: 'DONE: m1\nNEXT: implement m2',
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
});
