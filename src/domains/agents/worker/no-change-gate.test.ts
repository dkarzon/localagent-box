import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { NO_CHANGE_ARTEFACT_PATH } from '../../../lib/schemas/no-change';
import { buildNoChangeExplanationPrompt, readNoChangeArtefact } from './no-change-gate';

const roots: string[] = [];

function workspaceWithArtefact(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-change-gate-'));
  roots.push(root);
  fs.mkdirSync(path.dirname(path.join(root, NO_CHANGE_ARTEFACT_PATH)), { recursive: true });
  fs.writeFileSync(path.join(root, NO_CHANGE_ARTEFACT_PATH), body);
  return root;
}

afterEach(() => {
  while (roots.length) {
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('readNoChangeArtefact', () => {
  it('reads a valid artefact through the safe reader', () => {
    const root = workspaceWithArtefact(
      JSON.stringify({
        reason: 'not_applicable',
        explanation: 'The task asks for a rename that the shared API contract forbids.',
        evidence: ['src/types/index.ts'],
      }),
    );

    const outcome = readNoChangeArtefact(root);
    assert.equal(outcome.status, 'valid');
    assert.equal(outcome.explanation?.reason, 'not_applicable');
    assert.deepEqual(outcome.explanation?.evidence, ['src/types/index.ts']);
  });

  it('reports a missing artefact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-change-gate-'));
    roots.push(root);

    const outcome = readNoChangeArtefact(root);
    assert.equal(outcome.status, 'missing');
    assert.equal(outcome.explanation, null);
    assert.deepEqual(outcome.errors, [`no artefact at ${NO_CHANGE_ARTEFACT_PATH}`]);
  });

  it('reports an off-schema artefact with its error paths', () => {
    const root = workspaceWithArtefact(JSON.stringify({ reason: 'done', explanation: 'short' }));

    const outcome = readNoChangeArtefact(root);
    assert.equal(outcome.status, 'invalid');
    assert.deepEqual(outcome.errors, [
      'reason: must be one of already_done, not_applicable, blocked, unclear_task',
      'explanation: must be between 20 and 2000 characters',
      'evidence: must be an array of strings',
    ]);
  });

  it('refuses an artefact that is a symlink out of the workspace', () => {
    const root = workspaceWithArtefact('{}');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'no-change-gate-outside-'));
    roots.push(outside);
    const target = path.join(outside, 'no-change.json');
    fs.writeFileSync(target, JSON.stringify({ reason: 'blocked', explanation: 'x'.repeat(30), evidence: [] }));

    fs.rmSync(path.join(root, NO_CHANGE_ARTEFACT_PATH));
    try {
      fs.symlinkSync(target, path.join(root, NO_CHANGE_ARTEFACT_PATH));
    } catch {
      return;
    }

    const outcome = readNoChangeArtefact(root);
    assert.equal(outcome.status, 'invalid');
    assert.match(outcome.errors[0], /symlink/);
  });
});

describe('buildNoChangeExplanationPrompt', () => {
  it('names the artefact path and embeds the schema', () => {
    const prompt = buildNoChangeExplanationPrompt();
    assert.match(prompt, /You finished without changing any files/);
    assert.match(prompt, new RegExp(NO_CHANGE_ARTEFACT_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(prompt, /```json/);
    assert.match(prompt, /unclear_task/);
  });

  it('adds the self-validation line only when a validate command exists', () => {
    // Item 3.3 supplies the CLI; until then the host is the validator.
    assert.doesNotMatch(buildNoChangeExplanationPrompt(), /Run `validate/);
    assert.match(
      buildNoChangeExplanationPrompt({ validateCommand: 'node dist/cli/validate-artefact.js' }),
      /Run `node dist\/cli\/validate-artefact\.js no-change .*no-change\.json` before finishing\./,
    );
  });
});
