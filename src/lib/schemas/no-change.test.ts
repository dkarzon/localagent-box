import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NO_CHANGE_ARTEFACT_PATH,
  NO_CHANGE_SCHEMA,
  noChangeSchemaBlock,
  parseNoChangeExplanation,
} from './no-change';

const valid = {
  reason: 'already_done',
  explanation: 'The branch already carries the fix, so no edit was needed here.',
  evidence: ['src/a.test.ts', 'git log -1'],
};

function errorsOf(text: string): string[] {
  const result = parseNoChangeExplanation(text);
  return result.ok ? [] : result.errors;
}

describe('parseNoChangeExplanation', () => {
  it('accepts a valid artefact', () => {
    const result = parseNoChangeExplanation(JSON.stringify(valid));
    assert.ok(result.ok);
    assert.equal(result.value.reason, 'already_done');
    assert.deepEqual(result.value.evidence, ['src/a.test.ts', 'git log -1']);
  });

  it('accepts a fenced json reply', () => {
    const result = parseNoChangeExplanation('```json\n' + JSON.stringify(valid) + '\n```');
    assert.ok(result.ok);
    assert.equal(result.value.explanation, valid.explanation);
  });

  it('reports readable paths for off-schema values', () => {
    assert.deepEqual(
      errorsOf(
        JSON.stringify({
          reason: 'not_done',
          explanation: 'too short',
          evidence: ['src/a.test.ts', '   '],
        }),
      ),
      [
        'reason: must be one of already_done, not_applicable, blocked, unclear_task',
        'explanation: must be between 20 and 2000 characters',
        'evidence[1]: must be a non-empty string',
      ],
    );
  });

  it('rejects a missing object, wrong types and too much evidence', () => {
    assert.deepEqual(errorsOf('no JSON here'), ['<root>: no JSON object found']);
    assert.deepEqual(errorsOf('[1,2]'), ['<root>: no JSON object found']);
    assert.deepEqual(errorsOf('{'), ['<root>: no JSON object found']);
    assert.ok(errorsOf('{ not json }')[0].startsWith('<root>: invalid JSON'));
    assert.deepEqual(errorsOf(JSON.stringify({ ...valid, evidence: null })), [
      'evidence: must be an array of strings',
    ]);
    assert.deepEqual(
      errorsOf(JSON.stringify({ ...valid, evidence: Array.from({ length: 11 }, (_, i) => `e${i}`) })),
      ['evidence: must have at most 10 items'],
    );
  });
});

describe('noChangeSchemaBlock', () => {
  it('renders the schema as a fenced JSON Schema object', () => {
    const block = noChangeSchemaBlock();
    assert.match(block, /^```json\n/);
    const schema = JSON.parse(block.replace(/^```json\n/, '').replace(/```$/, '')) as Record<string, unknown>;
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['reason', 'explanation', 'evidence']);
    assert.ok(Object.keys((schema.properties as Record<string, unknown>) ?? {}).includes('reason'));
  });

  it('points at the artefact path the prompt names', () => {
    assert.equal(NO_CHANGE_ARTEFACT_PATH, '.localagent-box/artefacts/no-change.json');
    assert.ok(JSON.stringify(NO_CHANGE_SCHEMA).includes('unclear_task'));
  });
});
