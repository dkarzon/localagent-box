import {
  validateOwner,
  validateRepoName,
  validateBranchName,
  buildRepoId,
} from '../../lib/validation';
import { CodedError } from '../../types';
import type { AppConfig, Repo } from '../../types';
import type { GithubAppService } from '../../services/github-app';
import type { GitService } from '../../services/git-service';
import { createRepoRepository, validateRepoId, type RepoRepository } from './repo.repository';
import type { JsonStore } from '../../lib/json-store';
import type { RegisterRepoRequest, VerifyRepoResponse } from './dto';

export { validateRepoId };

export interface RepoService {
  listRepos: () => Repo[];
  getRepo: (repoId: string) => Repo;
  registerRepo: (body: RegisterRepoRequest) => Repo;
  updateRepo: (
    repoId: string,
    updates: Partial<Pick<Repo, 'autoReviewPullRequests'>>,
  ) => Repo;
  deleteRepo: (repoId: string) => Repo;
  verifyRepo: (
    config: AppConfig,
    repoId: string,
    branch?: unknown,
  ) => Promise<VerifyRepoResponse>;
  resolveAuthenticatedCloneUrl: (
    config: AppConfig,
    repoId: string,
  ) => Promise<{ repo: Repo; cloneUrl: string }>;
  cloneToWorkspace: (
    config: AppConfig,
    repoId: string,
    workspaceDir: string,
    branch?: unknown,
  ) => Promise<{ repo: Repo; branch: string; workspaceDir: string }>;
  validateRepoId: (repoId: unknown) => string;
}

export function createRepoService({
  reposStore,
  githubApp,
  gitService,
  repository: injectedRepository,
}: {
  reposStore: JsonStore<{ repos: Repo[] }>;
  githubApp: GithubAppService;
  gitService: GitService;
  repository?: RepoRepository;
}): RepoService {
  const repository = injectedRepository || createRepoRepository(reposStore);

  function getRepo(repoId: string): Repo {
    const repo = repository.findById(repoId);
    if (!repo) {
      throw new CodedError('Repository not found', 'NOT_FOUND');
    }
    return repo;
  }

  function registerRepo({ owner, name, defaultBranch }: RegisterRepoRequest): Repo {
    const validatedOwner = validateOwner(owner);
    const validatedName = validateRepoName(name);
    const validatedBranch = validateBranchName(defaultBranch || 'main');
    const repoId = buildRepoId(validatedOwner, validatedName);
    const repos = repository.findAll();

    if (repos.some((entry) => entry.repoId === repoId)) {
      throw new CodedError('Repository already registered', 'DUPLICATE');
    }

    const repo: Repo = {
      repoId,
      owner: validatedOwner,
      name: validatedName,
      defaultBranch: validatedBranch,
      cloneUrl: `https://github.com/${validatedOwner}/${validatedName}.git`,
      registeredAt: new Date().toISOString(),
      lastVerifiedAt: null,
      lastVerifyStatus: null,
      lastVerifyMessage: null,
      autoReviewPullRequests: null,
    };

    repository.add(repo);
    return repo;
  }

  function deleteRepo(repoId: string): Repo {
    const removed = repository.remove(repoId);
    if (!removed) {
      throw new CodedError('Repository not found', 'NOT_FOUND');
    }
    return removed;
  }

  async function verifyRepo(config: AppConfig, repoId: string, branch?: unknown) {
    const repo = getRepo(repoId);
    const branchToUse = branch ? validateBranchName(branch) : repo.defaultBranch;

    try {
      const result = await gitService.verifyClone(config, {
        owner: repo.owner,
        name: repo.name,
        branch: branchToUse,
      });
      repository.updateVerifyStatus(repoId, 'ok', result.message);
      return {
        ...result,
        repoId,
        branch: branchToUse,
      };
    } catch (err) {
      repository.updateVerifyStatus(repoId, 'error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async function resolveAuthenticatedCloneUrl(config: AppConfig, repoId: string) {
    const repo = getRepo(repoId);
    const token = await githubApp.getInstallationToken(config);
    return {
      repo,
      cloneUrl: githubApp.buildAuthenticatedCloneUrl(repo.owner, repo.name, token),
    };
  }

  async function cloneToWorkspace(
    config: AppConfig,
    repoId: string,
    workspaceDir: string,
    branch?: unknown,
  ) {
    const repo = getRepo(repoId);
    const branchToUse = branch ? validateBranchName(branch) : repo.defaultBranch;
    const token = await githubApp.getInstallationToken(config);

    await gitService.shallowClone({
      owner: repo.owner,
      name: repo.name,
      branch: branchToUse,
      targetDir: workspaceDir,
      token,
    });

    return {
      repo,
      branch: branchToUse,
      workspaceDir,
    };
  }

  return {
    listRepos: () => repository.findAll(),
    getRepo,
    registerRepo,
    updateRepo: (repoId, updates) => {
      const repo = repository.update(repoId, updates);
      if (!repo) {
        throw new CodedError('Repository not found', 'NOT_FOUND');
      }
      return repo;
    },
    deleteRepo,
    verifyRepo,
    resolveAuthenticatedCloneUrl,
    cloneToWorkspace,
    validateRepoId,
  };
}

/** @deprecated Use createRepoService */
export const createRepoManager = createRepoService;

export type RepoManager = RepoService;
