import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatLoopStepAgentsSummary, resolveLoopStepOpenCodeAgent } from './loop-agent';

describe('resolveLoopStepOpenCodeAgent', () => {
  it('uses read-only plan for ORIENT and REFLECT by default', () => {
    assert.equal(resolveLoopStepOpenCodeAgent('ORIENT'), 'plan');
    assert.equal(resolveLoopStepOpenCodeAgent('REFLECT'), 'plan');
  });

  it('uses build for INITIAL_PLAN and ACT by default', () => {
    assert.equal(resolveLoopStepOpenCodeAgent('INITIAL_PLAN'), 'build');
    assert.equal(resolveLoopStepOpenCodeAgent('ACT'), 'build');
  });

  it('honors per-step agent overrides from loop.json', () => {
    assert.equal(resolveLoopStepOpenCodeAgent('ORIENT', 'build'), 'build');
    assert.equal(resolveLoopStepOpenCodeAgent('ACT', 'plan'), 'plan');
  });
});

describe('formatLoopStepAgentsSummary', () => {
  it('lists INITIAL_PLAN plus each configured step', () => {
    const summary = formatLoopStepAgentsSummary([
      { verb: 'ORIENT', prompt: 'x', agent: 'plan' },
      { verb: 'ACT', prompt: 'y' },
      { verb: 'REFLECT', prompt: 'z' },
    ]);
    assert.equal(summary, 'INITIAL_PLAN=build, ORIENT=plan, ACT=build, REFLECT=plan');
  });
});
