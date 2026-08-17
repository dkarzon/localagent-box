import assert from 'node:assert/strict';
import test from 'node:test';
import { formatErrorForLog } from './process-handlers';

test('formatErrorForLog captures Error details', () => {
  const err = new Error('boom');
  const details = formatErrorForLog(err);

  assert.equal(details.err, err);
  assert.equal(details.errName, 'Error');
  assert.equal(details.errMessage, 'boom');
  assert.match(String(details.errStack), /boom/);
});

test('formatErrorForLog stringifies non-Error values', () => {
  const details = formatErrorForLog('plain failure');

  assert.equal(details.err, 'plain failure');
  assert.equal(details.errType, 'string');
  assert.equal(details.errValue, 'plain failure');
});

test('formatErrorForLog handles plain objects', () => {
  const details = formatErrorForLog({ code: 'E_FAIL', detail: 'bad' });

  assert.deepEqual(details.err, { code: 'E_FAIL', detail: 'bad' });
  assert.equal(details.errType, 'Object');
});
