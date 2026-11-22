import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { loadReviewRepoConfigFromBase, OCR_PROJECT_RULE_RELATIVE_PATH } from './review-repo-config';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function write(dir: string, relativePath: string, content: string): void {
  const filePath = path.join(dir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function readRuleFile(dir: string): string | null {
  const filePath = path.join(dir, ...OCR_PROJECT_RULE_RELATIVE_PATH.split('/'));
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

/**
 * Creates a repo whose `main` holds `baseFiles`, then checks out `feature`
 * with `headFiles` committed on top — the shape of a review workspace.
 */
function makeRepo(baseFiles: Record<string, string>, headFiles: Record<string, string | null>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-repo-config-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  write(dir, 'README.md', 'x');
  for (const [file, content] of Object.entries(baseFiles)) write(dir, file, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  for (const [file, content] of Object.entries(headFiles)) {
    if (content === null) fs.rmSync(path.join(dir, ...file.split('/')));
    else write(dir, file, content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'head', '--allow-empty');
  return dir;
}

const baseConfig = JSON.stringify({ review: { background: 'Base instructions', effort: 'high' } });
const headConfig = JSON.stringify({ review: { background: 'Head instructions', exclude: ['**'] } });
const baseRules = JSON.stringify({ rules: [{ path: 'src/auth/**', rule: 'BASE', merge_system_rule: true }] });
const headRules = JSON.stringify({ rules: [{ path: '**', rule: 'HEAD', merge_system_rule: false }] });

describe('loadReviewRepoConfigFromBase', () => {
  it('reads the config from the base branch, ignoring head branch edits', async () => {
    const dir = makeRepo(
      { '.localagent-box/config.json': baseConfig },
      { '.localagent-box/config.json': headConfig },
    );

    const { overrides, notes } = await loadReviewRepoConfigFromBase(dir, 'main');

    assert.deepEqual(overrides?.review, { background: 'Base instructions', effort: 'high' });
    assert.ok(notes.some((note) => note.includes('from base branch main')));
  });

  it('ignores a config the head branch adds when the base branch has none', async () => {
    const dir = makeRepo({}, { '.localagent-box/config.json': headConfig });
    const { overrides } = await loadReviewRepoConfigFromBase(dir, 'main');
    assert.equal(overrides, null);
  });

  it('restores the base OCR rule file over head branch edits', async () => {
    const dir = makeRepo(
      { [OCR_PROJECT_RULE_RELATIVE_PATH]: baseRules },
      { [OCR_PROJECT_RULE_RELATIVE_PATH]: headRules },
    );
    assert.equal(readRuleFile(dir), headRules);

    const { notes } = await loadReviewRepoConfigFromBase(dir, 'main');

    assert.equal(readRuleFile(dir), baseRules);
    assert.ok(notes.some((note) => note.includes('head branch changes to it are ignored')));
  });

  it('restores the base OCR rule file when the head branch deletes it', async () => {
    const dir = makeRepo(
      { [OCR_PROJECT_RULE_RELATIVE_PATH]: baseRules },
      { [OCR_PROJECT_RULE_RELATIVE_PATH]: null },
    );
    await loadReviewRepoConfigFromBase(dir, 'main');
    assert.equal(readRuleFile(dir), baseRules);
  });

  it('removes an OCR rule file the head branch adds when the base branch has none', async () => {
    const dir = makeRepo({}, { [OCR_PROJECT_RULE_RELATIVE_PATH]: headRules });
    const { notes } = await loadReviewRepoConfigFromBase(dir, 'main');
    assert.equal(readRuleFile(dir), null);
    assert.ok(notes.some((note) => note.includes('Ignoring')));
  });

  it('fails closed when the base branch is not available', async () => {
    const dir = makeRepo({}, { '.localagent-box/config.json': headConfig, [OCR_PROJECT_RULE_RELATIVE_PATH]: headRules });

    const { overrides, notes } = await loadReviewRepoConfigFromBase(dir, 'does-not-exist');

    assert.equal(overrides, null);
    assert.equal(readRuleFile(dir), null);
    assert.ok(notes.some((note) => note.startsWith('Warning: base branch does-not-exist is not available')));
  });

  it('throws on an invalid config file on the base branch', async () => {
    const dir = makeRepo({ '.localagent-box/config.json': JSON.stringify({ review: { effort: 'max' } }) }, {});
    await assert.rejects(() => loadReviewRepoConfigFromBase(dir, 'main'), /Failed to load .*effort must be one of/);
  });
});
