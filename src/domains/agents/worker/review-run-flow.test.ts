import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { Agent, AgentJob, AppConfig } from '../../../types';
import { createJsonStore } from '../../../lib/json-store';
import { completeReviewCheck, resolveReviewRunConfig, runReviewJob } from './review-run-flow';
import type { WorkerContext } from './worker-context';

describe('resolveReviewRunConfig', () => {
  const baseConfig = {
    ollamaBaseUrl: 'http://localhost:11434',
    opencodeModel: 'qwen2.5-coder:7b',
    reviewModel: 'llama3.2',
  } as AppConfig;

  it('overrides reviewModel when job.model is set', () => {
    const job = { model: 'mistral:7b' } as AgentJob;
    const resolved = resolveReviewRunConfig(baseConfig, job);
    assert.equal(resolved.reviewModel, 'mistral:7b');
    assert.equal(resolved.opencodeModel, 'qwen2.5-coder:7b');
  });

  it('returns config unchanged when job.model is absent', () => {
    const job = {} as AgentJob;
    const resolved = resolveReviewRunConfig(baseConfig, job);
    assert.equal(resolved, baseConfig);
  });
});

const cleanups: Array<() => void> = [];

afterEach(() => {
  const envKeys = ['OCR_BIN'];
  for (const key of envKeys) {
    delete process.env[key];
  }
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()!;
    cleanup();
  }
});

function writeOcrStub(dir: string, response: unknown): void {
  // A shell script that prints the fixture JSON regardless of arguments.
  const script = `#!/bin/sh\ncat <<'OCR_EOF'\n${JSON.stringify(response)}\nOCR_EOF\n`;
  const binPath = path.join(dir, 'ocr');
  fs.writeFileSync(binPath, script, 'utf8');
  fs.chmodSync(binPath, 0o755);
}

function makeReviewAgent(agentId: string): Agent {
  return {
    agentId,
    workspaceId: 'ws1',
    repoId: 'r1',
    mode: 'review',
    prompt: '',
    systemPrompt: null,
    baseBranch: 'main',
    agentBranch: 'feature',
    commitMessage: '',
    push: false,
    pushOnFailure: false,
    model: null,
    status: 'running',
    commitSha: null,
    pushed: false,
    filesChanged: null,
    createdAt: '2026-09-04T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    branch: 'feature',
    error: null,
    result: null,
    parentAgentId: null,
    review: {
      baseBranch: 'main',
      headBranch: 'feature',
      background: null,
    },
  };
}

interface FlowHarness {
  root: string;
  dataDir: string;
  agentDir: string;
  agentsStore: ReturnType<typeof createJsonStore<{ agents: Agent[] }>>;
  ctx: WorkerContext;
  postedReviewComments: Array<{
    id: number;
    html_url: string;
    path: string;
    line: number | null;
    start_line: number | null;
  }>;
}

function makeFlowHarness(root: string, expectedSha: string | null): FlowHarness {
  const dataDir = path.join(root, 'data');
  const workspaceDir = path.join(root, 'workspace');
  const agentDir = path.join(dataDir, 'agents', 'rev1');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  if (expectedSha) {
    const { execFileSync } = require('node:child_process') as {
      execFileSync: (cmd: string, args: string[], opts: object) => Buffer;
    };
    execFileSync('git', ['init', '-q'], { cwd: workspaceDir });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: workspaceDir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: workspaceDir });
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), 'x', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: workspaceDir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: workspaceDir });
  }

  const agent = makeReviewAgent('rev1');
  const agentsStore = createJsonStore<{ agents: Agent[] }>(
    path.join(dataDir, 'agents.json'),
    { agents: [] },
    fs,
  );
  agentsStore.save({ agents: [agent] });

  const job: AgentJob = {
    agentId: 'rev1',
    workspaceId: 'ws1',
    repoId: 'r1',
    mode: 'review',
    prompt: '',
    baseBranch: 'main',
    agentBranch: 'feature',
    headBranch: 'feature',
    commitMessage: '',
    push: false,
    pushOnFailure: false,
    agentTimeoutMs: 60000,
    dataDir,
    workspaceRoot: root,
    workspaceDir,
    logPath: path.join(agentDir, 'worker.log'),
  };

  const config = {
    ollamaBaseUrl: 'http://localhost:11434',
    opencodeModel: 'model',
    reviewModel: 'model',
  } as AppConfig;

  const postedReviewComments: FlowHarness['postedReviewComments'] = [];
  let nextCommentId = 100;

  const ctx = {
    job,
    logPath: job.logPath,
    config,
    repo: undefined,
    agentsStore,
    githubApp: {
      findPullRequestByHead: async () => null,
      createCheckRun: async () => {
        throw new Error('not implemented');
      },
      updateCheckRun: async () => {
        throw new Error('not implemented');
      },
      createPullRequestReview: async () => ({ id: '1', html_url: 'x' }),
      createPullRequestReviewComment: async () => ({ id: '2', html_url: 'x' }),
      listPullRequestReviewComments: async () => postedReviewComments,
      createPullRequestReviewCommentWithId: undefined,
    },
  } as unknown as WorkerContext;

  const githubApp = (ctx as unknown as { githubApp: Record<string, unknown> }).githubApp;
  githubApp.createPullRequestReviewComment = async (
    _config: unknown,
    _owner: string,
    _repoName: string,
    _prNumber: number,
    _input: { path: string; subject_type?: string },
  ) => {
    const id = nextCommentId;
    nextCommentId += 1;
    return { id: String(id), html_url: `https://github.com/x/comments/${id}` };
  };

  return { root, dataDir, agentDir, agentsStore, ctx, postedReviewComments };
}

describe('runReviewJob findings persistence', () => {
  it('normalizes OCR output and persists review-findings.json with the reviewed SHA', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, {
      status: 'ok',
      comments: [
        { content: 'Fix this', severity: 'high', path: 'a.ts', start_line: 3, end_line: 4 },
        { content: 'Note something', path: 'b.ts' },
      ],
    });

    const harness = makeFlowHarness(root, null);
    await runReviewJob(harness.ctx);

    const findingsPath = path.join(harness.agentDir, 'review-findings.json');
    assert.ok(fs.existsSync(findingsPath), 'review-findings.json should be written');
    const persisted = JSON.parse(fs.readFileSync(findingsPath, 'utf8')) as Array<{
      id: string;
      reviewedSha: string | null;
      fixStatus: string;
      severity: string;
    }>;
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].id, 'rev1:finding:0');
    assert.equal(persisted[0].severity, 'high');
    assert.equal(persisted[0].fixStatus, 'available');
    assert.equal(persisted[1].severity, 'unknown');

    const log = fs.readFileSync(path.join(harness.agentDir, 'worker.log'), 'utf8');
    assert.ok(log.includes('Persisted 2 structured finding(s)'));
    assert.ok(log.includes('Review agent completed successfully'));
  });

  it('persists an empty findings array for OCR output without comments', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, { status: 'ok', comments: [] });

    const harness = makeFlowHarness(root, null);
    await runReviewJob(harness.ctx);

    const findingsPath = path.join(harness.agentDir, 'review-findings.json');
    assert.ok(fs.existsSync(findingsPath));
    const persisted = JSON.parse(fs.readFileSync(findingsPath, 'utf8')) as unknown[];
    assert.deepEqual(persisted, []);
  });

  it('captures line and file comment IDs and maps them onto findings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, {
      status: 'ok',
      comments: [
        { content: 'Line issue', severity: 'high', path: 'a.ts', start_line: 3, end_line: 4 },
        { content: 'File issue', path: 'b.ts' },
        { content: 'Summary only' },
      ],
    });

    const harness = makeFlowHarness(root, null);
    // Repo present so GitHub posting runs; PR found so the review posts.
    (harness.ctx as { repo: unknown }).repo = {
      repoId: 'r1',
      owner: 'o',
      name: 'n',
      defaultBranch: 'main',
      cloneUrl: '',
      registeredAt: '',
      lastVerifiedAt: null,
      lastVerifyStatus: null,
      lastVerifyMessage: null,
      autoReviewPullRequests: null,
    };
    const githubApp = (harness.ctx as unknown as { githubApp: Record<string, unknown> }).githubApp;
    githubApp.findPullRequestByHead = async () => ({ number: 7, head: { sha: 'sha123' } });
    harness.postedReviewComments.push({
      id: 501,
      html_url: 'https://github.com/o/n/pull/7#discussion_r501',
      path: 'a.ts',
      line: 4,
      start_line: 3,
    });

    await runReviewJob(harness.ctx);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(harness.agentDir, 'review-findings.json'), 'utf8'),
    ) as Array<{
      ordinal: number;
      github: {
        reviewId: string | null;
        commentId: number | null;
        commentUrl: string | null;
        resolutionStatus: string;
      };
    }>;

    assert.equal(persisted.length, 3);
    // Line comment mapped from the submitted review.
    assert.equal(persisted[0].github.commentId, 501);
    assert.equal(persisted[0].github.reviewId, '1');
    assert.equal(persisted[0].github.resolutionStatus, 'pending');
    // File comment captured from createPullRequestReviewComment.
    assert.equal(persisted[1].github.commentId, 100);
    assert.equal(persisted[1].github.commentUrl, 'https://github.com/x/comments/100');
    assert.equal(persisted[1].github.resolutionStatus, 'pending');
    // Summary-only finding has no comment and stays not_applicable.
    assert.equal(persisted[2].github.commentId, null);
    assert.equal(persisted[2].github.resolutionStatus, 'not_applicable');

    const log = fs.readFileSync(path.join(harness.agentDir, 'worker.log'), 'utf8');
    assert.ok(log.includes('Mapped 1 line comment(s) onto findings'));
    assert.ok(log.includes('Posted 1 file-level comment(s)'));
  });

  it('leaves findings unlinked when posted comments cannot be mapped', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, {
      status: 'ok',
      comments: [
        { content: 'Line issue', severity: 'high', path: 'a.ts', start_line: 3, end_line: 4 },
      ],
    });

    const harness = makeFlowHarness(root, null);
    (harness.ctx as { repo: unknown }).repo = {
      repoId: 'r1',
      owner: 'o',
      name: 'n',
      defaultBranch: 'main',
      cloneUrl: '',
      registeredAt: '',
      lastVerifiedAt: null,
      lastVerifyStatus: null,
      lastVerifyMessage: null,
      autoReviewPullRequests: null,
    };
    const githubApp = (harness.ctx as unknown as { githubApp: Record<string, unknown> }).githubApp;
    githubApp.findPullRequestByHead = async () => ({ number: 7, head: { sha: 'sha123' } });
    // The listed comment does not match the line comment's path/line.
    harness.postedReviewComments.push({
      id: 900,
      html_url: 'https://github.com/o/n/pull/7#discussion_r900',
      path: 'other.ts',
      line: 99,
      start_line: null,
    });

    await runReviewJob(harness.ctx);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(harness.agentDir, 'review-findings.json'), 'utf8'),
    ) as Array<{
      github: { commentId: number | null; resolutionStatus: string };
    }>;
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].github.commentId, null);
    assert.equal(persisted[0].github.resolutionStatus, 'not_applicable');

    const log = fs.readFileSync(path.join(harness.agentDir, 'worker.log'), 'utf8');
    assert.ok(log.includes('could not map a GitHub comment to finding ordinal 0'));
  });

  it('keeps findings persisted and unlinked when GitHub posting fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, {
      status: 'ok',
      comments: [
        { content: 'Line issue', severity: 'high', path: 'a.ts', start_line: 3, end_line: 4 },
      ],
    });

    const harness = makeFlowHarness(root, null);
    (harness.ctx as { repo: unknown }).repo = {
      repoId: 'r1',
      owner: 'o',
      name: 'n',
      defaultBranch: 'main',
      cloneUrl: '',
      registeredAt: '',
      lastVerifiedAt: null,
      lastVerifyStatus: null,
      lastVerifyMessage: null,
      autoReviewPullRequests: null,
    };
    const githubApp = (harness.ctx as unknown as { githubApp: Record<string, unknown> }).githubApp;
    githubApp.findPullRequestByHead = async () => ({ number: 7, head: { sha: 'sha123' } });
    githubApp.createPullRequestReview = async () => {
      throw new Error('posting down');
    };

    await runReviewJob(harness.ctx);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(harness.agentDir, 'review-findings.json'), 'utf8'),
    ) as Array<{
      github: { commentId: number | null; resolutionStatus: string };
    }>;
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].github.commentId, null);
    assert.equal(persisted[0].github.resolutionStatus, 'not_applicable');

    const log = fs.readFileSync(path.join(harness.agentDir, 'worker.log'), 'utf8');
    assert.ok(log.includes('GitHub review post failed: posting down'));
    assert.ok(log.includes('Review agent completed successfully'));
  });
});

describe('runReviewJob autofix plan materialization', () => {
  function setRepoAutofix(
    harness: FlowHarness,
    autofix: { severityThreshold: string; maxFindingsPerBatch: number } | null,
  ): void {
    (harness.ctx as { repo: unknown }).repo = {
      repoId: 'r1',
      owner: 'o',
      name: 'n',
      defaultBranch: 'main',
      cloneUrl: '',
      registeredAt: '',
      lastVerifiedAt: null,
      lastVerifyStatus: null,
      lastVerifyMessage: null,
      autoReviewPullRequests: null,
      ...(autofix ? { autofix } : {}),
    };
  }

  it('writes review-autofix-plan.json with eligible-only batches and snapshotted settings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    // 4 high findings + 1 critical + 1 unknown (never eligible) = 5 eligible.
    const comments = [
      { content: 'A', severity: 'high', path: 'a.ts', start_line: 1, end_line: 2 },
      { content: 'B', severity: 'high', path: 'b.ts', start_line: 1, end_line: 2 },
      { content: 'C', severity: 'high', path: 'c.ts', start_line: 1, end_line: 2 },
      { content: 'D', severity: 'critical', path: 'd.ts', start_line: 1, end_line: 2 },
      { content: 'E', severity: 'high', path: 'e.ts', start_line: 1, end_line: 2 },
      { content: 'Unknown', path: 'f.ts' },
    ];
    writeOcrStub(stubDir, { status: 'ok', comments });

    const harness = makeFlowHarness(root, null);
    setRepoAutofix(harness, { severityThreshold: 'medium', maxFindingsPerBatch: 2 });
    const githubApp = (harness.ctx as unknown as { githubApp: Record<string, unknown> }).githubApp;
    githubApp.findPullRequestByHead = async () => ({ number: 7, head: { sha: 'sha123' } });

    await runReviewJob(harness.ctx);

    const planPath = path.join(harness.agentDir, 'review-autofix-plan.json');
    assert.ok(fs.existsSync(planPath), 'review-autofix-plan.json should be written');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as {
      schemaVersion: number;
      snapshot: {
        severityThreshold: string;
        maxFindingsPerBatch: number;
        reviewedSha: string | null;
        baseBranch: string;
        headBranch: string;
        prNumber: number | null;
        snapshottedAt: string;
      };
      chainStatus: string;
      batches: Array<{ index: number; findingIds: string[]; agentId: string | null; status: string }>;
      nextBatchIndex: number | null;
      verification: { status: string; agentId: string | null };
    };

    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.snapshot.severityThreshold, 'medium');
    assert.equal(plan.snapshot.maxFindingsPerBatch, 2);
    assert.equal(plan.snapshot.reviewedSha, 'sha123');
    assert.equal(plan.snapshot.baseBranch, 'main');
    assert.equal(plan.snapshot.headBranch, 'feature');
    assert.equal(plan.snapshot.prNumber, 7);
    assert.ok(plan.snapshot.snapshottedAt);
    assert.equal(plan.chainStatus, 'running');
    assert.equal(plan.nextBatchIndex, 0);
    assert.deepEqual(plan.verification, { status: 'none', agentId: null });

    // 5 eligible findings split into batches of 2 → 2/2/1. The critical
    // finding sorts first; the unknown-severity finding never appears.
    assert.equal(plan.batches.length, 3);
    assert.deepEqual(
      plan.batches.map((batch) => batch.findingIds.length),
      [2, 2, 1],
    );
    assert.ok(plan.batches[0]!.findingIds[0]!.endsWith(':finding:3'), 'critical sorts first');
    for (const batch of plan.batches) {
      assert.equal(batch.agentId, null);
      assert.equal(batch.status, 'pending');
    }
    const allIds = plan.batches.flatMap((batch) => batch.findingIds);
    assert.ok(!allIds.some((id) => id.endsWith(':finding:5')), 'unknown severity is excluded');

    const log = fs.readFileSync(path.join(harness.agentDir, 'worker.log'), 'utf8');
    assert.ok(log.includes('Autofix plan created: 3 batch(es) from 6 finding(s)'));
  });

  it('does not create a plan when autofix is disabled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, {
      status: 'ok',
      comments: [{ content: 'Fix this', severity: 'high', path: 'a.ts', start_line: 1 }],
    });

    const harness = makeFlowHarness(root, null);
    setRepoAutofix(harness, { severityThreshold: 'disabled', maxFindingsPerBatch: 5 });

    await runReviewJob(harness.ctx);

    assert.equal(
      fs.existsSync(path.join(harness.agentDir, 'review-autofix-plan.json')),
      false,
      'no plan file should exist when autofix is disabled',
    );
    const log = fs.readFileSync(path.join(harness.agentDir, 'worker.log'), 'utf8');
    assert.ok(log.includes('Autofix plan not created (disabled or no eligible findings)'));
  });

  it('does not create a plan when no finding is auto-eligible', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, {
      status: 'ok',
      comments: [
        { content: 'Unknown severity', path: 'a.ts' },
        { content: 'Low priority', severity: 'low', path: 'b.ts' },
      ],
    });

    const harness = makeFlowHarness(root, null);
    // Threshold critical excludes the low finding and the unknown one.
    setRepoAutofix(harness, { severityThreshold: 'critical', maxFindingsPerBatch: 5 });

    await runReviewJob(harness.ctx);

    assert.equal(
      fs.existsSync(path.join(harness.agentDir, 'review-autofix-plan.json')),
      false,
      'no plan file should exist without eligible findings',
    );
  });
});

describe('runReviewJob verification metadata persistence', () => {
  it('persists verification review metadata through the worker final record update', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, {
      status: 'ok',
      comments: [{ content: 'Fix this', severity: 'high', path: 'a.ts', start_line: 1 }],
    });

    const harness = makeFlowHarness(root, null);
    // The verification review was created with its relationship persisted
    // before the worker ran (see scheduleVerificationReview).
    const stored = harness.agentsStore.load();
    for (const agent of stored.agents) {
      agent.review = {
        baseBranch: 'main',
        headBranch: 'feature',
        purpose: 'verification',
        autofixIneligible: true,
        sourceReviewAgentId: 'review1',
      };
    }
    harness.agentsStore.save(stored);

    await runReviewJob(harness.ctx);

    const loaded = harness.agentsStore.load();
    const agent = loaded.agents.find((entry) => entry.agentId === 'rev1');
    assert.ok(agent, 'review agent record should exist');
    const review = agent!.review;
    assert.ok(review, 'review metadata should be persisted');
    assert.equal(review!.purpose, 'verification');
    assert.equal(review!.autofixIneligible, true);
    assert.equal(review!.sourceReviewAgentId, 'review1');
  });

  it('does not add verification metadata for a standard review run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, {
      status: 'ok',
      comments: [{ content: 'Fix this', severity: 'high', path: 'a.ts', start_line: 1 }],
    });

    const harness = makeFlowHarness(root, null);

    await runReviewJob(harness.ctx);

    const loaded = harness.agentsStore.load();
    const agent = loaded.agents.find((entry) => entry.agentId === 'rev1');
    assert.ok(agent, 'review agent record should exist');
    const review = agent!.review;
    assert.equal(review!.purpose, undefined);
    assert.equal(review!.autofixIneligible, undefined);
    assert.equal(review!.sourceReviewAgentId, undefined);
  });
});

describe('runReviewJob check-run lifecycle', () => {
  interface CheckHarness extends FlowHarness {
    checkRequests: Array<{ path: string; method: string; body: Record<string, unknown> }>;
  }

  function makeCheckHarness(
    root: string,
    options: {
      pr?: { number: number; head: { sha: string } } | null;
      createCheckError?: Error;
      lookupError?: Error;
    } = {},
  ): CheckHarness {
    const harness = makeFlowHarness(root, null);
    (harness.ctx as { repo: unknown }).repo = {
      repoId: 'r1',
      owner: 'o',
      name: 'n',
      defaultBranch: 'main',
      cloneUrl: '',
      registeredAt: '',
      lastVerifiedAt: null,
      lastVerifyStatus: null,
      lastVerifyMessage: null,
      autoReviewPullRequests: null,
    };

    const checkRequests: CheckHarness['checkRequests'] = [];
    const githubApp = (harness.ctx as unknown as { githubApp: Record<string, unknown> }).githubApp;
    githubApp.findPullRequestByHead = async () => {
      if (options.lookupError) {
        throw options.lookupError;
      }
      return options.pr === undefined ? null : (options.pr ?? null);
    };
    githubApp.createCheckRun = async (
      _config: unknown,
      _owner: string,
      _repoName: string,
      input: { name: string; headSha: string; status: string },
    ) => {
      checkRequests.push({
        path: '/check-runs',
        method: 'POST',
        body: input as unknown as Record<string, unknown>,
      });
      if (options.createCheckError) {
        throw options.createCheckError;
      }
      return { id: 555, html_url: 'https://github.com/o/n/checks/555', status: 'in_progress', conclusion: null };
    };
    githubApp.updateCheckRun = async (
      _config: unknown,
      _owner: string,
      _repoName: string,
      checkRunId: number,
      input: { status?: string; conclusion?: string },
    ) => {
      checkRequests.push({
        path: `/check-runs/${checkRunId}`,
        method: 'PATCH',
        body: input as unknown as Record<string, unknown>,
      });
      return { id: checkRunId, html_url: 'x', status: 'completed', conclusion: input.conclusion ?? null };
    };

    return { ...harness, checkRequests };
  }

  it('creates the check before OCR and completes it with action_required', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, {
      status: 'ok',
      comments: [{ content: 'Fix this', severity: 'high', path: 'a.ts', start_line: 1 }],
    });

    const harness = makeCheckHarness(root, { pr: { number: 7, head: { sha: 'sha123' } } });

    await runReviewJob(harness.ctx);

    assert.deepEqual(
      harness.checkRequests.map((request) => `${request.method} ${request.path}`),
      ['POST /check-runs', 'PATCH /check-runs/555'],
    );
    const create = harness.checkRequests[0]!.body;
    assert.equal(create.name, 'localagent-box / review');
    assert.equal(create.headSha, 'sha123');
    assert.equal(create.status, 'in_progress');
    const patch = harness.checkRequests[1]!.body;
    assert.equal(patch.status, 'completed');
    assert.equal(patch.conclusion, 'action_required');

    const agent = harness.agentsStore.load().agents.find((entry) => entry.agentId === 'rev1');
    assert.equal(agent?.review?.githubCheckRunId, 555);
    assert.equal(agent?.review?.githubCheckHeadSha, 'sha123');
    assert.equal(agent?.review?.githubCheckConclusion, 'action_required');
    assert.equal(agent?.review?.prNumber, 7);
  });

  it('completes with success when the review has no findings', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, { status: 'ok', comments: [] });

    const harness = makeCheckHarness(root, { pr: { number: 7, head: { sha: 'sha123' } } });

    await runReviewJob(harness.ctx);

    const patch = harness.checkRequests.find((request) => request.method === 'PATCH');
    assert.ok(patch);
    assert.equal(patch.body.conclusion, 'success');
  });

  it('completes with failure when OCR fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'nonexistent-ocr');

    const harness = makeCheckHarness(root, { pr: { number: 7, head: { sha: 'sha123' } } });

    await runReviewJob(harness.ctx);

    const patch = harness.checkRequests.find((request) => request.method === 'PATCH');
    assert.ok(patch);
    assert.equal(patch.body.conclusion, 'failure');

    const agent = harness.agentsStore.load().agents.find((entry) => entry.agentId === 'rev1');
    assert.equal(agent?.status, 'failed');
  });

  it('skips the check when no PR matches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, { status: 'ok', comments: [] });

    const harness = makeCheckHarness(root, { pr: null });

    await runReviewJob(harness.ctx);

    assert.equal(harness.checkRequests.length, 0);
    const agent = harness.agentsStore.load().agents.find((entry) => entry.agentId === 'rev1');
    assert.equal(agent?.review?.githubCheckRunId ?? null, null);
  });

  it('continues without a check when creation fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, { status: 'ok', comments: [] });

    const harness = makeCheckHarness(root, {
      pr: { number: 7, head: { sha: 'sha123' } },
      createCheckError: new Error('This app does not have access to checks'),
    });

    await runReviewJob(harness.ctx);

    assert.deepEqual(
      harness.checkRequests.map((request) => request.method),
      ['POST'],
    );
    const agent = harness.agentsStore.load().agents.find((entry) => entry.agentId === 'rev1');
    assert.equal(agent?.status, 'completed');
    assert.equal(agent?.review?.githubCheckRunId ?? null, null);
    assert.equal(agent?.review?.prNumber, 7);

    const log = fs.readFileSync(path.join(harness.agentDir, 'worker.log'), 'utf8');
    assert.ok(log.includes('creating check run failed'));
    assert.ok(log.includes('Review agent completed successfully'));
  });

  it('preserves pre-existing review metadata when the check is created and OCR fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'nonexistent-ocr');

    const harness = makeCheckHarness(root, { pr: { number: 7, head: { sha: 'sha123' } } });
    const stored = harness.agentsStore.load();
    for (const agent of stored.agents) {
      agent.review = {
        baseBranch: 'main',
        headBranch: 'feature',
        purpose: 'verification',
        autofixIneligible: true,
        sourceReviewAgentId: 'review1',
      };
    }
    harness.agentsStore.save(stored);

    await runReviewJob(harness.ctx);

    const agent = harness.agentsStore.load().agents.find((entry) => entry.agentId === 'rev1');
    assert.equal(agent?.status, 'failed');
    const review = agent?.review;
    assert.equal(review?.purpose, 'verification', 'verification metadata must survive');
    assert.equal(review?.autofixIneligible, true);
    assert.equal(review?.sourceReviewAgentId, 'review1');
    assert.equal(review?.baseBranch, 'main');
    assert.equal(review?.githubCheckRunId, 555);
    assert.equal(review?.githubCheckHeadSha, 'sha123');
    assert.equal(review?.githubCheckConclusion, 'failure');
    assert.equal(review?.prNumber, 7);
    assert.equal(review?.headSha, 'sha123');
  });

  it('retries the PR lookup for comment posting when the pre-OCR lookup failed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, { status: 'ok', comments: [] });

    const harness = makeCheckHarness(root, {
      pr: { number: 7, head: { sha: 'sha123' } },
      lookupError: new Error('GitHub down'),
    });

    let lookupCount = 0;
    const githubApp = (harness.ctx as unknown as { githubApp: Record<string, unknown> }).githubApp;
    githubApp.findPullRequestByHead = async () => {
      lookupCount += 1;
      if (lookupCount === 1) {
        throw new Error('GitHub down');
      }
      return { number: 7, head: { sha: 'sha123' } };
    };

    const postedBodies: Array<Record<string, unknown>> = [];
    githubApp.createPullRequestReview = async (
      _config: unknown,
      _owner: string,
      _repoName: string,
      _prNumber: number,
      input: Record<string, unknown>,
    ) => {
      postedBodies.push(input);
      return { id: '9', html_url: 'x' };
    };

    await runReviewJob(harness.ctx);

    assert.equal(lookupCount, 2, 'PR lookup should be retried after the transient failure');
    assert.equal(postedBodies.length, 1, 'review comments should post after the retry');

    const agent = harness.agentsStore.load().agents.find((entry) => entry.agentId === 'rev1');
    assert.equal(agent?.status, 'completed');
    assert.equal(agent?.review?.prNumber, 7);
  });

  it('retry overwrites the previous attempt check and drops its stale conclusion', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, { status: 'ok', comments: [] });

    const harness = makeCheckHarness(root, { pr: { number: 7, head: { sha: 'sha456' } } });
    const githubApp = (harness.ctx as unknown as { githubApp: Record<string, unknown> }).githubApp;
    githubApp.createCheckRun = async (
      _config: unknown,
      _owner: string,
      _repoName: string,
      input: { name: string; headSha: string; status: string },
    ) => {
      harness.checkRequests.push({
        path: '/check-runs',
        method: 'POST',
        body: input as unknown as Record<string, unknown>,
      });
      return { id: 777, html_url: 'x', status: 'in_progress', conclusion: null };
    };
    githubApp.updateCheckRun = async (
      _config: unknown,
      _owner: string,
      _repoName: string,
      checkRunId: number,
      input: { status?: string; conclusion?: string },
    ) => {
      harness.checkRequests.push({
        path: `/check-runs/${checkRunId}`,
        method: 'PATCH',
        body: input as unknown as Record<string, unknown>,
      });
      return { id: checkRunId, html_url: 'x', status: 'completed', conclusion: input.conclusion ?? null };
    };

    // Seed the first attempt's state (check 555 on sha123, concluded failure),
    // as retryAgent leaves it after clearing the check fields.
    const stored = harness.agentsStore.load();
    for (const agent of stored.agents) {
      agent.review = {
        baseBranch: 'main',
        headBranch: 'feature',
        prNumber: 7,
        headSha: 'sha123',
        githubCheckRunId: null,
        githubCheckHeadSha: null,
        githubCheckConclusion: 'failure',
      };
    }
    harness.agentsStore.save(stored);

    await runReviewJob(harness.ctx);

    // The retry created a NEW check on the current SHA and completed it itself.
    assert.deepEqual(
      harness.checkRequests.map((request) => `${request.method} ${request.path}`),
      ['POST /check-runs', 'PATCH /check-runs/777'],
    );
    assert.equal(harness.checkRequests[0]!.body.headSha, 'sha456', 'new check on the new SHA');
    assert.equal(harness.checkRequests[1]!.body.conclusion, 'success');

    const agent = harness.agentsStore.load().agents.find((entry) => entry.agentId === 'rev1');
    assert.equal(agent?.status, 'completed');
    assert.equal(agent?.review?.githubCheckRunId, 777, 'new check id overwrites the old one');
    assert.equal(agent?.review?.githubCheckHeadSha, 'sha456');
    assert.equal(agent?.review?.githubCheckConclusion, 'success', 'stale failure conclusion is not preserved');
    assert.equal(agent?.review?.headSha, 'sha456');
  });

  it('drops a stale conclusion when the retry cannot create a check', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const stubDir = path.join(root, 'bin');
    fs.mkdirSync(stubDir, { recursive: true });
    process.env.OCR_BIN = path.join(stubDir, 'ocr');
    writeOcrStub(stubDir, { status: 'ok', comments: [] });

    const harness = makeCheckHarness(root, {
      pr: { number: 7, head: { sha: 'sha123' } },
      createCheckError: new Error('This app does not have access to checks'),
    });

    const stored = harness.agentsStore.load();
    for (const agent of stored.agents) {
      agent.review = {
        baseBranch: 'main',
        headBranch: 'feature',
        prNumber: 7,
        headSha: 'sha123',
        githubCheckRunId: null,
        githubCheckHeadSha: null,
        githubCheckConclusion: 'failure',
      };
    }
    harness.agentsStore.save(stored);

    await runReviewJob(harness.ctx);

    const agent = harness.agentsStore.load().agents.find((entry) => entry.agentId === 'rev1');
    assert.equal(agent?.status, 'completed');
    assert.equal(agent?.review?.githubCheckRunId ?? null, null);
    assert.equal(agent?.review?.githubCheckConclusion ?? null, null, 'stale conclusion must not survive');
  });

  it('completeReviewCheck hydrates the repo from repos.json on a crash-rebuilt context', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const harness = makeFlowHarness(root, null);
    // Crash-rebuilt context: prepareWorkspace never ran, so ctx.repo is unset
    // and repos.json exists on disk from the original clone. The check id was
    // persisted by startReviewCheck before the crash, so the seeded record
    // must carry it for the conclusion write to apply.
    fs.writeFileSync(
      path.join(harness.dataDir, 'repos.json'),
      JSON.stringify({
        repos: [
          {
            repoId: 'r1',
            owner: 'o',
            name: 'n',
            defaultBranch: 'main',
            cloneUrl: '',
            registeredAt: '',
            lastVerifiedAt: null,
            lastVerifyStatus: null,
            lastVerifyMessage: null,
            autoReviewPullRequests: null,
          },
        ],
      }),
      'utf8',
    );
    const crashedRecord = harness.agentsStore.load();
    const crashedAgent = crashedRecord.agents.find((entry) => entry.agentId === 'rev1');
    crashedAgent!.review = {
      ...crashedAgent!.review!,
      baseBranch: crashedAgent!.review?.baseBranch ?? null,
      headBranch: crashedAgent!.review?.headBranch ?? null,
      githubCheckRunId: 555,
      githubCheckHeadSha: 'sha123',
      githubCheckConclusion: null,
    };
    harness.agentsStore.save(crashedRecord);

    const patches: Array<Record<string, unknown>> = [];
    const githubApp = (harness.ctx as unknown as { githubApp: Record<string, unknown> }).githubApp;
    githubApp.updateCheckRun = async (
      _config: unknown,
      owner: string,
      repoName: string,
      checkRunId: number,
      input: Record<string, unknown>,
    ) => {
      patches.push({ owner, repoName, checkRunId, ...input });
      return { id: checkRunId, html_url: 'x', status: 'completed', conclusion: input.conclusion ?? null };
    };

    await completeReviewCheck(harness.ctx, 555, 'failure', [], null, 'Worker error: boom');

    assert.equal(patches.length, 1, 'failure PATCH must be sent, not silently skipped');
    assert.equal(patches[0].owner, 'o');
    assert.equal(patches[0].repoName, 'n');
    assert.equal(patches[0].checkRunId, 555);
    assert.equal(patches[0].status, 'completed');
    assert.equal(patches[0].conclusion, 'failure');

    const agent = harness.agentsStore.load().agents.find((entry) => entry.agentId === 'rev1');
    assert.equal(agent?.review?.githubCheckConclusion, 'failure');
  });

  it('completeReviewCheck still skips when the repo record is missing entirely', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-flow-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const harness = makeFlowHarness(root, null);
    const patches: Array<Record<string, unknown>> = [];
    const githubApp = (harness.ctx as unknown as { githubApp: Record<string, unknown> }).githubApp;
    githubApp.updateCheckRun = async (
      _config: unknown,
      _owner: string,
      _repoName: string,
      _checkRunId: number,
      input: Record<string, unknown>,
    ) => {
      patches.push(input);
      return { id: 555, html_url: 'x', status: 'completed', conclusion: null };
    };

    await completeReviewCheck(harness.ctx, 555, 'failure', [], null, 'Worker error: boom');

    assert.equal(patches.length, 0, 'no repo means no PATCH target');
  });
});