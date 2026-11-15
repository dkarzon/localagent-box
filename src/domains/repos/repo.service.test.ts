import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createJsonStore } from '../../lib/json-store';
import { createRepoService } from './repo.service';
import { createRepoRepository } from './repo.repository';
import { CodedError, type Repo, type RepoAutofixSettings } from '../../types';

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

  it('preserves the other setting for every single-key update', () => {
    const service = setup();
    const id = 'acme-demo';

    const severityOnly = service.updateRepo(id, { autofix: { severityThreshold: 'low' } });
    assert.equal(severityOnly.autofix?.severityThreshold, 'low');
    assert.equal(severityOnly.autofix?.maxFindingsPerBatch, 10, 'batch size should be preserved');

    const batchOnly = service.updateRepo(id, { autofix: { maxFindingsPerBatch: 3 } });
    assert.equal(batchOnly.autofix?.severityThreshold, 'low', 'severity should be preserved');
    assert.equal(batchOnly.autofix?.maxFindingsPerBatch, 3);

    const reloaded = service.getRepo(id);
    assert.equal(reloaded.autofix?.severityThreshold, 'low');
    assert.equal(reloaded.autofix?.maxFindingsPerBatch, 3, 'both settings should be persisted');
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

describe('repo service updateRepo webhookUrl', () => {
  it('stores and persists a per-repo webhook endpoint', () => {
    const service = setup();
    const id = 'acme-demo';

    const updated = service.updateRepo(id, { webhookUrl: 'https://hooks.example.com/agent' });
    assert.equal(updated.webhookUrl, 'https://hooks.example.com/agent');
    assert.equal(service.getRepo(id).webhookUrl, 'https://hooks.example.com/agent');
  });

  it('trims stored webhook urls', () => {
    const service = setup();
    const id = 'acme-demo';

    const updated = service.updateRepo(id, { webhookUrl: '  https://hooks.example.com/agent  ' });
    assert.equal(updated.webhookUrl, 'https://hooks.example.com/agent');
  });

  it('null and empty string clear the override so the global setting applies', () => {
    const service = setup();
    const id = 'acme-demo';

    service.updateRepo(id, { webhookUrl: 'https://hooks.example.com/agent' });
    assert.equal(service.updateRepo(id, { webhookUrl: null }).webhookUrl, null);

    service.updateRepo(id, { webhookUrl: 'https://hooks.example.com/agent' });
    assert.equal(service.updateRepo(id, { webhookUrl: '   ' }).webhookUrl, null);
  });

  it('rejects webhook urls that are not http(s)', () => {
    const service = setup();
    const id = 'acme-demo';

    assert.throws(
      () => service.updateRepo(id, { webhookUrl: 'ftp://hooks.example.com/agent' }),
      (err: unknown) =>
        err instanceof CodedError &&
        err.code === 'VALIDATION_ERROR' &&
        /valid http\(s\) URL/.test(err.message),
    );
    assert.equal(service.getRepo(id).webhookUrl, undefined);
  });

  it('rejects non-string webhook urls instead of clearing the override', () => {
    const service = setup();
    const id = 'acme-demo';

    service.updateRepo(id, { webhookUrl: 'https://hooks.example.com/agent' });
    assert.throws(
      () => service.updateRepo(id, { webhookUrl: 123 as unknown as string }),
      (err: unknown) => err instanceof CodedError && err.code === 'VALIDATION_ERROR',
    );
    assert.equal(service.getRepo(id).webhookUrl, 'https://hooks.example.com/agent');
  });

  it('rejects webhook urls longer than 2048 characters', () => {
    const service = setup();
    const id = 'acme-demo';

    assert.throws(
      () => service.updateRepo(id, { webhookUrl: `https://hooks.example.com/${'a'.repeat(2048)}` }),
      (err: unknown) => err instanceof CodedError && err.code === 'VALIDATION_ERROR',
    );
  });

  it('leaves other settings untouched when only the webhook is updated', () => {
    const service = setup();
    const id = 'acme-demo';

    const updated = service.updateRepo(id, { webhookUrl: 'https://hooks.example.com/agent' });
    assert.equal(updated.autofix?.severityThreshold, 'high');
    assert.equal(updated.autofix?.maxFindingsPerBatch, 10);
    assert.equal(updated.autoReviewPullRequests, null);
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

  it('preserves the severity when only the batch size is updated', () => {
    const dataDir = makeDataDir();
    const reposStore = createJsonStore<{ repos: Repo[] }>(path.join(dataDir, 'repos.json'), {
      repos: [],
    }, fs);
    reposStore.save({ repos: [makeRepo()] });
    const repository = createRepoRepository(reposStore);
    const id = 'acme-demo';
    const partial: Partial<RepoAutofixSettings> = { maxFindingsPerBatch: 4 };
    const result = repository.update(id, { autofix: partial });
    assert.equal(result?.autofix?.maxFindingsPerBatch, 4);
    assert.equal(
      result?.autofix?.severityThreshold,
      'high',
      'severity should be preserved when only the batch size is updated',
    );
  });
});
