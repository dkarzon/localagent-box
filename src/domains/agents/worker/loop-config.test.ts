import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  interpolateStepPrompt,
  loadLoopConfig,
  loadServerDefaultLoopConfig,
  parseCompletionSignal,
  validateLoopConfig,
} from './loop-config';

describe('validateLoopConfig', () => {
  const valid = {
    version: 1,
    maxIterations: 5,
    completionMarker: 'LOOP_COMPLETE',
    steps: [
      { verb: 'OBSERVE', prompt: 'Look at {{goal}}' },
      { verb: 'REFLECT', prompt: 'Done? {{completionMarker}}: true' },
    ],
  };

  it('accepts a valid config', () => {
    const result = validateLoopConfig(valid);
    assert.equal(result.maxIterations, 5);
    assert.equal(result.steps.length, 2);
  });

  it('rejects invalid version', () => {
    assert.throws(() => validateLoopConfig({ ...valid, version: 2 }), /version must be 1/);
  });

  it('rejects empty steps', () => {
    assert.throws(() => validateLoopConfig({ ...valid, steps: [] }), /non-empty array/);
  });

  it('rejects invalid verb', () => {
    assert.throws(
      () =>
        validateLoopConfig({
          ...valid,
          steps: [{ verb: 'RUN', prompt: 'x' }],
        }),
      /verb must be one of/,
    );
  });

  it('accepts optional initialPlanPrompt', () => {
    const result = validateLoopConfig({
      ...valid,
      initialPlanPrompt: 'Plan for {{goal}}',
    });
    assert.equal(result.initialPlanPrompt, 'Plan for {{goal}}');
  });

  it('rejects empty initialPlanPrompt', () => {
    assert.throws(
      () => validateLoopConfig({ ...valid, initialPlanPrompt: '   ' }),
      /initialPlanPrompt must be a non-empty string/,
    );
  });
});

describe('loadLoopConfig', () => {
  it('uses server default when no repo override exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-config-'));
    const loaded = loadLoopConfig(dir);
    assert.equal(loaded.configSource, 'server-default');
    assert.equal(loaded.config.version, 1);
    assert.ok(loaded.config.steps.length >= 4);
  });

  it('replaces server default entirely when repo loop.json exists (M1)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-config-'));
    const repoDir = path.join(dir, '.localagent-box');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'loop.json'),
      JSON.stringify({
        version: 1,
        maxIterations: 2,
        completionMarker: 'DONE',
        steps: [{ verb: 'ACT', prompt: 'Custom {{goal}} step' }],
      }),
      'utf8',
    );

    const loaded = loadLoopConfig(dir);
    assert.equal(loaded.configSource, 'repo-override');
    assert.equal(loaded.config.maxIterations, 2);
    assert.equal(loaded.config.completionMarker, 'DONE');
    assert.equal(loaded.config.steps.length, 1);
    assert.equal(loaded.config.steps[0].prompt, 'Custom {{goal}} step');
  });
});

describe('loadServerDefaultLoopConfig', () => {
  it('loads bundled default with initial plan and four harness steps', () => {
    const config = loadServerDefaultLoopConfig();
    assert.equal(config.version, 1);
    assert.ok(config.initialPlanPrompt?.includes('{{goal}}'));
    assert.equal(config.steps.length, 4);
    assert.deepEqual(
      config.steps.map((step) => step.verb),
      ['OBSERVE', 'PLAN', 'ACT', 'REFLECT'],
    );
  });
});

describe('interpolateStepPrompt', () => {
  it('replaces template variables', () => {
    const result = interpolateStepPrompt(
      'Goal: {{goal}} Iter: {{iteration}} Marker: {{completionMarker}}',
      { goal: 'fix bug', iteration: 3, completionMarker: 'LOOP_COMPLETE' },
    );
    assert.equal(result, 'Goal: fix bug Iter: 3 Marker: LOOP_COMPLETE');
  });
});

describe('parseCompletionSignal', () => {
  const reflectPrompt =
    'Evaluate progress toward the goal. If the goal is fully achieved, output a line exactly: `LOOP_COMPLETE: true`\nOtherwise summarize remaining gaps.\n\nGoal: fix bug\nIteration: 3';

  it('detects completion marker line case-insensitively', () => {
    assert.equal(
      parseCompletionSignal('Summary of work\nLOOP_COMPLETE: true\n', 'LOOP_COMPLETE'),
      true,
    );
    assert.equal(parseCompletionSignal('loop_complete: true', 'LOOP_COMPLETE'), true);
  });

  it('rejects false or missing markers', () => {
    assert.equal(parseCompletionSignal('LOOP_COMPLETE: false', 'LOOP_COMPLETE'), false);
    assert.equal(parseCompletionSignal('Still working on it', 'LOOP_COMPLETE'), false);
    assert.equal(parseCompletionSignal(null, 'LOOP_COMPLETE'), false);
  });

  it('rejects marker followed by extra text on same line', () => {
    assert.equal(
      parseCompletionSignal('Not yet LOOP_COMPLETE: true embedded', 'LOOP_COMPLETE'),
      false,
    );
  });

  it('detects marker appearing mid-line preceded by other text', () => {
    assert.equal(
      parseCompletionSignal('Goal achieved. LOOP_COMPLETE: true', 'LOOP_COMPLETE'),
      true,
    );
    assert.equal(
      parseCompletionSignal(
        'Some analysis...\nDone — LOOP_COMPLETE: true\nSummary follows.',
        'LOOP_COMPLETE',
      ),
      true,
    );
  });

  it('detects marker in markdown list or emphasis wrappers', () => {
    assert.equal(parseCompletionSignal('- LOOP_COMPLETE: true', 'LOOP_COMPLETE'), true);
    assert.equal(parseCompletionSignal('**LOOP_COMPLETE: true**', 'LOOP_COMPLETE'), true);
    assert.equal(parseCompletionSignal('Summary: LOOP_COMPLETE: true', 'LOOP_COMPLETE'), true);
    assert.equal(parseCompletionSignal('All work done so LOOP_COMPLETE: true.', 'LOOP_COMPLETE'), true);
  });

  it('rejects negation prose and substring marker false positives', () => {
    assert.equal(parseCompletionSignal('Not yet LOOP_COMPLETE: true', 'LOOP_COMPLETE'), false);
    assert.equal(parseCompletionSignal('still need LOOP_COMPLETE: true', 'LOOP_COMPLETE'), false);
    assert.equal(parseCompletionSignal('ALMOST_DONE: true', 'DONE'), false);
  });

  it('rejects instruction reference lines from the step prompt', () => {
    assert.equal(
      parseCompletionSignal(
        'If the goal is fully achieved, output a line exactly: LOOP_COMPLETE: true',
        'LOOP_COMPLETE',
      ),
      false,
    );
    assert.equal(
      parseCompletionSignal('If the goal is fully achieved, output a line exactly: `LOOP_COMPLETE: true`', 'LOOP_COMPLETE'),
      false,
    );
  });

  it('ignores responses that echo the REFLECT step prompt', () => {
    const echoed = `${reflectPrompt}\n\nProgress: still need tests.`;
    assert.equal(parseCompletionSignal(echoed, 'LOOP_COMPLETE', reflectPrompt), false);
    assert.equal(parseCompletionSignal(reflectPrompt, 'LOOP_COMPLETE', reflectPrompt), false);
  });

  it('accepts genuine completion after non-echo analysis even when prompt mentions marker', () => {
    const output =
      'Implemented fixes and verified tests pass.\n\nGoal achieved. LOOP_COMPLETE: true';
    assert.equal(parseCompletionSignal(output, 'LOOP_COMPLETE', reflectPrompt), true);
  });

  it('accepts completion marker appended after partial prompt echo', () => {
    const output = `${reflectPrompt}\n\nAll verification passed.\nLOOP_COMPLETE: true`;
    assert.equal(parseCompletionSignal(output, 'LOOP_COMPLETE', reflectPrompt), true);
  });
});
