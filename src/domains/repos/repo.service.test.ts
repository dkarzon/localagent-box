import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createJsonStore } from '../../lib/json-store';
import { createRepoService } from './repo.service';
import { createRepoRepository } from './repo.repository';
import type { Repo, RepoAutofixSettings } from '../../types';

const rootDirs: string[] = [];

afterEach(() => {
  while (rootDirs.length > 0) {
    const root = rootDirs.pop()!;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRepo(): Repo {
  return {
    repoId: 'acme-demo',
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    cloneUrl: 'https://github.com/acme/demo.git',
    registeredAt: '2025-01-01T00:00:00.000Z',
    lastVerifiedAt: null,
    lastVerifyStatus: null,
    lastVerifyMessage: null,
    autoReviewPullRequests: null,
    autofix: { severityThreshold: 'high', maxFindingsPerBatch: 10 },
  };
}

function makeDataDir(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-service-'));
  rootDirs.push(dataDir);
  return dataDir;
}

function setup(): ReturnType<typeof createRepoService> {
  const dataDir = makeDataDir();
  const reposStore = createJsonStore<{ repos: Repo[] }>(path.join(dataDir, 'repos.json'), {
    repos: [],
  }, fs);
  reposStore.save({ repos: [makeRepo()] });

  const githubApp = {} as unknown as Parameters<typeof createRepoService>[0]['githubApp'];
  const gitService = {} as unknown as Parameters<typeof createRepoService>[0]['gitService'];

  return createRepoService({ reposStore, githubApp, gitService });
}

describe('repo service updateRepo autofix partial update', () => {
  it('preserves the batch size when only the severity is updated', () => {
    const service = setup();
    const id = 'acme-demo';

    const updated = service.updateRepo(id, { autofix: { severityThreshold: 'critical' } });
    assert.equal(updated.autofix?.severityThreshold, 'critical');
    assert.equal(updated.autofix?.maxFindingsPerBatch, 10, 'batch size should be preserved');

    const reloaded = service.getRepo(id);
    assert.equal(reloaded.autofix?.severityThreshold, 'critical');
    assert.equal(reloaded.autofix?.maxFindingsPerBatch, 10, 'batch size should be persisted');
  });

  it('preserves the severity when only the batch size is updated', () => {
    const service = setup();
    const id = 'acme-demo';

    const updated = service.updateRepo(id, { autofix: { maxFindingsPerBatch: 7 } });
    assert.equal(updated.autofix?.maxFindingsPerBatch, 7);
    assert.equal(updated.autofix?.severityThreshold, 'high', 'severity should be preserved');
  });

  it('updates both settings when both are provided', () => {
    const service = setup();
    const id = 'acme-demo';

    const updated = service.updateRepo(id, {
      autofix: { severityThreshold: 'medium', maxFindingsPerBatch: 3 },
    });
    assert.equal(updated.autofix?.severityThreshold, 'medium');
    assert.equal(updated.autofix?.maxFindingsPerBatch, 3);
  });
});

describe('repo repository autofix merge', () => {
  it('merges only the keys present in the partial over the stored settings', () => {
    const dataDir = makeDataDir();
    const reposStore = createJsonStore<{ repos: Repo[] }>(path.join(dataDir, 'repos.json'), {
      repos: [],
    }, fs);
    reposStore.save({ repos: [makeRepo()] });
    const repository = createRepoRepository(reposStore);
    const id = 'acme-demo';
    const partial: Partial<RepoAutofixSettings> = { severityThreshold: 'medium' };
    const result = repository.update(id, { autofix: partial });
    assert.equal(result?.autofix?.severityThreshold, 'medium');
    assert.equal(
      result?.autofix?.maxFindingsPerBatch,
      10,
      'batch size should be preserved when only severity is updated',
    );
  });
});
