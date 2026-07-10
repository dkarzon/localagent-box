export interface RegisterRepoRequest {
  owner: unknown;
  name: unknown;
  defaultBranch?: unknown;
}

export interface VerifyRepoRequest {
  branch?: unknown;
}

export interface VerifyRepoResponse {
  ok: boolean;
  owner: string;
  name: string;
  branch: string;
  message: string;
  repoId: string;
}

export interface CloneToWorkspaceResult {
  repo: import('../../types').Repo;
  branch: string;
  workspaceDir: string;
}
