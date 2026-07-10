import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import os from 'os';
import { ensureLocalagentBoxIgnored } from './workspace-setup';

describe('ensureLocalagentBoxIgnored', () => {
  const base = path.join(os.tmpdir(), 'test-gitignore-');

  it('creates .gitignore when it does not exist', () => {
    const dir = fs.mkdtempSync(base);
    try {
      ensureLocalagentBoxIgnored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.equal(content, '.localagent-box/\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends entry when .gitignore exists without the entry', () => {
    const dir = fs.mkdtempSync(base);
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
      ensureLocalagentBoxIgnored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.equal(content, 'node_modules/\n.localagent-box/\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when entry already present', () => {
    const dir = fs.mkdtempSync(base);
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), '.localagent-box/\nnode_modules/\n', 'utf8');
      ensureLocalagentBoxIgnored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.equal(content, '.localagent-box/\nnode_modules/\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles .gitignore not ending with newline', () => {
    const dir = fs.mkdtempSync(base);
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/', 'utf8');
      ensureLocalagentBoxIgnored(dir);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      assert.equal(content, 'node_modules/\n.localagent-box/\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
