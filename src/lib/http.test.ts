import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodePathParam } from './http';

describe('decodePathParam', () => {
  it('decodes finding IDs that contain colons', () => {
    assert.equal(decodePathParam('bace361779c1%3Afinding%3A0'), 'bace361779c1:finding:0');
  });

  it('returns plain values unchanged', () => {
    assert.equal(decodePathParam('bace361779c1'), 'bace361779c1');
  });

  it('returns malformed sequences unchanged', () => {
    assert.equal(decodePathParam('%E0%A4%A'), '%E0%A4%A');
  });
});
