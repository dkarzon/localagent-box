import { validationError } from '../../lib/validation';
import type { Repo } from '../../types';
import type { JsonStore } from '../../lib/json-store';

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
}

export function createRepoRepository(reposStore: JsonStore<{ repos: Repo[] }>): RepoRepository {
  function loadRepos(): Repo[] {
    return reposStore.load().repos || [];
  }

  function saveRepos(repos: Repo[]): void {
    reposStore.save({ repos });
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
