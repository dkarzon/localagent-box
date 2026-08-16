import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import os from 'os';
import { initCodegraph, ensureLocalagentBoxIgnored, checkoutJobBranch } from './workspace-setup';

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

describe('initCodegraph', () => {
  function makeLogPath(): { dir: string; logPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-codegraph-'));
    return { dir, logPath: path.join(dir, 'agent.log') };
  }

  it('runs `codegraph init` in the workspace and reports success', async () => {
    const { dir, logPath } = makeLogPath();
    try {
      const calls: { file: string; args: string[]; cwd?: string }[] = [];
      const execStub = (async (file: string, args: string[], opts: { cwd?: string }) => {
        calls.push({ file, args, cwd: opts.cwd });
        return { stdout: '', stderr: '' };
      }) as never;

      const ok = await initCodegraph('/workspace/agents/abc', logPath, execStub);

      assert.equal(ok, true);
      assert.deepEqual(calls, [
        { file: 'codegraph', args: ['init'], cwd: '/workspace/agents/abc' },
      ]);
      assert.match(fs.readFileSync(logPath, 'utf8'), /codegraph index built/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is non-fatal when init fails', async () => {
    const { dir, logPath } = makeLogPath();
    try {
      const execStub = (async () => {
        throw new Error('binary not found');
      }) as never;

      const ok = await initCodegraph('/workspace/agents/abc', logPath, execStub);

      assert.equal(ok, false);
      assert.match(
        fs.readFileSync(logPath, 'utf8'),
        /codegraph init failed.*binary not found/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkoutJobBranch', () => {
  function makeLogPath(): { dir: string; logPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-checkout-'));
    return { dir, logPath: path.join(dir, 'agent.log') };
  }

  function stubGit(remoteExists: boolean) {
    const created: string[] = [];
    const fetched: Array<{ branch: string; shallow?: boolean }> = [];
    return {
      created,
      fetched,
      gitService: {
        remoteBranchExists: async () => remoteExists,
        fetchAndCheckoutBranch: async (
          _dir: string,
          branch: string,
          options?: { shallow?: boolean },
        ) => {
          fetched.push({ branch, shallow: options?.shallow });
        },
        createBranch: async (_dir: string, branch: string) => {
          created.push(branch);
        },
      },
    };
  }

  it('stays on the cloned branch when agentBranch equals baseBranch', async () => {
    const { dir, logPath } = makeLogPath();
    try {
      const stub = stubGit(true);
      const result = await checkoutJobBranch(
        stub.gitService,
        { workspaceDir: '/ws', baseBranch: 'main', agentBranch: 'main' },
        { shallow: true, logPath },
      );
      assert.equal(result, 'cloned');
      assert.deepEqual(stub.created, []);
      assert.deepEqual(stub.fetched, []);
      assert.match(fs.readFileSync(logPath, 'utf8'), /Checked out existing branch main/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fetches the agent branch when it exists on origin', async () => {
    const { dir, logPath } = makeLogPath();
    try {
      const stub = stubGit(true);
      const result = await checkoutJobBranch(
        stub.gitService,
        { workspaceDir: '/ws', baseBranch: 'main', agentBranch: 'feature/project' },
        { shallow: true, logPath },
      );
      assert.equal(result, 'fetched');
      assert.deepEqual(stub.created, []);
      assert.deepEqual(stub.fetched, [{ branch: 'feature/project', shallow: true }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the agent branch from base when origin does not have it', async () => {
    const { dir, logPath } = makeLogPath();
    try {
      const stub = stubGit(false);
      const result = await checkoutJobBranch(
        stub.gitService,
        { workspaceDir: '/ws', baseBranch: 'main', agentBranch: 'feature/project' },
        { shallow: true, logPath },
      );
      assert.equal(result, 'created');
      assert.deepEqual(stub.created, ['feature/project']);
      assert.deepEqual(stub.fetched, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
