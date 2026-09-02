import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDshCredentialsFile } from './write-dsh-credentials.mjs';

test('writeDshCredentialsFile writes versioned refs document', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cred-'));
  writeDshCredentialsFile(dir, { OLLAMA_API_KEY: 'ollama' });
  const text = fs.readFileSync(path.join(dir, '.credentials.yaml'), 'utf8');
  assert.match(text, /^version: 1\nrefs:\n  OLLAMA_API_KEY: ollama\n$/);
});
