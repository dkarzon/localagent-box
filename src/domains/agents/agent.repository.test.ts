import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createJsonStore } from '../../lib/json-store';
import type { Agent, ReviewAutofixPlan, ReviewFindingRecord } from '../../types';
import { createAgentRepository } from './agent.repository';

const rootDirs: string[] = [];

afterEach(() => {
  while (rootDirs.length > 0) {
    const root = rootDirs.pop()!;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function setup(): ReturnType<typeof createAgentRepository> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-repo-'));
  rootDirs.push(root);
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const agentsStore = createJsonStore<{ agents: Agent[] }>(
    path.join(dataDir, 'agents.json'),
    { agents: [] },
    fs,
  );
  const repository = createAgentRepository({
    dataDir,
    workspaceRoot: path.join(root, 'workspaces'),
    agentsStore,
    fs,
    path,
  });
  const agent: Agent = {
    agentId: 'review1',
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
    status: 'completed',
    commitSha: null,
    pushed: false,
    filesChanged: null,
    createdAt: '2026-09-04T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    branch: null,
    error: null,
    result: null,
  };
  repository.save(agent);
  return repository;
}

function finding(ordinal: number): ReviewFindingRecord {
  return {
    id: `review1:finding:${ordinal}`,
    ordinal,
    severity: 'high',
    category: 'correctness',
    path: 'src/a.ts',
    startLine: ordinal + 1,
    endLine: ordinal + 2,
    content: `finding ${ordinal}`,
    existingCode: null,
    suggestionCode: null,
    reviewedSha: null,
    fixStatus: 'available',
    assignedAgentId: null,
    fixedAt: null,
    github: {
      reviewId: null,
      commentId: null,
      commentUrl: null,
      threadId: null,
      resolutionStatus: 'not_applicable',
      resolutionError: null,
      resolvedAt: null,
    },
  };
}

describe('agent repository review findings artifacts', () => {
  it('reads null for missing review-findings.json', () => {
    const repository = setup();
    assert.equal(repository.readReviewFindings('review1'), null);
  });

  it('writes and reads findings with atomic replacement', () => {
    const repository = setup();
    const findings = [finding(0), finding(1)];
    repository.writeReviewFindings('review1', findings);
    assert.deepEqual(repository.readReviewFindings('review1'), findings);
    // No temp files left behind
    const dir = repository.getAgentDir('review1');
    assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')).length, 0);
  });

  it('replaces existing findings instead of merging', () => {
    const repository = setup();
    repository.writeReviewFindings('review1', [finding(0)]);
    repository.writeReviewFindings('review1', [finding(1)]);
    const loaded = repository.readReviewFindings('review1');
    assert.equal(loaded?.length, 1);
    assert.equal(loaded?.[0].ordinal, 1);
  });

  it('returns null for malformed findings JSON instead of throwing', () => {
    const repository = setup();
    fs.mkdirSync(repository.getAgentDir('review1'), { recursive: true });
    fs.writeFileSync(
      repository.getReviewFindingsPath('review1'),
      '{not json',
      'utf8',
    );
    assert.equal(repository.readReviewFindings('review1'), null);
  });

  it('returns null when findings JSON is not an array', () => {
    const repository = setup();
    fs.mkdirSync(repository.getAgentDir('review1'), { recursive: true });
    fs.writeFileSync(
      repository.getReviewFindingsPath('review1'),
      JSON.stringify({ findings: [] }),
      'utf8',
    );
    assert.equal(repository.readReviewFindings('review1'), null);
  });

  it('throws NOT_FOUND for unknown agents', () => {
    const repository = setup();
    assert.throws(
      () => repository.writeReviewFindings('missing', [finding(0)]),
      /Agent not found/,
    );
  });

  it('writes and reads the autofix plan', () => {
    const repository = setup();
    const plan: ReviewAutofixPlan = {
      schemaVersion: 1,
      snapshot: {
        severityThreshold: 'high',
        maxFindingsPerBatch: 5,
        reviewedSha: 'sha1',
        baseBranch: 'main',
        headBranch: 'feature',
        prNumber: 7,
        snapshottedAt: '2026-09-04T00:00:00.000Z',
      },
      chainStatus: 'running',
      batches: [],
      nextBatchIndex: 0,
      verification: { status: 'none', agentId: null },
    };
    repository.writeReviewAutofixPlan('review1', plan);
    assert.deepEqual(repository.readReviewAutofixPlan('review1'), plan);
  });

  it('reads null for missing autofix plan and malformed JSON', () => {
    const repository = setup();
    assert.equal(repository.readReviewAutofixPlan('review1'), null);
    fs.mkdirSync(repository.getAgentDir('review1'), { recursive: true });
    fs.writeFileSync(repository.getReviewAutofixPlanPath('review1'), '{oops', 'utf8');
    assert.equal(repository.readReviewAutofixPlan('review1'), null);
  });
});