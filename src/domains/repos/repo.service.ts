import {
  validateOwner,
  validateRepoName,
  validateBranchName,
  buildRepoId,
  validationError,
  isValidHttpUrl,
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
      webhookUrl?: string | null;
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
      webhookUrl: null,
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

  /**
   * Validates the optional per-repo `webhookUrl` at the service boundary.
   * `null` or an empty string clears the override (inherit the global setting);
   * a non-empty value must be an http(s) URL.
   */
  function validateWebhookUrlUpdate(value: unknown): string | null {
    if (value === null) {
      return null;
    }
    const url = typeof value === 'string' ? value.trim() : '';
    if (!url) {
      return null;
    }
    if (!isValidHttpUrl(url)) {
      throw validationError('webhookUrl must be a valid http(s) URL or null to inherit the global setting');
    }
    return url;
  }

  return {
    listRepos: () => repository.findAll(),
    getRepo,
    registerRepo,
    updateRepo: (repoId, updates) => {
      const { autofix, webhookUrl, ...rest } = updates;
      // Pass the validated partial through unchanged; the repository merges it with
      // the stored settings, so an absent key never resets the other to defaults.
      const normalized: Partial<RepoUpdateFields> = { ...rest };
      if (autofix !== undefined) {
        normalized.autofix = validateAutofixUpdates(autofix);
      }
      if (webhookUrl !== undefined) {
        normalized.webhookUrl = validateWebhookUrlUpdate(webhookUrl);
      }
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
