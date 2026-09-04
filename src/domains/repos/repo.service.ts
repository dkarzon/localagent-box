import {
  validateOwner,
  validateRepoName,
  validateBranchName,
  buildRepoId,
  validationError,
} from '../../lib/validation';
import { CodedError } from '../../types';
import {
  AUTOFIX_SEVERITY_THRESHOLDS,
  DEFAULT_REPO_AUTOFIX_SETTINGS,
} from '../../types';
import type {
  AutofixSeverityThreshold,
  AppConfig,
  Repo,
  RepoAutofixSettings,
} from '../../types';
import type { GithubAppService } from '../../services/github-app';
import type { GitService } from '../../services/git-service';
import {
  createRepoRepository,
  validateRepoId,
  type RepoUpdateFields,
  type RepoRepository,
} from './repo.repository';
import type { JsonStore } from '../../lib/json-store';
import type { RegisterRepoRequest, VerifyRepoResponse } from './dto';

export { validateRepoId };

export interface RepoService {
  listRepos: () => Repo[];
  getRepo: (repoId: string) => Repo;
  registerRepo: (body: RegisterRepoRequest) => Repo;
  updateRepo: (
    repoId: string,
    updates: {
      autoReviewPullRequests?: boolean | null;
      autofix?: Partial<RepoAutofixSettings>;
    },
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
    options?: { fullHistory?: boolean },
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
      autofix: { ...DEFAULT_REPO_AUTOFIX_SETTINGS },
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
    options?: { fullHistory?: boolean },
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
      fullHistory: options?.fullHistory,
    });

    return {
      repo,
      branch: branchToUse,
      workspaceDir,
    };
  }

  /**
   * Validates autofix settings at the service boundary (plan rule: validate at
   * repository API boundaries). Accepts only known threshold strings and
   * integer batch sizes 1–20; updating one setting preserves the other.
   */
  function validateAutofixUpdates(autofix: unknown): Partial<RepoAutofixSettings> {
    if (!autofix || typeof autofix !== 'object' || Array.isArray(autofix)) {
      throw validationError('autofix must be an object');
    }
    const raw = autofix as Partial<RepoAutofixSettings>;
    const validated: Partial<RepoAutofixSettings> = {};

    if (raw.severityThreshold !== undefined) {
      if (
        typeof raw.severityThreshold !== 'string' ||
        !AUTOFIX_SEVERITY_THRESHOLDS.includes(raw.severityThreshold as AutofixSeverityThreshold)
      ) {
        throw validationError(
          `autofix.severityThreshold must be one of: ${AUTOFIX_SEVERITY_THRESHOLDS.join(', ')}`,
        );
      }
      validated.severityThreshold = raw.severityThreshold as AutofixSeverityThreshold;
    }

    if (raw.maxFindingsPerBatch !== undefined) {
      if (
        typeof raw.maxFindingsPerBatch !== 'number' ||
        !Number.isInteger(raw.maxFindingsPerBatch) ||
        raw.maxFindingsPerBatch < 1 ||
        raw.maxFindingsPerBatch > 20
      ) {
        throw validationError('autofix.maxFindingsPerBatch must be an integer from 1 through 20');
      }
      validated.maxFindingsPerBatch = raw.maxFindingsPerBatch;
    }

    return validated;
  }

  return {
    listRepos: () => repository.findAll(),
    getRepo,
    registerRepo,
    updateRepo: (repoId, updates) => {
      const { autofix, ...rest } = updates;
      const normalized: Partial<RepoUpdateFields> =
        autofix !== undefined ? { ...rest, autofix: validateAutofixUpdates(autofix) } : { ...rest };
      const repo = repository.update(repoId, normalized);
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
