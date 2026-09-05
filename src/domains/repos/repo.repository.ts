import { validationError } from '../../lib/validation';
import {
  AUTOFIX_SEVERITY_THRESHOLDS,
  DEFAULT_REPO_AUTOFIX_SETTINGS,
} from '../../types';
import type { AutofixSeverityThreshold, Repo, RepoAutofixSettings } from '../../types';
import type { JsonStore } from '../../lib/json-store';

/**
 * Normalizes the optional `autofix` settings block on a repository record so
 * old JSON (which omits the block) and manually edited data get safe defaults
 * without a migration. Invalid persisted values are clamped/defaulted.
 */
export function normalizeRepoAutofixSettings(value: unknown): RepoAutofixSettings {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_REPO_AUTOFIX_SETTINGS };
  }
  const raw = value as Partial<RepoAutofixSettings>;
  const severityThreshold: AutofixSeverityThreshold = AUTOFIX_SEVERITY_THRESHOLDS.includes(
    raw.severityThreshold as AutofixSeverityThreshold,
  )
    ? (raw.severityThreshold as AutofixSeverityThreshold)
    : DEFAULT_REPO_AUTOFIX_SETTINGS.severityThreshold;
  const maxFindingsPerBatch =
    typeof raw.maxFindingsPerBatch === 'number' &&
    Number.isInteger(raw.maxFindingsPerBatch) &&
    raw.maxFindingsPerBatch >= 1 &&
    raw.maxFindingsPerBatch <= 20
      ? raw.maxFindingsPerBatch
      : DEFAULT_REPO_AUTOFIX_SETTINGS.maxFindingsPerBatch;
  return { severityThreshold, maxFindingsPerBatch };
}

export interface RepoUpdateFields {
  autoReviewPullRequests: Repo['autoReviewPullRequests'];
  autofix: Partial<RepoAutofixSettings>;
}

export function validateRepoId(repoId: unknown): string {
  if (!repoId || typeof repoId !== 'string') {
    throw validationError('Repository id is required');
  }

  const sanitized = repoId.trim();
  const validPattern = /^[a-zA-Z0-9._-]+$/;

  if (!validPattern.test(sanitized) || sanitized.length > 200) {
    throw validationError('Invalid repository id');
  }

  return sanitized;
}

export interface RepoRepository {
  findAll: () => Repo[];
  findById: (repoId: string) => Repo | undefined;
  saveAll: (repos: Repo[]) => void;
  add: (repo: Repo) => void;
  remove: (repoId: string) => Repo | undefined;
  updateVerifyStatus: (repoId: string, status: string, message: string) => void;
  update: (repoId: string, partial: Partial<RepoUpdateFields>) => Repo | undefined;
}

export function createRepoRepository(reposStore: JsonStore<{ repos: Repo[] }>): RepoRepository {
  function loadRepos(): Repo[] {
    const repos = reposStore.load().repos || [];
    for (const repo of repos) {
      repo.autofix = normalizeRepoAutofixSettings(repo.autofix);
    }
    return repos;
  }

  function saveRepos(repos: Repo[]): void {
    reposStore.save({ repos });
  }

  function updateRepo(
    repoId: string,
    partial: Partial<RepoUpdateFields>,
  ): Repo | undefined {
    const repos = loadRepos();
    const repo = repos.find((entry) => entry.repoId === validateRepoId(repoId));
    if (!repo) return undefined;
    if (partial.autofix !== undefined) {
      const merged = normalizeRepoAutofixSettings({
        ...normalizeRepoAutofixSettings(repo.autofix),
        ...partial.autofix,
      });
      repo.autofix = merged;
      const rest = { ...partial };
      delete rest.autofix;
      Object.assign(repo, rest);
    } else {
      Object.assign(repo, partial);
    }
    saveRepos(repos);
    return repo;
  }

  return {
    findAll: loadRepos,
    findById: (repoId) => loadRepos().find((entry) => entry.repoId === validateRepoId(repoId)),
    saveAll: saveRepos,
    add: (repo) => {
      const repos = loadRepos();
      repos.push(repo);
      saveRepos(repos);
    },
    update: updateRepo,
    remove: (repoId) => {
      const repos = loadRepos();
      const index = repos.findIndex((entry) => entry.repoId === validateRepoId(repoId));
      if (index === -1) {
        return undefined;
      }
      const [removed] = repos.splice(index, 1);
      saveRepos(repos);
      return removed;
    },
    updateVerifyStatus: (repoId, status, message) => {
      const repos = loadRepos();
      const repo = repos.find((entry) => entry.repoId === repoId);
      if (!repo) {
        return;
      }
      repo.lastVerifiedAt = new Date().toISOString();
      repo.lastVerifyStatus = status;
      repo.lastVerifyMessage = message;
      saveRepos(repos);
    },
  };
}
